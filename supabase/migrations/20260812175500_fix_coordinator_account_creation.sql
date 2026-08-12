create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare is_bootstrap_editor boolean;
begin
  is_bootstrap_editor := lower(coalesce(new.email, '')) = 'erwin.klein@ext.rumolog.com';
  insert into public.user_profiles (id,email,full_name,role,enabled)
  values (new.id,coalesce(new.email,''),coalesce(new.raw_user_meta_data->>'full_name',''),case when is_bootstrap_editor then 'editor' else 'user' end,is_bootstrap_editor);
  return new;
end;
$$;
