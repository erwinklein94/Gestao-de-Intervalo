begin;

-- Covers the audit-log foreign key and the common per-actor chronology lookup.
create index if not exists interval_audit_actor_created_idx
  on public.interval_audit_log (actor_id, created_at desc)
  where actor_id is not null;

commit;
