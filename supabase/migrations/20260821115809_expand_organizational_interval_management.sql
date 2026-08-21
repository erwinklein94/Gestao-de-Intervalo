begin;

-- Expansion is intentionally additive. Legacy columns remain available until every
-- existing profile and interval has been reviewed by an Editor.

create table if not exists public.subs (
  id bigint generated always as identity primary key,
  code text not null unique,
  name text not null,
  operation text,
  sort_order integer not null default 0,
  active boolean not null default true,
  source_document text not null default 'Mapa Rumo 2020-V9',
  source_page integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subs_code_not_blank check (btrim(code) <> ''),
  constraint subs_name_not_blank check (btrim(name) <> ''),
  constraint subs_source_page_positive check (source_page > 0)
);

insert into public.subs (code, name, sort_order, source_document, source_page)
select
  'SUB ' || lpad(number::text, 2, '0'),
  'SUB ' || lpad(number::text, 2, '0'),
  number,
  'Mapa Rumo 2020-V9 - base SIV atualizada em JAN-2020 (mapa em revisao)',
  1
from generate_series(1, 103) as number
on conflict (code) do nothing;

create table if not exists public.datasets (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  kind text not null check (kind in ('real', 'demo')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint datasets_code_not_blank check (btrim(code) <> ''),
  constraint datasets_name_not_blank check (btrim(name) <> '')
);

insert into public.datasets (code, name, kind)
values
  ('real', 'Operacao real', 'real'),
  ('demo', 'Ambiente de exemplos', 'demo')
on conflict (code) do nothing;

create or replace function private.real_dataset_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from public.datasets where code = 'real' and active limit 1;
$$;

create or replace function private.demo_dataset_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from public.datasets where code = 'demo' and active limit 1;
$$;

-- Expand the account profile without invalidating the two legacy Coordinators.
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = 'public.user_profiles'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%role%'
  loop
    execute format('alter table public.user_profiles drop constraint %I', constraint_name);
  end loop;
end;
$$;

alter table public.user_profiles
  add column if not exists manager_id uuid,
  add column if not exists sub_id bigint,
  add column if not exists coordinator_type text,
  add column if not exists profile_needs_review boolean not null default false,
  add column if not exists organization_member_id uuid;

update public.user_profiles
set role = 'coordinator', profile_needs_review = true
where role = 'user';

alter table public.user_profiles alter column role set default 'coordinator';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_profiles'::regclass
      and conname = 'user_profiles_role_check'
  ) then
    alter table public.user_profiles
      add constraint user_profiles_role_check
      check (role in ('director', 'consultant', 'manager', 'coordinator', 'editor'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_profiles'::regclass
      and conname = 'user_profiles_coordinator_type_check'
  ) then
    alter table public.user_profiles
      add constraint user_profiles_coordinator_type_check
      check (coordinator_type is null or coordinator_type in ('infrastructure', 'superstructure'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_profiles'::regclass
      and conname = 'user_profiles_coordinator_registration_check'
  ) then
    alter table public.user_profiles
      add constraint user_profiles_coordinator_registration_check
      check (
        role <> 'coordinator'
        or profile_needs_review
        or (manager_id is not null and sub_id is not null and coordinator_type is not null)
      );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_profiles'::regclass
      and conname = 'user_profiles_manager_not_self_check'
  ) then
    alter table public.user_profiles
      add constraint user_profiles_manager_not_self_check
      check (manager_id is null or manager_id <> id);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_profiles'::regclass
      and conname = 'user_profiles_manager_id_fkey'
  ) then
    alter table public.user_profiles
      add constraint user_profiles_manager_id_fkey
      foreign key (manager_id) references public.user_profiles(id) on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_profiles'::regclass
      and conname = 'user_profiles_sub_id_fkey'
  ) then
    alter table public.user_profiles
      add constraint user_profiles_sub_id_fkey
      foreign key (sub_id) references public.subs(id) on delete restrict;
  end if;
end;
$$;

create index if not exists user_profiles_manager_idx
  on public.user_profiles (manager_id) where manager_id is not null;
create index if not exists user_profiles_sub_idx
  on public.user_profiles (sub_id) where sub_id is not null;
create index if not exists user_profiles_organization_member_idx
  on public.user_profiles (organization_member_id) where organization_member_id is not null;

create table if not exists public.organization_members (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references public.datasets(id) on delete restrict,
  code text not null,
  auth_user_id uuid references auth.users(id) on delete restrict,
  email text,
  full_name text not null default '',
  role text not null check (role in ('director', 'consultant', 'manager', 'coordinator', 'editor')),
  enabled boolean not null default true,
  manager_id uuid,
  sub_id bigint references public.subs(id) on delete restrict,
  coordinator_type text check (coordinator_type is null or coordinator_type in ('infrastructure', 'superstructure')),
  profile_needs_review boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_members_dataset_code_key unique (dataset_id, code),
  constraint organization_members_dataset_auth_key unique (dataset_id, auth_user_id),
  constraint organization_members_dataset_id_id_key unique (dataset_id, id),
  constraint organization_members_manager_fkey
    foreign key (dataset_id, manager_id)
    references public.organization_members(dataset_id, id)
    on delete restrict,
  constraint organization_members_manager_not_self_check check (manager_id is null or manager_id <> id),
  constraint organization_members_coordinator_registration_check check (
    role <> 'coordinator'
    or profile_needs_review
    or (manager_id is not null and sub_id is not null and coordinator_type is not null)
  )
);

create index if not exists organization_members_dataset_role_idx
  on public.organization_members (dataset_id, role, enabled);
create index if not exists organization_members_manager_idx
  on public.organization_members (dataset_id, manager_id) where manager_id is not null;
create index if not exists organization_members_sub_idx
  on public.organization_members (sub_id) where sub_id is not null;
create index if not exists organization_members_auth_user_idx
  on public.organization_members (auth_user_id) where auth_user_id is not null;

drop trigger if exists subs_set_updated_at on public.subs;
create trigger subs_set_updated_at before update on public.subs
for each row execute function public.set_updated_at();

drop trigger if exists datasets_set_updated_at on public.datasets;
create trigger datasets_set_updated_at before update on public.datasets
for each row execute function public.set_updated_at();

drop trigger if exists organization_members_set_updated_at on public.organization_members;
create trigger organization_members_set_updated_at before update on public.organization_members
for each row execute function public.set_updated_at();

insert into public.organization_members (
  dataset_id, code, auth_user_id, email, full_name, role, enabled,
  sub_id, coordinator_type, profile_needs_review, created_at, updated_at
)
select
  private.real_dataset_id(),
  'auth-' || profile.id::text,
  profile.id,
  profile.email,
  profile.full_name,
  profile.role,
  profile.enabled,
  profile.sub_id,
  profile.coordinator_type,
  profile.profile_needs_review,
  profile.created_at,
  profile.updated_at
from public.user_profiles profile
on conflict (dataset_id, auth_user_id) do update set
  email = excluded.email,
  full_name = excluded.full_name,
  role = excluded.role,
  enabled = excluded.enabled,
  sub_id = excluded.sub_id,
  coordinator_type = excluded.coordinator_type,
  profile_needs_review = excluded.profile_needs_review,
  updated_at = excluded.updated_at;

update public.organization_members member
set manager_id = manager_member.id
from public.user_profiles profile
join public.organization_members manager_member
  on manager_member.dataset_id = private.real_dataset_id()
 and manager_member.auth_user_id = profile.manager_id
