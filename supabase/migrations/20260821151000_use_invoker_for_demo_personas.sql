begin;

-- The demo bootstrap client supplies only the demo dataset header. RLS resolves
-- the safe demo Editor fallback, so this RPC no longer needs definer privileges.
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
      when 'editor' then 1 when 'director' then 2 when 'consultant' then 3
      when 'manager' then 4 else 5 end,
    member.full_name;
end;
$$;

revoke all on function public.list_demo_personas() from public, anon;
grant execute on function public.list_demo_personas() to authenticated;

commit;
