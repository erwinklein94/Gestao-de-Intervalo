begin;

-- SUB remains only as a legacy data structure so historical migrations stay
-- reproducible. The active profile hierarchy is now entirely person-based.
alter table public.user_profiles
  drop constraint if exists user_profiles_role_check,
  drop constraint if exists user_profiles_coordinator_type_check,
  drop constraint if exists user_profiles_coordinator_registration_check;

alter table public.organization_members
  drop constraint if exists organization_members_role_check,
  drop constraint if exists organization_members_coordinator_type_check,
  drop constraint if exists organization_members_coordinator_registration_check;

alter table public.interval_plans
  drop constraint if exists interval_plans_coordinator_type_check;

alter table public.interval_comments
  drop constraint if exists interval_comments_author_role_check;

alter table public.user_profiles
  add constraint user_profiles_role_check
  check (role in (
    'director', 'executive_manager', 'manager', 'consultant',
    'coordinator', 'specialist', 'editor'
  ));

alter table public.organization_members
  add constraint organization_members_role_check
  check (role in (
    'director', 'executive_manager', 'manager', 'consultant',
    'coordinator', 'specialist', 'editor'
  ));

alter table public.interval_comments
  add constraint interval_comments_author_role_check
  check (author_role in (
    'director', 'executive_manager', 'manager', 'consultant',
    'coordinator', 'specialist', 'editor'
  ));

create or replace function private.validate_user_profile_hierarchy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  supervisor_role text;
begin
  if new.coordinator_type not in ('infrastructure', 'superstructure', 'modernization') then
    raise exception 'Selecione uma classificacao valida.' using errcode = '23514';
  end if;

  if new.manager_id is not null then
    select profile.role into supervisor_role
    from public.user_profiles profile
    where profile.id = new.manager_id and profile.enabled;

    if new.role = 'manager' and supervisor_role is distinct from 'executive_manager' then
      raise exception 'O Gerente Executivo informado nao existe ou esta desabilitado.' using errcode = '23514';
    elsif new.role in ('coordinator', 'specialist') and supervisor_role is distinct from 'manager' then
      raise exception 'O Gerente informado nao existe ou esta desabilitado.' using errcode = '23514';
    elsif new.role not in ('manager', 'coordinator', 'specialist') then
      raise exception 'Esta funcao nao pode possuir gestor direto.' using errcode = '23514';
    end if;
  end if;

  if tg_op = 'UPDATE'
     and old.role in ('executive_manager', 'manager')
     and (new.role is distinct from old.role or not new.enabled)
     and exists (
       select 1
       from public.user_profiles report
       where report.manager_id = old.id and report.enabled
     ) then
    raise exception 'Reatribua os subordinados ativos antes de alterar ou desabilitar este perfil.' using errcode = '23503';
  end if;

  if tg_op = 'UPDATE'
     and old.role = 'editor' and old.enabled
     and (new.role <> 'editor' or not new.enabled)
     and not exists (
       select 1 from public.user_profiles editor
       where editor.id <> old.id and editor.role = 'editor' and editor.enabled
     ) then
    raise exception 'O sistema deve manter ao menos um Editor habilitado.' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function private.sync_user_profile_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  member_id uuid;
  manager_member_id uuid;
  expected_supervisor_role text;
