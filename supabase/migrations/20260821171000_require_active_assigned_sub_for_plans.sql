begin;

create or replace function private.guard_interval_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  member public.organization_members%rowtype;
  sub_is_assigned boolean;
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  if (select auth.uid()) is null then
    new.revision := case when tg_op = 'UPDATE' then old.revision + 1 else greatest(coalesce(new.revision, 0), 1) end;
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.dataset_id := private.current_dataset_id();
    new.is_example := new.dataset_id = private.demo_dataset_id();
    new.revision := greatest(coalesce(new.revision, 0), 1);
    new.status := 'planning';
    new.completed_at := null;
  else
    if not private.can_write_plan(old.dataset_id, old.coordinator_member_id) then
      raise exception 'Intervalo fora do escopo de edicao.' using errcode = '42501';
    end if;
    if old.completed_at is not null and private.actual_role() <> 'editor' then
      raise exception 'Intervalos concluidos fazem parte do historico e nao podem ser alterados.' using errcode = '42501';
    end if;
    new.dataset_id := old.dataset_id;
    new.is_example := old.is_example;
    new.created_at := old.created_at;
    new.revision := old.revision + 1;
    if old.completed_at is not null then
      new.status := 'completed';
      new.completed_at := old.completed_at;
      new.archived_at := old.archived_at;
    elsif private.actual_role() <> 'editor' then
      new.status := old.status;
      new.completed_at := old.completed_at;
      new.archived_at := old.archived_at;
    end if;
  end if;

  if private.actual_role() = 'coordinator' then
    select * into member
    from public.organization_members
    where id = private.actual_member_id();
    new.user_id := (select auth.uid());
    new.coordinator_member_id := member.id;
  elsif private.actual_role() = 'editor' and new.coordinator_member_id is not null then
    select * into member
    from public.organization_members
    where id = new.coordinator_member_id
      and dataset_id = new.dataset_id
      and role = 'coordinator'
      and enabled;
    if not found then
      raise exception 'Selecione um Coordenador ativo do mesmo ambiente.' using errcode = '23514';
    end if;
    new.user_id := coalesce(member.auth_user_id, new.user_id);
  elsif private.actual_role() <> 'editor' then
    raise exception 'Perfil sem permissao para editar intervalos.' using errcode = '42501';
  end if;

  new.sub_id := coalesce(new.sub_id, member.sub_id);
  select exists (
    select 1
    from public.coordinator_sub_assignments assignment
    join public.subs sub on sub.id = assignment.sub_id and sub.active
    where assignment.coordinator_member_id = member.id
      and assignment.sub_id = new.sub_id
  ) into sub_is_assigned;

  if not sub_is_assigned
     and not (
       tg_op = 'UPDATE'
       and new.coordinator_member_id is not distinct from old.coordinator_member_id
       and new.sub_id is not distinct from old.sub_id
     ) then
    raise exception 'Selecione uma SUB ativa atribuida ao Coordenador.' using errcode = '23514';
  end if;

  new.manager_member_id := member.manager_id;
  new.coordinator_type := member.coordinator_type;
  new.coordinator := member.full_name;

  return new;
end;
$$;

commit;
