# Gestão de Intervalo

Aplicação web para planejar, executar e acompanhar intervalos de manutenção de via permanente. O frontend é estático, responsivo e não exige etapa de build; a autenticação, a persistência, a hierarquia organizacional e as autorizações são fornecidas pelo Supabase. A publicação do frontend é feita pelo GitHub Pages.

## Arquitetura

| Camada | Responsabilidade | Arquivos principais |
|---|---|---|
| Fluxo operacional | Planejamento, execução, dashboard individual, conta, compartilhamento e sincronização offline | `index.html`, `executar.html`, `dashboard.html`, `conta.html`, `acompanhar.html`, `app.js` |
| Portal gerencial | Cards por intervalo, filtros, histórico, dashboard geral, contador de atrasos e detecção de silêncio | `gestao.html`, `assets/portal.js` |
| Administração | Criação e edição de perfis e hierarquia Gerente → Coordenador | `admin.html`, `assets/portal.js` |
| Identidade e interface | Login, proteção inicial de rotas, temas claro/escuro e estilos responsivos | `login.html`, `assets/auth-guard.js`, `styles.css` |
| Backend | Auth, Postgres, RLS, funções SQL, auditoria e Edge Functions | `supabase/migrations/`, `supabase/functions/` |
| Aplicativo instalável | Manifesto, service worker e app shell em cache para abrir sem sinal | `manifest.webmanifest`, `sw.js`, `assets/pwa.js` |
| Entrega | Publicação automática do site estático | `.github/workflows/deploy-pages.yml` |

O navegador usa somente a chave publicável do projeto. Chaves `service_role` ou secretas permanecem restritas às Edge Functions e nunca devem ser copiadas para HTML ou JavaScript público.

## Perfis e permissões

As permissões são aplicadas na navegação e novamente no banco por Row Level Security (RLS). Ocultar uma página ou botão não é considerado controle de acesso.

| Perfil | Escopo | Páginas e ações principais |
|---|---|---|
| Diretor | Toda a operação | Gestão, intervalos em execução, histórico, dashboard geral, acompanhamento somente leitura e Minha Conta |
| Gerente Executivo | Mesmo escopo do Diretor | Mesma visão global e somente leitura dos intervalos |
| Consultor | Mesmo escopo do Diretor | Mesma visão global e somente leitura dos intervalos |
| Gerente | Coordenadores vinculados ao próprio Gerente | As três visões gerenciais, filtradas automaticamente para a própria equipe |
| Coordenador | Próprios intervalos | Planejamento, execução, dashboard individual, histórico, comentários operacionais e Minha Conta |
| Editor | Toda a operação | Visão gerencial completa, ferramentas operacionais, Administração e gestão de usuários |

Cada Coordenador deve possuir Gerente responsável e classificação `infrastructure`, `superstructure` ou `modernization`. O Gerente Executivo é um perfil global somente leitura e não participa da relação hierárquica Gerente → Coordenador. Perfis legados incompletos são preservados com indicação de revisão, em vez de terem dados removidos silenciosamente.

## Páginas

- `login.html`: autenticação por e-mail e senha, validação da conta habilitada e solicitação administrativa de alteração de senha.
- `index.html`: criação e revisão do plano, montagem de etapas, linha do tempo, travamento do cronograma e exportação `.xlsx`.
- `executar.html`: registro dos horários e observações realizados, etapas não executadas, comentários e estado de sincronização.
- `dashboard.html`: indicadores e gráficos do intervalo selecionado, comparação Programado × Realizado e impressão preparada para PDF em A4 paisagem.
- `gestao.html`: portal com as áreas Em execução, Histórico e Dashboard geral. Inclui filtros por Gerente, Coordenador, classificação, status, prazo, tipo, período e texto livre. Um contador discreto sobre a aba **Em execução** mostra quantos intervalos em andamento estão atrasados agora.
- `admin.html`: área exclusiva do Editor para criar e editar usuários e vínculos da hierarquia.
- `conta.html`: mostra somente os dados do usuário autenticado. Para Editor, oferece o acesso à Administração.
- `acompanhar.html`: acompanhamento público somente leitura por link temporário, revogável e protegido por token.

