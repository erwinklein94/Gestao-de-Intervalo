create table public.interval_share_links (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.interval_plans(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique check (length(token_hash) = 64),
  token_hint text not null default '',
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_accessed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (plan_id)
);

create index interval_share_links_owner_idx
  on public.interval_share_links (owner_id, created_at desc);
create index interval_share_links_active_token_idx
  on public.interval_share_links (token_hash)
  where revoked_at is null;

create trigger interval_share_links_set_updated_at
before update on public.interval_share_links
for each row execute function public.set_updated_at();

alter table public.interval_share_links enable row level security;

create policy "Owners read own share links"
on public.interval_share_links for select to authenticated
using (
  owner_id = (select auth.uid())
  and exists (
    select 1 from public.interval_plans p
    where p.id = interval_share_links.plan_id
      and p.user_id = (select auth.uid())
  )
);

create policy "Owners create share links"
on public.interval_share_links for insert to authenticated
with check (
  owner_id = (select auth.uid())
  and exists (
    select 1 from public.interval_plans p
    where p.id = interval_share_links.plan_id
      and p.user_id = (select auth.uid())
  )
);

create policy "Owners update own share links"
on public.interval_share_links for update to authenticated
using (
  owner_id = (select auth.uid())
  and exists (
    select 1 from public.interval_plans p
    where p.id = interval_share_links.plan_id
      and p.user_id = (select auth.uid())
  )
)
with check (
  owner_id = (select auth.uid())
  and exists (
    select 1 from public.interval_plans p
    where p.id = interval_share_links.plan_id
      and p.user_id = (select auth.uid())
  )
);

create policy "Owners delete own share links"
on public.interval_share_links for delete to authenticated
using (
  owner_id = (select auth.uid())
  and exists (
    select 1 from public.interval_plans p
    where p.id = interval_share_links.plan_id
      and p.user_id = (select auth.uid())
  )
);

grant select, insert, update, delete on public.interval_share_links to authenticated;
revoke all on public.interval_share_links from anon;

comment on table public.interval_share_links is
  'Links temporarios e revogaveis para acompanhamento somente leitura de um intervalo.';
comment on column public.interval_share_links.token_hash is
  'SHA-256 do token de compartilhamento; o token original nunca e armazenado.';
