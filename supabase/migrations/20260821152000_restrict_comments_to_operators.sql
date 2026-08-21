begin;

-- Comentários são uma mutação operacional. Perfis gerenciais mantêm acesso de
-- leitura, mas nem a API direta pode transformar esse acesso em escrita.
create or replace function private.interval_accepts_comments(target_plan_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    private.can_write_plan(plan.dataset_id, plan.coordinator_member_id)
    and plan.status = 'executing'
    and plan.completed_at is null,
    false
  )
  from public.interval_plans plan
  where plan.id = target_plan_id;
$$;

revoke all on function private.interval_accepts_comments(uuid)
  from public, anon, authenticated;
grant execute on function private.interval_accepts_comments(uuid)
  to authenticated;

commit;
