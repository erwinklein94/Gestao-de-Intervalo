-- Remove o ambiente de exemplos por completo: o sistema passa a ter apenas
-- dados reais.
--
-- Sai o dataset 'demo' (63 intervalos, 236 etapas e 35 personas espelhadas),
-- saem as funcoes que existiam so para sustenta-lo (list_demo_personas,
-- demo_dataset_id) e sai a coluna interval_plans.is_example, que existia
-- unicamente para marcar intervalo de demonstracao.
--
-- Com isso, current_dataset_id passa a devolver sempre o dataset real e
-- current_member_id volta a ser o membro do proprio usuario autenticado --
-- nao ha mais persona a personificar.
--
-- Os dados reais nao sao tocados: 4 intervalos, 35 perfis e 35 membros.

do $$
declare
  demo_id uuid := (select id from public.datasets where code = 'demo');
begin
  if demo_id is null then
    raise notice 'Dataset demo ja removido.';
    return;
  end if;

  delete from public.interval_comments where dataset_id = demo_id;
  -- interval_steps, share_links e sync_receipts caem por cascade.
  delete from public.interval_plans where dataset_id = demo_id;
  delete from public.interval_audit_log where dataset_id = demo_id;

  -- manager_id e auto-referencia com ON DELETE RESTRICT: zera antes de remover.
  update public.organization_members set manager_id = null where dataset_id = demo_id;
  -- coordinator_sub_assignments e manager_operator_assignments caem por cascade.
  delete from public.organization_members where dataset_id = demo_id;
end $$;

-- O intervalo deixa de carregar a marca de exemplo; o guard nao a atribui mais.
create or replace function private.guard_interval_plan()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  member public.organization_members%rowtype;
begin
  if pg_trigger_depth() > 1 then return new; end if;

  if (select auth.uid()) is null then
    new.revision := case when tg_op = 'UPDATE' then old.revision + 1 else greatest(coalesce(new.revision, 0), 1) end;
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.dataset_id := private.current_dataset_id();
    new.revision := greatest(coalesce(new.revision, 0), 1);
    new.status := 'planning';
    new.completed_at := null;
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
    if old.completed_at is not null then
      new.status := 'completed';
      new.completed_at := old.completed_at;
      new.archived_at := old.archived_at;
    elsif private.actual_role() <> 'editor' then
      new.status := old.status;
      new.completed_at := old.completed_at;
      new.archived_at := old.archived_at;
    end if;
  end if;

  if private.actual_role() in ('coordinator', 'specialist') then
    select * into member from public.organization_members where id = private.actual_member_id();
    new.user_id := (select auth.uid());
    new.coordinator_member_id := member.id;
  elsif private.actual_role() = 'editor' and new.coordinator_member_id is not null then
    select * into member
    from public.organization_members
    where id = new.coordinator_member_id
      and dataset_id = new.dataset_id
      and role in ('coordinator', 'specialist')
      and enabled;
    if not found then
      raise exception 'Selecione um Coordenador ou Especialista ativo do mesmo ambiente.' using errcode = '23514';
    end if;
    new.user_id := coalesce(member.auth_user_id, new.user_id);
  elsif private.actual_role() <> 'editor' then
    raise exception 'Perfil sem permissao para editar intervalos.' using errcode = '42501';
  end if;

  new.manager_member_id := member.manager_id;
  new.sub_id := case when tg_op = 'UPDATE' then old.sub_id else null end;
  new.coordinator_type := member.coordinator_type;
  new.coordinator := member.full_name;
  return new;
end;
$function$;

-- So existe um ambiente agora.
create or replace function private.current_dataset_id()
returns uuid
language sql
stable
security definer
set search_path to ''
as $function$
  select private.real_dataset_id();
$function$;

create or replace function private.current_member_id()
returns uuid
language sql
stable
security definer
set search_path to ''
as $function$
  select private.actual_member_id();
$function$;

drop function if exists public.list_demo_personas();

delete from public.datasets where code = 'demo';

drop function if exists private.demo_dataset_id();

-- is_example existia so para marcar intervalo de demonstracao. Ao remove-la,
-- cai junto o check 'is_example or user_id is not null'; todo intervalo passa a
-- exigir dono, que e a regra que sobra.
alter table public.interval_plans drop column is_example;
alter table public.interval_plans alter column user_id set not null;
