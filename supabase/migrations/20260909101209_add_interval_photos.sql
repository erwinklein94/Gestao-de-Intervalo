-- Fotos permanentes da execucao, armazenadas em bucket privado.
-- O arquivo so pode ser criado enquanto a frente esta em execucao. Depois que
-- o metadado e registrado, nao ha UPDATE nem DELETE disponivel ao cliente.

begin;

create table public.interval_photos (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  dataset_id uuid not null references public.datasets(id) on delete restrict,
  plan_id uuid not null references public.interval_plans(id) on delete restrict,
  storage_path text not null unique,
  original_name text not null,
  mime_type text not null,
  file_size bigint not null,
  caption text not null default '',
  author_user_id uuid not null references auth.users(id) on delete restrict,
  author_member_id uuid not null references public.organization_members(id) on delete restrict,
  author_name text not null,
  author_role text not null,
  author_role_gender text,
  created_at timestamptz not null default now(),
  constraint interval_photos_client_key unique (plan_id, client_id),
  constraint interval_photos_path_format check (storage_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'),
  constraint interval_photos_original_name_length check (char_length(btrim(original_name)) between 1 and 180),
  constraint interval_photos_mime_type check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  constraint interval_photos_file_size check (file_size between 1 and 6291456),
  constraint interval_photos_caption_length check (char_length(caption) <= 500)
);

create index interval_photos_plan_created_idx on public.interval_photos(plan_id, created_at);
create index interval_photos_dataset_created_idx on public.interval_photos(dataset_id, created_at desc);

create or replace function private.guard_interval_photo()
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

  if not private.interval_accepts_comments(new.plan_id) then
    raise exception 'Fotos so podem ser adicionadas durante a execucao.' using errcode = '42501';
  end if;

  select dataset_id into plan_dataset
  from public.interval_plans
  where id = new.plan_id;
  select * into member
  from public.organization_members
  where id = private.current_member_id();

  if member.id is null then
    raise exception 'Perfil sem permissao para anexar fotos.' using errcode = '42501';
  end if;
  if split_part(new.storage_path, '/', 1) <> new.plan_id::text
    or split_part(new.storage_path, '/', 2) <> (select auth.uid())::text then
    raise exception 'Caminho da foto invalido.' using errcode = '22023';
  end if;

  new.dataset_id := plan_dataset;
  new.author_user_id := (select auth.uid());
  new.author_member_id := member.id;
  new.author_name := member.full_name;
  new.author_role := member.role;
  new.author_role_gender := member.role_gender;
  new.original_name := left(btrim(new.original_name), 180);
  new.caption := left(btrim(coalesce(new.caption, '')), 500);
  new.created_at := now();
  return new;
end;
$$;

create trigger interval_photos_guard
before insert on public.interval_photos
for each row execute function private.guard_interval_photo();

alter table public.interval_photos enable row level security;

create policy "Authorized members read interval photos"
on public.interval_photos for select to authenticated
using (
  exists (
    select 1 from public.interval_plans plan
    where plan.id = interval_photos.plan_id
      and private.can_read_plan(plan.dataset_id, plan.coordinator_member_id, plan.manager_member_id)
  )
);

create policy "Authorized members attach photos during execution"
on public.interval_photos for insert to authenticated
with check (private.interval_accepts_comments(plan_id));

revoke all on public.interval_photos from anon, authenticated;
grant select, insert on public.interval_photos to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('interval-photos', 'interval-photos', false, 6291456, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "Authorized members read stored interval photos"
on storage.objects for select to authenticated
using (
  bucket_id = 'interval-photos'
  and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and exists (
    select 1 from public.interval_plans plan
    where plan.id::text = (storage.foldername(name))[1]
      and private.can_read_plan(plan.dataset_id, plan.coordinator_member_id, plan.manager_member_id)
  )
);

create policy "Authorized members upload interval photos"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'interval-photos'
  and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and (storage.foldername(name))[2] = (select auth.uid())::text
  and private.interval_accepts_comments(((storage.foldername(name))[1])::uuid)
);

-- Permite limpar somente um upload que falhou antes de ganhar metadado. Assim
-- que public.interval_photos referencia o caminho, o arquivo se torna imutavel.
create policy "Uploaders remove only unregistered interval photos"
on storage.objects for delete to authenticated
using (
  bucket_id = 'interval-photos'
  and owner_id = (select auth.uid())::text
  and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and private.interval_accepts_comments(((storage.foldername(name))[1])::uuid)
  and not exists (
    select 1 from public.interval_photos photo
    where photo.storage_path = storage.objects.name
  )
);

revoke all on function private.guard_interval_photo() from public, anon, authenticated;

comment on table public.interval_photos is
  'Fotos imutaveis anexadas durante a execucao e preservadas no historico do intervalo.';

commit;
