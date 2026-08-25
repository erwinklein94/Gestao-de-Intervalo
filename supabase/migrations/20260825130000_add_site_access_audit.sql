begin;

create table public.site_access_audit (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  email text not null,
  page text not null,
  accessed_at timestamptz not null default now(),
  constraint site_access_audit_page_length check (char_length(page) between 1 and 80),
  constraint site_access_audit_email_length check (char_length(email) between 3 and 320)
);

create index site_access_audit_accessed_at_idx
  on public.site_access_audit (accessed_at desc);

alter table public.site_access_audit enable row level security;

create policy "Enabled users register own access"
on public.site_access_audit for insert to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.user_profiles profile
    where profile.id = (select auth.uid())
      and profile.enabled
      and lower(profile.email) = lower(site_access_audit.email)
  )
);

create policy "Editors read site access audit"
on public.site_access_audit for select to authenticated
using ((select private.actual_is_editor()));

revoke all on table public.site_access_audit from anon, authenticated;
grant insert, select on table public.site_access_audit to authenticated;
revoke all on sequence public.site_access_audit_id_seq from anon, authenticated;
grant usage, select on sequence public.site_access_audit_id_seq to authenticated;

comment on table public.site_access_audit is
  'Registro imutável de páginas abertas por usuários autenticados; somente Editores podem consultar.';

commit;
