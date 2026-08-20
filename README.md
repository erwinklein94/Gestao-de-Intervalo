# Gestão de Intervalo

Aplicação web estática para planejar e acompanhar intervalos de manutenção de via permanente. Foi desenhada para funcionar diretamente no GitHub Pages, sem servidor ou dependências de build.

## Como usar

1. Abra `index.html`, cadastre os dados do intervalo e monte livremente as etapas.
2. Revise a linha do tempo e trave o cronograma.
3. Abra `executar.html` durante o intervalo e preencha somente os horários e registros realizados.
4. Consulte `dashboard.html` para comparar o planejado com o realizado e analisar progresso, duração e desvios por etapa.
5. Acompanhe o indicador superior de atraso/adiantamento e a necessidade de compensação nas etapas seguintes.

## Como o atraso é calculado

O indicador principal da execução, do dashboard e do acompanhamento compartilhado é o **saldo entre o tempo em atraso e o tempo de adiantamento**, medidos etapa a etapa contra o **prazo final de cada etapa**.

Regra por etapa:

| Situação da etapa | Comparação | Resultado |
|---|---|---|
| Concluída | término real vs. fim programado | negativo = adiantada, positivo = atrasada |
| Em andamento | agora vs. fim programado | dentro do prazo enquanto agora não passa dele |
| Não iniciada | agora vs. fim programado | só entra na conta depois que o prazo vence |

Uma etapa que começou muito antes do planejado continua **dentro do prazo** enquanto o horário atual não passar do fim programado dela — mesmo que já tenha gastado mais tempo do que a duração prevista. Ter começado cedo é margem, e a margem só acaba no prazo final da etapa.

Etapa que ainda não começou e já passou do horário planejado de **início** não entra no saldo (a régua é o prazo final), mas aparece como aviso próprio no painel e no cartão da etapa.

### Totalização sem contar o mesmo minuto duas vezes

Os totais não são uma soma aritmética dos desvios: cada etapa ocupa uma **janela de relógio**, e o total é a união dessas janelas.

- Etapa atrasada ocupa `[prazo final, prazo final + atraso]`.
- Etapa adiantada ocupa `[prazo final − adiantamento, prazo final]`.

Etapas **sequenciais** têm janelas disjuntas e portanto se somam normalmente. Etapas **simultâneas** se sobrepõem, e o trecho comum é contado uma vez só. Duas frentes 30 min além do próprio prazo dão **30 min** de atraso no total, não 60 — porque só 30 minutos de relógio se passaram. Quando há sobreposição, o painel avisa: *"já descontados os períodos simultâneos"*.

O saldo (`tempo em atraso − tempo de adiantamento`) vai para o indicador principal, com as duas parcelas ao lado.

## Projeção de término

Ao lado do saldo, o site mostra **quando o intervalo deve terminar** pelo ritmo atual. Essa é a leitura de relógio, e ela não soma etapas simultâneas: o término vem do caminho mais longo. A projeção é montada etapa a etapa:

- Etapa concluída: usa o horário real de término.
- Etapa em andamento: assume, no mínimo, a duração planejada contada a partir do início real, e nunca termina antes de agora.
- Etapa ainda não iniciada: não pode começar antes de agora nem antes do fim projetado das etapas que o plano colocou à sua frente; etapas planejadas em paralelo continuam em paralelo.
- Etapa marcada como não executada: sai dos dois lados da conta, para que retirar escopo não vire adiantamento.

O **prazo final** da janela aparece em relógio próprio, com aviso quando a projeção ameaça ultrapassá-lo.

### Etapa em andamento

Cada etapa aberta traz duas leituras diferentes, que respondem a perguntas diferentes:

- **Posição no prazo** (o selo de desvio): agora contra o fim programado da etapa. Negativo enquanto o prazo não vence, positivo depois.
- **Consumo da duração**: o tempo já em execução contra o previsto.

As duas são necessárias: uma etapa pode estar dentro do prazo (porque começou muito antes do previsto) e ao mesmo tempo já ter consumido mais tempo do que o estimado. Somente o selo esconderia esse segundo fato.

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
