-- Concessao do CCO: tempo extra autorizado para o termino do intervalo.
--
-- Fica em coluna propria, ao lado de window_end, em vez de somado dentro dela.
-- Sao duas decisoes de origens diferentes -- a janela e o que foi planejado, a
-- concessao e o que o CCO liberou depois -- e o relatorio precisa mostrar as
-- duas. Somar antes de gravar apagaria de quem partiu cada horario, e nao ha
-- como separar de novo.
--
-- cco_grant_unit guarda a unidade em que o numero foi digitado. O valor de
-- verdade sao os minutos; a unidade existe para quem lancou "1 h" reler "1 h",
-- e nao "60".
--
-- A concessao descreve o bloqueio, nao a frente, entao entra na mesma
-- propagacao de titulo, data, janela e local.

alter table public.interval_plans
  add column if not exists cco_grant_minutes integer not null default 0,
  add column if not exists cco_grant_unit text not null default 'minutes';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.interval_plans'::regclass
      and conname = 'interval_plans_cco_grant_minutes_check'
  ) then
    alter table public.interval_plans
      add constraint interval_plans_cco_grant_minutes_check
      check (cco_grant_minutes between 0 and 1440);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.interval_plans'::regclass
      and conname = 'interval_plans_cco_grant_unit_check'
  ) then
    alter table public.interval_plans
      add constraint interval_plans_cco_grant_unit_check
      check (cco_grant_unit in ('minutes', 'hours'));
  end if;
end;
$$;

comment on column public.interval_plans.cco_grant_minutes is
  'Tempo extra concedido pelo CCO para o termino do intervalo, em minutos. O prazo final e window_end mais este valor.';
comment on column public.interval_plans.cco_grant_unit is
  'Unidade em que a concessao foi digitada. So afeta exibicao; o valor de verdade sao os minutos.';

-- ---------------------------------------------------------------------------
-- A concessao acompanha o bloqueio, como a janela.
-- ---------------------------------------------------------------------------
create or replace function private.propagate_interval_group_fields()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  -- A propria propagacao dispara este gatilho de novo, uma vez por irma. A
  -- profundidade corta a recursao; a comparacao abaixo ja garantiria a parada,
  -- mas depender dela seria contar com sorte.
  if pg_trigger_depth() > 1 then return null; end if;

  update public.interval_plans sibling
  set title = new.title,
      interval_date = new.interval_date,
      window_start = new.window_start,
      window_end = new.window_end,
      location = new.location,
      cco_grant_minutes = new.cco_grant_minutes,
      cco_grant_unit = new.cco_grant_unit,
      -- De proposito: a revisao das irmas nao sobe. Ver o cabecalho de
      -- 20260824190000_group_fields_and_front_position.sql.
      revision = sibling.revision
  where sibling.group_id = new.group_id
    and sibling.dataset_id = new.dataset_id
    and sibling.id <> new.id
    -- Frente encerrada e historico e nao se reescreve. O guard recusaria, mas
    -- em gatilho aninhado ele volta cedo, entao o filtro mora aqui.
    and sibling.completed_at is null
    and (sibling.title, sibling.interval_date, sibling.window_start, sibling.window_end,
         sibling.location, sibling.cco_grant_minutes, sibling.cco_grant_unit)
        is distinct from
        (new.title, new.interval_date, new.window_start, new.window_end,
         new.location, new.cco_grant_minutes, new.cco_grant_unit);

  return null;
end;
$function$;

-- ---------------------------------------------------------------------------
-- A frente nova adota a concessao do grupo, junto com o resto do bloqueio.
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

    -- Titulo, data, janela, local e concessao descrevem o bloqueio, e o
    -- bloqueio e um so. A frente que chega adota o que o grupo ja diz, em vez
    -- de impor o que veio no payload.
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
      new.cco_grant_minutes := group_lead.cco_grant_minutes;
      new.cco_grant_unit := group_lead.cco_grant_unit;
    end if;
  end if;

  -- O nome de quem encerrou fica gravado aqui, onde member ja foi resolvido.
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
-- A sincronizacao grava a concessao. Valor fora da faixa e recusado, e nao
-- truncado -- mesma regra da posicao da frente, pelo mesmo motivo.
-- ---------------------------------------------------------------------------
create or replace function public.sync_interval_plan(
  p_plan jsonb,
  p_steps jsonb,
  p_expected_revision bigint,
  p_operation_id uuid,
  p_device_id text
)
returns jsonb
language plpgsql
set search_path to ''
as $function$
declare
  target_id uuid;
  target_revision bigint;
  target_status text;
  existing_receipt public.interval_sync_receipts%rowtype;
  payload_hash text;
  requested_database_id uuid;
  requested_owner_id uuid;
  requested_front_position integer;
  requested_grant integer;
  requested_grant_unit text;
