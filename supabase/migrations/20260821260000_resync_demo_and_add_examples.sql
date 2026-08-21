-- Ressincroniza as personas de exemplo com os perfis reais e amplia o acervo
-- de intervalos de 30 para 60.
--
-- As personas foram criadas em 20260821220000 e desde entao a operacao real
-- mudou: um Gerente foi renomeado e dois passaram a dividir o time com outros
-- (Caio com Adenis, Geraldo com Joao Paulo). A sincronia e feita por UPDATE,
-- casando pelo e-mail, e nao por delete/insert: interval_plans referencia
-- organization_members com ON DELETE RESTRICT, entao recriar as personas
-- exigiria descartar os exemplos que ja existem.

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
  -- 1. Personas: nome, funcao, classificacoes e situacao vindos do real
  ---------------------------------------------------------------------------
  update public.organization_members destino
  set full_name = origem.full_name,
      role = origem.role,
      coordinator_types = origem.coordinator_types,
      enabled = origem.enabled,
      profile_needs_review = false
  from public.organization_members origem
  where destino.dataset_id = demo_id
    and origem.dataset_id = real_id
    and origem.email = destino.email;

  -- Perfis criados no real depois da ultima sincronia.
  insert into public.organization_members (
    dataset_id, code, auth_user_id, email, full_name, role, enabled,
    manager_id, sub_id, coordinator_types, profile_needs_review
  )
  select demo_id, 'demo-' || lower(split_part(origem.email, '@', 1)), null,
         origem.email, origem.full_name, origem.role, true, null,
         origem.sub_id, origem.coordinator_types, false
  from public.organization_members origem
  where origem.dataset_id = real_id
    and origem.enabled
    and not exists (
      select 1 from public.organization_members atual
      where atual.dataset_id = demo_id and atual.email = origem.email
    );

  -- Linha de reporte
  update public.organization_members destino
  set manager_id = chefe_demo.id
  from public.organization_members origem
  join public.organization_members chefe_real on chefe_real.id = origem.manager_id
  join public.organization_members chefe_demo
    on chefe_demo.dataset_id = demo_id and chefe_demo.email = chefe_real.email
  where destino.dataset_id = demo_id
    and origem.dataset_id = real_id
    and origem.email = destino.email;

  -- Escopo gerente <-> operador, incluindo os times compartilhados
  delete from public.manager_operator_assignments where dataset_id = demo_id;
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

  -- Nome do responsavel gravado no plano acompanha o nome atual da persona
  update public.interval_plans plan
  set coordinator = membro.full_name
  from public.organization_members membro
  where plan.dataset_id = demo_id
    and membro.id = plan.coordinator_member_id
    and plan.coordinator is distinct from membro.full_name;

  ---------------------------------------------------------------------------
  -- 2. Mais 30 intervalos de exemplo
  ---------------------------------------------------------------------------
  create temporary table _novos (
    email text, titulo text, servico text, local text,
    dia int, janela_inicio time, janela_fim time,
    etapas text[], concluidas int, em_execucao boolean,
    pulada int, desvio int, nota_plan text, nota_exec text
  ) on commit drop;

  insert into _novos values
  ('raquel.klein@rumolog.com', 'Renovacao de linha - km 288+700', 'Renovacao de linha', 'Curitiba - LCO', -30, '22:00', '02:00',
   array['Bloqueio e isolamento', 'Retirada de dormentes', 'Lancamento de trilho', 'Socaria', 'Liberacao'], 5, false, null, -8,
   'Janela ampliada em acordo com o CCO.', 'Liberacao 8 minutos antes do previsto.'),
  ('john.soares@rumolog.com', 'Limpeza de valas do km 44', 'Drenagem', 'Morretes - LMR', -28, '08:00', '11:00',
   array['Mobilizacao', 'Limpeza das valas', 'Conferencia de escoamento'], 3, false, null, 6,
   'Preventivo do periodo chuvoso.', 'Sem intercorrencias relevantes.'),
  ('moises.paiva@rumolog.com', 'Socaria de nivelamento km 155', 'Socaria', 'Rondonopolis - TRO', -26, '06:00', '10:00',
   array['Posicionamento da socadora', 'Socaria do segmento 1', 'Socaria do segmento 2', 'Regularizacao'], 4, false, null, 0,
   'Plano trimestral de nivelamento.', 'Executado exatamente na janela.'),
  ('carlos.ribeiro@rumolog.com', 'Recomposicao de lastro km 402', 'Base de rachão', 'Tres Lagoas - JLG', -24, '22:00', '03:00',
   array['Remocao do lastro contaminado', 'Espalhamento', 'Compactacao', 'Recomposicao'], 4, false, null, 14,
   'Material posicionado na vespera.', 'Compactacao exigiu passada adicional.'),
  ('andreans.coimbra@rumolog.com', 'Troca de controladores de patio', 'Manutencao preventiva', 'Maringa - LMG', -22, '07:00', '11:00',
   array['Desligamento programado', 'Troca dos controladores', 'Testes de licenciamento'], 3, false, null, -6,
   'Equipamentos homologados em estoque.', 'Testes aprovados na primeira tentativa.'),
  ('israel.barros@rumolog.com', 'Bueiro celular km 231', 'Lançamento de Bueiro', 'Sorriso - TSO', -20, '08:00', '14:00',
   array['Desvio de trafego', 'Escavacao', 'Lancamento das aduelas', 'Reaterro', 'Recomposicao da via'], 5, false, null, 20,
   'Obra com maior mobilizacao do mes.', 'Reaterro impactado por chuva na vespera.'),
  ('vanderlei.lima@rumolog.com', 'Correcao de superelevacao km 377', 'Geometria de via', 'Chapadao do Sul - TCS', -18, '06:00', '09:30',
   array['Levantamento topografico', 'Correcao', 'Verificacao final'], 3, false, null, -9,
   'Desvio apontado pelo carro controle.', 'Frente liberada adiantada.'),
  ('luiz.col@rumolog.com', 'Substituicao de AMV 31', 'AMV', 'Alto Araguaia - TAG', -17, '21:00', '03:00',
   array['Desmontagem do AMV antigo', 'Preparo da base', 'Montagem do AMV novo', 'Ajuste de bitola', 'Teste de acionamento'], 5, false, 2, 3,
   'AMV pre-montado no canteiro.', 'Base ja regularizada; etapa dispensada.'),
  ('victor.bruno@rumolog.com', 'Contencao de talude km 63', 'Contencao', 'Morretes - LMR', -15, '09:00', '13:00',
   array['Limpeza do talude', 'Instalacao de tela', 'Concreto projetado'], 3, false, null, 7,
   'Ponto critico monitorado desde o ultimo ciclo.', 'Concluido com pequeno atraso.'),
  ('wesley.brandao@rumolog.com', 'Inspecao de viaduto ferroviario', 'Inspecao de obra de arte', 'Aparecida do Taboado - TAP', -14, '07:30', '11:00',
   array['Inspecao dos apoios', 'Ensaio nos encontros', 'Relatorio'], 3, false, null, -4,
   'Inspecao periodica obrigatoria.', 'Estrutura aprovada sem restricoes.'),
  ('vagner.lima@rumolog.com', 'Comissionamento de detector', 'Manutencao preventiva', 'Cascavel - LCV', -13, '08:30', '12:30',
   array['Conferencia da instalacao', 'Testes integrados', 'Homologacao'], 3, false, null, 0,
   'Fecha o piloto iniciado no mes anterior.', 'Homologado sem pendencias.'),
  ('paulo.conceicao@rumolog.com', 'Recuperacao de AMV 12', 'AMV', 'Sorriso - TSO', -12, '21:00', '01:00',
   array['Inspecao do AMV', 'Substituicao de agulhas', 'Ajuste de bitola', 'Lubrificacao', 'Teste de acionamento'], 5, false, null, 11,
   'Desgaste apontado na inspecao anterior.', 'Teste de acionamento repetido duas vezes.'),
  ('maicon.rossini@rumolog.com', 'Socaria mecanizada setor oeste', 'Socaria', 'Chapadao do Sul - TCS', -11, '07:00', '11:00',
   array['Posicionamento', 'Socaria do segmento 1', 'Socaria do segmento 2', 'Regularizacao'], 4, false, null, -5,
   'Sequencia combinada com a circulacao.', 'Encerrado antes do prazo.'),
  ('raifran.rodrigues@rumolog.com', 'Solda de juntas km 512', 'Manutencao preventiva', 'Alto Araguaia - TAG', -10, '07:00', '11:00',
   array['Preparo das juntas', 'Execucao das soldas', 'Esmerilhamento'], 3, false, null, 8,
   'Nove juntas mapeadas.', 'Uma junta exigiu retrabalho.'),
  ('fabio.ravenna@rumolog.com', 'Desobstrucao de drenagem km 96', 'Drenagem', 'Ponta Grossa - LPG', -9, '08:00', '12:00',
   array['Mobilizacao', 'Desobstrucao', 'Limpeza de bueiros', 'Conferencia'], 4, false, null, -12,
   'Servico antecipado por alerta meteorologico.', 'Concluido bem antes da janela.'),
  ('adriano.lima1@rumolog.com', 'Renovacao de linha - km 640+300', 'Renovacao de linha', 'Sorriso - TSO', -9, '22:00', '04:00',
   array['Bloqueio', 'Retirada de dormentes', 'Lancamento de trilho', 'Socaria', 'Liberacao'], 5, false, null, 16,
   'Maior janela do periodo.', 'Atraso concentrado na socaria.'),
  ('leandro.alves@rumolog.com', 'Substituicao de dormentes km 118', 'Manutencao preventiva', 'Alto Araguaia - TAG', 0, '06:00', '10:00',
   array['Marcacao', 'Remocao', 'Assentamento', 'Fixacao e socaria'], 2, true, null, 9,
   'Dormentes de concreto no local.', 'Assentamento em andamento.'),
  ('ronaldo.conceicao@rumolog.com', 'Regularizacao de lastro km 288', 'Base de rachão', 'Rondonopolis - TRO', 0, '08:00', '12:00',
   array['Remocao de material', 'Espalhamento', 'Compactacao', 'Conferencia'], 1, true, null, -3,
   'Complementa o servico do mes passado.', 'Espalhamento em andamento.'),
  ('fabio.pelegrini@rumolog.com', 'Atualizacao do sistema de patio', 'Manutencao preventiva', 'Maringa - LMG', 0, '09:00', '13:00',
   array['Backup da configuracao', 'Atualizacao', 'Validacao'], 1, true, null, 5,
   'Janela sem impacto na circulacao.', 'Atualizacao em andamento.'),
  ('romulo.rodrigues@rumolog.com', 'Ensaio de trilhos km 205', 'Inspecao de obra de arte', 'Ponta Grossa - LPG', 0, '13:00', '17:00',
   array['Calibracao', 'Varredura', 'Marcacao de defeitos'], 1, false, null, 0,
   'Segunda etapa da varredura anual.', 'Calibracao concluida.'),
  ('luciano.junior@rumolog.com', 'Inspecao de obra de arte km 588', 'Inspecao de obra de arte', 'Rondonopolis - TRO', 0, '08:00', '11:30',
   array['Inspecao visual', 'Ensaio de aderencia', 'Relatorio'], 2, true, null, -7,
   'Acesso por plataforma elevatoria.', 'Relatorio em elaboracao.'),
  ('joao.chapina@rumolog.com', 'Solda aluminotermica km 470', 'Manutencao preventiva', 'Tres Lagoas - JLG', 0, '21:00', '01:00',
   array['Preparo das juntas', 'Execucao das soldas', 'Esmerilhamento', 'Inspecao final'], 1, true, null, 12,
   'Seis juntas previstas.', 'Soldas em execucao.'),
  ('rafael.oliveira@rumolog.com', 'Expansao do piloto preditivo', 'Manutencao preventiva', 'Cascavel - LCV', 2, '14:00', '18:00',
   array['Instalacao de sensores', 'Coleta de linha de base', 'Configuracao de alertas'], 0, false, null, 0,
   'Amplia o piloto para mais 12 km.', ''),
  ('fabio.bernardo@rumolog.com', 'Telemetria de via - fase 2', 'Manutencao preventiva', 'Curitiba - LCO', 3, '13:00', '17:00',
   array['Backup', 'Atualizacao de firmware', 'Validacao dos dados'], 0, false, null, 0,
   'Depende da liberacao da fase 1.', ''),
  ('moises.paiva@rumolog.com', 'Socaria km 190', 'Socaria', 'Rondonopolis - TRO', 5, '06:00', '10:00',
   array['Posicionamento', 'Socaria', 'Regularizacao'], 0, false, null, 0,
   'Continuidade do plano de nivelamento.', ''),
  ('carlos.ribeiro@rumolog.com', 'Base de rachao km 415', 'Base de rachão', 'Tres Lagoas - JLG', 6, '22:00', '04:00',
   array['Remocao de lastro', 'Espalhamento', 'Compactacao', 'Recomposicao'], 0, false, null, 0,
   'Aguardando chegada do rachao.', ''),
  ('john.soares@rumolog.com', 'Drenagem profunda km 51', 'Drenagem', 'Morretes - LMR', 8, '08:00', '13:00',
   array['Mobilizacao', 'Escavacao', 'Tubulacao', 'Recomposicao'], 0, false, null, 0,
   'Servico estruturante do trecho.', ''),
  ('maicon.rossini@rumolog.com', 'Geometria de via km 366', 'Geometria de via', 'Chapadao do Sul - TCS', 10, '06:00', '09:30',
   array['Levantamento', 'Correcao', 'Verificacao'], 0, false, null, 0,
   'Programado apos leitura do carro controle.', ''),
  ('wesley.brandao@rumolog.com', 'Inspecao especial de ponte', 'Inspecao de obra de arte', 'Aparecida do Taboado - TAP', 12, '07:30', '11:30',
   array['Inspecao dos pilares', 'Ensaios', 'Relatorio tecnico'], 0, false, null, 0,
   'Inspecao especial solicitada pela engenharia.', ''),
  ('raquel.klein@rumolog.com', 'Renovacao de linha - km 301+200', 'Renovacao de linha', 'Curitiba - LCO', 14, '22:00', '03:00',
   array['Bloqueio', 'Retirada de dormentes', 'Lancamento de trilho', 'Socaria', 'Liberacao'], 0, false, null, 0,
   'Depende de trem de lastro disponivel.', '');

  for rec in select * from _novos loop
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
    v_total := (rec.janela_fim - rec.janela_inicio)
               + case when rec.janela_fim <= rec.janela_inicio
                      then interval '24 hours' else interval '0' end;
    v_slot := v_total / v_qtd;

    insert into public.interval_steps (
      plan_id, client_id, position, activity_name,
      planned_start, planned_end, actual_start, actual_end,
      actual_notes, status
    )
    select
      v_plan, gen_random_uuid()::text, passo - 1, rec.etapas[passo],
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

  -- refresh_interval_statuses carimba completed_at com now(); realinha com o
  -- fim real da janela para o historico ficar coerente.
  update public.interval_plans plan
  set completed_at = (plan.interval_date
        + case when plan.window_end <= plan.window_start then interval '24 hours' else interval '0' end
        + plan.window_end)::timestamptz
  where plan.dataset_id = demo_id
    and plan.completed_at is not null
    and plan.completed_at::date <> plan.interval_date;

  drop table _novos;
end $$;
