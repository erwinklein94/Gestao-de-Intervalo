-- Destinatario do aviso de nova solicitacao de acesso.
--
-- Fica no banco, e nao no codigo: o repositorio e publico e um endereco
-- pessoal ali viraria alvo de coleta automatica. Tambem nao vira segredo de
-- Edge Function porque assim o Editor consegue conferir e trocar o valor sem
-- depender do painel do Supabase.

create table public.app_settings (
  key text primary key,
  value text not null default '',
  updated_at timestamptz not null default now()
);

comment on table public.app_settings is
  'Ajustes operacionais do sistema, legiveis apenas por Editores.';

alter table public.app_settings enable row level security;

create policy "Editors read settings" on public.app_settings
  for select using (private.actual_is_editor());
create policy "Editors update settings" on public.app_settings
  for update using (private.actual_is_editor()) with check (private.actual_is_editor());

grant select, update on public.app_settings to authenticated;

create trigger app_settings_set_updated_at
  before update on public.app_settings
  for each row execute function set_updated_at();

insert into public.app_settings (key, value) values
  ('access_request_notify_email', 'erwinklein1994@gmail.com')
on conflict (key) do update set value = excluded.value;
