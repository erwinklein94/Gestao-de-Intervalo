# Gestão de Intervalo

Aplicação web estática para planejar e acompanhar intervalos de manutenção de via permanente. Foi desenhada para funcionar diretamente no GitHub Pages, sem servidor ou dependências de build.

## Como usar

1. Abra `index.html`, cadastre os dados do intervalo e monte livremente as etapas.
2. Revise a linha do tempo e trave o cronograma.
3. Abra `executar.html` durante o intervalo e preencha somente os horários e registros realizados.
4. Consulte `dashboard.html` para comparar o planejado com o realizado e analisar progresso, duração e desvios por etapa.
4. Acompanhe o indicador superior de atraso/adiantamento e a necessidade de compensação nas etapas seguintes.

Os dados são mantidos localmente enquanto o usuário não está conectado. Ao entrar com e-mail e senha, planos e etapas são sincronizados com o Supabase, com acesso protegido por usuário e uma cópia local para continuidade em caso de falha temporária de conexão. A tela de planejamento também exporta um relatório Excel `.xlsx` com Programado x Realizado.

O site possui temas claro e escuro. O tema claro é o padrão inicial, e a escolha do usuário fica memorizada no dispositivo.

## Publicação

O workflow em `.github/workflows/deploy-pages.yml` publica todo push na branch `main` usando GitHub Pages via Actions.

## Referências de produto

- Identidade visual baseada no brand book oficial da Rumo: paleta institucional, combinações de acessibilidade e Verdana como tipografia de sistema para HTML.
- Fluxo funcional derivado da planilha `00 - CronoAVF.xlsx`: planejado x executado, duração, produtividade/ritmo e visão de Gantt, reorganizados para uso operacional em telas menores.
