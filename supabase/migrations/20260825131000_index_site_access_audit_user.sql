begin;

create index site_access_audit_user_accessed_idx
  on public.site_access_audit (user_id, accessed_at desc)
  where user_id is not null;

commit;