Os cards gerenciais mostram título, local, Gerente, Coordenador, classificação, tipo, janela, progresso, status, desvio e — quando houver — a quantidade de frentes e o aviso de silêncio. Um card representa o intervalo inteiro, somando as frentes. Ao abrir um card, a Página de Acompanhamento reúne Plano, Execução, Dashboard e comentários no mesmo contexto.

O site possui temas claro e escuro. O tema claro é o padrão inicial, e a preferência escolhida fica memorizada no dispositivo.

## Fluxo operacional

1. Entre por `login.html` com uma conta habilitada.
2. Em `index.html`, preencha os dados do intervalo e monte as etapas.
3. Revise a linha do tempo e trave o cronograma.
4. Durante o intervalo, use `executar.html` para registrar somente horários e informações realizados.
5. Consulte `dashboard.html` para comparar o planejado com o realizado e analisar progresso, duração e desvios por etapa.
6. Use `gestao.html?view=history` para consultar intervalos concluídos dentro do escopo do perfil.

## Como o atraso é calculado

O indicador principal da execução, do dashboard e do acompanhamento compartilhado usa o **marco mais avançado da sequência operacional**. A sequência define a ordem lógica de início, mas não impede que etapas sejam concomitantes ou sobrepostas.

Regra por etapa:

| Situação da etapa | Comparação | Resultado |
|---|---|---|
| Concluída | término real vs. fim programado | negativo = adiantada, positivo = atrasada |
| Em andamento | início real vs. início programado | negativo = iniciou adiantada, positivo = iniciou atrasada |
| Não iniciada | não entra no indicador geral | aparece como aviso quando o início programado vence |

Enquanto uma etapa está em andamento, somente o início é um marco realizado. O sistema não inventa um término nem transforma automaticamente a etapa em atraso porque o relógio avançou. O consumo da duração e a projeção de término continuam visíveis separadamente.

Etapa que ainda não começou e já passou do horário planejado de **início** não entra no saldo (a régua é o prazo final), mas aparece como aviso próprio no painel e no cartão da etapa.

### Totalização sem contar o mesmo minuto duas vezes

Os totais não são uma soma aritmética dos desvios: cada etapa ocupa uma **janela de relógio**, e o total é a união dessas janelas.

- Etapa atrasada ocupa `[prazo final, prazo final + atraso]`.
- Etapa adiantada ocupa `[prazo final − adiantamento, prazo final]`.

Etapas **sequenciais** têm janelas disjuntas e portanto se somam normalmente. Etapas **simultâneas** se sobrepõem, e o trecho comum é contado uma vez só. Duas frentes 30 min além do próprio prazo dão **30 min** de atraso no total, não 60 — porque só 30 minutos de relógio se passaram. Quando há sobreposição, o painel avisa: *“já descontados os períodos simultâneos”*.

Esses totais permanecem como informação analítica. O status geral — **adiantado, dentro do prazo ou atrasado** — vem do marco mais avançado da sequência para evitar falsos atrasos em cronogramas concomitantes.

## Projeção de término

Ao lado do saldo, o site mostra **quando o intervalo deve terminar** pelo ritmo atual. Essa é a leitura de relógio, e ela não soma etapas simultâneas: o término vem do caminho mais longo. A projeção é montada etapa a etapa:

- Etapa concluída: usa o horário real de término.
- Etapa em andamento: assume, no mínimo, a duração planejada contada a partir do início real, e nunca termina antes de agora.
- Etapa ainda não iniciada: não pode começar antes de agora nem antes do fim projetado das etapas que o plano colocou à sua frente; etapas planejadas em paralelo continuam em paralelo.
- Etapa marcada como não executada: sai dos dois lados da conta, para que retirar escopo não vire adiantamento.

O **prazo final** da janela aparece em relógio próprio, com aviso quando a projeção ameaça ultrapassá-lo.

### Etapa em andamento

Cada etapa aberta traz duas leituras diferentes, que respondem a perguntas diferentes:

- **Posição na sequência** (o selo de desvio): início real contra início programado enquanto a etapa estiver aberta; depois de concluída, término real contra término programado.
- **Consumo da duração**: o tempo já em execução contra o previsto.

As duas são necessárias: uma etapa pode estar dentro do prazo porque começou antes do previsto e, ao mesmo tempo, já ter consumido mais tempo do que o estimado.

