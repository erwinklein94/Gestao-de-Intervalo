-- Permite que um perfil de chefia (Diretor, Gerente Executivo, Gerente,
-- Consultor, Editor) responda por mais de uma classificacao.
-- Coordenador e Especialista continuam com exatamente uma, para que o
-- intervalo criado por eles nunca fique com classificacao ambigua.
--
-- coordinator_type deixa de ser coluna comum e passa a ser gerada a partir
-- da primeira posicao de coordinator_types, mantendo compativel tudo que ja
-- le a coluna (guard_interval_plan, list_demo_personas, front-end antigo).

alter table public.user_profiles
  add column coordinator_types text[] not null default array['infrastructure']::text[];
update public.user_profiles set coordinator_types = array[coordinator_type];
alter table public.user_profiles drop column coordinator_type;
alter table public.user_profiles
  add column coordinator_type text generated always as (coordinator_types[1]) stored;
alter table public.user_profiles add constraint user_profiles_coordinator_types_check
  check (cardinality(coordinator_types) between 1 and 3
     and coordinator_types <@ array['superstructure', 'infrastructure', 'modernization']::text[]);

alter table public.organization_members
  add column coordinator_types text[] not null default array['infrastructure']::text[];
update public.organization_members set coordinator_types = array[coordinator_type];
alter table public.organization_members drop column coordinator_type;
alter table public.organization_members
  add column coordinator_type text generated always as (coordinator_types[1]) stored;
alter table public.organization_members add constraint organization_members_coordinator_types_check
  check (cardinality(coordinator_types) between 1 and 3
     and coordinator_types <@ array['superstructure', 'infrastructure', 'modernization']::text[]);

comment on column public.user_profiles.coordinator_types is
  'Classificacoes sob responsabilidade do perfil. Coordenador e Especialista possuem exatamente uma.';
comment on column public.user_profiles.coordinator_type is
  'Classificacao principal, derivada da primeira posicao de coordinator_types.';

-- Normaliza a lista (remove repetidos, fixa a ordem) e aplica a cardinalidade por funcao.
create or replace function private.validate_user_profile_hierarchy()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  supervisor_role text;
begin
  select coalesce(array_agg(entry order by array_position(
           array['superstructure', 'infrastructure', 'modernization']::text[], entry)), '{}'::text[])
  into new.coordinator_types
  from (select distinct unnest(coalesce(new.coordinator_types, '{}'::text[])) as entry) normalized
  where entry in ('superstructure', 'infrastructure', 'modernization');

  if cardinality(new.coordinator_types) = 0 then
    raise exception 'Selecione ao menos uma classificacao valida.' using errcode = '23514';
  end if;

  if new.role in ('coordinator', 'specialist') and cardinality(new.coordinator_types) > 1 then
    raise exception 'Coordenador e Especialista respondem por uma unica classificacao.' using errcode = '23514';
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
$function$;

-- Propaga a lista completa para organization_members.
create or replace function private.sync_user_profile_member()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
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
     and new.coordinator_types is not distinct from old.coordinator_types
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
    manager_id, sub_id, coordinator_types, profile_needs_review, created_at, updated_at
  ) values (
    private.real_dataset_id(), 'auth-' || new.id::text, new.id, new.email,
    new.full_name, new.role, new.enabled, manager_member_id, new.sub_id,
    new.coordinator_types, new.profile_needs_review, new.created_at, new.updated_at
  )
  on conflict (dataset_id, auth_user_id) do update set
    email = excluded.email,
    full_name = excluded.full_name,
    role = excluded.role,
    enabled = excluded.enabled,
    manager_id = excluded.manager_id,
    sub_id = excluded.sub_id,
    coordinator_types = excluded.coordinator_types,
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
$function$;

-- A RPC de edicao passa a receber a lista de classificacoes.
drop function if exists public.update_site_user_profile(uuid, text, text, boolean, uuid[], text);

create or replace function public.update_site_user_profile(
  p_target_user_id uuid,
  p_full_name text,
  p_role text,
  p_enabled boolean,
  p_subordinate_ids uuid[],
  p_classifications text[]
) returns public.user_profiles
language plpgsql
set search_path to ''
as $function$
declare
  normalized_ids uuid[] := '{}'::uuid[];
  normalized_classifications text[] := '{}'::text[];
  current_profile public.user_profiles%rowtype;
  saved_profile public.user_profiles%rowtype;
  expected_role text;