begin
  if tg_op = 'UPDATE'
     and new.email is not distinct from old.email
     and new.full_name is not distinct from old.full_name
     and new.role is not distinct from old.role
     and new.enabled is not distinct from old.enabled
     and new.manager_id is not distinct from old.manager_id
     and new.sub_id is not distinct from old.sub_id
     and new.coordinator_type is not distinct from old.coordinator_type
     and new.profile_needs_review is not distinct from old.profile_needs_review then
    return new;
  end if;

  expected_supervisor_role := case
    when new.role = 'manager' then 'executive_manager'
    when new.role in ('coordinator', 'specialist') then 'manager'
    else null
  end;

  if new.manager_id is not null and expected_supervisor_role is not null then
    select id into manager_member_id
    from public.organization_members
    where dataset_id = private.real_dataset_id()
      and auth_user_id = new.manager_id
      and role = expected_supervisor_role
      and enabled;
  end if;

  insert into public.organization_members (
    dataset_id, code, auth_user_id, email, full_name, role, enabled,
    manager_id, sub_id, coordinator_type, profile_needs_review, created_at, updated_at
  ) values (
    private.real_dataset_id(), 'auth-' || new.id::text, new.id, new.email,
    new.full_name, new.role, new.enabled, manager_member_id, new.sub_id,
    new.coordinator_type, new.profile_needs_review, new.created_at, new.updated_at
  )
  on conflict (dataset_id, auth_user_id) do update set
    email = excluded.email,
    full_name = excluded.full_name,
    role = excluded.role,
    enabled = excluded.enabled,
    manager_id = excluded.manager_id,
    sub_id = excluded.sub_id,
    coordinator_type = excluded.coordinator_type,
    profile_needs_review = excluded.profile_needs_review,
    updated_at = excluded.updated_at
  returning id into member_id;

  if new.organization_member_id is distinct from member_id then
    update public.user_profiles
    set organization_member_id = member_id
    where id = new.id;
  end if;
  return new;
end;
$$;

update public.user_profiles
set coordinator_type = coalesce(coordinator_type, 'infrastructure');

update public.organization_members
set coordinator_type = coalesce(coordinator_type, 'infrastructure');

alter table public.user_profiles
  alter column coordinator_type set default 'infrastructure',
  alter column coordinator_type set not null,
  add constraint user_profiles_coordinator_type_check
  check (coordinator_type in ('infrastructure', 'superstructure', 'modernization'));

alter table public.organization_members
  alter column coordinator_type set default 'infrastructure',
  alter column coordinator_type set not null,
  add constraint organization_members_coordinator_type_check
  check (coordinator_type in ('infrastructure', 'superstructure', 'modernization'));

alter table public.interval_plans
  add constraint interval_plans_coordinator_type_check
  check (coordinator_type is null or coordinator_type in ('infrastructure', 'superstructure', 'modernization'));

-- Preserve the requested initial real hierarchy when there is one active
-- Executive Manager. Editors can subsequently change it in the profile screen.
update public.user_profiles manager
set manager_id = executive.id
from public.user_profiles executive
where manager.role = 'manager'
  and manager.enabled
  and executive.role = 'executive_manager'
  and executive.enabled
  and (select count(*) from public.user_profiles item where item.role = 'executive_manager' and item.enabled) = 1
  and manager.manager_id is distinct from executive.id;

update public.organization_members manager
set manager_id = executive.id
from public.organization_members executive
where manager.dataset_id = executive.dataset_id
  and manager.role = 'manager'
  and manager.enabled
  and executive.role = 'executive_manager'
  and executive.enabled
  and (select count(*) from public.organization_members item where item.dataset_id = manager.dataset_id and item.role = 'executive_manager' and item.enabled) = 1
  and manager.manager_id is distinct from executive.id;

insert into public.organization_members (
  dataset_id, code, email, full_name, role, enabled, manager_id,
  coordinator_type, profile_needs_review
)
select
  private.demo_dataset_id(), 'demo-specialist-modernization',
  'especialista.modernizacao@exemplos.invalid', 'Patricia Azevedo',
  'specialist', true, manager.id, 'modernization', false
from public.organization_members manager
where manager.dataset_id = private.demo_dataset_id()
  and manager.code = 'demo-manager-south'
on conflict (dataset_id, code) do update set
  full_name = excluded.full_name,
  role = excluded.role,
  enabled = excluded.enabled,
  manager_id = excluded.manager_id,
  sub_id = null,
  coordinator_type = excluded.coordinator_type,
  profile_needs_review = excluded.profile_needs_review;

create or replace function private.can_read_plan(
  target_dataset_id uuid,
  target_coordinator_id uuid,
  target_manager_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    target_dataset_id = private.current_dataset_id()
    and case private.current_role()
      when 'editor' then true
      when 'director' then true
      when 'consultant' then true
      when 'executive_manager' then exists (
        select 1 from public.organization_members manager
        where manager.id = target_manager_id
          and manager.manager_id = private.current_member_id()
          and manager.role = 'manager'
          and manager.enabled
      )
      when 'manager' then target_manager_id = private.current_member_id()
      when 'coordinator' then target_coordinator_id = private.current_member_id()
      when 'specialist' then target_coordinator_id = private.current_member_id()
      else false
    end,
    false
  );
