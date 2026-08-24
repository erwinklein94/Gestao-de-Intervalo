-- closed_by era gravado e nunca lido: nem tela, nem exportacao, nem Edge
-- Function. O motivo nao era esquecimento -- e que nao dava. closed_by guarda
-- um id de auth.users, e a coluna organization_members.auth_user_id nao esta
-- entre as que o perfil "authenticated" pode ler, de proposito. O cliente
-- recebia um uuid que nao tinha como transformar em nome.
--
-- A saida e a mesma que interval_comments ja usa para o autor: gravar o nome
-- no momento do ato. Alem de resolver a leitura, isso e o certo para um
-- registro historico -- quem encerrou aquele intervalo naquele dia continua
-- sendo aquela pessoa mesmo que o cadastro mude de nome ou seja desativado
-- depois.

alter table public.interval_plans
  add column if not exists closed_by_name text;

comment on column public.interval_plans.closed_by_name is
  'Nome de quem encerrou o intervalo, gravado no encerramento. Historico nao segue renomeacao de cadastro.';

-- ---------------------------------------------------------------------------
-- O guard passa a carimbar o nome junto com o id.
-- ---------------------------------------------------------------------------
create or replace function private.guard_interval_plan()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  member public.organization_members%rowtype;
  is_finalizing boolean := false;
  group_owner uuid;
  group_size integer;
  group_lead public.interval_plans%rowtype;
