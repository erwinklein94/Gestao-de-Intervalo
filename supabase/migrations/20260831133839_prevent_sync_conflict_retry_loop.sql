-- Business conflicts must not trigger PostgREST serialization retries (40001).
-- PT409 returns HTTP 409 immediately, so clients can preserve the local copy.
-- Patch the installed definition instead of replacing business rules from an
-- older snapshot. CREATE OR REPLACE preserves its owner, grants and RLS mode.
-- Safe to rerun after an emergency application through the SQL Editor.
do $migration$
declare
  function_sql text := pg_get_functiondef('public.sync_interval_plan(jsonb,jsonb,bigint,uuid,text)'::regprocedure);
  conflict_statement text;
  corrected_statement text;
begin
  foreach conflict_statement in array array[
    $statement$raise exception 'SYNC_OPERATION_PAYLOAD_MISMATCH' using errcode = '40001';$statement$,
    $statement$raise exception 'SYNC_CONFLICT: expected %, found %', p_expected_revision, target_revision using errcode = '40001';$statement$
  ] loop
    corrected_statement := replace(conflict_statement, '40001', 'PT409');
    if strpos(function_sql, conflict_statement) = 0 and strpos(function_sql, corrected_statement) = 0 then
      raise exception 'Unexpected sync_interval_plan definition; no changes applied.';
    end if;
    function_sql := replace(function_sql, conflict_statement, corrected_statement);
  end loop;
  execute function_sql;
end;
$migration$;