where member.dataset_id = private.real_dataset_id()
  and member.auth_user_id = profile.id
  and profile.manager_id is not null;

update public.user_profiles profile
set organization_member_id = member.id
from public.organization_members member
where member.dataset_id = private.real_dataset_id()
  and member.auth_user_id = profile.id
  and profile.organization_member_id is distinct from member.id;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_profiles'::regclass
      and conname = 'user_profiles_organization_member_id_fkey'
  ) then
    alter table public.user_profiles
      add constraint user_profiles_organization_member_id_fkey
      foreign key (organization_member_id)
      references public.organization_members(id)
      on delete restrict;
  end if;
end;
$$;

create or replace function private.sync_user_profile_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  member_id uuid;
  manager_member_id uuid;
begin
  -- The recursive UPDATE below only fills organization_member_id. Ignore that
  -- exact follow-up without suppressing INSERTs originating in auth.users.
  if tg_op = 'UPDATE'
     and new.email is not distinct from old.email
     and new.full_name is not distinct from old.full_name
     and new.role is not distinct from old.role
     and new.enabled is not distinct from old.enabled
     and new.manager_id is not distinct from old.manager_id
     and new.sub_id is not distinct from old.sub_id
     and new.coordinator_type is not distinct from old.coordinator_type
     and new.profile_needs_review is not distinct from old.profile_needs_review then
    return new;
  end if;

  if new.manager_id is not null then
    select id into manager_member_id
    from public.organization_members
    where dataset_id = private.real_dataset_id()
      and auth_user_id = new.manager_id
      and role = 'manager'
      and enabled;
  end if;

  insert into public.organization_members (
    dataset_id, code, auth_user_id, email, full_name, role, enabled,
    manager_id, sub_id, coordinator_type, profile_needs_review, created_at, updated_at
  )
  values (
    private.real_dataset_id(), 'auth-' || new.id::text, new.id, new.email,
    new.full_name, new.role, new.enabled, manager_member_id, new.sub_id,
    new.coordinator_type, new.profile_needs_review, new.created_at, new.updated_at
  )
  on conflict (dataset_id, auth_user_id) do update set
    email = excluded.email,
    full_name = excluded.full_name,
    role = excluded.role,
    enabled = excluded.enabled,
    manager_id = excluded.manager_id,
    sub_id = excluded.sub_id,
    coordinator_type = excluded.coordinator_type,
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
$$;

create or replace function private.validate_user_profile_hierarchy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role = 'coordinator' and not new.profile_needs_review then
    if new.manager_id is null or new.sub_id is null or new.coordinator_type is null then
      raise exception 'Coordenador exige Gerente, SUB e classificacao.' using errcode = '23514';
    end if;
    if not exists (
      select 1 from public.user_profiles manager
      where manager.id = new.manager_id and manager.role = 'manager' and manager.enabled
    ) then
      raise exception 'O Gerente informado nao existe ou esta desabilitado.' using errcode = '23514';
    end if;
    if not exists (select 1 from public.subs where id = new.sub_id and active) then
      raise exception 'A SUB informada nao existe ou esta inativa.' using errcode = '23514';
    end if;
  elsif new.role <> 'coordinator'
    and (new.manager_id is not null or new.sub_id is not null or new.coordinator_type is not null) then
    raise exception 'Somente Coordenadores possuem Gerente, SUB e classificacao.' using errcode = '23514';
  end if;

  if tg_op = 'UPDATE'
     and old.role = 'manager'
     and (new.role <> 'manager' or not new.enabled)
     and exists (
       select 1 from public.user_profiles coordinator
       where coordinator.manager_id = old.id
         and coordinator.role = 'coordinator'
         and coordinator.enabled
     ) then
    raise exception 'Reatribua os Coordenadores ativos antes de alterar ou desabilitar este Gerente.' using errcode = '23503';
  end if;
  if tg_op = 'UPDATE'
     and old.role = 'editor' and old.enabled
     and (new.role <> 'editor' or not new.enabled)
     and not exists (
       select 1 from public.user_profiles editor
       where editor.id <> old.id and editor.role = 'editor' and editor.enabled
     ) then
    raise exception 'O sistema deve manter ao menos um Editor habilitado.' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists user_profiles_validate_hierarchy on public.user_profiles;
create trigger user_profiles_validate_hierarchy
before insert or update on public.user_profiles
for each row execute function private.validate_user_profile_hierarchy();

drop trigger if exists user_profiles_sync_organization_member on public.user_profiles;
create trigger user_profiles_sync_organization_member
after insert or update on public.user_profiles
for each row execute function private.sync_user_profile_member();

-- Demo personas are organizational records, never Auth accounts. Seed the
-- non-Coordinators first so every Coordinator can satisfy the required manager
-- relationship in the same INSERT that creates the record.
insert into public.organization_members (
  dataset_id, code, email, full_name, role, enabled, sub_id,
  coordinator_type, profile_needs_review
)
select
  private.demo_dataset_id(), valueset.code, valueset.email, valueset.full_name,
  valueset.role, true, subs.id, valueset.coordinator_type, false
from (
  values
    ('demo-editor', 'editor@exemplos.invalid', 'Marina Costa', 'editor', null::text, null::text),
    ('demo-director', 'diretor@exemplos.invalid', 'Roberto Almeida', 'director', null, null),
    ('demo-consultant', 'consultor@exemplos.invalid', 'Carolina Nunes', 'consultant', null, null),
    ('demo-manager-north', 'gerente.norte@exemplos.invalid', 'Carlos Mendes', 'manager', null, null),
    ('demo-manager-south', 'gerente.sul@exemplos.invalid', 'Fernanda Lima', 'manager', null, null)
) as valueset(code, email, full_name, role, sub_code, coordinator_type)
left join public.subs subs on subs.code = valueset.sub_code
on conflict (dataset_id, code) do nothing;

insert into public.organization_members (
  dataset_id, code, email, full_name, role, enabled, manager_id, sub_id,
  coordinator_type, profile_needs_review
)
select
  private.demo_dataset_id(), valueset.code, valueset.email, valueset.full_name,
  'coordinator', true, manager.id, subs.id, valueset.coordinator_type, false
from (
  values
    ('demo-coord-infra-north', 'coord.infra.norte@exemplos.invalid', 'Ana Ribeiro', 'demo-manager-north', 'SUB 74', 'infrastructure'),
    ('demo-coord-super-north', 'coord.super.norte@exemplos.invalid', 'Bruno Tavares', 'demo-manager-north', 'SUB 81', 'superstructure'),
    ('demo-coord-infra-south', 'coord.infra.sul@exemplos.invalid', 'Luciana Prado', 'demo-manager-south', 'SUB 12', 'infrastructure'),
    ('demo-coord-super-south', 'coord.super.sul@exemplos.invalid', 'Diego Martins', 'demo-manager-south', 'SUB 29', 'superstructure')
) as valueset(code, email, full_name, manager_code, sub_code, coordinator_type)
join public.organization_members manager
  on manager.dataset_id = private.demo_dataset_id()
 and manager.code = valueset.manager_code
join public.subs subs on subs.code = valueset.sub_code
on conflict (dataset_id, code) do nothing;