Consumir mais tempo que o previsto **não é, por si só, um problema**. Uma etapa que começou bem antes do horário planejado pode gastar mais e ainda entregar com folga; nesse caso a leitura é informativa, sem alarme:

> Em execução há 1h 40min de 1h 20min previstos · 20 min a mais que o previsto, **ainda 1h 00min antes do fim programado**

O destaque em vermelho aparece apenas quando a etapa passa do próprio fim programado:

> Em execução há 2h 00min de 1h 45min previstos · 15 min a mais que o previsto e **15 min além do fim programado**

## Dados e segurança no Supabase

As migrações mantêm as tabelas operacionais originais e ampliam o modelo de forma aditiva. Os principais objetos são:

- `user_profiles`: conta Auth, papel, habilitação e dados organizacionais reais.
- `organization_members`: diretório e hierarquia organizacional.
- `interval_plans` e `interval_steps`: cada linha de `interval_plans` é uma **frente de serviço**; `group_id` reúne as frentes do mesmo intervalo e `front_position`/`front_name` dão a elas ordem e nome. A linha guarda ainda plano, execução, status, responsáveis, revisões, empreiteira, encarregado e o encerramento.
- `datasets`: identificação do conjunto de dados real.
- `interval_comments`: comentários históricos com autoria e exclusão lógica.
- `interval_sync_receipts`: recibos de idempotência da sincronização offline.
- `interval_audit_log`: rastreabilidade das alterações relevantes de intervalos e comentários.
- `interval_share_links`: tokens temporários e revogáveis para acompanhamento externo.

As políticas RLS calculam o escopo a partir do usuário autenticado e da hierarquia: Diretor, Gerente Executivo, Consultor e Editor consultam toda a operação; Gerente consulta apenas sua equipe; Coordenador consulta e altera apenas os próprios intervalos. Diretor, Gerente Executivo e Consultor permanecem somente leitura. Permissões de tabela e coluna são concedidas explicitamente, separadas das políticas de linha.

## Frentes de serviço

Um bloqueio da via costuma abrigar mais de uma frente trabalhando ao mesmo tempo, cada uma com cronograma e execução próprios. O intervalo comporta até **12 frentes**, e o mesmo responsável cria todas elas.

O que descreve o **bloqueio** é único e vale para todas as frentes: nome do plano, data, janela e local. Alterar qualquer um deles em uma frente altera nas demais — a janela autorizada é uma só. O que é **da frente** fica isolado: nome da frente, tipo de serviço, etapas, observações e execução.

- No planejamento, a faixa de frentes fica abaixo do seletor de intervalos. **+ Frente** cria uma nova frente já com os dados do bloqueio preenchidos e o cronograma em branco.
- O rótulo da frente sai sempre de `front_position`, nunca da posição na lista: a exportação e o link compartilhado enxergam uma frente de cada vez e não teriam lista para indexar. Por isso o nome padrão é **derivado**, não gravado — e excluir uma frente renumera as restantes, para que posição e ordem continuem sendo a mesma coisa. Um nome próprio digitado em **Nome da frente** sempre tem prioridade.
- A frente nova ocupa a **menor posição livre** de 1 a 12, não o tamanho da lista mais um: a renumeração feita em outro aparelho pode ainda não ter sincronizado, e uma numeração com buraco faria duas frentes caírem na mesma posição e usarem o mesmo nome derivado. Posição fora da faixa é **recusada** por `sync_interval_plan`, com `INTERVAL_FRONT_POSITION_OUT_OF_RANGE` — antes ela era truncada em silêncio, e o cliente seguia acreditando no valor que pediu.
- Título, data, janela e local descrevem o bloqueio, não a frente, e o banco garante isso sozinho: uma frente nova **adota** os valores do grupo em vez de impô-los, e alterar qualquer um deles em uma frente desce para as irmãs pelo gatilho `interval_plans_propagate_group`. A propagação **preserva a revisão** das irmãs de propósito — incrementá-la faria as gravações que o cliente já tem na fila para elas chegarem com base velha, e a fila travaria em `SYNC_CONFLICT`.
- Na execução, a mesma faixa alterna entre as frentes; cada uma tem seu próprio indicador de atraso, projeção e comentários.
- No portal gerencial, um card representa o **intervalo inteiro**: o progresso soma as etapas de todas as frentes e o desvio exibido é o pior entre elas. A etiqueta “N frentes” identifica os bloqueios com mais de uma.
- No banco, a frente continua sendo uma linha de `interval_plans`. Todo o motor de projeção, dashboard, exportação e RLS segue valendo sem alteração.

