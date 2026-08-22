# Gestão de Intervalo

Aplicação web para planejar, executar e acompanhar intervalos de manutenção de via permanente. O frontend é estático, responsivo e não exige etapa de build; a autenticação, a persistência, a hierarquia organizacional e as autorizações são fornecidas pelo Supabase. A publicação do frontend é feita pelo GitHub Pages.

## Arquitetura

| Camada | Responsabilidade | Arquivos principais |
|---|---|---|
| Fluxo operacional | Planejamento, execução, dashboard individual, conta, compartilhamento e sincronização offline | `index.html`, `executar.html`, `dashboard.html`, `conta.html`, `acompanhar.html`, `app.js` |
| Portal gerencial | Cards, filtros, histórico, dashboard geral, acompanhamento detalhado e modo de exemplos | `gestao.html`, `assets/portal.js` |
| Administração | Criação e edição de perfis, hierarquia Gerente → Coordenador, atribuição de múltiplas SUBs e cadastro de SUBs | `admin.html`, `assets/portal.js` |
| Identidade e interface | Login, proteção inicial de rotas, temas claro/escuro e estilos responsivos | `login.html`, `assets/auth-guard.js`, `styles.css` |
| Backend | Auth, Postgres, RLS, funções SQL, auditoria, dados demonstrativos e Edge Functions | `supabase/migrations/`, `supabase/functions/` |
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
| Editor | Toda a operação | Visão gerencial completa, ferramentas operacionais, Administração, gestão de usuários/SUBs e modo Exemplos |

Cada Coordenador deve possuir Gerente responsável, uma ou mais SUBs e classificação `infrastructure` ou `superstructure`. Cada intervalo continua associado a uma SUB específica dentre as atribuídas ao Coordenador. O Gerente Executivo é um perfil global somente leitura e não participa da relação hierárquica Gerente → Coordenador. Perfis legados incompletos são preservados com indicação de revisão, em vez de terem dados removidos silenciosamente.

## Páginas

- `login.html`: autenticação por e-mail e senha, validação da conta habilitada e solicitação administrativa de alteração de senha.
- `index.html`: criação e revisão do plano, montagem de etapas, linha do tempo, travamento do cronograma e exportação `.xlsx`.
- `executar.html`: registro dos horários e observações realizados, etapas não executadas, comentários e estado de sincronização.
- `dashboard.html`: indicadores e gráficos do intervalo selecionado, comparação Programado × Realizado e impressão preparada para PDF em A4 paisagem.
- `gestao.html`: portal com as áreas Em execução, Histórico e Dashboard geral. Inclui filtros por Gerente, Coordenador, SUB, classificação, status, prazo, tipo, período e texto livre.
- `admin.html`: área exclusiva do Editor para criar e editar usuários, vínculos e SUBs. SUBs deixam de ser excluídas e podem ser desativadas para preservar referências históricas.
- `conta.html`: mostra somente os dados do usuário autenticado e os atalhos permitidos. Para Editor, oferece Administração e o botão **Exemplos**.
- `acompanhar.html`: acompanhamento público somente leitura por link temporário, revogável e protegido por token.

Os cards gerenciais mostram título, local, Gerente, Coordenador, SUB, classificação, tipo, janela, progresso, status e desvio. Ao abrir um card, a Página de Acompanhamento reúne Plano, Execução, Dashboard e comentários no mesmo contexto.

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
- `organization_members`: diretório e hierarquia por dataset, incluindo personas sem conta Auth no ambiente demonstrativo.
- `coordinator_sub_assignments`: relação muitos-para-muitos entre cada Coordenador e as SUBs sob sua responsabilidade.
- `subs`: catálogo administrável das 103 SUBs identificadas no mapa utilizado como fonte, mais futuras inclusões administrativas.
- `datasets`: separação explícita entre `real` e `demo`.
- `interval_plans` e `interval_steps`: plano, execução, status, responsáveis, revisões e etapas independentes.
- `interval_comments`: comentários históricos com autoria e exclusão lógica.
- `interval_sync_receipts`: recibos de idempotência da sincronização offline.
- `interval_audit_log`: rastreabilidade das alterações relevantes de intervalos e comentários.
- `interval_share_links`: tokens temporários e revogáveis para acompanhamento externo.