-- Keep user_profiles as the Auth-facing account record while the organizational
-- member is the canonical hierarchy and demo-persona record.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  is_bootstrap_editor boolean;
begin
  is_bootstrap_editor := lower(coalesce(new.email, '')) = 'erwin.klein@ext.rumolog.com';
  insert into public.user_profiles (
    id, email, full_name, role, enabled, profile_needs_review
  ) values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    case when is_bootstrap_editor then 'editor' else 'coordinator' end,
    is_bootstrap_editor,
    not is_bootstrap_editor
  );
  return new;
end;
$$;

alter table public.interval_plans
  add column if not exists dataset_id uuid,
  add column if not exists coordinator_member_id uuid,
  add column if not exists manager_member_id uuid,
  add column if not exists sub_id bigint,
  add column if not exists coordinator_type text,
  add column if not exists status text not null default 'planning',
  add column if not exists completed_at timestamptz,
  add column if not exists archived_at timestamptz,
  add column if not exists revision bigint not null default 0,
  add column if not exists last_operation_id uuid;

update public.interval_plans
set dataset_id = case when is_example then private.demo_dataset_id() else private.real_dataset_id() end
where dataset_id is null;

update public.interval_plans plan
set coordinator_member_id = member.id,
    manager_member_id = member.manager_id,
    sub_id = member.sub_id,
    coordinator_type = member.coordinator_type
from public.organization_members member
where plan.dataset_id = private.real_dataset_id()
  and member.dataset_id = plan.dataset_id
  and member.auth_user_id = plan.user_id
  and plan.coordinator_member_id is null;

update public.interval_plans plan
set coordinator_member_id = member.id,
    manager_member_id = member.manager_id,
    sub_id = member.sub_id,
    coordinator_type = member.coordinator_type
from public.organization_members member
where plan.dataset_id = private.demo_dataset_id()
  and member.dataset_id = plan.dataset_id
  and member.code = 'demo-coord-infra-north'
  and plan.coordinator_member_id is null;

update public.interval_plans plan
set status = case
  when exists (select 1 from public.interval_steps step where step.plan_id = plan.id)
   and not exists (
     select 1 from public.interval_steps step
     where step.plan_id = plan.id
       and step.actual_end is null
       and step.actual_notes not like '[[ETAPA_NAO_EXECUTADA]]%'
   ) then 'completed'
  when exists (
    select 1 from public.interval_steps step
    where step.plan_id = plan.id
      and (step.actual_start is not null or step.actual_end is not null or btrim(step.actual_notes) <> '')
  ) then 'executing'
  else 'planning'
end,
completed_at = case
  when exists (select 1 from public.interval_steps step where step.plan_id = plan.id)
   and not exists (
     select 1 from public.interval_steps step
     where step.plan_id = plan.id
       and step.actual_end is null
       and step.actual_notes not like '[[ETAPA_NAO_EXECUTADA]]%'
   ) then coalesce(plan.completed_at, plan.updated_at)
  else plan.completed_at
end;

alter table public.interval_plans
  alter column dataset_id set default private.real_dataset_id(),
  alter column dataset_id set not null,
  alter column user_id drop not null;

alter table public.interval_plans drop constraint if exists interval_plans_user_id_fkey;
alter table public.interval_plans
  add constraint interval_plans_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete restrict;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.interval_plans'::regclass
      and conname = 'interval_plans_dataset_id_fkey'
  ) then
    alter table public.interval_plans
      add constraint interval_plans_dataset_id_fkey
      foreign key (dataset_id) references public.datasets(id) on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.interval_plans'::regclass
      and conname = 'interval_plans_coordinator_member_fkey'
  ) then
    alter table public.interval_plans
      add constraint interval_plans_coordinator_member_fkey
      foreign key (dataset_id, coordinator_member_id)
      references public.organization_members(dataset_id, id) on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.interval_plans'::regclass
      and conname = 'interval_plans_manager_member_fkey'
  ) then
    alter table public.interval_plans
      add constraint interval_plans_manager_member_fkey
      foreign key (dataset_id, manager_member_id)
      references public.organization_members(dataset_id, id) on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.interval_plans'::regclass
      and conname = 'interval_plans_sub_id_fkey'
  ) then
    alter table public.interval_plans
      add constraint interval_plans_sub_id_fkey
      foreign key (sub_id) references public.subs(id) on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.interval_plans'::regclass
      and conname = 'interval_plans_status_check'
  ) then
    alter table public.interval_plans
      add constraint interval_plans_status_check
      check (status in ('planning', 'executing', 'completed', 'cancelled'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.interval_plans'::regclass
      and conname = 'interval_plans_coordinator_type_check'
  ) then
    alter table public.interval_plans
      add constraint interval_plans_coordinator_type_check
      check (coordinator_type is null or coordinator_type in ('infrastructure', 'superstructure'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.interval_plans'::regclass
      and conname = 'interval_plans_revision_check'
  ) then
    alter table public.interval_plans
      add constraint interval_plans_revision_check check (revision >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.interval_plans'::regclass
      and conname = 'interval_plans_real_owner_check'
  ) then
    alter table public.interval_plans
      add constraint interval_plans_real_owner_check check (is_example or user_id is not null);
  end if;
end;
$$;

create index if not exists interval_plans_dataset_status_date_idx
  on public.interval_plans (dataset_id, status, interval_date desc);
create index if not exists interval_plans_dataset_manager_idx
  on public.interval_plans (dataset_id, manager_member_id, updated_at desc)
  where manager_member_id is not null;
create index if not exists interval_plans_dataset_coordinator_idx
  on public.interval_plans (dataset_id, coordinator_member_id, updated_at desc)
  where coordinator_member_id is not null;
create index if not exists interval_plans_sub_idx
  on public.interval_plans (sub_id) where sub_id is not null;
create unique index if not exists interval_plans_demo_client_key
  on public.interval_plans (dataset_id, client_id) where is_example;

alter table public.interval_steps
  add column if not exists status text not null default 'pending',
  add column if not exists skip_reason text not null default '',
  add column if not exists revision bigint not null default 0,
  add column if not exists last_operation_id uuid;

update public.interval_steps
set status = case
      when actual_notes like '[[ETAPA_NAO_EXECUTADA]]%' then 'skipped'
      when actual_end is not null then 'completed'
      when actual_start is not null then 'running'
      else 'pending'
    end,
    skip_reason = case
      when actual_notes like '[[ETAPA_NAO_EXECUTADA]]%'
        then regexp_replace(split_part(actual_notes, E'\n', 1), '^\[\[ETAPA_NAO_EXECUTADA\]\]\s*', '')
      else ''
    end;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.interval_steps'::regclass
      and conname = 'interval_steps_status_check'
  ) then
    alter table public.interval_steps
      add constraint interval_steps_status_check
      check (status in ('pending', 'running', 'completed', 'skipped'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.interval_steps'::regclass
      and conname = 'interval_steps_revision_check'
  ) then
    alter table public.interval_steps
      add constraint interval_steps_revision_check check (revision >= 0);
  end if;
end;
$$;

create table if not exists public.interval_comments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  dataset_id uuid not null references public.datasets(id) on delete restrict,
  plan_id uuid not null references public.interval_plans(id) on delete restrict,
  author_user_id uuid references auth.users(id) on delete restrict,
  author_member_id uuid references public.organization_members(id) on delete restrict,
  author_name text not null,
  author_role text not null check (author_role in ('director', 'consultant', 'manager', 'coordinator', 'editor')),
  content text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint interval_comments_content_length check (char_length(btrim(content)) between 1 and 2000),
  constraint interval_comments_author_check check (author_user_id is not null or author_member_id is not null),
  constraint interval_comments_client_key unique (plan_id, author_user_id, client_id)
);

create index if not exists interval_comments_plan_created_idx
  on public.interval_comments (plan_id, created_at);
create index if not exists interval_comments_author_idx
  on public.interval_comments (author_user_id, created_at desc);
create index if not exists interval_comments_dataset_idx
  on public.interval_comments (dataset_id, created_at desc);
create index if not exists interval_comments_author_member_idx
  on public.interval_comments (author_member_id) where author_member_id is not null;

create table if not exists public.interval_sync_receipts (
  id bigint generated always as identity primary key,
  actor_id uuid not null references auth.users(id) on delete restrict,
  device_id text not null,
  operation_id uuid not null,
  plan_id uuid not null references public.interval_plans(id) on delete cascade,
  payload_hash text not null check (length(payload_hash) = 64),
  base_revision bigint not null,
  applied_revision bigint not null,
  applied_at timestamptz not null default now(),
  constraint interval_sync_receipts_operation_key unique (actor_id, device_id, operation_id),
  constraint interval_sync_receipts_device_length check (char_length(device_id) between 8 and 120)
);

create index if not exists interval_sync_receipts_plan_idx
  on public.interval_sync_receipts (plan_id, applied_at desc);

create table if not exists public.interval_audit_log (
  id bigint generated always as identity primary key,
  dataset_id uuid not null references public.datasets(id) on delete restrict,
  plan_id uuid references public.interval_plans(id) on delete set null,
  entity_type text not null,
  entity_id text not null,
  action text not null,
  actor_id uuid references auth.users(id) on delete set null,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);

create index if not exists interval_audit_plan_created_idx
  on public.interval_audit_log (plan_id, created_at desc)
  where plan_id is not null;
create index if not exists interval_audit_dataset_created_idx
  on public.interval_audit_log (dataset_id, created_at desc);

-- Trusted authorization helpers. The dataset/persona headers are honored only
-- for a real, enabled Editor; all other sessions are always bound to real data.
create or replace function private.request_header(header_name text)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    (nullif(current_setting('request.headers', true), '')::jsonb ->> lower(header_name)),
    ''
  );
