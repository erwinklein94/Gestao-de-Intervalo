# Gestão de Intervalo

Aplicação web estática para planejar e acompanhar intervalos de manutenção de via permanente. Foi desenhada para funcionar diretamente no GitHub Pages, sem servidor ou dependências de build.

## Como usar

1. Abra `index.html`, cadastre os dados do intervalo e monte livremente as etapas.
2. Revise a linha do tempo e trave o cronograma.
3. Abra `executar.html` durante o intervalo e preencha somente os horários e registros realizados.
4. Acompanhe o indicador superior de atraso/adiantamento e a necessidade de compensação nas etapas seguintes.

Os dados ficam no `localStorage` do navegador nesta primeira etapa. A tela de planejamento exporta um relatório Excel `.xlsx` com Programado x Realizado e mantém a importação JSON para restauração de planos. Essa camada foi isolada no início de `app.js` para facilitar a futura substituição por Supabase.

## Publicação

O workflow em `.github/workflows/deploy-pages.yml` publica todo push na branch `main` usando GitHub Pages via Actions.

## Referências de produto

- Identidade visual baseada no brand book oficial da Rumo: paleta institucional, combinações de acessibilidade e Verdana como tipografia de sistema para HTML.
- Fluxo funcional derivado da planilha `00 - CronoAVF.xlsx`: planejado x executado, duração, produtividade/ritmo e visão de Gantt, reorganizados para uso operacional em telas menores.
