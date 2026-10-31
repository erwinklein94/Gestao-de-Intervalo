begin;
do $test$
declare
  first_front public.interval_plans%rowtype;
  second_front public.interval_plans%rowtype;
  fresh public.interval_plans%rowtype;
  current_sibling jsonb;
  next_position integer;
begin
  select p.* into first_front from public.interval_plans p
  where p.completed_at is null and exists (
    select 1 from public.interval_plans other where other.group_id=p.group_id and other.id<>p.id and other.completed_at is null
  ) order by p.updated_at desc limit 1;
  if not found then raise exception 'Need an open multifront interval for regression test'; end if;
  select * into second_front from public.interval_plans where group_id=first_front.group_id and id<>first_front.id and completed_at is null limit 1;
  select max(front_position)+1 into next_position from public.interval_plans where group_id=first_front.group_id;
  perform set_config('request.jwt.claims',json_build_object('sub',first_front.user_id,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  update public.interval_plans set cco_grant_minutes=(first_front.cco_grant_minutes+17)%1441, cco_grant_unit='minutes' where id=first_front.id;
  select to_jsonb(p) into current_sibling from public.interval_plans p where id=second_front.id;
  if current_sibling is distinct from to_jsonb(second_front) then raise exception 'Concession changed sibling'; end if;
  update public.interval_plans set cco_grant_minutes=0,location=first_front.location||' [regression]' where id=first_front.id;
  if not exists (select 1 from public.interval_plans where id=second_front.id and cco_grant_minutes=second_front.cco_grant_minutes and cco_grant_unit=second_front.cco_grant_unit and location=first_front.location||' [regression]') then
    raise exception 'Shared-field propagation overwrote concession';
  end if;
  if next_position <= 12 then
    fresh := first_front;
    fresh.id := gen_random_uuid();
    fresh.client_id := gen_random_uuid()::text;
    fresh.front_position := next_position;
    fresh.cco_grant_minutes := 45;
    fresh.cco_grant_unit := 'minutes';
    insert into public.interval_plans select (fresh).*;
    if not exists (select 1 from public.interval_plans where id=fresh.id and cco_grant_minutes=45) then raise exception 'New front inherited sibling grant'; end if;
  end if;
end;
$test$;
rollback;