$$;

create or replace function private.can_write_plan(
  target_dataset_id uuid,
  target_coordinator_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    target_dataset_id = private.real_dataset_id()
    and target_dataset_id = private.current_dataset_id()
    and (
      private.actual_role() = 'editor'
      or (
        private.actual_role() in ('coordinator', 'specialist')
        and target_coordinator_id = private.actual_member_id()
      )
    ),
    false
  );
$$;

create or replace function private.can_read_member(
  target_dataset_id uuid,
  target_member_id uuid,
  target_manager_id uuid,
  target_role text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    target_dataset_id = private.current_dataset_id()
    and case private.current_role()
      when 'editor' then true
      when 'director' then true
      when 'consultant' then true
      when 'executive_manager' then
        target_member_id = private.current_member_id()
        or (target_role = 'manager' and target_manager_id = private.current_member_id())
        or (
          target_role in ('coordinator', 'specialist')
          and exists (
            select 1 from public.organization_members manager
            where manager.id = target_manager_id
              and manager.manager_id = private.current_member_id()
              and manager.role = 'manager'
              and manager.enabled
          )
        )
      when 'manager' then target_member_id = private.current_member_id()
        or (target_role in ('coordinator', 'specialist') and target_manager_id = private.current_member_id())
      when 'coordinator' then target_member_id = private.current_member_id()
        or target_member_id = (select manager_id from public.organization_members where id = private.current_member_id())
      when 'specialist' then target_member_id = private.current_member_id()
        or target_member_id = (select manager_id from public.organization_members where id = private.current_member_id())
      else false
    end,
    false
  );
$$;

create or replace function private.guard_interval_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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
    new.is_example := new.dataset_id = private.demo_dataset_id();
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
    new.is_example := old.is_example;
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
$$;

-- Keep the mature offline/idempotent synchronization routine and extend only
-- its operational-role gate. The plan guard above remains authoritative.
do $$
declare
  function_definition text;
begin
  select pg_get_functiondef(procedure.oid)
  into function_definition
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'sync_interval_plan'
    and pg_get_function_identity_arguments(procedure.oid) =
      'p_plan jsonb, p_steps jsonb, p_expected_revision bigint, p_operation_id uuid, p_device_id text';

  function_definition := replace(
    function_definition,
    'not in (''coordinator'', ''editor'')',
    'not in (''coordinator'', ''specialist'', ''editor'')'
  );
  if function_definition not like '%not in (''coordinator'', ''specialist'', ''editor'')%' then
    raise exception 'Nao foi possivel ampliar a rotina sync_interval_plan para Especialista.';
  end if;
  execute function_definition;
end;
$$;

drop function if exists public.update_site_user_profile(uuid, text, text, boolean, uuid, bigint[], text);

create or replace function public.update_site_user_profile(
  p_target_user_id uuid,
  p_full_name text,
  p_role text,
  p_enabled boolean,
  p_subordinate_ids uuid[],
  p_classification text
)
returns public.user_profiles
language plpgsql
security invoker
set search_path = ''
as $$
declare
  normalized_ids uuid[] := '{}'::uuid[];
  current_profile public.user_profiles%rowtype;
  saved_profile public.user_profiles%rowtype;
  expected_role text;
