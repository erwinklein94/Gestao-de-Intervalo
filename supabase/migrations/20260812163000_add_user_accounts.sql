create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create table public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text not null default '',
  role text not null default 'user' check (role in ('editor','user')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index user_profiles_role_enabled_idx on public.user_profiles (role, enabled);

create function private.is_editor() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.user_profiles where id = (select auth.uid()) and role = 'editor' and enabled);
$$;
create function private.is_enabled_user() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.user_profiles where id = (select auth.uid()) and enabled);
$$;
revoke all on function private.is_editor(), private.is_enabled_user() from public, anon;
grant execute on function private.is_editor(), private.is_enabled_user() to authenticated;

create function private.handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $$
declare is_bootstrap_editor boolean;
begin
  is_bootstrap_editor := lower(coalesce(new.email, '')) = 'erwin.klein@ext.rumolog.com';
  insert into public.user_profiles (id,email,full_name,role,enabled) values
    (new.id,coalesce(new.email,''),coalesce(new.raw_user_meta_data->>'full_name',''),case when is_bootstrap_editor then 'editor' else 'user' end,is_bootstrap_editor);
  return new;
end; $$;
revoke all on function private.handle_new_user() from public, anon, authenticated;
create trigger on_auth_user_created after insert on auth.users for each row execute function private.handle_new_user();
create trigger user_profiles_set_updated_at before update on public.user_profiles for each row execute function public.set_updated_at();

alter table public.user_profiles enable row level security;
create policy "Users read own profile" on public.user_profiles for select to authenticated using (id=(select auth.uid()) or (select private.is_editor()));
create policy "Editors update profiles" on public.user_profiles for update to authenticated using ((select private.is_editor())) with check ((select private.is_editor()));
grant select on public.user_profiles to authenticated;
grant update (full_name,role,enabled) on public.user_profiles to authenticated;
revoke all on public.user_profiles from anon;

drop policy "Users read own interval plans" on public.interval_plans;
drop policy "Users create own interval plans" on public.interval_plans;
drop policy "Users update own interval plans" on public.interval_plans;
drop policy "Users delete own interval plans" on public.interval_plans;
create policy "Enabled users read own interval plans" on public.interval_plans for select to authenticated using ((select private.is_enabled_user()) and (select auth.uid())=user_id);
create policy "Enabled users create own interval plans" on public.interval_plans for insert to authenticated with check ((select private.is_enabled_user()) and (select auth.uid())=user_id);
create policy "Enabled users update own interval plans" on public.interval_plans for update to authenticated using ((select private.is_enabled_user()) and (select auth.uid())=user_id) with check ((select private.is_enabled_user()) and (select auth.uid())=user_id);
create policy "Enabled users delete own interval plans" on public.interval_plans for delete to authenticated using ((select private.is_enabled_user()) and (select auth.uid())=user_id);
