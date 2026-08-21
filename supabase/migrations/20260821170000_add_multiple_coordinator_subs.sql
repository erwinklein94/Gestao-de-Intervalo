begin;

create table if not exists public.coordinator_sub_assignments (
  coordinator_member_id uuid not null
    references public.organization_members(id) on delete cascade,
  sub_id bigint not null
    references public.subs(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (coordinator_member_id, sub_id)
);

create index if not exists coordinator_sub_assignments_sub_idx
  on public.coordinator_sub_assignments(sub_id);

comment on table public.coordinator_sub_assignments is
  'Relacao muitos-para-muitos entre Coordenadores e as SUBs sob sua responsabilidade.';

insert into public.coordinator_sub_assignments (coordinator_member_id, sub_id)
select member.id, member.sub_id
from public.organization_members member
where member.role = 'coordinator'
  and member.sub_id is not null
on conflict do nothing;

create or replace function private.sync_primary_coordinator_sub_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  member_id uuid;
begin
  select member.id into member_id
  from public.organization_members member
  where member.dataset_id = private.real_dataset_id()
    and member.auth_user_id = new.id;

  if member_id is null then
    return new;
  end if;

  if new.role = 'coordinator' and new.sub_id is not null then
    insert into public.coordinator_sub_assignments (coordinator_member_id, sub_id)
    values (member_id, new.sub_id)
    on conflict do nothing;
  else
    delete from public.coordinator_sub_assignments assignment
    where assignment.coordinator_member_id = member_id;
  end if;

  return new;
end;
$$;

drop trigger if exists user_profiles_sync_primary_coordinator_sub on public.user_profiles;
create trigger user_profiles_sync_primary_coordinator_sub
after insert or update on public.user_profiles
for each row execute function private.sync_primary_coordinator_sub_assignment();

create or replace function public.update_site_user_profile(
  p_target_user_id uuid,
  p_full_name text,
  p_role text,
  p_enabled boolean,
  p_manager_id uuid,
  p_sub_ids bigint[],
  p_coordinator_type text
)
returns public.user_profiles
language plpgsql
security invoker
set search_path = ''
as $$
declare
  normalized_sub_ids bigint[] := '{}'::bigint[];
  saved_profile public.user_profiles%rowtype;
begin
  if not private.actual_is_editor() then
    raise exception 'Apenas Editores podem atualizar perfis.' using errcode = '42501';
  end if;

  if p_target_user_id is null
     or nullif(btrim(p_full_name), '') is null
     or length(btrim(p_full_name)) > 120
     or p_role not in ('director', 'consultant', 'executive_manager', 'manager', 'coordinator', 'editor') then
    raise exception 'Revise nome e perfil informados.' using errcode = '23514';
  end if;

  if p_role = 'coordinator' then
    select coalesce(array_agg(candidate.sub_id order by candidate.first_position), '{}'::bigint[])
    into normalized_sub_ids
    from (
      select selected.sub_id, min(selected.position) as first_position
      from unnest(coalesce(p_sub_ids, '{}'::bigint[])) with ordinality as selected(sub_id, position)
      where selected.sub_id is not null
      group by selected.sub_id
    ) candidate;

    if p_manager_id is null
       or cardinality(normalized_sub_ids) = 0
       or p_coordinator_type not in ('infrastructure', 'superstructure') then
      raise exception 'Coordenador exige Gerente, uma ou mais SUBs e classificacao.' using errcode = '23514';
    end if;

    if not exists (
      select 1 from public.user_profiles manager
      where manager.id = p_manager_id
        and manager.role = 'manager'
        and manager.enabled
    ) then
      raise exception 'O Gerente informado nao existe ou esta desabilitado.' using errcode = '23514';
    end if;

    if exists (
      select 1
      from unnest(normalized_sub_ids) selected(sub_id)
      left join public.subs sub on sub.id = selected.sub_id and sub.active
      where sub.id is null
    ) then
      raise exception 'Uma ou mais SUBs selecionadas nao estao disponiveis.' using errcode = '23514';
    end if;
  elsif p_manager_id is not null
     or cardinality(coalesce(p_sub_ids, '{}'::bigint[])) > 0
     or p_coordinator_type is not null then
    raise exception 'Somente Coordenadores podem receber Gerente, SUBs e classificacao.' using errcode = '23514';
  end if;

  update public.user_profiles
  set full_name = btrim(p_full_name),
      role = p_role,
      enabled = p_enabled,
      manager_id = case when p_role = 'coordinator' then p_manager_id else null end,
      sub_id = case when p_role = 'coordinator' then normalized_sub_ids[1] else null end,
      coordinator_type = case when p_role = 'coordinator' then p_coordinator_type else null end,
      profile_needs_review = false
  where id = p_target_user_id
  returning * into saved_profile;

  if not found then
    raise exception 'Perfil nao encontrado.' using errcode = 'P0002';
  end if;

  delete from public.coordinator_sub_assignments assignment
  where assignment.coordinator_member_id = saved_profile.organization_member_id;

  if p_role = 'coordinator' then
    insert into public.coordinator_sub_assignments (coordinator_member_id, sub_id)
    select saved_profile.organization_member_id, selected.sub_id
    from unnest(normalized_sub_ids) selected(sub_id);
  end if;

  return saved_profile;
end;
$$;

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
    raise exception 'Selecione uma SUB atribuida ao Coordenador.' using errcode = '23514';
  end if;

  new.manager_member_id := member.manager_id;
  new.coordinator_type := member.coordinator_type;
  new.coordinator := member.full_name;

  return new;
end;
$$;

alter table public.coordinator_sub_assignments enable row level security;

create policy "Members read Coordinator SUB assignments within scope"
on public.coordinator_sub_assignments for select to authenticated
using (
  exists (
    select 1
    from public.organization_members member
    where member.id = coordinator_sub_assignments.coordinator_member_id
      and private.can_read_member(member.dataset_id, member.id, member.manager_id, member.role)
  )
);

create policy "Editors create Coordinator SUB assignments"
on public.coordinator_sub_assignments for insert to authenticated
with check (private.actual_is_editor());

create policy "Editors delete Coordinator SUB assignments"
on public.coordinator_sub_assignments for delete to authenticated
using (private.actual_is_editor());

revoke all on public.coordinator_sub_assignments from anon, authenticated;
grant select, insert, delete on public.coordinator_sub_assignments to authenticated;

revoke all on function public.update_site_user_profile(uuid, text, text, boolean, uuid, bigint[], text)
from public, anon;
grant execute on function public.update_site_user_profile(uuid, text, text, boolean, uuid, bigint[], text)
to authenticated;

revoke all on function private.sync_primary_coordinator_sub_assignment()
from public, anon, authenticated;

commit;