begin
  if not private.actual_is_editor() then
    raise exception 'Apenas Editores podem atualizar perfis.' using errcode = '42501';
  end if;

  select * into current_profile
  from public.user_profiles
  where id = p_target_user_id
  for update;
  if not found then raise exception 'Perfil nao encontrado.' using errcode = 'P0002'; end if;

  if nullif(btrim(p_full_name), '') is null
     or length(btrim(p_full_name)) > 120
     or p_role not in ('director', 'executive_manager', 'manager', 'consultant', 'coordinator', 'specialist', 'editor')
     or (p_role = 'editor' and current_profile.role <> 'editor')
     or p_classification not in ('infrastructure', 'superstructure', 'modernization') then
    raise exception 'Revise nome, funcao e classificacao informados.' using errcode = '23514';
  end if;

  select coalesce(array_agg(candidate.id order by candidate.first_position), '{}'::uuid[])
  into normalized_ids
  from (
    select selected.id, min(selected.position) as first_position
    from unnest(coalesce(p_subordinate_ids, '{}'::uuid[])) with ordinality as selected(id, position)
    where selected.id is not null
    group by selected.id
  ) candidate;

  expected_role := case
    when p_role = 'executive_manager' then 'manager'
    when p_role = 'manager' then 'operator'
    else null
  end;

  if expected_role is null and cardinality(normalized_ids) > 0 then
    raise exception 'Esta funcao nao possui subordinados diretos.' using errcode = '23514';
  end if;

  if exists (
    select 1
    from unnest(normalized_ids) selected(id)
    left join public.user_profiles candidate on candidate.id = selected.id and candidate.enabled
    where candidate.id is null
       or candidate.id = p_target_user_id
       or (expected_role = 'manager' and candidate.role <> 'manager')
       or (expected_role = 'operator' and candidate.role not in ('coordinator', 'specialist'))
  ) then
    raise exception 'Um ou mais subordinados selecionados nao estao disponiveis.' using errcode = '23514';
  end if;

  if current_profile.role in ('executive_manager', 'manager')
     and (p_role is distinct from current_profile.role or not p_enabled) then
    update public.user_profiles set manager_id = null where manager_id = p_target_user_id;
  end if;

  update public.user_profiles
  set full_name = btrim(p_full_name),
      role = p_role,
      enabled = p_enabled,
      manager_id = case when p_role = current_profile.role then current_profile.manager_id else null end,
      sub_id = current_profile.sub_id,
      coordinator_type = p_classification,
      profile_needs_review = false
  where id = p_target_user_id
  returning * into saved_profile;

  if expected_role is not null then
    update public.user_profiles
    set manager_id = null
    where manager_id = p_target_user_id
      and not (id = any(normalized_ids));

    update public.user_profiles
    set manager_id = p_target_user_id
    where id = any(normalized_ids);
  end if;

  return saved_profile;
end;
$$;

create or replace function public.list_demo_personas()
returns table (
  id uuid, code text, full_name text, role text,
  manager_id uuid, sub_id bigint, coordinator_type text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if not private.actual_is_editor()
     or private.current_dataset_id() <> private.demo_dataset_id() then
    raise exception 'Apenas Editores podem acessar personas de demonstracao.' using errcode = '42501';
  end if;

  return query
  select member.id, member.code, member.full_name, member.role,
         member.manager_id, null::bigint, member.coordinator_type
  from public.organization_members member
  where member.dataset_id = private.demo_dataset_id() and member.enabled
  order by
    case member.role
      when 'editor' then 1 when 'director' then 2
      when 'executive_manager' then 3 when 'consultant' then 4
      when 'manager' then 5 when 'coordinator' then 6
      when 'specialist' then 7 else 99
    end,
    member.full_name;
end;
$$;

drop trigger if exists user_profiles_sync_primary_coordinator_sub on public.user_profiles;

revoke all on public.subs, public.coordinator_sub_assignments from authenticated;

revoke all on function public.update_site_user_profile(uuid, text, text, boolean, uuid[], text)
from public, anon;
grant execute on function public.update_site_user_profile(uuid, text, text, boolean, uuid[], text)
to authenticated;

revoke all on function private.can_read_plan(uuid, uuid, uuid),
  private.can_write_plan(uuid, uuid),
  private.can_read_member(uuid, uuid, uuid, text),
  private.validate_user_profile_hierarchy(),
  private.sync_user_profile_member(),
  private.guard_interval_plan()
from public, anon, authenticated;
grant execute on function private.can_read_plan(uuid, uuid, uuid),
  private.can_write_plan(uuid, uuid),
  private.can_read_member(uuid, uuid, uuid, text)
to authenticated;

commit;
