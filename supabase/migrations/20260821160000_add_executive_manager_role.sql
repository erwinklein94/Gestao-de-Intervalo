begin;

-- Gerente Executivo has the same organization-wide, read-only scope as Diretor.
-- It is intentionally distinct from the hierarchical Gerente role.
alter table public.user_profiles
  drop constraint if exists user_profiles_role_check;
alter table public.user_profiles
  add constraint user_profiles_role_check
  check (role in (
    'director', 'executive_manager', 'consultant',
    'manager', 'coordinator', 'editor'
  ));

alter table public.organization_members
  drop constraint if exists organization_members_role_check;
alter table public.organization_members
  add constraint organization_members_role_check
  check (role in (
    'director', 'executive_manager', 'consultant',
    'manager', 'coordinator', 'editor'
  ));

alter table public.interval_comments
  drop constraint if exists interval_comments_author_role_check;
alter table public.interval_comments
  add constraint interval_comments_author_role_check
  check (author_role in (
    'director', 'executive_manager', 'consultant',
    'manager', 'coordinator', 'editor'
  ));

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
      when 'executive_manager' then true
      when 'consultant' then true
      when 'manager' then target_manager_id = private.current_member_id()
      when 'coordinator' then target_coordinator_id = private.current_member_id()
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
      when 'executive_manager' then true
      when 'consultant' then true
      when 'manager' then target_member_id = private.current_member_id()
        or (target_role = 'coordinator' and target_manager_id = private.current_member_id())
      when 'coordinator' then target_member_id = private.current_member_id()
        or target_member_id = (
          select manager_id
          from public.organization_members
          where id = private.current_member_id()
        )
      else false
    end,
    false
  );
$$;

revoke all on function private.can_read_plan(uuid, uuid, uuid),
  private.can_read_member(uuid, uuid, uuid, text)
from public, anon, authenticated;
grant execute on function private.can_read_plan(uuid, uuid, uuid),
  private.can_read_member(uuid, uuid, uuid, text)
to authenticated;

insert into public.organization_members (
  dataset_id, code, email, full_name, role, enabled,
  manager_id, sub_id, coordinator_type, profile_needs_review
)
values (
  private.demo_dataset_id(),
  'demo-executive-manager',
  'gerente.executivo@exemplos.invalid',
  'Helena Duarte',
  'executive_manager',
  true,
  null,
  null,
  null,
  false
)
on conflict (dataset_id, code) do update set
  email = excluded.email,
  full_name = excluded.full_name,
  role = excluded.role,
  enabled = excluded.enabled,
  manager_id = excluded.manager_id,
  sub_id = excluded.sub_id,
  coordinator_type = excluded.coordinator_type,
  profile_needs_review = excluded.profile_needs_review;

create or replace function public.list_demo_personas()
returns table (
  id uuid,
  code text,
  full_name text,
  role text,
  manager_id uuid,
  sub_id bigint,
  coordinator_type text
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
         member.manager_id, member.sub_id, member.coordinator_type
  from public.organization_members member
  where member.dataset_id = private.demo_dataset_id()
    and member.enabled
  order by
    case member.role
      when 'editor' then 1
      when 'director' then 2
      when 'executive_manager' then 3
      when 'consultant' then 4
      when 'manager' then 5
      when 'coordinator' then 6
      else 99
    end,
    member.full_name;
end;
$$;

revoke all on function public.list_demo_personas() from public, anon, authenticated;
grant execute on function public.list_demo_personas() to authenticated;

commit;