begin
  if pg_trigger_depth() > 1 then return new; end if;

  if (select auth.uid()) is null then
    new.group_id := coalesce(new.group_id, new.id, gen_random_uuid());
    new.revision := case when tg_op = 'UPDATE' then old.revision + 1 else greatest(coalesce(new.revision, 0), 1) end;
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.dataset_id := private.current_dataset_id();
    new.revision := greatest(coalesce(new.revision, 0), 1);
    new.status := 'planning';
    new.completed_at := null;
    new.closed_by := null;
    new.closed_by_name := null;
    new.group_id := coalesce(new.group_id, gen_random_uuid());
  else
    if not private.can_write_plan(old.dataset_id, old.coordinator_member_id) then
      raise exception 'Intervalo fora do escopo de edicao.' using errcode = '42501';
    end if;
    if old.completed_at is not null and private.actual_role() <> 'editor' then
      raise exception 'Intervalos concluidos fazem parte do historico e nao podem ser alterados.' using errcode = '42501';
    end if;
    new.dataset_id := old.dataset_id;
    new.created_at := old.created_at;
    new.revision := old.revision + 1;
    -- Uma frente nao troca de intervalo depois de criada.
    new.group_id := old.group_id;
    if old.completed_at is not null then
      new.status := 'completed';
      new.completed_at := old.completed_at;
      new.archived_at := old.archived_at;
      new.closed_by := old.closed_by;
      new.closed_by_name := old.closed_by_name;
    elsif private.actual_role() <> 'editor' then
      is_finalizing := new.status = 'completed'
        and new.completed_at is not null
        and private.actual_role() in ('manager', 'coordinator', 'specialist');
      if is_finalizing then
        -- A regra olha o grupo, nao a linha: encerrar uma frente sozinha
        -- deixaria o bloqueio meio fechado no historico.
        if exists (
          select 1 from public.interval_plans front
          where front.group_id = old.group_id
            and front.dataset_id = old.dataset_id
            and not exists (select 1 from public.interval_steps step where step.plan_id = front.id)
        ) then
          raise exception 'Inclua ao menos uma etapa antes de finalizar a execucao.' using errcode = '23514';
        end if;
        if exists (
          select 1
          from public.interval_plans front
          join public.interval_steps step on step.plan_id = front.id
          where front.group_id = old.group_id
            and front.dataset_id = old.dataset_id
            and step.status not in ('completed', 'skipped')
        ) then
          raise exception 'Todas as etapas devem estar concluidas ou marcadas como nao executadas.' using errcode = '23514';
        end if;
        new.archived_at := old.archived_at;
        new.closed_by := coalesce(new.closed_by, (select auth.uid()));
      else
        new.status := old.status;
        new.completed_at := old.completed_at;
        new.archived_at := old.archived_at;
        new.closed_by := old.closed_by;
        new.closed_by_name := old.closed_by_name;
      end if;
    end if;
  end if;

  if private.actual_role() in ('manager', 'coordinator', 'specialist') then
    select * into member
    from public.organization_members
    where id = private.actual_member_id()
      and dataset_id = new.dataset_id
      and role = private.actual_role()
      and enabled;
    if not found then
      raise exception 'Perfil operacional sem cadastro ativo no ambiente.' using errcode = '42501';
    end if;
    new.user_id := (select auth.uid());
    new.coordinator_member_id := member.id;
  elsif private.actual_role() = 'editor' and new.coordinator_member_id is not null then
    select * into member
    from public.organization_members
    where id = new.coordinator_member_id
      and dataset_id = new.dataset_id
      and role in ('manager', 'coordinator', 'specialist')
      and enabled;
    if not found then
      raise exception 'Selecione um Gerente, Coordenador ou Especialista ativo do mesmo ambiente.' using errcode = '23514';
    end if;
    new.user_id := coalesce(member.auth_user_id, new.user_id);
  elsif private.actual_role() <> 'editor' then
    raise exception 'Perfil sem permissao para editar intervalos.' using errcode = '42501';
  end if;

  -- Frentes do mesmo intervalo pertencem a um unico responsavel. Sem isso,
  -- bastaria reaproveitar um group_id alheio para pendurar uma frente no
  -- intervalo de outra pessoa.
  select front.user_id into group_owner
  from public.interval_plans front
  where front.group_id = new.group_id
    and front.dataset_id = new.dataset_id
    and front.id is distinct from new.id
  limit 1;
  if group_owner is not null and group_owner is distinct from new.user_id then
    raise exception 'Este intervalo pertence a outro responsavel.' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    select count(*) into group_size
    from public.interval_plans front
    where front.group_id = new.group_id and front.dataset_id = new.dataset_id;
    if group_size >= 12 then
      raise exception 'Um intervalo comporta no maximo 12 frentes.' using errcode = '23514';
    end if;

    -- Titulo, data, janela e local descrevem o bloqueio, e o bloqueio e um so.
    -- A frente que chega adota o que o grupo ja diz, em vez de impor o que
    -- veio no payload: quem manda e o intervalo, nao a ultima linha inserida.
    select * into group_lead
    from public.interval_plans front
    where front.group_id = new.group_id and front.dataset_id = new.dataset_id
    order by front.front_position, front.created_at
    limit 1;
    if found then
      new.title := group_lead.title;
      new.interval_date := group_lead.interval_date;
      new.window_start := group_lead.window_start;
      new.window_end := group_lead.window_end;
      new.location := group_lead.location;
    end if;
  end if;

  -- O nome de quem encerrou fica gravado aqui, onde member ja foi resolvido.
  -- Sem isso a tela recebe um uuid de auth.users que nao tem permissao de
  -- traduzir -- foi por isso que closed_by nasceu ilegivel.
  if new.completed_at is not null and new.closed_by is not null then
    new.closed_by_name := coalesce(nullif(new.closed_by_name, ''), member.full_name, new.coordinator);
  end if;

  new.manager_member_id := case when member.role = 'manager' then member.id else member.manager_id end;
  new.coordinator_type := member.coordinator_type;
  new.coordinator := member.full_name;
  return new;
end;
$function$;

