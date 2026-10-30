alter table public.interval_steps add column substeps jsonb not null default '[]'::jsonb;
comment on column public.interval_steps.substeps is 'Checklist opcional da etapa, sem horários; IDs estáveis e tombstones para sincronização offline.';
create function private.valid_interval_substeps(items jsonb)
returns boolean language sql immutable set search_path = '' as $$
select case when jsonb_typeof(items) <> 'array' then false else
  not exists (
    select 1 from jsonb_array_elements(items) item
    where jsonb_typeof(item) <> 'object'
      or jsonb_typeof(item->'id') is distinct from 'string'
      or length(item->>'id') not between 1 and 100
      or jsonb_typeof(item->'name') is distinct from 'string'
      or length(item->>'name') > 140
      or jsonb_typeof(item->'description') is distinct from 'string'
      or length(item->>'description') > 300
      or jsonb_typeof(item->'done') is distinct from 'boolean'
      or (item ? 'deleted' and jsonb_typeof(item->'deleted') is distinct from 'boolean')
      or jsonb_typeof(item->'updatedAt') is distinct from 'string'
  ) and (select count(*) = count(distinct item->>'id') from jsonb_array_elements(items) item)
end;
$$;
revoke all on function private.valid_interval_substeps(jsonb) from public;
grant execute on function private.valid_interval_substeps(jsonb) to authenticated, service_role;
alter table public.interval_steps add constraint interval_steps_substeps_valid check (private.valid_interval_substeps(substeps));

-- Preserve the existing invoker RPC, authorization, revision checks and receipts.
do $migration$
declare
  original text;
  patched text;
begin
  original := pg_get_functiondef('public.sync_interval_plan(jsonb,jsonb,bigint,uuid,text)'::regprocedure);
  patched := replace(original,
    '  delete from public.interval_steps where plan_id = target_id;',
    $replacement$
  -- Older clients omit substeps: preserve the current checklist before replacing rows.
  select coalesce(jsonb_agg(
    case when item ? 'substeps' then item else item || jsonb_build_object(
      'substeps', coalesce((select saved.substeps from public.interval_steps saved
        where saved.plan_id = target_id and saved.client_id = item->>'client_id'), '[]'::jsonb))
    end order by ordinal), '[]'::jsonb)
  into p_steps from jsonb_array_elements(coalesce(p_steps, '[]'::jsonb)) with ordinality as payload(item, ordinal);
  delete from public.interval_steps where plan_id = target_id;
$replacement$);
  if patched = original then raise exception 'Sync delete anchor not found'; end if;
  original := patched;
  patched := replace(patched,
    'actual_start, actual_end, actual_notes, status, skip_reason, last_operation_id',
    'actual_start, actual_end, actual_notes, status, skip_reason, last_operation_id, substeps');
  if patched = original then raise exception 'Sync columns anchor not found'; end if;
  original := patched;
  patched := replace(patched,
    E'    p_operation_id\n  from jsonb_array_elements',
    E'    p_operation_id, coalesce(step->''substeps'', ''[]''::jsonb)\n  from jsonb_array_elements');
  if patched = original then raise exception 'Sync values anchor not found'; end if;
  execute patched;
end;
$migration$;
