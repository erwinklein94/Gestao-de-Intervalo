create extension if not exists pgcrypto;

create table public.interval_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  title text not null default '',
  service_type text not null default '',
  coordinator text not null default '',
  interval_date date,
  location text not null default '',
  window_start time,
  window_end time,
  planning_notes text not null default '',
  execution_notes text not null default '',
  is_locked boolean not null default false,
  locked_at timestamptz,
  is_example boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, client_id)
);

create table public.interval_steps (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.interval_plans(id) on delete cascade,
  client_id text not null,
  position integer not null check (position >= 0),
  activity_name text not null default '',
  planned_start time,
  planned_end time,
  actual_start time,
  actual_end time,
  actual_notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (plan_id, client_id),
  unique (plan_id, position)
);

create index interval_plans_user_updated_idx on public.interval_plans (user_id, updated_at desc);
create index interval_steps_plan_position_idx on public.interval_steps (plan_id, position);

create or replace function public.set_updated_at()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger interval_plans_set_updated_at before update on public.interval_plans
for each row execute function public.set_updated_at();
create trigger interval_steps_set_updated_at before update on public.interval_steps
for each row execute function public.set_updated_at();

alter table public.interval_plans enable row level security;
alter table public.interval_steps enable row level security;

create policy "Users read own interval plans" on public.interval_plans for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users create own interval plans" on public.interval_plans for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users update own interval plans" on public.interval_plans for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users delete own interval plans" on public.interval_plans for delete to authenticated using ((select auth.uid()) = user_id);

create policy "Users read steps from own plans" on public.interval_steps for select to authenticated
using (exists (select 1 from public.interval_plans p where p.id = interval_steps.plan_id and p.user_id = (select auth.uid())));
create policy "Users create steps in own plans" on public.interval_steps for insert to authenticated
with check (exists (select 1 from public.interval_plans p where p.id = interval_steps.plan_id and p.user_id = (select auth.uid())));
create policy "Users update steps in own plans" on public.interval_steps for update to authenticated
using (exists (select 1 from public.interval_plans p where p.id = interval_steps.plan_id and p.user_id = (select auth.uid())))
with check (exists (select 1 from public.interval_plans p where p.id = interval_steps.plan_id and p.user_id = (select auth.uid())));
create policy "Users delete steps from own plans" on public.interval_steps for delete to authenticated
using (exists (select 1 from public.interval_plans p where p.id = interval_steps.plan_id and p.user_id = (select auth.uid())));

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.interval_plans, public.interval_steps to authenticated;
revoke all on public.interval_plans, public.interval_steps from anon;