$$;

create or replace function private.actual_member_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select member.id
  from public.organization_members member
  where member.dataset_id = private.real_dataset_id()
    and member.auth_user_id = (select auth.uid())
    and member.enabled
  limit 1;
$$;

create or replace function private.actual_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select member.role
  from public.organization_members member
  where member.id = private.actual_member_id();
$$;

create or replace function private.actual_is_editor()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.actual_role() = 'editor', false);
$$;

create or replace function private.actual_manager_auth_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select manager.auth_user_id
  from public.organization_members member
  join public.organization_members manager
    on manager.dataset_id = member.dataset_id
   and manager.id = member.manager_id
  where member.id = private.actual_member_id()
    and manager.enabled
  limit 1;
$$;

create or replace function private.current_dataset_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when private.actual_is_editor()
     and lower(private.request_header('x-dataset-context')) = 'demo'
      then private.demo_dataset_id()
    else private.real_dataset_id()
  end;
$$;

create or replace function private.current_member_id()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  requested_id uuid;
  resolved_id uuid;
begin
  if private.current_dataset_id() = private.real_dataset_id() then
    return private.actual_member_id();
  end if;

  begin
    requested_id := nullif(private.request_header('x-demo-persona-id'), '')::uuid;
  exception when invalid_text_representation then
    requested_id := null;
  end;

  if requested_id is not null then
    select id into resolved_id
    from public.organization_members
    where id = requested_id
      and dataset_id = private.demo_dataset_id()
      and enabled;
  end if;

  if resolved_id is null then
    select id into resolved_id
    from public.organization_members
    where dataset_id = private.demo_dataset_id()
      and code = 'demo-editor'
      and enabled
    limit 1;
  end if;
  return resolved_id;
end;
$$;

create or replace function private.current_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select member.role
  from public.organization_members member
  where member.id = private.current_member_id()
    and member.dataset_id = private.current_dataset_id()
    and member.enabled;
$$;

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
      when 'manager' then target_manager_id = private.current_member_id()
      when 'coordinator' then target_coordinator_id = private.current_member_id()
      else false
    end,
    false
  );
$$;

create or replace function private.can_write_plan(
  target_dataset_id uuid,
  target_coordinator_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    target_dataset_id = private.real_dataset_id()
    and target_dataset_id = private.current_dataset_id()
    and (
      private.actual_role() = 'editor'
      or (
        private.actual_role() = 'coordinator'
        and target_coordinator_id = private.actual_member_id()
      )
    ),
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
      when 'manager' then target_member_id = private.current_member_id()
        or (target_role = 'coordinator' and target_manager_id = private.current_member_id())
      when 'coordinator' then target_member_id = private.current_member_id()
        or target_member_id = (
          select manager_id from public.organization_members
          where id = private.current_member_id()
        )
      else false
    end,
    false
  );
$$;

create or replace function private.plan_is_mutable(target_plan_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    private.can_write_plan(plan.dataset_id, plan.coordinator_member_id)
    and (private.actual_role() = 'editor' or plan.completed_at is null),
    false
  )
  from public.interval_plans plan
  where plan.id = target_plan_id;
$$;

create or replace function private.interval_accepts_comments(target_plan_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    plan.dataset_id = private.real_dataset_id()
    and private.can_read_plan(plan.dataset_id, plan.coordinator_member_id, plan.manager_member_id)
    and plan.status = 'executing'
    and plan.completed_at is null,
    false
  )
  from public.interval_plans plan
  where plan.id = target_plan_id;
$$;

create or replace function private.guard_interval_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  member public.organization_members%rowtype;
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  -- Migrations and trusted service-role maintenance do not carry an Auth UID.
  -- RLS already separates browser clients; this branch keeps controlled seeds
  -- and administrative maintenance from being rejected by the browser guard.
  if (select auth.uid()) is null then
    new.revision := case when tg_op = 'UPDATE' then old.revision + 1 else greatest(coalesce(new.revision, 0), 1) end;
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.dataset_id := private.current_dataset_id();
    new.is_example := new.dataset_id = private.demo_dataset_id();
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
    new.is_example := old.is_example;
    new.created_at := old.created_at;
    new.revision := old.revision + 1;
    if old.completed_at is not null then
      new.status := 'completed';
      new.completed_at := old.completed_at;
      new.archived_at := old.archived_at;
    elsif private.actual_role() <> 'editor' then
      new.status := old.status;
      new.completed_at := old.completed_at;
      new.archived_at := old.archived_at;
    end if;
  end if;

  if private.actual_role() = 'coordinator' then
    select * into member
    from public.organization_members
    where id = private.actual_member_id();
    new.user_id := (select auth.uid());
    new.coordinator_member_id := member.id;
    new.manager_member_id := member.manager_id;
    new.sub_id := member.sub_id;
    new.coordinator_type := member.coordinator_type;
    new.coordinator := member.full_name;
  elsif private.actual_role() = 'editor' and new.coordinator_member_id is not null then
    select * into member
    from public.organization_members
    where id = new.coordinator_member_id
      and dataset_id = new.dataset_id
      and role = 'coordinator'
      and enabled;
    if not found then
      raise exception 'Selecione um Coordenador ativo do mesmo ambiente.' using errcode = '23514';
    end if;
    new.manager_member_id := member.manager_id;
    new.sub_id := member.sub_id;
    new.coordinator_type := member.coordinator_type;
    new.coordinator := member.full_name;
    new.user_id := coalesce(member.auth_user_id, new.user_id);
  elsif private.actual_role() <> 'editor' then
    raise exception 'Perfil sem permissao para editar intervalos.' using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists interval_plans_guard on public.interval_plans;