begin
  if (select auth.uid()) is null then
    raise exception 'Autenticacao obrigatoria.' using errcode = '42501';
  end if;
  if coalesce(private.actual_role() not in ('manager', 'coordinator', 'specialist', 'editor'), true)
     or private.current_dataset_id() is distinct from private.real_dataset_id() then
    raise exception 'Perfil ou ambiente sem permissao para sincronizar intervalos.' using errcode = '42501';
  end if;
  if p_operation_id is null or char_length(coalesce(p_device_id, '')) not between 8 and 120 then
    raise exception 'Identificacao de sincronizacao invalida.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    (select auth.uid())::text || ':' || p_device_id || ':' || p_operation_id::text, 0));

  if jsonb_typeof(coalesce(p_plan, '{}'::jsonb)) <> 'object'
     or jsonb_typeof(coalesce(p_steps, '[]'::jsonb)) <> 'array' then
    raise exception 'Payload de sincronizacao invalido.' using errcode = '22023';
  end if;

  payload_hash := encode(extensions.digest(convert_to(coalesce(p_plan, '{}'::jsonb)::text || coalesce(p_steps, '[]'::jsonb)::text, 'UTF8'), 'sha256'), 'hex');
  select * into existing_receipt
  from public.interval_sync_receipts receipt
  where receipt.actor_id = (select auth.uid())
    and receipt.device_id = p_device_id
    and receipt.operation_id = p_operation_id;

  if found then
    if existing_receipt.payload_hash <> payload_hash then
      raise exception 'SYNC_OPERATION_PAYLOAD_MISMATCH' using errcode = '40001';
    end if;
    return jsonb_build_object('plan_id', existing_receipt.plan_id,
      'revision', existing_receipt.applied_revision, 'replayed', true);
  end if;

  begin
    requested_database_id := nullif(p_plan->>'database_id', '')::uuid;
  exception when invalid_text_representation then requested_database_id := null;
  end;
  begin
    requested_owner_id := nullif(p_plan->>'user_id', '')::uuid;
  exception when invalid_text_representation then requested_owner_id := null;
  end;

  -- Antes: greatest(1, least(12, ...)). O banco guardava 12, respondia sucesso
  -- e o cliente seguia achando que gravou 13 -- duas frentes na mesma posicao,
  -- com o mesmo nome derivado, sem nenhum sinal. Recusar e a unica forma de
  -- isso nao passar despercebido.
  begin
    requested_front_position := nullif(p_plan->>'front_position', '')::integer;
  exception when invalid_text_representation then
    raise exception 'INTERVAL_FRONT_POSITION_INVALID: %', p_plan->>'front_position' using errcode = '22023';
  end;
  if requested_front_position is not null and requested_front_position not between 1 and 12 then
    raise exception 'INTERVAL_FRONT_POSITION_OUT_OF_RANGE: %', requested_front_position using errcode = '23514';
  end if;

  begin
    requested_grant := nullif(p_plan->>'cco_grant_minutes', '')::integer;
  exception when invalid_text_representation then
    raise exception 'INTERVAL_CCO_GRANT_INVALID: %', p_plan->>'cco_grant_minutes' using errcode = '22023';
  end;
  if requested_grant is not null and requested_grant not between 0 and 1440 then
    raise exception 'INTERVAL_CCO_GRANT_OUT_OF_RANGE: %', requested_grant using errcode = '23514';
  end if;
  requested_grant_unit := nullif(p_plan->>'cco_grant_unit', '');
  if requested_grant_unit is not null and requested_grant_unit not in ('minutes', 'hours') then
    raise exception 'INTERVAL_CCO_GRANT_UNIT_INVALID: %', requested_grant_unit using errcode = '23514';
  end if;

  if requested_database_id is not null then
    select plan.id, plan.revision into target_id, target_revision
    from public.interval_plans plan
    where plan.id = requested_database_id and plan.dataset_id = private.current_dataset_id()
    for update;
  else
    select plan.id, plan.revision into target_id, target_revision
    from public.interval_plans plan
    where plan.dataset_id = private.current_dataset_id()
      and plan.client_id = p_plan->>'client_id'
      and plan.user_id = coalesce(requested_owner_id, (select auth.uid()))
    limit 1 for update;
  end if;

  if target_id is not null then
    if target_revision <> coalesce(p_expected_revision, 0) then
      raise exception 'SYNC_CONFLICT: expected %, found %', p_expected_revision, target_revision using errcode = '40001';
    end if;
    update public.interval_plans
    set title = coalesce(p_plan->>'title', ''),
        service_type = coalesce(p_plan->>'service_type', ''),
        contractor_name = coalesce(p_plan->>'contractor_name', ''),
        foreman_name = coalesce(p_plan->>'foreman_name', ''),
        front_position = coalesce(requested_front_position, front_position),
        front_name = coalesce(p_plan->>'front_name', ''),
        coordinator = coalesce(p_plan->>'coordinator', ''),
        interval_date = nullif(p_plan->>'interval_date', '')::date,
        location = coalesce(p_plan->>'location', ''),
        window_start = nullif(p_plan->>'window_start', '')::timestamp,
        window_end = nullif(p_plan->>'window_end', '')::timestamp,
        cco_grant_minutes = coalesce(requested_grant, cco_grant_minutes),
        cco_grant_unit = coalesce(requested_grant_unit, cco_grant_unit),
        planning_notes = coalesce(p_plan->>'planning_notes', ''),
        execution_notes = coalesce(p_plan->>'execution_notes', ''),
        is_locked = coalesce((p_plan->>'is_locked')::boolean, false),
        locked_at = nullif(p_plan->>'locked_at', '')::timestamptz,
        coordinator_member_id = nullif(p_plan->>'coordinator_member_id', '')::uuid,
        manager_member_id = nullif(p_plan->>'manager_member_id', '')::uuid,
        coordinator_type = nullif(p_plan->>'coordinator_type', ''),
        last_operation_id = p_operation_id
    where id = target_id
    returning revision into target_revision;
  else
    insert into public.interval_plans (
      user_id, client_id, title, service_type, contractor_name, foreman_name,
      coordinator, interval_date, location, window_start, window_end,
      cco_grant_minutes, cco_grant_unit,
      planning_notes, execution_notes, is_locked, locked_at, dataset_id,
      coordinator_member_id, manager_member_id, coordinator_type,
      last_operation_id, group_id, front_position, front_name
    ) values (
      coalesce(requested_owner_id, (select auth.uid())), p_plan->>'client_id',
      coalesce(p_plan->>'title', ''), coalesce(p_plan->>'service_type', ''),
      coalesce(p_plan->>'contractor_name', ''), coalesce(p_plan->>'foreman_name', ''),
      coalesce(p_plan->>'coordinator', ''), nullif(p_plan->>'interval_date', '')::date,
      coalesce(p_plan->>'location', ''), nullif(p_plan->>'window_start', '')::timestamp,
      nullif(p_plan->>'window_end', '')::timestamp,
      coalesce(requested_grant, 0), coalesce(requested_grant_unit, 'minutes'),
      coalesce(p_plan->>'planning_notes', ''),
      coalesce(p_plan->>'execution_notes', ''), coalesce((p_plan->>'is_locked')::boolean, false),
      nullif(p_plan->>'locked_at', '')::timestamptz, private.current_dataset_id(),
      nullif(p_plan->>'coordinator_member_id', '')::uuid,
      nullif(p_plan->>'manager_member_id', '')::uuid,
      nullif(p_plan->>'coordinator_type', ''),
      p_operation_id,
      coalesce(nullif(p_plan->>'group_id', '')::uuid, gen_random_uuid()),
      coalesce(requested_front_position, 1),
      coalesce(p_plan->>'front_name', '')
    ) returning id, revision into target_id, target_revision;
  end if;

  insert into public.interval_sync_receipts (
    actor_id, device_id, operation_id, plan_id, payload_hash,
    base_revision, applied_revision
  ) values (
    (select auth.uid()), p_device_id, p_operation_id, target_id,
    payload_hash, coalesce(p_expected_revision, 0), target_revision
  );

  delete from public.interval_steps where plan_id = target_id;
  insert into public.interval_steps (
    plan_id, client_id, position, activity_name, planned_start, planned_end,
    actual_start, actual_end, actual_notes, status, skip_reason, last_operation_id
  )
  select target_id, step->>'client_id', (ordinality - 1)::integer,
    coalesce(step->>'activity_name', ''), nullif(step->>'planned_start', '')::timestamp,
    nullif(step->>'planned_end', '')::timestamp, nullif(step->>'actual_start', '')::timestamp,
    nullif(step->>'actual_end', '')::timestamp, coalesce(step->>'actual_notes', ''),
    coalesce(nullif(step->>'status', ''), 'pending'), coalesce(step->>'skip_reason', ''),
    p_operation_id
  from jsonb_array_elements(coalesce(p_steps, '[]'::jsonb)) with ordinality as rows(step, ordinality);

  select revision, status into target_revision, target_status
  from public.interval_plans where id = target_id;

  return jsonb_build_object('plan_id', target_id, 'revision', target_revision,
    'status', target_status, 'replayed', false);
end;
$function$;

revoke all on function public.sync_interval_plan(jsonb,jsonb,bigint,uuid,text) from public, anon;
grant execute on function public.sync_interval_plan(jsonb,jsonb,bigint,uuid,text) to authenticated;
