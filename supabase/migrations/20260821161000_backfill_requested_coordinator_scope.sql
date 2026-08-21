begin;

-- The requested Coordinator already owned legacy plans created before the
-- organizational hierarchy existed. Enrich only those matching records so the
-- assigned Gerente can see them through the normal scoped RLS rules.
with requested_hierarchy as (
  select
    coordinator.id as coordinator_member_id,
    coordinator.auth_user_id as coordinator_user_id,
    manager.id as manager_member_id,
    coordinator.sub_id,
    coordinator.coordinator_type
  from public.organization_members coordinator
  join auth.users coordinator_auth
    on coordinator_auth.id = coordinator.auth_user_id
  join public.organization_members manager
    on manager.id = coordinator.manager_id
   and manager.dataset_id = coordinator.dataset_id
   and manager.role = 'manager'
   and manager.enabled
  where coordinator.dataset_id = private.real_dataset_id()
    and lower(coordinator_auth.email) = 'raquel.klein@rumolog.com'
    and coordinator.role = 'coordinator'
    and coordinator.enabled
    and coordinator.sub_id is not null
    and coordinator.coordinator_type is not null
)
update public.interval_plans plan
set coordinator_member_id = hierarchy.coordinator_member_id,
    manager_member_id = hierarchy.manager_member_id,
    sub_id = hierarchy.sub_id,
    coordinator_type = hierarchy.coordinator_type
from requested_hierarchy hierarchy
where plan.dataset_id = private.real_dataset_id()
  and (
    plan.coordinator_member_id = hierarchy.coordinator_member_id
    or plan.user_id = hierarchy.coordinator_user_id
  )
  and (
    plan.manager_member_id is null
    or plan.sub_id is null
    or plan.coordinator_type is null
  );

commit;
