-- Remocao completa do conceito de SUB.
--
-- A SUB entrou como recorte territorial herdado do mapa e nunca chegou a ser
-- usada na operacao: nao aparece em filtro, card, relatorio nem indicador, e o
-- frontend ja parou de envia-la. Ela so sobrevivia como cadastro paralelo que
-- o Editor precisava manter e como uma trava a mais no planejamento.
--
-- Esta migracao APAGA o catalogo das 103 SUBs e as atribuicoes por Coordenador.
-- Nao ha caminho de volta por migracao: para reverter seria preciso recarregar
-- o catalogo do documento de origem.
--
-- As funcoes abaixo sao reescritas apenas para deixarem de citar sub_id, a
-- partir das versoes que estao em producao hoje. Corpo de plpgsql nao e
-- verificado no momento em que a coluna cai: sem esta reescrita, guard e sync
-- quebrariam so na hora em que alguem salvasse um intervalo.

-- Espelhamento do perfil em organization_members, agora sem sub_id.
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
     and new.role_gender is not distinct from old.role_gender
     and new.enabled is not distinct from old.enabled
     and new.manager_id is not distinct from old.manager_id
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
    dataset_id, code, auth_user_id, email, full_name, role, role_gender, enabled,
    manager_id, coordinator_types, profile_needs_review, created_at, updated_at
  ) values (
    private.real_dataset_id(), 'auth-' || new.id::text, new.id, new.email,
    new.full_name, new.role, new.role_gender, new.enabled, manager_member_id,
    new.coordinator_types, new.profile_needs_review, new.created_at, new.updated_at
  )
  on conflict (dataset_id, auth_user_id) do update set
    email = excluded.email,
    full_name = excluded.full_name,
    role = excluded.role,
    role_gender = excluded.role_gender,
    enabled = excluded.enabled,
    manager_id = excluded.manager_id,
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

-- Edicao de perfil pelo Editor, agora sem carregar a SUB anterior.
create or replace function public.update_site_user_profile(
  p_target_user_id uuid,
  p_full_name text,
  p_role text,
  p_enabled boolean,
  p_subordinate_ids uuid[],
  p_classifications text[],
  p_role_gender text default null
) returns public.user_profiles
language plpgsql
security definer
set search_path to ''
as $function$
declare
  normalized_ids uuid[] := '{}'::uuid[];
  normalized_classifications text[] := '{}'::text[];
  normalized_gender text := nullif(btrim(coalesce(p_role_gender, '')), '');
  current_profile public.user_profiles%rowtype;
  saved_profile public.user_profiles%rowtype;
  expected_role text;
begin
  if not private.actual_is_editor() then
    raise exception 'Apenas Editores podem atualizar perfis.' using errcode = '42501';
  end if;
  select * into current_profile from public.user_profiles where id = p_target_user_id for update;
  if not found then raise exception 'Perfil nao encontrado.' using errcode = 'P0002'; end if;

  if normalized_gender is not null and normalized_gender not in ('masculine', 'feminine') then
    raise exception 'Tratamento invalido.' using errcode = '23514';
  end if;

  select coalesce(array_agg(entry order by array_position(
           array['superstructure', 'infrastructure', 'modernization']::text[], entry)), '{}'::text[])
  into normalized_classifications
  from (select distinct unnest(coalesce(p_classifications, '{}'::text[])) as entry) normalized
  where entry in ('superstructure', 'infrastructure', 'modernization');

  if p_role = 'editor' then
    normalized_classifications := '{}'::text[];
  end if;

  if nullif(btrim(p_full_name), '') is null or length(btrim(p_full_name)) > 120
     or p_role not in ('director', 'executive_manager', 'manager', 'consultant', 'coordinator', 'specialist', 'editor')
     or (p_role = 'editor' and current_profile.role <> 'editor')
     or (p_role <> 'editor' and cardinality(normalized_classifications) = 0) then
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
      role_gender = normalized_gender,
      manager_id = case when p_role = current_profile.role then current_profile.manager_id else null end,
      coordinator_types = normalized_classifications,
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

-- Guard do intervalo sem a validacao de SUB. Mantem a finalizacao
-- explicita e o escopo de Gerente introduzidos nas migracoes anteriores.
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
        and private.actual_role() in ('manager', 'coordinator', 'specialist');
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

  if private.actual_role() in ('manager', 'coordinator', 'specialist') then
    select * into member
    from public.organization_members
    where id = private.actual_member_id()
      and dataset_id = new.dataset_id
      and role = private.actual_role()
      and enabled;
    if not found then
      raise exception 'Perfil operacional sem cadastro ativo no ambiente.' using errcode = '42501';
    end if;
    new.user_id := (select auth.uid());
    new.coordinator_member_id := member.id;
  elsif private.actual_role() = 'editor' and new.coordinator_member_id is not null then
    select * into member
    from public.organization_members
    where id = new.coordinator_member_id
      and dataset_id = new.dataset_id
      and role in ('manager', 'coordinator', 'specialist')
      and enabled;
    if not found then
      raise exception 'Selecione um Gerente, Coordenador ou Especialista ativo do mesmo ambiente.' using errcode = '23514';
    end if;
    new.user_id := coalesce(member.auth_user_id, new.user_id);
  elsif private.actual_role() <> 'editor' then
    raise exception 'Perfil sem permissao para editar intervalos.' using errcode = '42501';
  end if;


  new.manager_member_id := case when member.role = 'manager' then member.id else member.manager_id end;
  new.coordinator_type := member.coordinator_type;
  new.coordinator := member.full_name;
  return new;
end;
$function$;

-- Sincronizacao sem sub_id, preservando empreiteira e encarregado.
create or replace function public.sync_interval_plan(
  p_plan jsonb, p_steps jsonb, p_expected_revision bigint,
  p_operation_id uuid, p_device_id text
)
returns jsonb
language plpgsql
security invoker
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
  if coalesce(private.actual_role() not in ('manager', 'coordinator', 'specialist', 'editor'), true)
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
        coordinator_type = nullif(p_plan->>'coordinator_type', ''),
        last_operation_id = p_operation_id
    where id = target_id
    returning revision into target_revision;
  else
    insert into public.interval_plans (
      user_id, client_id, title, service_type, contractor_name, foreman_name,
      coordinator, interval_date, location, window_start, window_end,
      planning_notes, execution_notes, is_locked, locked_at, dataset_id,
      coordinator_member_id, manager_member_id, coordinator_type,
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

-- O gatilho que espelhava a SUB principal do Coordenador perde a razao de ser.
drop trigger if exists user_profiles_sync_primary_coordinator_sub on public.user_profiles;
drop function if exists private.sync_primary_coordinator_sub_assignment();

-- Colunas e tabelas. As politicas RLS, indices e chaves estrangeiras caem
-- junto com os objetos que as sustentam.
alter table public.interval_plans drop column if exists sub_id;
alter table public.user_profiles drop column if exists sub_id;
alter table public.organization_members drop column if exists sub_id;

drop table if exists public.coordinator_sub_assignments;
drop table if exists public.subs;
