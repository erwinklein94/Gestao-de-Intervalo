-- Permite que mais de um Gerente seja chefe dos mesmos Coordenadores.
--
-- O modelo de dados ja suportava: manager_operator_assignments tem chave
-- (manager_member_id, operator_member_id), e user_profiles.manager_id guarda
-- apenas o gestor primario. O que travava era permissao.
--
-- update_site_user_profile roda como SECURITY INVOKER, ou seja, com os
-- privilegios do Editor logado (role authenticated). No ramo de Gerente ela
-- precisa ler organization_members.auth_user_id para reeleger o gestor
-- primario de quem saiu da lista -- e authenticated so tem SELECT em algumas
-- colunas de organization_members, sem auth_user_id. Resultado: qualquer
-- salvamento de Gerente com subordinados falhava com
-- 'permission denied for table organization_members', e nunca foi possivel
-- atribuir o mesmo Coordenador a dois Gerentes pela tela.
--
-- A funcao ja faz a propria autorizacao na primeira linha (private.actual_is_editor)
-- e ja tem search_path fixo, entao SECURITY DEFINER e o modo correto para ela:
-- a checagem de quem pode executar continua sendo do proprio corpo.

alter function public.update_site_user_profile(uuid, text, text, boolean, uuid[], text[])
  security definer;

comment on function public.update_site_user_profile(uuid, text, text, boolean, uuid[], text[]) is
  'Atualiza um perfil e seus vinculos de hierarquia. SECURITY DEFINER: restringe o acesso pela checagem private.actual_is_editor() no inicio do corpo, nao pelos grants da role chamadora.';