O vínculo é protegido no banco: frentes do mesmo `group_id` precisam pertencer ao mesmo responsável, e uma frente não troca de intervalo depois de criada.

## Encerramento do intervalo

Terminar as etapas e encerrar o bloqueio são atos diferentes: entre um e outro ainda cabem devolução da via, pendência e restrição. Por isso o encerramento é explícito.

## Concessão do CCO e ajuste de início

Dois controles do planejamento mexem em horário sem mexer no mesmo horário, e ficam deliberadamente separados.

A **concessão do CCO** é tempo extra autorizado para o término. Fica em `cco_grant_minutes`, ao lado de `window_end` e não somada dentro dela: a janela é o que foi planejado, a concessão é o que o CCO liberou depois, e o relatório precisa mostrar as duas — somar antes de gravar apagaria de quem partiu cada horário. `cco_grant_unit` guarda apenas em que unidade o número foi digitado, para quem lançou "1 h" reler "1 h" e não "60". O prazo que vale passa a ser `window_end + concessão`: é contra ele que o saldo final da execução, a validação do cronograma, o cartão da execução, o card gerencial e o acompanhamento compartilhado são medidos. Pode ser registrada com o cronograma travado, porque ela não altera o programado.

O **ajuste de início** resolve o caso do bloqueio que abriu depois da hora: desloca a abertura da janela e todas as etapas — de todas as frentes do grupo, porque o bloqueio escorregou inteiro — pelo mesmo tanto, para a diferença não virar atraso etapa por etapa. O fim da janela não se move: esticar o prazo é papel da concessão. O ajuste deixa de valer assim que qualquer frente registra o primeiro horário real, porque deslocar o programado depois disso mudaria um desvio que já foi medido e já foi lido.

Com mais de uma frente, o encerramento passa a valer para o **intervalo**, não para a frente: o botão **Encerrar** só libera quando todas as frentes tiverem etapas resolvidas — concluídas ou marcadas como não executadas — e quem encerra é a frente que terminou por último; nas demais, o painel indica qual é ela.

No banco, a validação de `private.guard_interval_plan` olha as etapas de todas as frentes do grupo, e `public.close_interval(group_id)` grava `completed_at` em todas de uma vez. `public.finalize_interval_plan(plan_id)` continua existindo e delega para o grupo do plano informado — para intervalo de frente única, que é o caso de tudo que já estava gravado, o comportamento é idêntico ao anterior. As duas devolvem `fronts_detail`, com a revisão de cada frente: como o encerramento incrementa a revisão de todas, sem isso a cópia local das frentes que ninguém tocou ficaria para trás.

Quem encerrou fica registrado em `closed_by` e, legível, em `closed_by_name`. O nome é carimbado no momento do encerramento, e não resolvido na hora de exibir, por dois motivos: `closed_by` guarda um id de `auth.users` e a coluna `organization_members.auth_user_id` não está entre as que o perfil `authenticated` pode ler; e um registro histórico não deve mudar se a pessoa for renomeada ou desativada depois. É a mesma escolha que `interval_comments` já faz com o autor. O crédito aparece no painel de encerramento da execução, no detalhe gerencial, no acompanhamento compartilhado e nas duas exportações.

Depois disso o intervalo é histórico: a tela continua legível, mas nada mais é editável e o banco recusa gravações.

## Detecção de silêncio

Um intervalo em execução que **para de receber registro** costuma ser um intervalo com problema, não um intervalo sem novidade. Passados **20 minutos** sem nenhuma movimentação — horário realizado, alteração no plano ou comentário —, o sistema passa a exibir “Sem atualização há X”:

- no card do portal e no detalhe do intervalo, como aviso para a gestão;
- na própria execução, como lembrete para quem está em campo.

Na aba **Em execução** do portal, um contador discreto sobre o botão mostra quantos intervalos em andamento estão em atraso agora, com a explicação ao passar o mouse. É a resposta à primeira pergunta do gerente, dada antes de ele precisar procurar.