-- ---------------------------------------------------------------------------
-- O encerramento devolve tambem quem encerrou, ja legivel.
-- ---------------------------------------------------------------------------
create or replace function public.close_interval(p_group_id uuid)
returns jsonb
language plpgsql
set search_path to ''
as $function$
declare
  dataset uuid := private.current_dataset_id();
  fronts integer;
  open_steps integer;
  closed integer;
  closed_at timestamptz := now();
  fronts_detail jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'Autenticacao obrigatoria.' using errcode = '42501';
  end if;
  if coalesce(private.actual_role() not in ('manager', 'coordinator', 'specialist'), true) then
    raise exception 'Somente Gerente, Coordenador, Coordenadora ou Especialista pode encerrar o intervalo.' using errcode = '42501';
  end if;
  if p_group_id is null then
    raise exception 'Intervalo nao informado.' using errcode = '22023';
  end if;

  select count(*) into fronts
  from public.interval_plans plan
  where plan.group_id = p_group_id and plan.dataset_id = dataset;
  if fronts = 0 then
    raise exception 'Intervalo nao encontrado.' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.interval_plans plan
    where plan.group_id = p_group_id and plan.dataset_id = dataset
      and not private.can_write_plan(plan.dataset_id, plan.coordinator_member_id)
  ) then
    raise exception 'Intervalo fora do escopo de encerramento.' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.interval_plans plan
    where plan.group_id = p_group_id and plan.dataset_id = dataset
      and not exists (select 1 from public.interval_steps step where step.plan_id = plan.id)
  ) then
    raise exception 'INTERVAL_FRONT_WITHOUT_STEPS' using errcode = '23514';
  end if;

  select count(*) into open_steps
  from public.interval_plans plan
  join public.interval_steps step on step.plan_id = plan.id
  where plan.group_id = p_group_id and plan.dataset_id = dataset
    and step.status not in ('completed', 'skipped');
  if open_steps > 0 then
    raise exception 'INTERVAL_HAS_OPEN_STEPS: %', open_steps using errcode = '23514';
  end if;

  update public.interval_plans
  set status = 'completed', completed_at = closed_at
  where group_id = p_group_id and dataset_id = dataset and completed_at is null;
  get diagnostics closed = row_count;

  -- A revisao de cada frente, para o cliente nao ficar com copia velha das
  -- irmas que ele nao tocou.
  select coalesce(jsonb_agg(jsonb_build_object(
           'plan_id', plan.id,
           'client_id', plan.client_id,
           'front_position', plan.front_position,
           'revision', plan.revision,
           'status', plan.status,
           'completed_at', plan.completed_at,
           'closed_by', plan.closed_by,
           'closed_by_name', plan.closed_by_name
         ) order by plan.front_position, plan.created_at), '[]'::jsonb)
    into fronts_detail
  from public.interval_plans plan
  where plan.group_id = p_group_id and plan.dataset_id = dataset;

  return jsonb_build_object('group_id', p_group_id, 'fronts', fronts,
    'closed', closed, 'status', 'completed', 'completed_at', closed_at,
    'closed_by_name', (fronts_detail->0->>'closed_by_name'),
    'fronts_detail', fronts_detail);
end;
$function$;

create or replace function public.finalize_interval_plan(p_plan_id uuid)
returns jsonb
language plpgsql
set search_path to ''
as $function$
declare
  target public.interval_plans%rowtype;
  resultado jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'Autenticacao obrigatoria.' using errcode = '42501';
  end if;

  select * into target
  from public.interval_plans plan
  where plan.id = p_plan_id
    and plan.dataset_id = private.current_dataset_id();

  if not found then
    raise exception 'Intervalo fora do escopo de edicao.' using errcode = '42501';
  end if;
  if target.completed_at is not null then
    return jsonb_build_object('plan_id', target.id, 'status', target.status,
      'completed_at', target.completed_at, 'revision', target.revision,
      'closed_by_name', target.closed_by_name, 'already_completed', true);
  end if;

  resultado := public.close_interval(target.group_id);

  select * into target from public.interval_plans plan where plan.id = p_plan_id;
  return jsonb_build_object('plan_id', target.id, 'status', target.status,
    'completed_at', target.completed_at, 'revision', target.revision,
    'closed_by_name', target.closed_by_name,
    'already_completed', false, 'fronts', resultado->'fronts',
    'fronts_detail', resultado->'fronts_detail');
end;
$function$;

revoke all on function public.close_interval(uuid) from public, anon;
grant execute on function public.close_interval(uuid) to authenticated;
revoke all on function public.finalize_interval_plan(uuid) from public, anon;
grant execute on function public.finalize_interval_plan(uuid) to authenticated;
