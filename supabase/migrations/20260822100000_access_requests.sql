-- Solicitacao de acesso: um visitante pede conta pela tela de login e um
-- Editor aprova ou recusa.
--
-- A senha escolhida pelo solicitante nunca fica em texto puro: e guardada ja
-- com hash bcrypt e, na aprovacao, esse mesmo hash vai direto para
-- auth.users.encrypted_password. Assim a conta nasce com a senha que a pessoa
-- escolheu sem que ninguem -- nem o Editor, nem quem le a tabela -- consiga
-- recuperar o valor original.

create table public.access_requests (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (btrim(full_name) <> '' and length(full_name) <= 120),
  email text not null check (position('@' in email) > 1 and length(email) <= 254),
  password_hash text not null,
  requested_role text not null check (requested_role = any (array['director', 'executive_manager', 'manager', 'consultant', 'coordinator', 'specialist'])),
  requested_classifications text[] not null
    check (cardinality(requested_classifications) between 1 and 3
       and requested_classifications <@ array['superstructure', 'infrastructure', 'modernization']::text[]),
  message text not null default '',
  status text not null default 'pending' check (status = any (array['pending', 'approved', 'rejected'])),
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  decision_note text not null default '',
  created_user_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);

comment on table public.access_requests is
  'Pedidos de acesso feitos na tela de login, pendentes de decisao de um Editor.';
comment on column public.access_requests.password_hash is
  'Hash bcrypt da senha escolhida pelo solicitante. O valor original nunca e armazenado.';

-- Um pedido em aberto por e-mail; recusados e aprovados ficam no historico.
create unique index access_requests_one_pending_per_email
  on public.access_requests (lower(email)) where status = 'pending';
create index access_requests_pending_first
  on public.access_requests (status, created_at desc);

alter table public.access_requests enable row level security;

-- Nem anon nem authenticated tocam a tabela direto: tudo passa pelas funcoes.
create policy "Editors read access requests" on public.access_requests
  for select using (private.actual_is_editor());

grant select on public.access_requests to authenticated;

---------------------------------------------------------------------------
-- Registro do pedido
---------------------------------------------------------------------------
create or replace function public.request_site_access(
  p_full_name text,
  p_email text,
  p_password text,
  p_role text,
  p_classifications text[],
  p_message text default ''
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  normalized_email text := lower(btrim(p_email));
  normalized_name text := btrim(p_full_name);
  normalized_classifications text[];
  novo_id uuid;
begin
  select coalesce(array_agg(entry order by array_position(
           array['superstructure', 'infrastructure', 'modernization']::text[], entry)), '{}'::text[])
  into normalized_classifications
  from (select distinct unnest(coalesce(p_classifications, '{}'::text[])) as entry) normalizado
  where entry in ('superstructure', 'infrastructure', 'modernization');

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

  -- Mensagem generica de propósito: nao revela a quem pergunta se um e-mail
  -- ja tem conta no sistema.
  if exists (select 1 from auth.users where lower(email) = normalized_email)
     or exists (select 1 from public.access_requests where lower(email) = normalized_email and status = 'pending') then
    return jsonb_build_object('status', 'received');
  end if;

  insert into public.access_requests (
    full_name, email, password_hash, requested_role, requested_classifications, message
  ) values (
    normalized_name, normalized_email,
    extensions.crypt(p_password, extensions.gen_salt('bf')),
    p_role, normalized_classifications,
    left(coalesce(btrim(p_message), ''), 500)
  ) returning id into novo_id;

  return jsonb_build_object('status', 'received', 'request_id', novo_id);
end;
$function$;

revoke all on function public.request_site_access(text, text, text, text, text[], text) from public, anon, authenticated;
grant execute on function public.request_site_access(text, text, text, text, text[], text) to service_role;

---------------------------------------------------------------------------
-- Aprovacao: cria a conta com o hash guardado
---------------------------------------------------------------------------
create or replace function public.approve_access_request(
  p_request_id uuid,
  p_role text default null,
  p_classifications text[] default null
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  pedido public.access_requests%rowtype;
  papel text;
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

  -- O Editor pode corrigir funcao e classificacao antes de aprovar.
  papel := coalesce(nullif(btrim(coalesce(p_role, '')), ''), pedido.requested_role);
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

  -- A senha escolhida no pedido continua valendo: reaproveita o hash.
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

  -- private.handle_new_user ja criou o perfil; aqui ele recebe o que foi aprovado.
  update public.user_profiles set
    full_name = pedido.full_name,
    role = papel,
    enabled = true,
    profile_needs_review = false,
    coordinator_types = classificacoes
  where id = novo_usuario;

  update public.access_requests set
    status = 'approved',
    decided_by = (select auth.uid()),
    decided_at = now(),
    created_user_id = novo_usuario,
    -- O hash deixa de ser necessario assim que a conta existe.
    password_hash = ''
  where id = p_request_id;

  return jsonb_build_object('status', 'approved', 'user_id', novo_usuario, 'email', pedido.email);
end;
$function$;

revoke all on function public.approve_access_request(uuid, text, text[]) from public, anon;
grant execute on function public.approve_access_request(uuid, text, text[]) to authenticated;

---------------------------------------------------------------------------
-- Recusa
---------------------------------------------------------------------------
create or replace function public.reject_access_request(
  p_request_id uuid,
  p_note text default ''
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  pedido public.access_requests%rowtype;
begin
  if not private.actual_is_editor() then
    raise exception 'Apenas Editores podem decidir solicitacoes.' using errcode = '42501';
  end if;

  select * into pedido from public.access_requests where id = p_request_id for update;
  if not found then raise exception 'Solicitacao nao encontrada.' using errcode = 'P0002'; end if;
  if pedido.status <> 'pending' then
    raise exception 'Esta solicitacao ja foi decidida.' using errcode = '23514';
  end if;

  update public.access_requests set
    status = 'rejected',
    decided_by = (select auth.uid()),
    decided_at = now(),
    decision_note = left(coalesce(btrim(p_note), ''), 500),
    -- Recusado nao vira conta: o hash nao serve mais para nada.
    password_hash = ''
  where id = p_request_id;

  return jsonb_build_object('status', 'rejected');
end;
$function$;

revoke all on function public.reject_access_request(uuid, text) from public, anon;
grant execute on function public.reject_access_request(uuid, text) to authenticated;
