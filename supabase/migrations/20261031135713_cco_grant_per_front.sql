-- CCO concession belongs to each front. Existing grants and execution records stay intact.
create or replace function private.propagate_interval_group_fields()
returns trigger language plpgsql security definer set search_path to '' as $function$
begin
  if pg_trigger_depth() > 1 then return null; end if;
  update public.interval_plans sibling
  set title = new.title, interval_date = new.interval_date,
      window_start = new.window_start, window_end = new.window_end,
      location = new.location, revision = sibling.revision
  where sibling.group_id = new.group_id and sibling.dataset_id = new.dataset_id
    and sibling.id <> new.id and sibling.completed_at is null
    and (sibling.title, sibling.interval_date, sibling.window_start, sibling.window_end, sibling.location)
      is distinct from (new.title, new.interval_date, new.window_start, new.window_end, new.location);
  return null;
end;
$function$;

-- Retain all existing authorization and closure checks; only stop inheriting CCO.
do $migration$
declare original text; patched text;
begin
  original := pg_get_functiondef('private.guard_interval_plan()'::regprocedure);
  patched := replace(original, E'      new.cco_grant_minutes := group_lead.cco_grant_minutes;\n', '');
  patched := replace(patched, E'      new.cco_grant_unit := group_lead.cco_grant_unit;\n', '');
  if patched = original then raise exception 'CCO inheritance anchor not found'; end if;
  execute patched;
end;
$migration$;
comment on column public.interval_plans.cco_grant_minutes is 'Extra minutes authorized by CCO for this front only; does not change the shared planned window.';