create trigger interval_plans_guard
before insert or update on public.interval_plans
for each row execute function private.guard_interval_plan();

create or replace function private.guard_interval_step()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    if tg_op = 'DELETE' then
      return old;
    end if;
    new.revision := case when tg_op = 'UPDATE' then old.revision + 1 else greatest(coalesce(new.revision, 0), 1) end;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if not private.plan_is_mutable(old.plan_id) then
      raise exception 'Etapas de intervalo concluido ou fora do escopo nao podem ser removidas.' using errcode = '42501';
    end if;
    return old;
  end if;

  if not private.plan_is_mutable(new.plan_id) then
    raise exception 'Etapa fora do escopo de edicao.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    new.plan_id := old.plan_id;
    new.client_id := old.client_id;
    new.created_at := old.created_at;
    new.revision := old.revision + 1;
  else
    new.revision := greatest(coalesce(new.revision, 0), 1);
  end if;

  if new.actual_notes like '[[ETAPA_NAO_EXECUTADA]]%' then
    new.status := 'skipped';
  elsif new.actual_end is not null then
    new.status := 'completed';
  elsif new.actual_start is not null then
    new.status := 'running';
  else
    new.status := 'pending';
  end if;
  return new;
end;
$$;

drop trigger if exists interval_steps_guard_insert_update on public.interval_steps;
drop trigger if exists interval_steps_guard_delete on public.interval_steps;
create trigger interval_steps_guard_insert_update
before insert or update on public.interval_steps
for each row execute function private.guard_interval_step();
create trigger interval_steps_guard_delete
before delete on public.interval_steps
for each row execute function private.guard_interval_step();