begin
  if not private.actual_is_editor() then
    raise exception 'Apenas Editores podem atualizar perfis.' using errcode = '42501';
  end if;
  select * into current_profile from public.user_profiles where id = p_target_user_id for update;
  if not found then raise exception 'Perfil nao encontrado.' using errcode = 'P0002'; end if;

  select coalesce(array_agg(entry order by array_position(
           array['superstructure', 'infrastructure', 'modernization']::text[], entry)), '{}'::text[])
  into normalized_classifications
  from (select distinct unnest(coalesce(p_classifications, '{}'::text[])) as entry) normalized
  where entry in ('superstructure', 'infrastructure', 'modernization');

  if nullif(btrim(p_full_name), '') is null or length(btrim(p_full_name)) > 120
     or p_role not in ('director', 'executive_manager', 'manager', 'consultant', 'coordinator', 'specialist', 'editor')
     or (p_role = 'editor' and current_profile.role <> 'editor')
     or cardinality(normalized_classifications) = 0 then
    raise exception 'Revise nome, funcao e classificacao informados.' using errcode = '23514';
  end if;

  if p_role in ('coordinator', 'specialist') and cardinality(normalized_classifications) > 1 then
    raise exception 'Coordenador e Especialista respondem por uma unica classificacao.' using errcode = '23514';
  end if;

  select coalesce(array_agg(candidate.id order by candidate.first_position), '{}'::uuid[])
  into normalized_ids
  from (
    select selected.id, min(selected.position) first_position
    from unnest(coalesce(p_subordinate_ids, '{}'::uuid[])) with ordinality selected(id, position)
    where selected.id is not null group by selected.id
  ) candidate;

  expected_role := case when p_role = 'executive_manager' then 'manager' when p_role = 'manager' then 'operator' else null end;
  if expected_role is null and cardinality(normalized_ids) > 0 then
    raise exception 'Esta funcao nao possui subordinados diretos.' using errcode = '23514';
  end if;
  if exists (
    select 1 from unnest(normalized_ids) selected(id)
    left join public.user_profiles candidate on candidate.id = selected.id and candidate.enabled
    where candidate.id is null or candidate.id = p_target_user_id
      or (expected_role = 'manager' and candidate.role <> 'manager')
      or (expected_role = 'operator' and candidate.role not in ('coordinator', 'specialist'))
  ) then
    raise exception 'Um ou mais subordinados selecionados nao estao disponiveis.' using errcode = '23514';
  end if;

  if current_profile.role = 'manager' and (p_role <> 'manager' or not p_enabled) then
    delete from public.manager_operator_assignments where manager_member_id = current_profile.organization_member_id;
    update public.user_profiles operator
    set manager_id = (
      select manager.auth_user_id
      from public.manager_operator_assignments assignment
      join public.organization_members manager on manager.id = assignment.manager_member_id and manager.enabled
      where assignment.operator_member_id = operator.organization_member_id
      order by assignment.created_at, manager.id limit 1
    )
    where operator.manager_id = p_target_user_id;
  end if;
  if current_profile.role in ('coordinator', 'specialist') and (p_role not in ('coordinator', 'specialist') or not p_enabled) then
    delete from public.manager_operator_assignments where operator_member_id = current_profile.organization_member_id;
  end if;
  if current_profile.role = 'executive_manager' and (p_role <> 'executive_manager' or not p_enabled) then
    update public.user_profiles set manager_id = null where manager_id = p_target_user_id and role = 'manager';
  end if;

  update public.user_profiles
  set full_name = btrim(p_full_name), role = p_role, enabled = p_enabled,
      manager_id = case when p_role = current_profile.role then current_profile.manager_id else null end,
      sub_id = current_profile.sub_id, coordinator_types = normalized_classifications,
      profile_needs_review = false
  where id = p_target_user_id returning * into saved_profile;

  if p_role = 'executive_manager' then
    update public.user_profiles set manager_id = null
    where manager_id = p_target_user_id and role = 'manager' and not (id = any(normalized_ids));
    update public.user_profiles set manager_id = p_target_user_id where id = any(normalized_ids) and role = 'manager';
  elsif p_role = 'manager' then
    delete from public.manager_operator_assignments assignment
    where assignment.manager_member_id = saved_profile.organization_member_id
      and not exists (
        select 1 from public.user_profiles selected
        where selected.id = any(normalized_ids) and selected.organization_member_id = assignment.operator_member_id
      );

    insert into public.manager_operator_assignments (dataset_id, manager_member_id, operator_member_id)
    select private.real_dataset_id(), saved_profile.organization_member_id, selected.organization_member_id
    from public.user_profiles selected
    where selected.id = any(normalized_ids)
    on conflict do nothing;

    update public.user_profiles operator
    set manager_id = (
      select manager.auth_user_id
      from public.manager_operator_assignments assignment
      join public.organization_members manager on manager.id = assignment.manager_member_id and manager.enabled
      where assignment.operator_member_id = operator.organization_member_id
      order by (manager.auth_user_id = p_target_user_id) desc, assignment.created_at, manager.id limit 1
    )
    where operator.manager_id = p_target_user_id and not (operator.id = any(normalized_ids));

    update public.user_profiles set manager_id = p_target_user_id
    where id = any(normalized_ids) and manager_id is null;
  end if;
  return saved_profile;
end;
$function$;

revoke all on function public.update_site_user_profile(uuid, text, text, boolean, uuid[], text[]) from public, anon;
grant execute on function public.update_site_user_profile(uuid, text, text, boolean, uuid[], text[]) to authenticated;
