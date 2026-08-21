-- Reconstroi o ambiente de exemplos a partir dos perfis reais.
--
-- As personas ficticias (Ana Ribeiro, Carlos Mendes, ...@exemplos.invalid) dao
-- lugar a um espelho da hierarquia real: mesmos nomes, funcoes, classificacoes
-- e linha de reporte. As personas demo continuam sem conta Auth
-- (auth_user_id nulo), entao ninguem entra no sistema por elas.
--
-- Os 9 intervalos de exemplo viram 30, distribuidos entre os 24 Coordenadores
-- e Especialistas cadastrados, com as tres classificacoes e os tres estados.
-- O status do plano nao e gravado direto: private.refresh_interval_statuses
-- deriva de interval_steps, entao o que controla o estado e o preenchimento
-- de actual_start / actual_end das etapas.

do $$
declare
  demo_id uuid := (select id from public.datasets where code = 'demo');
  real_id uuid := (select id from public.datasets where code = 'real');
  hoje date := current_date;
  rec record;
  v_plan uuid;
  v_member uuid;
  v_manager uuid;
  v_types text[];
  v_total interval;
  v_slot interval;
  v_qtd int;
begin
  if demo_id is null or real_id is null then
    raise exception 'Datasets demo/real nao encontrados.';
  end if;

  ---------------------------------------------------------------------------
  -- 1. Limpa o ambiente de exemplos antigo
  ---------------------------------------------------------------------------
  delete from public.interval_comments where dataset_id = demo_id;
  delete from public.interval_plans where dataset_id = demo_id;
  delete from public.interval_audit_log where dataset_id = demo_id;
  -- manager_id e auto-referencia com ON DELETE RESTRICT: zera antes de remover.
  update public.organization_members set manager_id = null where dataset_id = demo_id;
  delete from public.organization_members where dataset_id = demo_id;

  ---------------------------------------------------------------------------
  -- 2. Espelha os perfis reais como personas de demonstracao
  ---------------------------------------------------------------------------
  insert into public.organization_members (
    dataset_id, code, auth_user_id, email, full_name, role, enabled,
    manager_id, sub_id, coordinator_types, profile_needs_review
  )
  select demo_id,
         'demo-' || lower(split_part(origem.email, '@', 1)),
         null,
         origem.email,
         origem.full_name,
         origem.role,
         true,
         null,
         origem.sub_id,
         origem.coordinator_types,
         false
  from public.organization_members origem
  where origem.dataset_id = real_id and origem.enabled;

  -- Refaz a linha de reporte usando o e-mail como chave entre os dois datasets.
  update public.organization_members destino
  set manager_id = chefe_demo.id
  from public.organization_members origem
  join public.organization_members chefe_real on chefe_real.id = origem.manager_id
  join public.organization_members chefe_demo
    on chefe_demo.dataset_id = demo_id and chefe_demo.email = chefe_real.email
  where destino.dataset_id = demo_id
    and origem.dataset_id = real_id
    and origem.email = destino.email;

  -- Escopo compartilhado gerente <-> operador, espelhado do real.
  insert into public.manager_operator_assignments (dataset_id, manager_member_id, operator_member_id)
  select demo_id, gerente_demo.id, operador_demo.id
  from public.manager_operator_assignments origem
  join public.organization_members gerente_real on gerente_real.id = origem.manager_member_id
  join public.organization_members operador_real on operador_real.id = origem.operator_member_id
  join public.organization_members gerente_demo
    on gerente_demo.dataset_id = demo_id and gerente_demo.email = gerente_real.email
  join public.organization_members operador_demo
    on operador_demo.dataset_id = demo_id and operador_demo.email = operador_real.email
  where origem.dataset_id = real_id
  on conflict do nothing;

  -- Cada Coordenador/Especialista demo recebe uma SUB, para que a persona
  -- consiga criar intervalos novos dentro do ambiente de exemplos.
  insert into public.coordinator_sub_assignments (coordinator_member_id, sub_id)
  select membro.id, sub.id
  from (
    select id, row_number() over (order by full_name) as posicao
    from public.organization_members
    where dataset_id = demo_id and role in ('coordinator', 'specialist')
  ) membro
  join public.subs sub on sub.id = ((membro.posicao - 1) % 40) + 1
  on conflict do nothing;

  ---------------------------------------------------------------------------
  -- 3. Roteiro dos 30 intervalos de exemplo
  ---------------------------------------------------------------------------
  create temporary table _exemplos (
    email text, titulo text, servico text, local text,
    dia int, janela_inicio time, janela_fim time,
    etapas text[], concluidas int, em_execucao boolean,
    pulada int, desvio int, nota_plan text, nota_exec text
  ) on commit drop;

  insert into _exemplos values
  -- Concluidos
  ('raquel.klein@rumolog.com', 'Renovacao de linha - km 312+400', 'Renovacao de linha', 'Curitiba - LCO', -8, '22:00', '02:00',
   array['Bloqueio e isolamento da via', 'Retirada de dormentes', 'Lancamento de trilho novo', 'Socaria e nivelamento', 'Liberacao da via'], 5, false, null, 12,
   'Janela noturna acordada com o CCO.', 'Concluido com 12 minutos de atraso na liberacao.'),
  ('fabio.ravenna@rumolog.com', 'Drenagem profunda do km 88', 'Drenagem', 'Ponta Grossa - LPG', -7, '08:00', '12:00',
   array['Mobilizacao de equipamentos', 'Escavacao da vala', 'Assentamento de tubulacao', 'Recomposicao do lastro'], 4, false, null, -10,
   'Equipe reforcada por conta do periodo chuvoso.', 'Encerrado 10 minutos antes do previsto.'),
  ('moises.paiva@rumolog.com', 'Socaria mecanizada trecho norte', 'Socaria', 'Rondonopolis - TRO', -6, '06:00', '10:00',
   array['Posicionamento da socadora', 'Socaria do segmento 1', 'Socaria do segmento 2', 'Regularizacao de lastro'], 4, false, null, 5,
   'Socadora alocada em conjunto com a SUB vizinha.', 'Sem intercorrencias.'),
  ('luiz.col@rumolog.com', 'Substituicao de AMV 14', 'AMV', 'Alto Araguaia - TAG', -6, '21:00', '03:00',
   array['Desmontagem do AMV antigo', 'Preparo da base', 'Montagem do AMV novo', 'Ajuste de bitola', 'Teste de acionamento'], 5, false, 2, 25,
   'AMV pre-montado no canteiro.', 'Preparo de base dispensado; atraso de 25 minutos no acionamento.'),
  ('andreans.coimbra@rumolog.com', 'Modernizacao de sinalizacao do patio', 'Manutencao preventiva', 'Maringa - LMG', -5, '07:00', '11:00',
   array['Desligamento programado', 'Substituicao de modulos', 'Comissionamento', 'Religamento e testes'], 4, false, null, -5,
   'Modulos homologados recebidos na semana anterior.', 'Comissionamento aprovado na primeira tentativa.'),
  ('israel.barros@rumolog.com', 'Lancamento de bueiro celular km 205', 'Lançamento de Bueiro', 'Sorriso - TSO', -4, '08:00', '14:00',
   array['Desvio de trafego', 'Escavacao', 'Lancamento das aduelas', 'Reaterro compactado', 'Recomposicao da via'], 5, false, null, 18,
   'Aduelas entregues no pe da obra.', 'Reaterro exigiu compactacao adicional.'),
  ('victor.bruno@rumolog.com', 'Contencao de talude km 57', 'Contencao', 'Morretes - LMR', -3, '09:00', '13:00',
   array['Limpeza do talude', 'Instalacao de tela', 'Aplicacao de concreto projetado'], 3, false, null, 0,
   'Servico critico apos periodo de chuva.', 'Executado exatamente na janela.'),
  ('carlos.ribeiro@rumolog.com', 'Base de rachao no patio de cruzamento', 'Base de rachão', 'Tres Lagoas - JLG', -3, '22:00', '04:00',
   array['Remocao do lastro contaminado', 'Espalhamento de rachao', 'Compactacao', 'Recomposicao de lastro'], 4, false, null, 8,
   'Rachao estocado no patio.', 'Compactacao levou 8 minutos a mais.'),
  ('vanderlei.lima@rumolog.com', 'Correcao geometrica km 410', 'Geometria de via', 'Chapadao do Sul - TCS', -2, '06:00', '09:30',
   array['Levantamento topografico', 'Correcao de alinhamento', 'Verificacao final'], 3, false, null, -12,
   'Desvio apontado pelo carro controle.', 'Frente liberada 12 minutos antes.'),
  ('wesley.brandao@rumolog.com', 'Inspecao estrutural da ponte do Rio Verde', 'Inspecao de obra de arte', 'Aparecida do Taboado - TAP', -1, '07:30', '11:00',
   array['Inspecao visual dos apoios', 'Ensaio nos encontros', 'Relatorio fotografico'], 3, false, null, 3,
   'Inspecao semestral obrigatoria.', 'Estrutura aprovada sem restricoes.'),
  -- Em execucao
  ('leandro.alves@rumolog.com', 'Renovacao de linha - km 497+900', 'Renovacao de linha', 'Alto Araguaia - TAG', 0, '08:00', '12:00',
   array['Bloqueio da via', 'Substituicao de dormentes', 'Lancamento de trilho', 'Socaria final'], 2, true, null, 10,
   'Maior frente da semana.', 'Substituicao de dormentes em andamento.'),
  ('john.soares@rumolog.com', 'Drenagem do trecho litoraneo', 'Drenagem', 'Morretes - LMR', 0, '09:00', '13:00',
   array['Limpeza de valas', 'Desobstrucao de bueiros', 'Recomposicao de talude'], 1, true, null, -4,
   'Trecho com historico de erosao.', 'Desobstrucao em andamento.'),
  ('maicon.rossini@rumolog.com', 'Socaria mecanizada - setor leste', 'Socaria', 'Chapadao do Sul - TCS', 0, '07:00', '11:00',
   array['Posicionamento da socadora', 'Socaria do segmento 1', 'Socaria do segmento 2', 'Regularizacao de lastro'], 2, false, null, 6,
   'Sequencia combinada com a circulacao.', 'Segmento 1 concluido.'),
  ('ronaldo.conceicao@rumolog.com', 'Troca de dormentes km 133', 'Manutencao preventiva', 'Rondonopolis - TRO', 0, '06:00', '10:00',
   array['Marcacao dos dormentes', 'Remocao', 'Assentamento dos novos', 'Fixacao e socaria'], 1, true, null, 15,
   'Dormentes de concreto ja no local.', 'Remocao mais lenta que o previsto.'),
  ('vagner.lima@rumolog.com', 'Implantacao de detector de descarrilamento', 'Manutencao preventiva', 'Cascavel - LCV', 0, '08:30', '12:30',
   array['Preparo da base do sensor', 'Instalacao do detector', 'Integracao com o CCO'], 1, true, null, 0,
   'Piloto de tecnologia embarcada.', 'Instalacao do detector em andamento.'),
  ('paulo.conceicao@rumolog.com', 'Recuperacao de AMV 07', 'AMV', 'Sorriso - TSO', 0, '21:00', '01:00',
   array['Inspecao do AMV', 'Substituicao de agulhas', 'Ajuste de bitola', 'Lubrificacao', 'Teste de acionamento'], 2, true, null, 8,
   'Desgaste identificado na ultima inspecao.', 'Ajuste de bitola em andamento.'),
  ('romulo.rodrigues@rumolog.com', 'Ensaio nao destrutivo de trilhos', 'Inspecao de obra de arte', 'Ponta Grossa - LPG', 0, '10:00', '14:00',
   array['Calibracao do equipamento', 'Varredura ultrassonica', 'Marcacao de defeitos'], 1, true, null, -6,
   'Varredura anual do segmento.', 'Varredura em andamento.'),
  ('fabio.bernardo@rumolog.com', 'Atualizacao de telemetria de via', 'Manutencao preventiva', 'Curitiba - LCO', 0, '13:00', '17:00',
   array['Backup da configuracao', 'Atualizacao de firmware', 'Validacao dos dados'], 1, true, null, 4,
   'Janela sem impacto na circulacao.', 'Atualizacao de firmware em andamento.'),
  -- Em planejamento
  ('fabio.pelegrini@rumolog.com', 'Modernizacao do sistema de licenciamento', 'Manutencao preventiva', 'Maringa - LMG', 1, '08:00', '12:00',
   array['Desligamento programado', 'Troca de controladores', 'Testes de licenciamento'], 0, false, null, 0,
   'Depende de liberacao do CCO.', ''),
  ('rafael.oliveira@rumolog.com', 'Piloto de manutencao preditiva', 'Manutencao preventiva', 'Cascavel - LCV', 1, '14:00', '18:00',
   array['Instalacao de sensores', 'Coleta de linha de base', 'Configuracao de alertas'], 0, false, null, 0,
   'Piloto restrito a um segmento de 8 km.', ''),
  ('adriano.lima1@rumolog.com', 'Renovacao de linha - km 622+100', 'Renovacao de linha', 'Sorriso - TSO', 2, '22:00', '04:00',
   array['Bloqueio e isolamento', 'Retirada de dormentes', 'Lancamento de trilho', 'Socaria', 'Liberacao'], 0, false, null, 0,
   'Maior janela do mes; exige trem de lastro.', ''),
  ('raifran.rodrigues@rumolog.com', 'Solda aluminotermica de juntas', 'Manutencao preventiva', 'Alto Araguaia - TAG', 2, '07:00', '11:00',
   array['Preparo das juntas', 'Execucao das soldas', 'Esmerilhamento e inspecao'], 0, false, null, 0,
   'Doze juntas mapeadas no trecho.', ''),
  ('joao.chapina@rumolog.com', 'Inspecao de obra de arte especial', 'Inspecao de obra de arte', 'Aparecida do Taboado - TAP', 3, '08:00', '11:30',
   array['Inspecao dos pilares', 'Ensaio de aderencia', 'Relatorio tecnico'], 0, false, null, 0,
   'Inspecao com acesso por alpinismo industrial.', ''),
  ('luciano.junior@rumolog.com', 'Ensaio ultrassonico de trilhos', 'Inspecao de obra de arte', 'Rondonopolis - TRO', 3, '09:00', '13:00',
   array['Calibracao', 'Varredura do segmento', 'Consolidacao dos achados'], 0, false, null, 0,
   'Complementa o ensaio de Ponta Grossa.', ''),
  ('raquel.klein@rumolog.com', 'Reforco de bueiro km 92', 'Lançamento de Bueiro', 'Curitiba - LCO', 4, '08:00', '14:00',
   array['Desvio de trafego', 'Reforco estrutural', 'Reaterro', 'Recomposicao da via'], 0, false, null, 0,
   'Reforco apontado na inspecao de drenagem.', ''),
  ('israel.barros@rumolog.com', 'Socaria de nivelamento km 318', 'Socaria', 'Sorriso - TSO', 5, '06:00', '10:00',
   array['Posicionamento da socadora', 'Socaria', 'Regularizacao de lastro'], 0, false, null, 0,
   'Segue o plano de nivelamento do trimestre.', ''),
  ('victor.bruno@rumolog.com', 'Drenagem de vala lateral km 61', 'Drenagem', 'Morretes - LMR', 6, '09:00', '13:00',
   array['Limpeza da vala', 'Regularizacao de talude', 'Protecao vegetal'], 0, false, null, 0,
   'Preventivo antes do proximo periodo chuvoso.', ''),
  ('luiz.col@rumolog.com', 'Substituicao de AMV 22', 'AMV', 'Tres Lagoas - JLG', 7, '21:00', '03:00',
   array['Desmontagem do AMV antigo', 'Preparo da base', 'Montagem do AMV novo', 'Ajuste de bitola', 'Teste de acionamento'], 0, false, null, 0,
   'AMV em pre-montagem no canteiro.', ''),
  ('moises.paiva@rumolog.com', 'Base de rachao - patio norte', 'Base de rachão', 'Chapadao do Sul - TCS', 8, '22:00', '04:00',
   array['Remocao de lastro contaminado', 'Espalhamento de rachao', 'Compactacao', 'Recomposicao de lastro'], 0, false, null, 0,
   'Depende da chegada do rachao.', ''),
  ('andreans.coimbra@rumolog.com', 'Comissionamento de CCO remoto', 'Manutencao preventiva', 'Ponta Grossa - LPG', 9, '08:00', '12:00',
   array['Checklist de pre-comissionamento', 'Testes integrados', 'Homologacao'], 0, false, null, 0,
   'Ultima etapa do projeto de CCO remoto.', '');

  ---------------------------------------------------------------------------
  -- 4. Cria os intervalos e suas etapas
  ---------------------------------------------------------------------------
  for rec in select * from _exemplos loop
    select id, manager_id, coordinator_types
    into v_member, v_manager, v_types
    from public.organization_members
    where dataset_id = demo_id and email = rec.email;

    if v_member is null then
      raise exception 'Persona demo ausente para %', rec.email;
    end if;

    insert into public.interval_plans (
      user_id, client_id, title, service_type, coordinator, interval_date,
      location, window_start, window_end, planning_notes, execution_notes,
      is_locked, dataset_id, is_example, coordinator_member_id,
      manager_member_id, sub_id, coordinator_type, status
    )
    select null, gen_random_uuid()::text, rec.titulo, rec.servico, membro.full_name,
           hoje + rec.dia, rec.local, rec.janela_inicio, rec.janela_fim,
           rec.nota_plan, rec.nota_exec, false, demo_id, true, v_member,
           v_manager,
           (select sub_id from public.coordinator_sub_assignments where coordinator_member_id = v_member limit 1),
           v_types[1], 'planning'
    from public.organization_members membro
    where membro.id = v_member
    returning id into v_plan;

    v_qtd := array_length(rec.etapas, 1);
    -- A soma tem de ser feita sobre o intervalo, nunca sobre o time: a
    -- aritmetica de time e modulo 24h, entao '01:00'::time + 24h volta a
    -- '01:00' e a janela noturna resultaria em duracao negativa.
    v_total := (rec.janela_fim - rec.janela_inicio)
               + case when rec.janela_fim <= rec.janela_inicio
                      then interval '24 hours' else interval '0' end;
    v_slot := v_total / v_qtd;

    -- Todas as etapas em UMA instrucao: o gatilho de statuses e por statement,
    -- e uma etapa concluida isolada marcaria o plano como concluido com
    -- completed_at, o que o prenderia nesse estado nas insercoes seguintes.
    insert into public.interval_steps (
      plan_id, client_id, position, activity_name,
      planned_start, planned_end, actual_start, actual_end,
      actual_notes, status
    )
    select
      v_plan,
      gen_random_uuid()::text,
      passo - 1,
      rec.etapas[passo],
      (timestamp '2000-01-01' + rec.janela_inicio + v_slot * (passo - 1))::time,
      (timestamp '2000-01-01' + rec.janela_inicio + v_slot * passo)::time,
      case
        when rec.pulada is not null and passo = rec.pulada then null
        when passo <= rec.concluidas or (rec.em_execucao and passo = rec.concluidas + 1)
          then (timestamp '2000-01-01' + rec.janela_inicio + v_slot * (passo - 1)
                + make_interval(mins => (rec.desvio * (passo - 1)) / v_qtd))::time
        else null
      end,
      case
        when rec.pulada is not null and passo = rec.pulada then null
        when passo <= rec.concluidas
          then (timestamp '2000-01-01' + rec.janela_inicio + v_slot * passo
                + make_interval(mins => (rec.desvio * passo) / v_qtd))::time
        else null
      end,
      case when rec.pulada is not null and passo = rec.pulada
           then '[[ETAPA_NAO_EXECUTADA]] Frente chegou pronta; etapa dispensada pela supervisao.'
           else '' end,
      case
        when rec.pulada is not null and passo = rec.pulada then 'skipped'
        when passo <= rec.concluidas then 'completed'
        when rec.em_execucao and passo = rec.concluidas + 1 then 'running'
        else 'pending'
      end
    from generate_series(1, v_qtd) as passo;
  end loop;

  ---------------------------------------------------------------------------
  -- 5. refresh_interval_statuses carimba completed_at com now(); realinha
  --    com o fim real da janela para o historico ficar coerente.
  ---------------------------------------------------------------------------
  update public.interval_plans plan
  set completed_at = (plan.interval_date
        + case when plan.window_end <= plan.window_start then interval '24 hours' else interval '0' end
        + plan.window_end)::timestamptz
  where plan.dataset_id = demo_id and plan.completed_at is not null;

  drop table _exemplos;
end $$;