create or replace function private.refresh_interval_statuses(plan_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.interval_plans plan
  set status = case
        when plan.completed_at is not null then 'completed'
        when exists (select 1 from public.interval_steps step where step.plan_id = plan.id)
         and not exists (
           select 1 from public.interval_steps step
           where step.plan_id = plan.id
             and step.status not in ('completed', 'skipped')
         ) then 'completed'
        when exists (
          select 1 from public.interval_steps step
          where step.plan_id = plan.id
            and step.status in ('running', 'completed', 'skipped')
        ) then 'executing'
        else 'planning'
      end,
      completed_at = case
        when plan.completed_at is not null then plan.completed_at
        when exists (select 1 from public.interval_steps step where step.plan_id = plan.id)
         and not exists (
           select 1 from public.interval_steps step
           where step.plan_id = plan.id
             and step.status not in ('completed', 'skipped')
         ) then now()
        else null
      end
  where plan.id = any(plan_ids);
end;
$$;

create or replace function private.refresh_interval_statuses_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.refresh_interval_statuses(array(select distinct plan_id from inserted_rows));
  return null;
end;
$$;

create or replace function private.refresh_interval_statuses_after_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.refresh_interval_statuses(array(
    select distinct plan_id from (
      select plan_id from updated_rows
      union all
      select plan_id from previous_rows
    ) rows
  ));
  return null;
end;
$$;

create or replace function private.refresh_interval_statuses_after_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.refresh_interval_statuses(array(select distinct plan_id from deleted_rows));
  return null;
end;
$$;

drop trigger if exists interval_steps_refresh_status_insert on public.interval_steps;
drop trigger if exists interval_steps_refresh_status_update on public.interval_steps;
drop trigger if exists interval_steps_refresh_status_delete on public.interval_steps;
create trigger interval_steps_refresh_status_insert
after insert on public.interval_steps
referencing new table as inserted_rows
for each statement execute function private.refresh_interval_statuses_after_insert();
create trigger interval_steps_refresh_status_update
after update on public.interval_steps
referencing old table as previous_rows new table as updated_rows
for each statement execute function private.refresh_interval_statuses_after_update();
create trigger interval_steps_refresh_status_delete
after delete on public.interval_steps
referencing old table as deleted_rows
for each statement execute function private.refresh_interval_statuses_after_delete();

create or replace function private.guard_interval_comment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  member public.organization_members%rowtype;
  plan_dataset uuid;
begin
  if (select auth.uid()) is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if not private.interval_accepts_comments(new.plan_id) then
      raise exception 'Comentarios so podem ser adicionados durante a execucao.' using errcode = '42501';
    end if;
    select dataset_id into plan_dataset from public.interval_plans where id = new.plan_id;
    select * into member from public.organization_members where id = private.current_member_id();
    new.dataset_id := plan_dataset;
    new.author_user_id := (select auth.uid());
    new.author_member_id := member.id;
    new.author_name := member.full_name;
    new.author_role := member.role;
    new.created_at := now();
    new.deleted_at := null;
    return new;
  end if;

  if old.author_user_id <> (select auth.uid()) then
    raise exception 'Somente o autor pode remover o comentario.' using errcode = '42501';
  end if;
  new.id := old.id;
  new.client_id := old.client_id;
  new.dataset_id := old.dataset_id;
  new.plan_id := old.plan_id;
  new.author_user_id := old.author_user_id;
  new.author_member_id := old.author_member_id;
  new.author_name := old.author_name;
  new.author_role := old.author_role;
  new.content := old.content;
  new.created_at := old.created_at;

  if old.deleted_at is not null then
    new.deleted_at := old.deleted_at;
  elsif new.deleted_at is not null and not private.interval_accepts_comments(old.plan_id) then
    raise exception 'Comentario encerrado faz parte permanente do historico.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists interval_comments_guard on public.interval_comments;
create trigger interval_comments_guard
before insert or update on public.interval_comments
for each row execute function private.guard_interval_comment();

create or replace function private.audit_interval_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_id uuid;
  row_dataset uuid;
begin
  if tg_op = 'DELETE' then
    row_id := old.id;
    row_dataset := old.dataset_id;
  else
    row_id := new.id;
    row_dataset := new.dataset_id;
  end if;
  insert into public.interval_audit_log (
    dataset_id, plan_id, entity_type, entity_id, action, actor_id, old_data, new_data
  ) values (
    row_dataset,
    case when tg_op = 'DELETE' then null else row_id end,
    'interval_plan',
    row_id::text,
    lower(tg_op),
    (select auth.uid()),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists interval_plans_audit on public.interval_plans;
create trigger interval_plans_audit
after insert or update or delete on public.interval_plans
for each row execute function private.audit_interval_plan();

create or replace function private.audit_interval_comment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- This trigger is currently registered only for INSERT/UPDATE. Keeping the
  -- branch explicit makes a future DELETE audit safe as well.
  if tg_op = 'DELETE' then
    insert into public.interval_audit_log (
      dataset_id, plan_id, entity_type, entity_id, action, actor_id, old_data
    ) values (
      old.dataset_id, old.plan_id, 'interval_comment', old.id::text,
      'delete', (select auth.uid()), to_jsonb(old)
    );
    return old;
  end if;

  insert into public.interval_audit_log (
    dataset_id, plan_id, entity_type, entity_id, action, actor_id, old_data, new_data
  ) values (
    new.dataset_id,
    new.plan_id,
    'interval_comment',
    new.id::text,
    case when tg_op = 'UPDATE' and old.deleted_at is null and new.deleted_at is not null then 'soft_delete' else lower(tg_op) end,
    (select auth.uid()),
    case when tg_op = 'UPDATE' then jsonb_build_object('deleted_at', old.deleted_at) else null end,
    jsonb_build_object(
      'author_member_id', new.author_member_id,
      'created_at', new.created_at,
      'deleted_at', new.deleted_at
    )
  );
  return new;
end;
$$;

drop trigger if exists interval_comments_audit on public.interval_comments;
create trigger interval_comments_audit
after insert or update on public.interval_comments
for each row execute function private.audit_interval_comment();

-- Replace owner-only policies with organizational scope and dataset isolation.
drop policy if exists "Enabled users read own interval plans" on public.interval_plans;
drop policy if exists "Enabled users create permitted interval plans" on public.interval_plans;
drop policy if exists "Enabled users update permitted interval plans" on public.interval_plans;
drop policy if exists "Enabled users delete own interval plans" on public.interval_plans;

create policy "Authorized members read scoped interval plans"
on public.interval_plans for select to authenticated
using (private.can_read_plan(dataset_id, coordinator_member_id, manager_member_id));

create policy "Coordinators and editors create interval plans"
on public.interval_plans for insert to authenticated
with check (private.can_write_plan(dataset_id, coordinator_member_id));

create policy "Coordinators and editors update mutable interval plans"
on public.interval_plans for update to authenticated
using (private.can_write_plan(dataset_id, coordinator_member_id))
with check (private.can_write_plan(dataset_id, coordinator_member_id));

create policy "Editors or coordinators delete drafts"
on public.interval_plans for delete to authenticated
using (
  private.can_write_plan(dataset_id, coordinator_member_id)
  and status = 'planning'
  and completed_at is null
);

drop policy if exists "Users read steps from own plans" on public.interval_steps;
drop policy if exists "Users create steps in own plans" on public.interval_steps;
drop policy if exists "Users update steps in own plans" on public.interval_steps;
drop policy if exists "Users delete steps from own plans" on public.interval_steps;

create policy "Authorized members read scoped interval steps"
on public.interval_steps for select to authenticated
using (
  exists (
    select 1 from public.interval_plans plan
    where plan.id = interval_steps.plan_id
      and private.can_read_plan(plan.dataset_id, plan.coordinator_member_id, plan.manager_member_id)
  )
);

create policy "Coordinators and editors create mutable interval steps"
on public.interval_steps for insert to authenticated
with check (private.plan_is_mutable(plan_id));
create policy "Coordinators and editors update mutable interval steps"
on public.interval_steps for update to authenticated
using (private.plan_is_mutable(plan_id))
with check (private.plan_is_mutable(plan_id));
create policy "Coordinators and editors delete mutable interval steps"
on public.interval_steps for delete to authenticated
using (private.plan_is_mutable(plan_id));

drop policy if exists "Users read own profile" on public.user_profiles;
drop policy if exists "Editors update profiles" on public.user_profiles;

create policy "Users read account profiles within scope"
on public.user_profiles for select to authenticated
using (
  id = (select auth.uid())
  or private.actual_is_editor()
);

create policy "Editors update account profiles"
on public.user_profiles for update to authenticated
using (private.actual_is_editor())
with check (private.actual_is_editor());

drop policy if exists "Enabled owners read own share links" on public.interval_share_links;
drop policy if exists "Enabled owners create share links" on public.interval_share_links;
drop policy if exists "Enabled owners update own share links" on public.interval_share_links;
drop policy if exists "Enabled owners delete own share links" on public.interval_share_links;

create policy "Authorized owners read real share links"
on public.interval_share_links for select to authenticated
using (
  owner_id = (select auth.uid())
  and exists (
    select 1 from public.interval_plans plan
    where plan.id = interval_share_links.plan_id
      and plan.dataset_id = private.real_dataset_id()
      and private.can_write_plan(plan.dataset_id, plan.coordinator_member_id)
  )
);
create policy "Authorized owners create real share links"
on public.interval_share_links for insert to authenticated
with check (
  owner_id = (select auth.uid())
  and exists (
    select 1 from public.interval_plans plan
    where plan.id = interval_share_links.plan_id
      and plan.dataset_id = private.real_dataset_id()
      and private.can_write_plan(plan.dataset_id, plan.coordinator_member_id)
  )
);
create policy "Authorized owners update real share links"
on public.interval_share_links for update to authenticated
using (owner_id = (select auth.uid()))
with check (
  owner_id = (select auth.uid())
  and exists (
    select 1 from public.interval_plans plan
    where plan.id = interval_share_links.plan_id
      and plan.dataset_id = private.real_dataset_id()
      and private.can_write_plan(plan.dataset_id, plan.coordinator_member_id)
  )
);
create policy "Authorized owners delete real share links"
on public.interval_share_links for delete to authenticated
using (
  owner_id = (select auth.uid())
  and exists (
    select 1 from public.interval_plans plan
    where plan.id = interval_share_links.plan_id
      and plan.dataset_id = private.real_dataset_id()
      and private.can_write_plan(plan.dataset_id, plan.coordinator_member_id)
  )
);

alter table public.datasets enable row level security;
alter table public.subs enable row level security;
alter table public.organization_members enable row level security;
alter table public.interval_comments enable row level security;
alter table public.interval_sync_receipts enable row level security;
alter table public.interval_audit_log enable row level security;

create policy "Members read active dataset"
on public.datasets for select to authenticated
using (id = private.current_dataset_id() or private.actual_is_editor());

create policy "Enabled users read SUBs"
on public.subs for select to authenticated
using (private.actual_member_id() is not null);
create policy "Editors create SUBs"
on public.subs for insert to authenticated
with check (private.actual_is_editor());
create policy "Editors update SUBs"
on public.subs for update to authenticated
using (private.actual_is_editor())
with check (private.actual_is_editor());

create policy "Members read organizational directory within scope"
on public.organization_members for select to authenticated
using (private.can_read_member(dataset_id, id, manager_id, role));

create policy "Authorized members read interval comments"
on public.interval_comments for select to authenticated
using (
  exists (
    select 1 from public.interval_plans plan
    where plan.id = interval_comments.plan_id
      and private.can_read_plan(plan.dataset_id, plan.coordinator_member_id, plan.manager_member_id)
  )
);
create policy "Authorized members comment during execution"
on public.interval_comments for insert to authenticated
with check (private.interval_accepts_comments(plan_id));
create policy "Authors update own comment tombstone"
on public.interval_comments for update to authenticated
using (author_user_id = (select auth.uid()))
with check (author_user_id = (select auth.uid()));

create policy "Actors read own synchronization receipts"
on public.interval_sync_receipts for select to authenticated
using (actor_id = (select auth.uid()));
create policy "Actors create own synchronization receipts"
on public.interval_sync_receipts for insert to authenticated
with check (
  actor_id = (select auth.uid())
  and private.plan_is_mutable(plan_id)
);

create policy "Authorized members read interval audit"
on public.interval_audit_log for select to authenticated
using (
  (plan_id is not null and exists (
    select 1 from public.interval_plans plan
    where plan.id = interval_audit_log.plan_id
      and private.can_read_plan(plan.dataset_id, plan.coordinator_member_id, plan.manager_member_id)
  ))
  or (plan_id is null and private.actual_is_editor())
);

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
security definer
set search_path = ''
as $$
begin
  if not private.actual_is_editor() then
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

create or replace function public.sync_interval_plan(
  p_plan jsonb,
  p_steps jsonb,
  p_expected_revision bigint,
  p_operation_id uuid,
  p_device_id text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
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
  if coalesce(private.actual_role() not in ('coordinator', 'editor'), true)
     or private.current_dataset_id() is distinct from private.real_dataset_id() then
    raise exception 'Perfil ou ambiente sem permissao para sincronizar intervalos.' using errcode = '42501';
  end if;
  if p_operation_id is null or char_length(coalesce(p_device_id, '')) not between 8 and 120 then
    raise exception 'Identificacao de sincronizacao invalida.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    (select auth.uid())::text || ':' || p_device_id || ':' || p_operation_id::text,
    0
  ));

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
    return jsonb_build_object(
      'plan_id', existing_receipt.plan_id,
      'revision', existing_receipt.applied_revision,
      'replayed', true
    );
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
    where plan.id = requested_database_id
      and plan.dataset_id = private.current_dataset_id()
    for update;
  else
    select plan.id, plan.revision into target_id, target_revision
    from public.interval_plans plan
    where plan.dataset_id = private.current_dataset_id()
      and plan.client_id = p_plan->>'client_id'
      and plan.user_id = coalesce(requested_owner_id, (select auth.uid()))
    limit 1
    for update;
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
        window_start = nullif(p_plan->>'window_start', '')::time,
        window_end = nullif(p_plan->>'window_end', '')::time,
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
      nullif(p_plan->>'window_start', '')::time,
      nullif(p_plan->>'window_end', '')::time,
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
    nullif(step->>'planned_start', '')::time,
    nullif(step->>'planned_end', '')::time,
    nullif(step->>'actual_start', '')::time,
    nullif(step->>'actual_end', '')::time,
    coalesce(step->>'actual_notes', ''),
    coalesce(nullif(step->>'status', ''), 'pending'),
    coalesce(step->>'skip_reason', ''),
    p_operation_id
  from jsonb_array_elements(coalesce(p_steps, '[]'::jsonb)) with ordinality as rows(step, ordinality);

  select revision, status into target_revision, target_status
  from public.interval_plans where id = target_id;

  return jsonb_build_object(
    'plan_id', target_id,
    'revision', target_revision,
    'status', target_status,
    'replayed', false
  );
end;
$$;

-- Demonstration dataset: stable client identifiers plus relational lookups avoid
-- hard-coded generated database IDs and keep the data isolated from real metrics.
insert into public.interval_plans (
  user_id, client_id, title, service_type, coordinator, interval_date, location,
  window_start, window_end, planning_notes, execution_notes, is_locked, locked_at,
  is_example, dataset_id, coordinator_member_id, manager_member_id, sub_id,
  coordinator_type, status
)
select
  null::uuid,
  examples.client_id,
  examples.title,
  examples.service_type,
  coordinator.full_name,
  current_date + examples.day_offset,
  examples.location,
  examples.window_start::time,
  examples.window_end::time,
  examples.planning_notes,
  examples.execution_notes,
  true,
  now(),
  true,
  private.demo_dataset_id(),
  coordinator.id,
  coordinator.manager_id,
  coordinator.sub_id,
  coordinator.coordinator_type,
  examples.status
from (
  values
    ('demo-interval-01', 'Renovacao de linha - km 497+900', 'Renovacao de linha', 'demo-coord-infra-north', 0, 'Alto Araguaia - TAG', '08:00', '12:00', 'Frentes, equipamentos e protecao confirmados.', 'Execucao com restricao operacional no acesso norte.', 'executing'),
    ('demo-interval-02', 'Inspecao estrutural da ponte ferroviaria', 'Inspecao de obra de arte', 'demo-coord-super-north', 0, 'Aparecida do Taboado - TAP', '07:30', '11:00', 'Equipe de estruturas e acesso por plataforma.', 'Execucao adiantada e sem interferencias.', 'executing'),
    ('demo-interval-03', 'Drenagem profunda do trecho litoraneo', 'Drenagem', 'demo-coord-infra-south', 0, 'Morretes - LMR', '09:00', '13:00', 'Bombas, tubos e janela de descarte validados.', 'Atividade principal em andamento.', 'executing'),
    ('demo-interval-04', 'Reforco de talude e contencao', 'Contencao', 'demo-coord-super-south', 1, 'Santa Rosa - NSR', '10:00', '14:00', 'Plano pronto para confirmacao de campo.', '', 'planning'),
    ('demo-interval-05', 'Socaria mecanizada - setor leste', 'Socaria', 'demo-coord-infra-north', -1, 'Chapadao do Sul - TCS', '08:00', '10:30', 'Sequencia liberada pelo CCO.', 'Encerrado com atraso por troca de equipamento.', 'completed'),
    ('demo-interval-06', 'Substituicao de aparelho de mudanca de via', 'AMV', 'demo-coord-super-north', -3, 'Tres Lagoas - JLG', '22:00', '02:00', 'Operacao noturna com duas frentes.', 'Encerrado antes do prazo.', 'completed'),
    ('demo-interval-07', 'Correcao geometrica e nivelamento', 'Geometria de via', 'demo-coord-infra-south', -7, 'Curitiba - LCO', '06:00', '09:00', 'Topografia e equipamentos conferidos.', 'Encerrado conforme programado.', 'completed'),
    ('demo-interval-08', 'Manutencao preventiva de ponte', 'Manutencao preventiva', 'demo-coord-super-south', 2, 'Ijui - NIJ', '13:00', '17:00', 'Aguardando janela operacional.', '', 'planning')
) as examples(client_id, title, service_type, coordinator_code, day_offset, location, window_start, window_end, planning_notes, execution_notes, status)
join public.organization_members coordinator
  on coordinator.dataset_id = private.demo_dataset_id()
 and coordinator.code = examples.coordinator_code
on conflict do nothing;

insert into public.interval_steps (
  plan_id, client_id, position, activity_name, planned_start, planned_end,
  actual_start, actual_end, actual_notes, status, skip_reason
)
select
  plan.id,
  step.client_id,
  step.position,
  step.activity_name,
  step.planned_start::time,
  step.planned_end::time,
  nullif(step.actual_start, '')::time,
  nullif(step.actual_end, '')::time,
  step.actual_notes,
  step.status,
  ''
from (
  values
    ('demo-interval-01','demo-01-step-01',0,'DDS e liberacao da frente','08:00','08:20','08:05','08:25','Frente liberada com cinco minutos de espera.','completed'),
    ('demo-interval-01','demo-01-step-02',1,'Desmontagem da grade','08:20','09:30','08:35','','Reposicionamento de equipamento em andamento.','running'),
    ('demo-interval-01','demo-01-step-03',2,'Lancamento da nova grade','09:30','11:20','','','','pending'),
    ('demo-interval-02','demo-02-step-01',0,'Montagem da plataforma','07:30','08:10','07:22','08:00','Acesso liberado antecipadamente.','completed'),
    ('demo-interval-02','demo-02-step-02',1,'Inspecao de apoios','08:10','09:40','08:02','','Sem anomalias criticas.','running'),
    ('demo-interval-03','demo-03-step-01',0,'Implantacao de protecao','09:00','09:20','09:00','09:20','','completed'),
    ('demo-interval-03','demo-03-step-02',1,'Escavacao e assentamento','09:20','11:40','09:20','','Frente principal em execucao.','running'),
    ('demo-interval-04','demo-04-step-01',0,'Preparacao de acessos','10:00','10:40','','','','pending'),
    ('demo-interval-04','demo-04-step-02',1,'Execucao da contencao','10:40','13:30','','','','pending'),
    ('demo-interval-05','demo-05-step-01',0,'Posicionamento da socadora','08:00','08:20','08:05','08:25','','completed'),
    ('demo-interval-05','demo-05-step-02',1,'Socaria e alinhamento','08:20','10:00','08:25','10:24','Troca de equipamento durante a etapa.','completed'),
    ('demo-interval-05','demo-05-step-03',2,'Inspecao e liberacao','10:00','10:30','10:24','10:46','','completed'),
    ('demo-interval-06','demo-06-step-01',0,'Retirada do AMV existente','22:00','23:20','21:52','23:05','','completed'),
    ('demo-interval-06','demo-06-step-02',1,'Montagem e regulagem','23:20','01:30','23:05','01:12','','completed'),
    ('demo-interval-06','demo-06-step-03',2,'Teste e liberacao','01:30','02:00','01:12','01:38','','completed'),
    ('demo-interval-07','demo-07-step-01',0,'Levantamento topografico','06:00','06:40','06:00','06:40','','completed'),
    ('demo-interval-07','demo-07-step-02',1,'Correcao geometrica','06:40','08:20','06:40','08:20','','completed'),
    ('demo-interval-07','demo-07-step-03',2,'Medicao final','08:20','09:00','08:20','09:00','','completed'),
    ('demo-interval-08','demo-08-step-01',0,'Montagem do acesso','13:00','13:45','','','','pending'),
    ('demo-interval-08','demo-08-step-02',1,'Inspecao e manutencao','13:45','16:30','','','','pending')
) as step(plan_client_id, client_id, position, activity_name, planned_start, planned_end, actual_start, actual_end, actual_notes, status)
join public.interval_plans plan
  on plan.dataset_id = private.demo_dataset_id()
 and plan.client_id = step.plan_client_id
on conflict (plan_id, client_id) do nothing;

insert into public.interval_comments (
  client_id, dataset_id, plan_id, author_user_id, author_member_id,
  author_name, author_role, content, created_at
)
select
  gen_random_uuid(),
  private.demo_dataset_id(),
  plan.id,
  null::uuid,
  author.id,
  author.full_name,
  author.role,
  comment.content,
  now() - comment.age
from (
  values
    ('demo-interval-01','demo-manager-north','Acesso norte condicionado; equipe reorganizada sem interromper a frente.', interval '18 minutes'),
    ('demo-interval-01','demo-coord-infra-north','Equipamento reserva deslocado e previsao atualizada.', interval '9 minutes'),
    ('demo-interval-02','demo-consultant','Ritmo adiantado confirmado na ultima medicao.', interval '12 minutes'),
    ('demo-interval-03','demo-coord-infra-south','Drenagem provisoria funcionando conforme o plano.', interval '6 minutes')
) as comment(plan_client_id, author_code, content, age)
join public.interval_plans plan
  on plan.dataset_id = private.demo_dataset_id()
 and plan.client_id = comment.plan_client_id
join public.organization_members author
  on author.dataset_id = private.demo_dataset_id()
 and author.code = comment.author_code
;

-- Rebuild object privileges explicitly. This removes inherited TRUNCATE/TRIGGER
-- rights while keeping the browser Data API usable under RLS.
revoke all on public.interval_plans, public.interval_steps, public.user_profiles,
  public.interval_share_links, public.datasets, public.subs,
  public.organization_members, public.interval_comments,
  public.interval_sync_receipts, public.interval_audit_log
from anon, authenticated;

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.interval_plans, public.interval_steps to authenticated;
grant select on public.user_profiles to authenticated;
grant update (full_name, role, enabled, manager_id, sub_id, coordinator_type, profile_needs_review)
  on public.user_profiles to authenticated;
grant select, insert, update, delete on public.interval_share_links to authenticated;
grant select on public.datasets, public.interval_audit_log to authenticated;
grant select (
  id, dataset_id, code, full_name, role, enabled, manager_id, sub_id,
  coordinator_type, profile_needs_review, created_at, updated_at
) on public.organization_members to authenticated;
grant select, insert, update on public.subs to authenticated;
grant select, insert, update on public.interval_comments to authenticated;
grant select, insert on public.interval_sync_receipts to authenticated;
grant usage, select on sequence public.subs_id_seq,
  public.interval_sync_receipts_id_seq, public.interval_audit_log_id_seq
to authenticated;

revoke all on function public.set_updated_at() from public, anon;
grant execute on function public.set_updated_at() to authenticated;
revoke all on function public.list_demo_personas() from public, anon;
grant execute on function public.list_demo_personas() to authenticated;
revoke all on function public.sync_interval_plan(jsonb, jsonb, bigint, uuid, text) from public, anon;
grant execute on function public.sync_interval_plan(jsonb, jsonb, bigint, uuid, text) to authenticated;

revoke all on function private.real_dataset_id(), private.demo_dataset_id(),
  private.request_header(text), private.actual_member_id(), private.actual_role(),
  private.actual_is_editor(), private.actual_manager_auth_user_id(),
  private.current_dataset_id(), private.current_member_id(), private.current_role(),
  private.can_read_plan(uuid, uuid, uuid), private.can_write_plan(uuid, uuid),
  private.can_read_member(uuid, uuid, uuid, text), private.plan_is_mutable(uuid),
  private.interval_accepts_comments(uuid), private.sync_user_profile_member(),
  private.validate_user_profile_hierarchy(), private.handle_new_user(), private.guard_interval_plan(),
  private.guard_interval_step(), private.refresh_interval_statuses(uuid[]),
  private.refresh_interval_statuses_after_insert(),
  private.refresh_interval_statuses_after_update(),
  private.refresh_interval_statuses_after_delete(), private.guard_interval_comment(),
  private.audit_interval_plan(), private.audit_interval_comment()
from public, anon, authenticated;
grant execute on function private.real_dataset_id(), private.demo_dataset_id(),
  private.request_header(text), private.actual_member_id(), private.actual_role(),
  private.actual_is_editor(), private.actual_manager_auth_user_id(),
  private.current_dataset_id(), private.current_member_id(), private.current_role(),
  private.can_read_plan(uuid, uuid, uuid), private.can_write_plan(uuid, uuid),
  private.can_read_member(uuid, uuid, uuid, text), private.plan_is_mutable(uuid),
  private.interval_accepts_comments(uuid)
to authenticated;

comment on table public.subs is
  'Cadastro administravel das 103 SUBs identificadas no Mapa Rumo 2020-V9.';
comment on table public.organization_members is
  'Hierarquia organizacional por dataset; personas demo nao possuem conta Auth.';
comment on table public.interval_comments is
  'Comentarios historicos com exclusao logica permitida apenas ao autor durante a execucao.';
comment on table public.interval_sync_receipts is
  'Recibos idempotentes usados pela fila offline para confirmar persistencia sem duplicacao.';
comment on table public.interval_audit_log is
  'Trilha append-only das alteracoes relevantes de intervalos e comentarios.';

commit;
