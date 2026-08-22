create or replace function public.sync_interval_plan(
  p_plan jsonb, p_steps jsonb, p_expected_revision bigint,
  p_operation_id uuid, p_device_id text
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
begin
  if (select auth.uid()) is null then
    raise exception 'Autenticacao obrigatoria.' using errcode = '42501';
  end if;
  if coalesce(private.actual_role() not in ('coordinator', 'specialist', 'editor'), true)
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
  exception when invalid_text_representation then
    requested_database_id := null;
  end;
  begin
    requested_owner_id := nullif(p_plan->>'user_id', '')::uuid;
  exception when invalid_text_representation then
    requested_owner_id := null;
  end;

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
        coordinator = coalesce(p_plan->>'coordinator', ''),
        interval_date = nullif(p_plan->>'interval_date', '')::date,
        location = coalesce(p_plan->>'location', ''),
        window_start = nullif(p_plan->>'window_start', '')::timestamp,
        window_end = nullif(p_plan->>'window_end', '')::timestamp,
        planning_notes = coalesce(p_plan->>'planning_notes', ''),
        execution_notes = coalesce(p_plan->>'execution_notes', ''),
        is_locked = coalesce((p_plan->>'is_locked')::boolean, false),
        locked_at = nullif(p_plan->>'locked_at', '')::timestamptz,
        coordinator_member_id = nullif(p_plan->>'coordinator_member_id', '')::uuid,
        manager_member_id = nullif(p_plan->>'manager_member_id', '')::uuid,
        sub_id = nullif(p_plan->>'sub_id', '')::bigint,
        coordinator_type = nullif(p_plan->>'coordinator_type', ''),
        last_operation_id = p_operation_id
    where id = target_id
    returning revision into target_revision;
  else
    insert into public.interval_plans (
      user_id, client_id, title, service_type, coordinator, interval_date,
      location, window_start, window_end, planning_notes, execution_notes,
      is_locked, locked_at, dataset_id, coordinator_member_id,
      manager_member_id, sub_id, coordinator_type, last_operation_id
    ) values (
      coalesce(requested_owner_id, (select auth.uid())),
      p_plan->>'client_id',
      coalesce(p_plan->>'title', ''),
      coalesce(p_plan->>'service_type', ''),
      coalesce(p_plan->>'coordinator', ''),
      nullif(p_plan->>'interval_date', '')::date,
      coalesce(p_plan->>'location', ''),
      nullif(p_plan->>'window_start', '')::timestamp,
      nullif(p_plan->>'window_end', '')::timestamp,
      coalesce(p_plan->>'planning_notes', ''),
      coalesce(p_plan->>'execution_notes', ''),
      coalesce((p_plan->>'is_locked')::boolean, false),
      nullif(p_plan->>'locked_at', '')::timestamptz,
      private.current_dataset_id(),
      nullif(p_plan->>'coordinator_member_id', '')::uuid,
      nullif(p_plan->>'manager_member_id', '')::uuid,
      nullif(p_plan->>'sub_id', '')::bigint,
      nullif(p_plan->>'coordinator_type', ''),
      p_operation_id
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
  select
    target_id,
    step->>'client_id',
    (ordinality - 1)::integer,
    coalesce(step->>'activity_name', ''),
    nullif(step->>'planned_start', '')::timestamp,
    nullif(step->>'planned_end', '')::timestamp,
    nullif(step->>'actual_start', '')::timestamp,
    nullif(step->>'actual_end', '')::timestamp,
    coalesce(step->>'actual_notes', ''),
    coalesce(nullif(step->>'status', ''), 'pending'),
    coalesce(step->>'skip_reason', ''),
    p_operation_id
  from jsonb_array_elements(coalesce(p_steps, '[]'::jsonb)) with ordinality as rows(step, ordinality);

  select revision, status into target_revision, target_status
  from public.interval_plans where id = target_id;

  return jsonb_build_object('plan_id', target_id, 'revision', target_revision,
    'status', target_status, 'replayed', false);
end;
$function$;
