-- Flexao de genero no nome da funcao: Diretor/Diretora, Coordenador/Coordenadora.
--
-- O campo guarda a forma do tratamento, nao um dado sensivel de identidade: e
-- exatamente o que decide como o cargo aparece escrito na tela.
--
-- Fica anulavel de proposito. Os 35 perfis ja cadastrados nao tem essa
-- informacao, e assumir 'feminine' ou 'masculine' para todos erraria com
-- alguem. Nulo significa "nao informado" e cai na forma masculina, que e como
-- o sistema ja exibia -- entao nada muda ate alguem preencher.
--
-- user_profiles concede privilegio por coluna a authenticated; sem os grants
-- abaixo a coluna nasce invisivel e a RPC de edicao falha inteira.

alter table public.user_profiles
  add column role_gender text check (role_gender is null or role_gender in ('masculine', 'feminine'));
alter table public.organization_members
  add column role_gender text check (role_gender is null or role_gender in ('masculine', 'feminine'));
alter table public.access_requests
  add column requested_role_gender text check (requested_role_gender is null or requested_role_gender in ('masculine', 'feminine'));

comment on column public.user_profiles.role_gender is
  'Forma do nome da funcao: masculine ou feminine. Nulo cai na forma masculina.';

grant update (role_gender) on public.user_profiles to authenticated;
grant select (role_gender) on public.organization_members to authenticated;

-- Propaga para organization_members junto com o resto do perfil.
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
    dataset_id, code, auth_user_id, email, full_name, role, role_gender, enabled,
    manager_id, sub_id, coordinator_types, profile_needs_review, created_at, updated_at
  ) values (
    private.real_dataset_id(), 'auth-' || new.id::text, new.id, new.email,
    new.full_name, new.role, new.role_gender, new.enabled, manager_member_id, new.sub_id,
    new.coordinator_types, new.profile_needs_review, new.created_at, new.updated_at
  )
  on conflict (dataset_id, auth_user_id) do update set
    email = excluded.email,
    full_name = excluded.full_name,
    role = excluded.role,
    role_gender = excluded.role_gender,
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

-- A edicao de perfil passa a receber o genero.
drop function if exists public.update_site_user_profile(uuid, text, text, boolean, uuid[], text[]);

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

revoke all on function public.update_site_user_profile(uuid, text, text, boolean, uuid[], text[], text) from public, anon;
grant execute on function public.update_site_user_profile(uuid, text, text, boolean, uuid[], text[], text) to authenticated;

