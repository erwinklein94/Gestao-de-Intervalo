begin;

create table public.manager_operator_assignments (
  dataset_id uuid not null references public.datasets(id) on delete cascade,
  manager_member_id uuid not null references public.organization_members(id) on delete cascade,
  operator_member_id uuid not null references public.organization_members(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint manager_operator_assignments_pkey primary key (manager_member_id, operator_member_id),
  constraint manager_operator_assignments_distinct_members check (manager_member_id <> operator_member_id)
);

create index manager_operator_assignments_operator_idx
  on public.manager_operator_assignments (operator_member_id, manager_member_id);
create index manager_operator_assignments_dataset_idx
  on public.manager_operator_assignments (dataset_id);

comment on table public.manager_operator_assignments is
  'Relacao muitos-para-muitos: um Coordenador ou Especialista pode estar no escopo de varios Gerentes.';

create or replace function private.validate_manager_operator_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  manager_record public.organization_members%rowtype;
  operator_record public.organization_members%rowtype;
begin
  select * into manager_record from public.organization_members where id = new.manager_member_id;
  select * into operator_record from public.organization_members where id = new.operator_member_id;
  if manager_record.id is null or manager_record.role <> 'manager' or not manager_record.enabled
     or operator_record.id is null or operator_record.role not in ('coordinator', 'specialist') or not operator_record.enabled
     or manager_record.dataset_id <> new.dataset_id or operator_record.dataset_id <> new.dataset_id then
    raise exception 'O vinculo exige Gerente e Coordenador/Especialista ativos no mesmo ambiente.' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger manager_operator_assignments_validate
before insert or update on public.manager_operator_assignments
for each row execute function private.validate_manager_operator_assignment();

insert into public.manager_operator_assignments (dataset_id, manager_member_id, operator_member_id)
select operator.dataset_id, operator.manager_id, operator.id
from public.organization_members operator
join public.organization_members manager
  on manager.id = operator.manager_id
 and manager.dataset_id = operator.dataset_id
 and manager.role = 'manager'
 and manager.enabled
where operator.role in ('coordinator', 'specialist')
  and operator.enabled
on conflict do nothing;

alter table public.manager_operator_assignments enable row level security;

create policy manager_operator_assignments_select
on public.manager_operator_assignments for select to authenticated
using (
  private.actual_is_editor()
  or dataset_id = private.current_dataset_id() and (
    manager_member_id = private.current_member_id()
    or operator_member_id = private.current_member_id()
    or private.current_role() = 'executive_manager' and exists (
      select 1 from public.organization_members manager
      where manager.id = manager_member_id
        and manager.manager_id = private.current_member_id()
        and manager.role = 'manager' and manager.enabled
    )
  )
);

create policy manager_operator_assignments_insert
on public.manager_operator_assignments for insert to authenticated
with check (private.actual_is_editor());

create policy manager_operator_assignments_delete
on public.manager_operator_assignments for delete to authenticated
using (private.actual_is_editor());

grant select, insert, delete on public.manager_operator_assignments to authenticated;

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
        select 1
        from public.manager_operator_assignments assignment
        join public.organization_members manager on manager.id = assignment.manager_member_id
        where assignment.dataset_id = target_dataset_id
          and assignment.operator_member_id = target_coordinator_id
          and manager.manager_id = private.current_member_id()
          and manager.role = 'manager' and manager.enabled
      )
      when 'manager' then exists (
        select 1 from public.manager_operator_assignments assignment
        where assignment.dataset_id = target_dataset_id
          and assignment.manager_member_id = private.current_member_id()
          and assignment.operator_member_id = target_coordinator_id
      )
      when 'coordinator' then target_coordinator_id = private.current_member_id()
      when 'specialist' then target_coordinator_id = private.current_member_id()
      else false
    end,
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
        or (target_role in ('coordinator', 'specialist') and exists (
          select 1
          from public.manager_operator_assignments assignment
          join public.organization_members manager on manager.id = assignment.manager_member_id
          where assignment.dataset_id = target_dataset_id
            and assignment.operator_member_id = target_member_id
            and manager.manager_id = private.current_member_id()
            and manager.role = 'manager' and manager.enabled
        ))
      when 'manager' then target_member_id = private.current_member_id()
        or (target_role in ('coordinator', 'specialist') and exists (
          select 1 from public.manager_operator_assignments assignment
          where assignment.dataset_id = target_dataset_id
            and assignment.manager_member_id = private.current_member_id()
            and assignment.operator_member_id = target_member_id
        ))
      when 'coordinator' then target_member_id = private.current_member_id()
        or (target_role = 'manager' and exists (
          select 1 from public.manager_operator_assignments assignment
          where assignment.dataset_id = target_dataset_id
            and assignment.manager_member_id = target_member_id
            and assignment.operator_member_id = private.current_member_id()
        ))
      when 'specialist' then target_member_id = private.current_member_id()
        or (target_role = 'manager' and exists (
          select 1 from public.manager_operator_assignments assignment
          where assignment.dataset_id = target_dataset_id
            and assignment.manager_member_id = target_member_id
            and assignment.operator_member_id = private.current_member_id()
        ))
      else false
    end,
    false
  );
$$;

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
  select * into current_profile from public.user_profiles where id = p_target_user_id for update;
  if not found then raise exception 'Perfil nao encontrado.' using errcode = 'P0002'; end if;

  if nullif(btrim(p_full_name), '') is null or length(btrim(p_full_name)) > 120
     or p_role not in ('director', 'executive_manager', 'manager', 'consultant', 'coordinator', 'specialist', 'editor')
     or (p_role = 'editor' and current_profile.role <> 'editor')
     or p_classification not in ('infrastructure', 'superstructure', 'modernization') then
    raise exception 'Revise nome, funcao e classificacao informados.' using errcode = '23514';
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
      sub_id = current_profile.sub_id, coordinator_type = p_classification, profile_needs_review = false
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
$$;

revoke all on function private.validate_manager_operator_assignment() from public, anon, authenticated;
revoke all on function private.can_read_plan(uuid, uuid, uuid), private.can_read_member(uuid, uuid, uuid, text)
from public, anon, authenticated;
grant execute on function private.can_read_plan(uuid, uuid, uuid), private.can_read_member(uuid, uuid, uuid, text)
to authenticated;

commit;
