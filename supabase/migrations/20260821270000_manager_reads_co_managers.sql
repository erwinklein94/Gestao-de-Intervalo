-- Um Gerente passa a enxergar os co-gerentes: quem divide operador com ele.
--
-- O intervalo guarda um unico manager_member_id, o gestor primario do
-- Coordenador. Quando dois Gerentes dividem o mesmo time, o outro Gerente ve o
-- intervalo (o operador esta no escopo dele) mas nao conseguia ler a linha do
-- gestor primario em organization_members: a regra de 'manager' so liberava a
-- si mesmo e aos proprios operadores. Como decoratePlans resolve o nome pelo
-- diretorio, o card exibia 'Gerente: Nao informado' mesmo com o dado gravado.
--
-- A liberacao e restrita a quem ja compartilha operador com o leitor, entao
-- nao amplia o diretorio para Gerentes de outras areas.

create or replace function private.can_read_member(
  target_dataset_id uuid,
  target_member_id uuid,
  target_manager_id uuid,
  target_role text
)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select coalesce(
    target_dataset_id = private.current_dataset_id()
    and case private.current_role()
      when 'editor' then true
      when 'director' then true
      when 'consultant' then true
      when 'executive_manager' then
        target_member_id = private.current_member_id()
        or (target_role = 'manager' and target_manager_id = private.current_member_id())
        or (target_role in ('coordinator', 'specialist') and exists (
          select 1
          from public.manager_operator_assignments assignment
          join public.organization_members manager on manager.id = assignment.manager_member_id
          where assignment.dataset_id = target_dataset_id
            and assignment.operator_member_id = target_member_id
            and manager.manager_id = private.current_member_id()
            and manager.role = 'manager' and manager.enabled
        ))
      when 'manager' then target_member_id = private.current_member_id()
        or (target_role in ('coordinator', 'specialist') and exists (
          select 1 from public.manager_operator_assignments assignment
          where assignment.dataset_id = target_dataset_id
            and assignment.manager_member_id = private.current_member_id()
            and assignment.operator_member_id = target_member_id
        ))
        or (target_role = 'manager' and exists (
          select 1
          from public.manager_operator_assignments meu
          join public.manager_operator_assignments dele
            on dele.operator_member_id = meu.operator_member_id
           and dele.dataset_id = meu.dataset_id
          where meu.dataset_id = target_dataset_id
            and meu.manager_member_id = private.current_member_id()
            and dele.manager_member_id = target_member_id
        ))
      when 'coordinator' then target_member_id = private.current_member_id()
        or (target_role = 'manager' and exists (
          select 1 from public.manager_operator_assignments assignment
          where assignment.dataset_id = target_dataset_id
            and assignment.manager_member_id = target_member_id
            and assignment.operator_member_id = private.current_member_id()
        ))
      when 'specialist' then target_member_id = private.current_member_id()
        or (target_role = 'manager' and exists (
          select 1 from public.manager_operator_assignments assignment
          where assignment.dataset_id = target_dataset_id
            and assignment.manager_member_id = target_member_id
            and assignment.operator_member_id = private.current_member_id()
        ))
      else false
    end,
    false
  );
$function$;