-- A solicitacao de acesso tambem carrega o tratamento escolhido.
create or replace function public.request_site_access(
  p_full_name text,
  p_email text,
  p_password text,
  p_role text,
  p_classifications text[],
  p_message text default '',
  p_role_gender text default null
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  normalized_email text := lower(btrim(p_email));
  normalized_name text := btrim(p_full_name);
  normalized_gender text := nullif(btrim(coalesce(p_role_gender, '')), '');
  normalized_classifications text[];
  novo_id uuid;
begin
  select coalesce(array_agg(entry order by array_position(
           array['superstructure', 'infrastructure', 'modernization']::text[], entry)), '{}'::text[])
  into normalized_classifications
  from (select distinct unnest(coalesce(p_classifications, '{}'::text[])) as entry) normalizado
  where entry in ('superstructure', 'infrastructure', 'modernization');

  if normalized_gender is not null and normalized_gender not in ('masculine', 'feminine') then
    normalized_gender := null;
  end if;

  if normalized_name = '' or length(normalized_name) > 120
     or normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     or length(p_password) < 8 or length(p_password) > 256
     or p_role not in ('director', 'executive_manager', 'manager', 'consultant', 'coordinator', 'specialist')
     or cardinality(normalized_classifications) = 0 then
    raise exception 'Revise os dados informados.' using errcode = '23514';
  end if;

  if p_role in ('coordinator', 'specialist') and cardinality(normalized_classifications) > 1 then
    raise exception 'Coordenador e Especialista respondem por uma unica classificacao.' using errcode = '23514';
  end if;

  if exists (select 1 from auth.users where lower(email) = normalized_email)
     or exists (select 1 from public.access_requests where lower(email) = normalized_email and status = 'pending') then
    return jsonb_build_object('status', 'received');
  end if;

  insert into public.access_requests (
    full_name, email, password_hash, requested_role, requested_role_gender,
    requested_classifications, message
  ) values (
    normalized_name, normalized_email,
    extensions.crypt(p_password, extensions.gen_salt('bf')),
    p_role, normalized_gender, normalized_classifications,
    left(coalesce(btrim(p_message), ''), 500)
  ) returning id into novo_id;

  return jsonb_build_object('status', 'received', 'request_id', novo_id);
end;
$function$;

revoke all on function public.request_site_access(text, text, text, text, text[], text, text) from public, anon, authenticated;
grant execute on function public.request_site_access(text, text, text, text, text[], text, text) to service_role;
drop function if exists public.request_site_access(text, text, text, text, text[], text);

-- A aprovacao leva o tratamento do pedido para o perfil criado.
create or replace function public.approve_access_request(
  p_request_id uuid,
  p_role text default null,
  p_classifications text[] default null,
  p_role_gender text default null
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  pedido public.access_requests%rowtype;
  papel text;
  tratamento text;
  classificacoes text[];
  novo_usuario uuid := gen_random_uuid();
begin
  if not private.actual_is_editor() then
    raise exception 'Apenas Editores podem decidir solicitacoes.' using errcode = '42501';
  end if;

  select * into pedido from public.access_requests where id = p_request_id for update;
  if not found then raise exception 'Solicitacao nao encontrada.' using errcode = 'P0002'; end if;
  if pedido.status <> 'pending' then
    raise exception 'Esta solicitacao ja foi decidida.' using errcode = '23514';
  end if;

  papel := coalesce(nullif(btrim(coalesce(p_role, '')), ''), pedido.requested_role);
  tratamento := coalesce(nullif(btrim(coalesce(p_role_gender, '')), ''), pedido.requested_role_gender);
  if tratamento is not null and tratamento not in ('masculine', 'feminine') then tratamento := null; end if;

  select coalesce(array_agg(entry order by array_position(
           array['superstructure', 'infrastructure', 'modernization']::text[], entry)), '{}'::text[])
  into classificacoes
  from (select distinct unnest(coalesce(p_classifications, pedido.requested_classifications)) as entry) normalizado
  where entry in ('superstructure', 'infrastructure', 'modernization');

  if papel not in ('director', 'executive_manager', 'manager', 'consultant', 'coordinator', 'specialist')
     or cardinality(classificacoes) = 0 then
    raise exception 'Revise funcao e classificacao antes de aprovar.' using errcode = '23514';
  end if;
  if papel in ('coordinator', 'specialist') and cardinality(classificacoes) > 1 then
    raise exception 'Coordenador e Especialista respondem por uma unica classificacao.' using errcode = '23514';
  end if;

  if exists (select 1 from auth.users where lower(email) = lower(pedido.email)) then
    raise exception 'Ja existe uma conta com este e-mail.' using errcode = '23505';
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000', novo_usuario, 'authenticated', 'authenticated',
    pedido.email, pedido.password_hash, now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('full_name', pedido.full_name), now(), now()
  );
  insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  values (
    novo_usuario::text, novo_usuario,
    jsonb_build_object('sub', novo_usuario::text, 'email', pedido.email, 'email_verified', false, 'phone_verified', false),
    'email', now(), now()
  );

  update public.user_profiles set
    full_name = pedido.full_name,
    role = papel,
    role_gender = tratamento,
    enabled = true,
    profile_needs_review = false,
    coordinator_types = classificacoes
  where id = novo_usuario;

  update public.access_requests set
    status = 'approved',
    decided_by = (select auth.uid()),
    decided_at = now(),
    created_user_id = novo_usuario,
    password_hash = ''
  where id = p_request_id;

  return jsonb_build_object('status', 'approved', 'user_id', novo_usuario, 'email', pedido.email);
end;
$function$;

revoke all on function public.approve_access_request(uuid, text, text[], text) from public, anon;
grant execute on function public.approve_access_request(uuid, text, text[], text) to authenticated;
drop function if exists public.approve_access_request(uuid, text, text[]);

-- O comentario guarda a funcao do autor como registro historico. Sem o
-- tratamento junto, uma Coordenadora apareceria como Coordenador na trilha.
alter table public.interval_comments
  add column author_role_gender text
    check (author_role_gender is null or author_role_gender in ('masculine', 'feminine'));

comment on column public.interval_comments.author_role_gender is
  'Tratamento do autor no momento do comentario. Nulo cai na forma masculina.';
