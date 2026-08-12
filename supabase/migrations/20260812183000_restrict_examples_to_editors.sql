drop policy "Enabled users create own interval plans" on public.interval_plans;
drop policy "Enabled users update own interval plans" on public.interval_plans;

create policy "Enabled users create permitted interval plans"
on public.interval_plans for insert to authenticated
with check (
  (select private.is_enabled_user())
  and (select auth.uid()) = user_id
  and ((select private.is_editor()) or not is_example)
);

create policy "Enabled users update permitted interval plans"
on public.interval_plans for update to authenticated
using ((select private.is_enabled_user()) and (select auth.uid()) = user_id)
with check (
  (select private.is_enabled_user())
  and (select auth.uid()) = user_id
  and ((select private.is_editor()) or not is_example)
);