## Aplicativo instalável e uso sem sinal

A fila offline já garantia que o registro feito sem sinal não se perde; o que faltava era o passo anterior — sem rede, a página não abria. `manifest.webmanifest`, `sw.js` e `assets/pwa.js` resolvem isso: o app pode ser instalado na tela inicial e o service worker guarda o app shell no dispositivo.

- Navegação usa **rede primeiro**, para que um deploy novo apareça de imediato; o cache entra quando a rede falha.
- Arquivos estáticos usam **cache primeiro**, com atualização em segundo plano.
- **Nada do Supabase é cacheado.** Resposta de dados guardada localmente viraria informação velha exibida como atual, que é exatamente o erro que esta operação não pode cometer.
- Com a sessão expirada e sem rede, o `auth-guard` deixa de expulsar para o login: nenhuma chamada ao servidor passa mesmo, o RLS continua sendo quem autoriza, e o coordenador não perde o acesso ao que registrou offline. A sessão é revalidada assim que houver conexão.

Ao alterar CSS ou JavaScript, mantenha a constante `VERSION` de `sw.js` sincronizada com o parâmetro `?v=` dos arquivos HTML — é ela que invalida o cache antigo.

> O ícone `assets/icon.svg` atende Chrome, Edge e Android. Para cobrir todas as versões de iOS, vale gerar depois um PNG 192×192 e 512×512 a partir dele e acrescentá-lo ao manifesto.

## Comentários

Comentários podem ser registrados durante a execução por usuários operacionais autorizados. Cada registro guarda nome, perfil, conteúdo, data e hora. A criação também participa da fila offline.

O autor pode excluir logicamente o próprio comentário somente enquanto o intervalo ainda está em execução. Comentários de outros autores não podem ser removidos; depois da conclusão, todos se tornam parte permanente do histórico. Consultas e links compartilhados omitem conteúdo excluído.

## Funcionamento offline e outbox

Depois do primeiro login, alterações operacionais são gravadas imediatamente em `localStorage`, em uma área separada por usuário. O navegador mantém também uma outbox persistente por usuário e um identificador estável do dispositivo.

O ciclo de sincronização é:

1. salvar a versão local antes de qualquer chamada de rede;
2. colocar plano, etapas ou comentário na outbox com `operation_id` único;
3. chamar `sync_interval_plan` quando houver conexão;
4. validar a revisão esperada no servidor e gravar plano e etapas em uma transação;
5. registrar um recibo por usuário, dispositivo e operação para tornar reenvios idempotentes;
6. remover o item local somente depois da confirmação do Supabase.

Falhas transitórias usam novas tentativas com espera progressiva. Ao recuperar a conexão, voltar à aba ou reabrir a página, itens pendentes são retomados. Em conflito de revisão, a cópia local permanece preservada para revisão em vez de substituir silenciosamente a versão do servidor.

A interface informa estados como **Salvo**, **Sem conexão**, **Sincronizando**, **Pendente de sincronização**, **Sincronizado** e **Erro de sincronização**.

## Migrações Supabase

As migrações ficam em `supabase/migrations/` e devem ser aplicadas na ordem do timestamp. A expansão organizacional está em `20260821115809_expand_organizational_interval_management.sql`; as seguintes cobrem auditoria, `executive_manager`, hierarquia compartilhada entre Gerentes, solicitação de acesso, flexão de gênero, finalização explícita da execução e o escopo operacional do Gerente. As duas últimas mudam o modelo de forma relevante: `20260823090000_remove_sub_catalog.sql` **apaga** o catálogo de SUBs e as colunas `sub_id` (não há caminho de volta por migração), e `20260823100000_interval_fronts_weather_and_closure.sql` introduz frentes e o encerramento por intervalo. `20260824120000_remove_interval_weather.sql` retira o registro de clima, que nunca chegou a ser preenchido. `20260824190000_group_fields_and_front_position.sql` faz o banco garantir que as frentes de um grupo compartilhem título, data, janela e local, recusa posição de frente fora da faixa em vez de truncá-la, e passa a devolver a revisão de cada frente no encerramento. `20260824193000_record_who_closed_the_interval.sql` acrescenta `closed_by_name`. `20260825090000_cco_grant.sql` acrescenta a concessão do CCO e a inclui na propagação do grupo.

