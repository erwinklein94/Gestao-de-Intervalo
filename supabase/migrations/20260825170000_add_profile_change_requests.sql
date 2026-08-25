begin;

create table public.profile_change_requests (
  id bigint generated always as identity primary key,
  requester_id uuid references auth.users(id) on delete set null,
  requester_email text not null,
  message text not null,
  created_at timestamptz not null default now(),
  constraint profile_change_requests_email_length check (char_length(requester_email) between 3 and 320),
  constraint profile_change_requests_message_length check (char_length(btrim(message)) between 10 and 2000)
);

create index profile_change_requests_created_at_idx
  on public.profile_change_requests (created_at desc);
create index profile_change_requests_requester_idx
  on public.profile_change_requests (requester_id, created_at desc)
  where requester_id is not null;

alter table public.profile_change_requests enable row level security;

create policy "Non-editors create own profile change requests"
on public.profile_change_requests for insert to authenticated
with check (
  requester_id = (select auth.uid())
  and exists (
    select 1 from public.user_profiles profile
    where profile.id = (select auth.uid())
      and profile.enabled
      and profile.role <> 'editor'
      and lower(profile.email) = lower(profile_change_requests.requester_email)
  )
);

create policy "Editors read profile change requests"
on public.profile_change_requests for select to authenticated
using ((select private.actual_is_editor()));

revoke all on table public.profile_change_requests from anon, authenticated;
grant insert, select on table public.profile_change_requests to authenticated;
revoke all on sequence public.profile_change_requests_id_seq from anon, authenticated;
grant usage, select on sequence public.profile_change_requests_id_seq to authenticated;

comment on table public.profile_change_requests is
  'Solicitações imutáveis de alteração de perfil enviadas ao Editor por usuários autenticados.';

commit;
