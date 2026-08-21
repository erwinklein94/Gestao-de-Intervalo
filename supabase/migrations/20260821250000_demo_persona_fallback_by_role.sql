-- Conserta o ambiente de exemplos apos a troca das personas.
--
-- private.current_member_id() resolvia a persona padrao procurando o code fixo
-- 'demo-editor'. A migration 20260821220000 passou a nomear as personas a
-- partir do e-mail do perfil real, entao o Editor virou 'demo-erwin.klein' e o
-- fallback deixou de encontrar qualquer linha. Sem persona resolvida,
-- private.current_role() fica nulo, can_read_member devolve false para tudo e
-- list_demo_personas retorna vazio -- a tela de exemplos carrega sem nenhuma
-- persona e falha antes de renderizar.
--
-- A persona padrao passa a ser localizada pela funcao 'editor', que e o que a
-- regra realmente quer dizer, e nao por uma convencao de nome.

create or replace function private.current_member_id()
returns uuid
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  requested_id uuid;
  resolved_id uuid;
begin
  if private.current_dataset_id() = private.real_dataset_id() then
    return private.actual_member_id();
  end if;

  begin
    requested_id := nullif(private.request_header('x-demo-persona-id'), '')::uuid;
  exception when invalid_text_representation then
    requested_id := null;
  end;

  if requested_id is not null then
    select id into resolved_id
    from public.organization_members
    where id = requested_id
      and dataset_id = private.demo_dataset_id()
      and enabled;
  end if;

  if resolved_id is null then
    select id into resolved_id
    from public.organization_members
    where dataset_id = private.demo_dataset_id()
      and role = 'editor'
      and enabled
    order by code
    limit 1;
  end if;
  return resolved_id;
end;
$function$;
