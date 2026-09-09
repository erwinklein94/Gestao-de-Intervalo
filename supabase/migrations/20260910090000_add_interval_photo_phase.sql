-- Momento da foto dentro do intervalo.
-- Ate aqui so existia a foto tirada durante a execucao. O registro completo do
-- servico precisa tambem do estado da via antes do bloqueio e da conferencia
-- depois da liberacao. As tres janelas continuam abertas depois que o intervalo
-- e encerrado: a foto do depois so existe com o servico terminado, e quem volta
-- do campo com o celular cheio precisa poder completar tambem o antes e o
-- durante que faltaram. Antes de a execucao comecar so o antes faz sentido, e
-- intervalo cancelado nao recebe foto nenhuma.
-- As fotos que ja existem sao da execucao e ficam em 'during' pelo default.

begin;

alter table public.interval_photos
  add column phase text not null default 'during'
  constraint interval_photos_phase check (phase in ('before', 'during', 'after'));

create index interval_photos_plan_phase_idx on public.interval_photos(plan_id, phase, created_at);

create or replace function private.interval_accepts_photos(target_plan_id uuid, target_phase text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    plan.dataset_id = private.real_dataset_id()
    and private.can_read_plan(plan.dataset_id, plan.coordinator_member_id, plan.manager_member_id)
    and case target_phase
      when 'before' then plan.status in ('planning', 'executing', 'completed')
      when 'during' then plan.status in ('executing', 'completed')
      when 'after' then plan.status in ('executing', 'completed')
      else false
    end,
    false
  )
  from public.interval_plans plan
  where plan.id = target_plan_id;
$$;

-- O caminho no storage nao carrega o momento da foto, entao o upload do arquivo
-- so pode perguntar se alguma das tres janelas esta aberta. Quem decide de fato
-- e o metadado: sem a linha em interval_photos o arquivo fica orfao, continua
-- removivel por quem enviou e nao aparece em lugar nenhum.
create or replace function private.interval_accepts_any_photo(target_plan_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.interval_accepts_photos(target_plan_id, 'before')
    or private.interval_accepts_photos(target_plan_id, 'during')
    or private.interval_accepts_photos(target_plan_id, 'after');
$$;

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

  new.phase := coalesce(new.phase, 'during');
  if new.phase not in ('before', 'during', 'after') then
    raise exception 'Momento da foto invalido.' using errcode = '22023';
  end if;

  if not private.interval_accepts_photos(new.plan_id, new.phase) then
    raise exception 'Este intervalo nao aceita fotos deste momento agora.' using errcode = '42501';
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

-- O gatilho de giro passa a aceitar apenas rotation: phase entra na lista de
-- colunas imutaveis para que uma foto do antes nao vire foto do depois.
create or replace function private.guard_interval_photo_rotation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    return new;
  end if;

  if new.id <> old.id
    or new.client_id <> old.client_id
    or new.dataset_id <> old.dataset_id
    or new.plan_id <> old.plan_id
    or new.storage_path <> old.storage_path
    or new.original_name <> old.original_name
    or new.mime_type <> old.mime_type
    or new.file_size <> old.file_size
    or new.caption <> old.caption
    or new.phase <> old.phase
    or new.author_user_id <> old.author_user_id
    or new.author_member_id <> old.author_member_id
    or new.author_name <> old.author_name
    or new.author_role <> old.author_role
    or new.author_role_gender is distinct from old.author_role_gender
    or new.created_at <> old.created_at then
    raise exception 'Somente a orientacao da foto pode ser alterada.' using errcode = '42501';
  end if;

  return new;
end;
$$;

drop policy if exists "Authorized members attach photos during execution" on public.interval_photos;
create policy "Authorized members attach photos in open phases"
on public.interval_photos for insert to authenticated
with check (private.interval_accepts_photos(plan_id, phase));

drop policy if exists "Authors delete own photos during execution" on public.interval_photos;
create policy "Authors delete own photos while the phase is open"
on public.interval_photos for delete to authenticated
using (
  author_user_id = (select auth.uid())
  and private.interval_accepts_photos(plan_id, phase)
);

drop policy if exists "Authorized members upload interval photos" on storage.objects;
create policy "Authorized members upload interval photos"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'interval-photos'
  and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and (storage.foldername(name))[2] = (select auth.uid())::text
  and private.interval_accepts_any_photo(((storage.foldername(name))[1])::uuid)
);

drop policy if exists "Uploaders remove only unregistered interval photos" on storage.objects;
create policy "Uploaders remove only unregistered interval photos"
on storage.objects for delete to authenticated
using (
  bucket_id = 'interval-photos'
  and owner_id = (select auth.uid())::text
  and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and private.interval_accepts_any_photo(((storage.foldername(name))[1])::uuid)
  and not exists (
    select 1 from public.interval_photos photo
    where photo.storage_path = storage.objects.name
  )
);

revoke all on function private.interval_accepts_photos(uuid, text) from public, anon, authenticated;
revoke all on function private.interval_accepts_any_photo(uuid) from public, anon, authenticated;

comment on column public.interval_photos.phase is
  'Momento do intervalo em que a foto foi tirada: before, during ou after. As fotos da tela de execucao sao sempre during.';

commit;