As políticas RLS calculam o escopo a partir do usuário autenticado e da hierarquia: Diretor, Gerente Executivo, Consultor e Editor consultam toda a operação; Gerente consulta apenas sua equipe; Coordenador consulta e altera apenas os próprios intervalos. Diretor, Gerente Executivo e Consultor permanecem somente leitura. Permissões de tabela e coluna são concedidas explicitamente, separadas das políticas de linha.

## Modo Exemplos

O botão **Exemplos**, disponível em Minha Conta para o Editor, abre um conjunto demonstrativo preenchido com todos os papéis, inclusive Gerente Executivo, Gerentes, Coordenadores, classificações, SUBs, intervalos simultâneos, atrasados, adiantados, concluídos, comentários e dashboards.

O isolamento não depende de uma simples filtragem visual:

- dados reais e exemplos possuem `dataset_id` distintos;
- cabeçalhos de contexto demonstrativo só são reconhecidos pelo banco para uma conta real de Editor habilitada;
- personas demonstrativas existem em `organization_members`, sem criar contas em `auth.users`;
- RLS filtra consultas, métricas, históricos e diretórios pelo dataset corrente;
- gravações de planos e comentários demonstrativos ficam desabilitadas;
- um banner persistente identifica o ambiente e permite alternar a persona visualizada;
- ao sair, o contexto demonstrativo é removido da sessão e o portal retorna imediatamente aos dados reais.

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

As migrações ficam em `supabase/migrations/` e devem ser aplicadas na ordem do timestamp. A expansão organizacional está em `20260821115809_expand_organizational_interval_management.sql`; `20260821133000_complete_sub_catalog.sql` completa o catálogo com as SUBs 100–103 sem alterar as anteriores. As migrações seguintes cobrem o índice da auditoria por autor, o bootstrap das personas demo sob RLS com privilégios do próprio chamador, a inclusão segura de `executive_manager`, o preenchimento do escopo organizacional de planos legados e a atribuição protegida de múltiplas SUBs por Coordenador.

Com a CLI autenticada e o projeto correto vinculado:

```powershell
supabase db push --dry-run
supabase db push
```

Revise sempre o `--dry-run`, a lista de migrações pendentes e os advisors de segurança/desempenho antes de aplicar em produção. Não edite uma migração já aplicada; crie uma nova migração incremental. As tabelas do schema exposto usam RLS e concessões explícitas, pois exposição à Data API e autorização por linha são controles diferentes.

## Edge Functions

- `create-site-user`: endpoint autenticado usado pela Administração. Revalida o JWT, exige Editor habilitado, valida papel, hierarquia e todas as SUBs atribuídas, permite provisionamento idempotente explícito de uma conta existente e mantém a chave administrativa somente no ambiente da função.
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

Eles validam cenários de etapas simultâneas, seleção do marco operacional, encerramento, tempo decorrido, métricas gerenciais, filtros, capacidades por perfil, estrutura das páginas, RLS, hierarquia, histórico, fila offline e Edge Functions. Antes de publicar, faça também um teste funcional com cada papel, confirmando a equivalência entre Gerente Executivo e Diretor, bloqueios de rota, escopo do Gerente, edição exclusiva de Coordenador/Editor, comentários, alternância real/demo, perda e retorno da conexão e link compartilhado revogado ou expirado.

## Publicação no GitHub Pages

O workflow `.github/workflows/deploy-pages.yml` publica o conteúdo do repositório a cada push na branch `main` e também aceita execução manual. O fluxo faz checkout, configura Pages, envia o artefato estático e cria o deployment; não há etapa de build.

Após alterar CSS ou JavaScript, mantenha os parâmetros de versão dos assets nos arquivos HTML sincronizados para evitar cache antigo. Depois do push, acompanhe o workflow **Deploy GitHub Pages** na aba Actions e valide as rotas principais no endereço publicado.

## Referências de produto

- Identidade visual baseada no brand book oficial da Rumo: paleta institucional, combinações de acessibilidade e Verdana como tipografia de sistema para HTML.
- Fluxo funcional derivado da planilha `00 - CronoAVF.xlsx`: planejado × executado, duração, produtividade/ritmo e visão de Gantt, reorganizados para uso operacional em telas menores.
- Catálogo inicial de SUBs derivado do Mapa Rumo 2020-V9, preservando todas as 103 identificações encontradas no documento.
