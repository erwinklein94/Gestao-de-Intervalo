drop policy if exists "Owners read own share links" on public.interval_share_links;
drop policy if exists "Owners create share links" on public.interval_share_links;
drop policy if exists "Owners update own share links" on public.interval_share_links;
drop policy if exists "Owners delete own share links" on public.interval_share_links;

create policy "Enabled owners read own share links"
on public.interval_share_links for select to authenticated
using (
  (select private.is_enabled_user())
  and owner_id = (select auth.uid())
  and exists (
    select 1 from public.interval_plans p
    where p.id = interval_share_links.plan_id
      and p.user_id = (select auth.uid())
  )
);

create policy "Enabled owners create share links"
on public.interval_share_links for insert to authenticated
with check (
  (select private.is_enabled_user())
  and owner_id = (select auth.uid())
  and exists (
    select 1 from public.interval_plans p
    where p.id = interval_share_links.plan_id
      and p.user_id = (select auth.uid())
  )
);

create policy "Enabled owners update own share links"
on public.interval_share_links for update to authenticated
using (
  (select private.is_enabled_user())
  and owner_id = (select auth.uid())
  and exists (
    select 1 from public.interval_plans p
    where p.id = interval_share_links.plan_id
      and p.user_id = (select auth.uid())
  )
)
with check (
  (select private.is_enabled_user())
  and owner_id = (select auth.uid())
  and exists (
    select 1 from public.interval_plans p
    where p.id = interval_share_links.plan_id
      and p.user_id = (select auth.uid())
  )
);

create policy "Enabled owners delete own share links"
on public.interval_share_links for delete to authenticated
using (
  (select private.is_enabled_user())
  and owner_id = (select auth.uid())
  and exists (
    select 1 from public.interval_plans p
    where p.id = interval_share_links.plan_id
      and p.user_id = (select auth.uid())
  )
);
