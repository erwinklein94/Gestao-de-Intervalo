begin;
do $test$
declare
  previous public.interval_steps%rowtype;
  saved public.interval_steps%rowtype;
  checklist jsonb := '[{"id":"substep-regression","name":"Inspeção","description":"Conferir","done":false,"updatedAt":"2026-10-30T21:00:00.000Z"}]'::jsonb;
begin
  if not private.valid_interval_substeps(checklist) or not private.valid_interval_substeps('[]') then
    raise exception 'Valid checklist rejected';
  end if;
  if private.valid_interval_substeps('[{"id":"invalid"}]') then raise exception 'Invalid checklist accepted'; end if;
  select * into previous from public.interval_steps limit 1;
  if found then
    update public.interval_steps set substeps = checklist where id = previous.id returning * into saved;
    if saved.substeps <> checklist or saved.planned_start is distinct from previous.planned_start
      or saved.planned_end is distinct from previous.planned_end
      or saved.actual_start is distinct from previous.actual_start
      or saved.actual_end is distinct from previous.actual_end then
      raise exception 'Checklist affected schedule or was not saved';
    end if;
    begin
      update public.interval_steps set substeps = '[{"id":"invalid"}]' where id = previous.id;
      raise exception 'Invalid checklist was stored';
    exception when check_violation then null;
    end;
  end if;
end;
$test$;
rollback;
