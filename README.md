# Gestão de Intervalo

Aplicação web estática para planejar e acompanhar intervalos de manutenção de via permanente. Foi desenhada para funcionar diretamente no GitHub Pages, sem servidor ou dependências de build.

## Como usar

1. Abra `index.html`, cadastre os dados do intervalo e monte livremente as etapas.
2. Revise a linha do tempo e trave o cronograma.
3. Abra `executar.html` durante o intervalo e preencha somente os horários e registros realizados.
4. Consulte `dashboard.html` para comparar o planejado com o realizado e analisar progresso, duração e desvios por etapa.
5. Acompanhe o indicador superior de atraso/adiantamento e a necessidade de compensação nas etapas seguintes.

## Como o atraso é calculado

O número principal de `executar.html`, do dashboard e do acompanhamento compartilhado responde a uma única pergunta: **quanto o intervalo inteiro está atrasado em relação ao planejado, agora**.

Ele é a diferença entre o **término projetado de todas as atividades** e o **término planejado das atividades** (o maior fim programado entre as etapas que continuam no escopo). A projeção é montada etapa a etapa:

- Etapa concluída: usa o horário real de término.
- Etapa em andamento: assume, no mínimo, a duração planejada contada a partir do início real, e nunca termina antes de agora.
- Etapa ainda não iniciada: não pode começar antes de agora nem antes do fim projetado das etapas que o plano colocou à sua frente; etapas planejadas em paralelo continuam em paralelo.
- Etapa marcada como não executada: sai dos dois lados da conta, para que retirar escopo não vire adiantamento.

Com isso o coordenador enxerga o atraso assim que ele acontece, e não apenas quando a janela é estourada. Etapas simultâneas nunca têm seus tempos somados: o atraso vem do caminho mais longo, e o painel indica qual etapa é o **ofensor principal**.

Três leituras complementares aparecem juntas: o **atraso já acumulado** (o que já ocorreu), o número de **etapas em atraso agora**, e o **prazo final** da janela, com aviso quando a projeção ameaça ultrapassá-lo. Quando a projeção fecha no horário mas existem etapas atrasadas, o painel fica em estado de atenção em vez de verde, sinalizando que a folga do cronograma está sendo consumida.

### Etapa em andamento

Cada etapa aberta traz duas leituras diferentes, que respondem a perguntas diferentes:

- **Posição no cronograma** (o selo de desvio): enquanto a etapa couber na própria duração planejada, o desvio é o do início. Assim que ela ultrapassa essa duração, passa a empurrar o término minuto a minuto — mesmo que tenha começado adiantada e o fim programado ainda esteja no futuro.
- **Consumo da duração**: o tempo já em execução contra o previsto, sempre comparado ao fim programado da própria etapa.

As duas são necessárias: uma etapa pode estar adiantada no cronograma (porque começou muito antes do previsto) e ao mesmo tempo já ter consumido mais tempo do que o estimado. Somente o selo esconderia esse segundo fato.

Consumir mais tempo que o previsto **não é, por si só, um problema**. Uma etapa que começou bem antes do horário planejado pode gastar mais e ainda entregar com folga, e nesse caso a leitura é informativa, sem alarme:

> Em execução há 1h 40min de 1h 20min previstos · 20 min a mais que o previsto, **ainda 1h 00min antes do fim programado**

O destaque em vermelho aparece apenas quando a etapa passa do próprio fim programado:

> Em execução há 2h 00min de 1h 45min previstos · 15 min a mais que o previsto e **15 min além do fim programado**

Os dados são mantidos localmente enquanto o usuário não está conectado. Ao entrar com e-mail e senha, planos e etapas são sincronizados com o Supabase, com acesso protegido por usuário e uma cópia local para continuidade em caso de falha temporária de conexão. A tela de planejamento também exporta um relatório Excel `.xlsx` com Programado x Realizado.

O site possui temas claro e escuro. O tema claro é o padrão inicial, e a escolha do usuário fica memorizada no dispositivo.

Todas as áreas operacionais são protegidas por autenticação. Usuários sem sessão válida ou com conta desabilitada são direcionados para `login.html` antes de acessar planejamento, execução, dashboard ou conta.

Os dados locais são separados por usuário. A carga demonstrativa e o botão `Exemplo` são exclusivos do perfil editor; coordenadores não recebem exemplos e também são impedidos pelo RLS de gravar planos demonstrativos.

Toda alteração de planejamento ou execução é gravada imediatamente no dispositivo e colocada em uma fila de sincronização com o Supabase. Se o usuário trocar de página, recarregar o site ou perder a conexão durante o salvamento, a versão local pendente é preservada e reenviada antes de qualquer leitura da nuvem, evitando que dados recentes sejam substituídos por uma versão anterior.

O dashboard possui exportação em PDF por meio da impressão preparada do navegador, incluindo indicadores, gráficos e tabela operacional em formato A4 paisagem.

## Publicação

O workflow em `.github/workflows/deploy-pages.yml` publica todo push na branch `main` usando GitHub Pages via Actions.

## Referências de produto

- Identidade visual baseada no brand book oficial da Rumo: paleta institucional, combinações de acessibilidade e Verdana como tipografia de sistema para HTML.
- Fluxo funcional derivado da planilha `00 - CronoAVF.xlsx`: planejado x executado, duração, produtividade/ritmo e visão de Gantt, reorganizados para uso operacional em telas menores.
