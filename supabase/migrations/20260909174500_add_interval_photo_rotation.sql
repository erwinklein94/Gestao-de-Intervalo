-- Orientacao da foto anexada.
-- O celular grava a imagem deitada e o EXIF nem sempre chega ate o navegador,
-- entao a foto correta aparece torta no site e no relatorio. Girar e metadado
-- de exibicao, nao conteudo: o arquivo enviado continua intacto e imutavel, e o
-- privilegio de UPDATE que o autor recebe cobre apenas a coluna rotation.

begin;

alter table public.interval_photos
  add column rotation smallint not null default 0
  constraint interval_photos_rotation check (rotation in (0, 90, 180, 270));

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

  -- O grant por coluna ja limita o UPDATE a rotation; a checagem aqui fecha o
  -- caminho de quem chegar pela API com privilegio mais amplo.
  if new.id <> old.id
    or new.client_id <> old.client_id
    or new.dataset_id <> old.dataset_id
    or new.plan_id <> old.plan_id
    or new.storage_path <> old.storage_path
    or new.original_name <> old.original_name
    or new.mime_type <> old.mime_type
    or new.file_size <> old.file_size
    or new.caption <> old.caption
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

create trigger interval_photos_rotation_guard
before update on public.interval_photos
for each row execute function private.guard_interval_photo_rotation();

-- Diferente do DELETE, girar continua liberado depois do encerramento: o
-- relatorio costuma ser exportado com o intervalo ja fechado, e ai de nada
-- adiantaria descobrir a foto torta sem poder corrigi-la.
create policy "Authors rotate own photos"
on public.interval_photos for update to authenticated
using (author_user_id = (select auth.uid()))
with check (author_user_id = (select auth.uid()));

revoke all on public.interval_photos from anon, authenticated;
grant select, insert, delete on public.interval_photos to authenticated;
grant update (rotation) on public.interval_photos to authenticated;

revoke all on function private.guard_interval_photo_rotation() from public, anon, authenticated;

comment on column public.interval_photos.rotation is
  'Giro em graus aplicado na exibicao da foto (0, 90, 180 ou 270). O arquivo no storage nunca e reescrito.';

comment on policy "Authors rotate own photos" on public.interval_photos is
  'O autor corrige a orientacao da propria foto a qualquer momento; o UPDATE alcanca somente a coluna rotation.';

commit;