Com a CLI autenticada e o projeto correto vinculado:

```powershell
supabase db push --dry-run
supabase db push
```

Revise sempre o `--dry-run`, a lista de migrações pendentes e os advisors de segurança/desempenho antes de aplicar em produção. Não edite uma migração já aplicada; crie uma nova migração incremental. As tabelas do schema exposto usam RLS e concessões explícitas, pois exposição à Data API e autorização por linha são controles diferentes.

## Edge Functions

- `create-site-user`: endpoint autenticado usado pela Administração. Revalida o JWT, exige Editor habilitado, valida papel e hierarquia, permite provisionamento idempotente explícito de uma conta existente e mantém a chave administrativa somente no ambiente da função.
- `interval-share`: endpoint público por token de alta entropia. Aceita somente planos do dataset real, valida link, expiração, revogação e proprietário habilitado, e retorna uma projeção de dados somente leitura sem identificadores privados.
- `request-password-reset`: recebe uma solicitação neutra na tela de login e, somente para uma conta ativa, avisa o Editor por e-mail para que a senha seja alterada manualmente no Supabase.

Deploy pela CLI, preservando verificação JWT na função administrativa e desabilitando-a somente na função cujo próprio token é a credencial:

```powershell
supabase functions deploy create-site-user --use-api
supabase functions deploy interval-share --no-verify-jwt --use-api
supabase functions deploy request-password-reset --no-verify-jwt --use-api
```

Se o domínio do frontend mudar, atualize de forma consciente a lista de origens permitidas nas duas funções antes do deploy.

## Execução local

Não há instalação de dependências nem build. Sirva o diretório por HTTP para que navegação, armazenamento e CORS tenham o mesmo comportamento esperado do site publicado:

```powershell
python -m http.server 4173
```

Abra `http://localhost:4173/login.html`. As Edge Functions já aceitam as origens locais documentadas no código; abrir os arquivos diretamente por `file://` não é o fluxo suportado.

## Testes

Os testes de cálculo usam o runtime nativo do Node.js:

```powershell
node --test tests/*.test.js
```

Eles validam cenários de etapas simultâneas, seleção do marco operacional, encerramento, tempo decorrido, métricas gerenciais, filtros, capacidades por perfil, estrutura das páginas, RLS, hierarquia, histórico, fila offline e Edge Functions. `tests/fronts-and-closure.test.js` cobre especificamente frentes, propagação dos dados do bloqueio, detecção de silêncio, encerramento por intervalo, PWA e a ausência de SUB e de clima.

Antes de publicar, faça também um teste funcional com cada papel, confirmando a equivalência entre Gerente Executivo e Diretor, bloqueios de rota, escopo do Gerente, edição exclusiva de Coordenador/Editor, comentários, perda e retorno da conexão, link compartilhado revogado ou expirado e — no fluxo novo — criar duas frentes no mesmo intervalo, verificar que a janela alterada em uma vale para a outra, conferir o contador de atrasos na aba **Em execução** e encerrar o intervalo pela frente que terminou por último.

## Publicação no GitHub Pages

O workflow `.github/workflows/deploy-pages.yml` publica o conteúdo do repositório a cada push na branch `main` e também aceita execução manual. O fluxo faz checkout, configura Pages, envia o artefato estático e cria o deployment; não há etapa de build.

Após alterar CSS ou JavaScript, mantenha sincronizados os parâmetros de versão dos assets nos arquivos HTML **e a constante `VERSION` de `sw.js`** — com o service worker ativo, é ela que descarta o cache anterior. Depois do push, acompanhe o workflow **Deploy GitHub Pages** na aba Actions e valide as rotas principais no endereço publicado.

## Referências de produto

- Identidade visual baseada no brand book oficial da Rumo: paleta institucional, combinações de acessibilidade e Verdana como tipografia de sistema para HTML.
- Fluxo funcional derivado da planilha `00 - CronoAVF.xlsx`: planejado × executado, duração, produtividade/ritmo e visão de Gantt, reorganizados para uso operacional em telas menores.
- Catálogo de SUBs do Mapa Rumo 2020-V9 usado na primeira versão e retirado depois: o recorte nunca chegou a ser usado na operação e só sobrevivia como cadastro paralelo.
