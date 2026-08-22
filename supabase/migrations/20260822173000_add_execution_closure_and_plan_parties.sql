-- Dados adicionais do planejamento e encerramento operacional explicito.
alter table public.interval_plans
  add column if not exists contractor_name text not null default '',
  add column if not exists foreman_name text not null default '';

create or replace function private.guard_interval_plan()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  member public.organization_members%rowtype;
  is_finalizing boolean := false;
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
      is_finalizing := new.status = 'completed'
        and new.completed_at is not null
        and private.actual_role() in ('coordinator', 'specialist');
      if is_finalizing then
        if not exists (select 1 from public.interval_steps step where step.plan_id = old.id) then
          raise exception 'Inclua ao menos uma etapa antes de finalizar a execucao.' using errcode = '23514';
        end if;
        if exists (
          select 1 from public.interval_steps step
          where step.plan_id = old.id and step.status not in ('completed', 'skipped')
        ) then
          raise exception 'Todas as etapas devem estar concluidas ou marcadas como nao executadas.' using errcode = '23514';
        end if;
        new.archived_at := old.archived_at;
      else
        new.status := old.status;
        new.completed_at := old.completed_at;
        new.archived_at := old.archived_at;
      end if;
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

  if new.sub_id is not null
     and not exists (select 1 from public.subs where id = new.sub_id and active) then
    raise exception 'Selecione uma SUB ativa.' using errcode = '23514';
  end if;

  new.manager_member_id := member.manager_id;
  new.coordinator_type := member.coordinator_type;
  new.coordinator := member.full_name;
  return new;
end;
$function$;

-- Etapas encerradas deixam o intervalo pronto para finalizar, mas nao o
-- concluem automaticamente. O carimbo de conclusao nasce somente da acao do
-- Coordenador/Coordenadora ou Especialista.
create or replace function private.refresh_interval_statuses(plan_ids uuid[])
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  update public.interval_plans plan
  set status = case
        when plan.completed_at is not null then 'completed'
        when exists (
          select 1 from public.interval_steps step
          where step.plan_id = plan.id
            and step.status in ('running', 'completed', 'skipped')
        ) then 'executing'
        else 'planning'
      end,
      completed_at = plan.completed_at
  where plan.id = any(plan_ids);
end;
$function$;

create or replace function public.finalize_interval_plan(p_plan_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  target public.interval_plans%rowtype;
begin
  if (select auth.uid()) is null then
    raise exception 'Autenticacao obrigatoria.' using errcode = '42501';
  end if;
  if coalesce(private.actual_role() not in ('coordinator', 'specialist'), true) then
    raise exception 'Somente Coordenador, Coordenadora ou Especialista pode finalizar a execucao.' using errcode = '42501';
  end if;

  select * into target
  from public.interval_plans plan
  where plan.id = p_plan_id
    and plan.dataset_id = private.current_dataset_id()
  for update;

  if not found or not private.can_write_plan(target.dataset_id, target.coordinator_member_id) then
    raise exception 'Intervalo fora do escopo de edicao.' using errcode = '42501';
  end if;
  if target.completed_at is not null then
    return jsonb_build_object('plan_id', target.id, 'status', target.status,
      'completed_at', target.completed_at, 'revision', target.revision, 'already_completed', true);
  end if;

  update public.interval_plans
  set status = 'completed', completed_at = now()
  where id = target.id
  returning * into target;

  return jsonb_build_object('plan_id', target.id, 'status', target.status,
    'completed_at', target.completed_at, 'revision', target.revision, 'already_completed', false);
end;
$function$;

revoke all on function public.finalize_interval_plan(uuid) from public, anon;
grant execute on function public.finalize_interval_plan(uuid) to authenticated;

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
  exception when invalid_text_representation then requested_database_id := null;
  end;
  begin
    requested_owner_id := nullif(p_plan->>'user_id', '')::uuid;
  exception when invalid_text_representation then requested_owner_id := null;
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
        contractor_name = coalesce(p_plan->>'contractor_name', ''),
        foreman_name = coalesce(p_plan->>'foreman_name', ''),
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
      user_id, client_id, title, service_type, contractor_name, foreman_name,
      coordinator, interval_date, location, window_start, window_end,
      planning_notes, execution_notes, is_locked, locked_at, dataset_id,
      coordinator_member_id, manager_member_id, sub_id, coordinator_type,
      last_operation_id
    ) values (
      coalesce(requested_owner_id, (select auth.uid())), p_plan->>'client_id',
      coalesce(p_plan->>'title', ''), coalesce(p_plan->>'service_type', ''),
      coalesce(p_plan->>'contractor_name', ''), coalesce(p_plan->>'foreman_name', ''),
      coalesce(p_plan->>'coordinator', ''), nullif(p_plan->>'interval_date', '')::date,
      coalesce(p_plan->>'location', ''), nullif(p_plan->>'window_start', '')::timestamp,
      nullif(p_plan->>'window_end', '')::timestamp, coalesce(p_plan->>'planning_notes', ''),
      coalesce(p_plan->>'execution_notes', ''), coalesce((p_plan->>'is_locked')::boolean, false),
      nullif(p_plan->>'locked_at', '')::timestamptz, private.current_dataset_id(),
      nullif(p_plan->>'coordinator_member_id', '')::uuid,
      nullif(p_plan->>'manager_member_id', '')::uuid,
      nullif(p_plan->>'sub_id', '')::bigint, nullif(p_plan->>'coordinator_type', ''),
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
