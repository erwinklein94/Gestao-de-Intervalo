-- Run as an administrator on a database containing a real plan and an enabled
-- editor. No user data is committed: every call must fail before applying data,
-- and the surrounding transaction is rolled back as a second safeguard.
begin;
set local statement_timeout = '5s';

do $test$
declare
  editor_id uuid;
  plan_id uuid;
  receipt public.interval_sync_receipts%rowtype;
begin
  select id into strict editor_id from public.user_profiles
  where enabled and role = 'editor' order by id limit 1;
  select id into strict plan_id from public.interval_plans
  where dataset_id = private.real_dataset_id() order by id limit 1;
  select r.* into strict receipt from public.interval_sync_receipts r
  join public.user_profiles p on p.id = r.actor_id
  where p.enabled and p.role in ('editor', 'manager', 'coordinator', 'specialist')
  order by r.applied_at desc limit 1;

  perform set_config('request.jwt.claims', jsonb_build_object('sub', editor_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.sync_interval_plan(jsonb_build_object('database_id', plan_id),
      '[]'::jsonb, -1, gen_random_uuid(), 'conflict-regression-test');
    raise exception 'FAIL: stale revision was accepted';
  exception when sqlstate 'PT409' then
    if sqlerrm not like 'SYNC_CONFLICT:%' then raise; end if;
  end;

  reset role;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', receipt.actor_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.sync_interval_plan(jsonb_build_object('regression_test', gen_random_uuid()),
      '[]'::jsonb, receipt.base_revision, receipt.operation_id, receipt.device_id);
    raise exception 'FAIL: changed idempotent payload was accepted';
  exception when sqlstate 'PT409' then
    if sqlerrm <> 'SYNC_OPERATION_PAYLOAD_MISMATCH' then raise; end if;
  end;
  reset role;
end;
$test$;

rollback;
