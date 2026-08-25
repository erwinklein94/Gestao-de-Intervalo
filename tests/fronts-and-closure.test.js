"use strict";

// Frentes de servico, deteccao de silencio, encerramento explicito, PWA e
// remocao da SUB.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function loadAppApi() {
  const sandbox = {
    console,
    crypto: { randomUUID: () => `id-${Math.random().toString(16).slice(2)}` },
    document: { body: { dataset: { page: "test" } }, addEventListener: () => {} },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    navigator: { onLine: true },
    setTimeout,
    clearTimeout,
    window: { __GESTAO_TEST_MODE__: true, __GESTAO_USER_ID__: null, addEventListener: () => {} }
  };
  sandbox.window.window = sandbox.window;
  vm.runInNewContext(read("app.js"), sandbox, { filename: "app.js" });
  return sandbox.window.__GESTAO_TEST_API__;
}

function loadPortalApi() {
  const sandbox = {
    console,
    crypto: { randomUUID: () => "test-id" },
    document: {},
    window: { __GESTAO_TEST_MODE__: true }
  };
  sandbox.window.window = sandbox.window;
  vm.runInNewContext(read("assets/portal.js"), sandbox, { filename: "assets/portal.js" });
  return sandbox.window.__GESTAO_PORTAL_TEST_API__;
}

const stampLocal = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

// Comentario explica o que o codigo faz; so o codigo em si vale como prova.
const stripJsComments = (source) => source.replace(/^\s*\/\/.*$/gm, "");
const stripSqlComments = (source) => source.replace(/^\s*--.*$/gm, "");

test("intervalo novo nasce como frente única dona do próprio grupo", () => {
  const api = loadAppApi();
  const plano = api.blankPlan("Renovação km 141");
  assert.equal(plano.groupId, plano.id);
  assert.equal(plano.frontPosition, 1);
});

test("frentes do mesmo intervalo se enxergam e recebem rótulo em ordem", () => {
  const api = loadAppApi();
  const primeira = api.blankPlan("Renovação km 141");
  const segunda = api.blankPlan("Renovação km 141", { groupId: primeira.groupId, frontPosition: 2 });
  api.setStore({ version: 4, activePlanId: primeira.id, plans: [primeira, segunda], deletedPlanIds: [] });
  assert.equal(api.frontsOf(primeira).length, 2);
  assert.equal(api.frontLabel(primeira), "Frente 1");
  assert.equal(api.frontLabel(segunda), "Frente 2");
  segunda.frontName = "  Frente sul  ";
  assert.equal(api.frontLabel(segunda), "Frente sul", "nome informado tem prioridade e vem aparado");
});

test("o rótulo da frente sai da posição gravada, não do índice na lista", () => {
  const api = loadAppApi();
  const portal = loadPortalApi();

  // A exportação e o link compartilhado veem uma frente de cada vez e não têm
  // lista para indexar. Se o rótulo dependesse da lista, a mesma frente teria
  // um nome na tela e outro no Excel.
  const solta = { frontName: "", frontPosition: 3 };
  assert.equal(api.frontLabel(solta), "Frente 3", "o rótulo não pode depender do store");
  assert.equal(
    portal.frontLabel({ front_name: "", front_position: 3 }),
    api.frontLabel(solta),
    "app e portal precisam dizer o mesmo nome"
  );

  // A página compartilhada aplica a mesma regra sobre a linha que recebe.
  const compartilhada = read("app.js").split("const sharedFront =")[1].split(";")[0];
  assert.ok(
    /plan\.frontPosition/.test(compartilhada) && !/frontsOf/.test(compartilhada),
    "o acompanhamento compartilhado deve usar a posição gravada"
  );
  assert.ok(
    !/frontLabel\([^)]+,/.test(read("app.js")) && !/frontLabel\([^)]+,/.test(read("assets/portal.js")),
    "frontLabel não deve mais receber lista nem índice"
  );
});

test("nova frente nasce sem nome gravado e em posição contígua", () => {
  const app = read("app.js");
  // Gravar "Frente 2" como texto congelaria o rótulo: depois de uma exclusão
  // ele deixaria de acompanhar a numeração.
  assert.ok(!/frontName: `Frente \$\{/.test(app), "o nome padrão não pode ser materializado");
  // A posição saía de fronts.length + 1, que só está certo enquanto a
  // numeração é contígua — e ela não é, quando a exclusão feita em outro
  // aparelho ainda não sincronizou. Agora sai da menor vaga livre.
  assert.ok(/frontPosition: posicao/.test(app), "a posição nova deve vir da menor vaga livre");
  assert.ok(!/frontPosition: fronts\.length \+ 1/.test(app), "a posição não pode voltar a sair do tamanho da lista");
  assert.ok(!/Math\.max\(\.\.\.fronts\.map/.test(app), "posição por max deixaria buracos e estouraria o teto de 12");
});

test("excluir uma frente mantém o bloqueio e renumera o grupo", () => {
  const app = read("app.js");
  // Recorta só o handler de exclusão: o bootstrap tem um fallback legítimo
  // para o primeiro plano quando o plano ativo salvo deixou de existir.
  const exclusao = app.split('$("#delete-plan-button").addEventListener')[1].split("\n    });")[0];
  assert.ok(
    exclusao.includes("const irmas = fronts.filter((item) => item.id !== plan.id);"),
    "a exclusão precisa conhecer as frentes irmãs"
  );
  assert.ok(
    exclusao.includes("store.activePlanId = (irmas[0] || store.plans[0]).id;"),
    "quem excluiu uma frente deve continuar no mesmo intervalo"
  );
  assert.ok(
    /irmas\.forEach\(\(front, index\) => \{[\s\S]*front\.frontPosition = index \+ 1;/.test(exclusao),
    "as frentes restantes precisam ser renumeradas"
  );
  assert.ok(
    !/store\.activePlanId = store\.plans\[0\]\.id;/.test(exclusao),
    "o salto direto para o primeiro plano da lista deve sumir da exclusão"
  );
});

test("o botão de encerrar só fica clicável quando o encerramento é possível", () => {
  const app = read("app.js");
  const fechamento = app.split("function renderClosing()")[1].split("\n    }")[0];
  assert.ok(fechamento.includes("finishButton.disabled = !podeEncerrar;"), "renderClosing deve governar o botão");
  assert.ok(
    /state\.ready[\s\S]*!state\.closed[\s\S]*state\.fronts\.length === 1 \|\| state\.last\?\.front\.id === plan\.id/.test(fechamento),
    "a liberação depende de todas as frentes prontas e de ser a última a concluir"
  );
  // Nada pode reabilitar o botão por fora e apagar a regra.
  assert.ok(
    !/if \(finishButton\) finishButton\.disabled = false;/.test(app),
    "renderPage não pode reabilitar o botão"
  );
  const erro = app.split("Não foi possível finalizar a execução.")[1].split("});")[0];
  assert.ok(!/finishButton\.disabled = false/.test(erro), "o caminho de erro deve devolver o botão via renderClosing");
});

test("dados do bloqueio se propagam entre frentes; dados da frente não", () => {
  const api = loadAppApi();
  const primeira = api.blankPlan("Original");
  const segunda = api.blankPlan("Original", { groupId: primeira.groupId, frontPosition: 2 });
  api.setStore({ version: 4, activePlanId: primeira.id, plans: [primeira, segunda], deletedPlanIds: [] });

  primeira.title = "Renovação km 200";
  primeira.location = "km 200+000";
  // A janela e reancorada na data do plano ao propagar, entao a assercao olha
  // o relogio: prender a data faria o teste quebrar na virada do dia.
  primeira.windowEnd = `${primeira.date}T05:00`;
  assert.equal(api.propagateSharedFields(primeira), true);
  assert.equal(segunda.title, "Renovação km 200");
  assert.equal(segunda.location, "km 200+000");
  assert.equal(segunda.windowEnd.slice(-5), "05:00");
  assert.equal(segunda.windowEnd, primeira.windowEnd);

  segunda.serviceType = "Socaria";
  segunda.notes = "só desta frente";
  api.propagateSharedFields(segunda);
  assert.notEqual(primeira.serviceType, "Socaria");
  assert.notEqual(primeira.notes, "só desta frente");
});

test("plano gravado antes das frentes vira frente única e perde a SUB", () => {
  const api = loadAppApi();
  const legado = { id: "legado-1", title: "Antigo", steps: [], subId: "42" };
  api.normalizePlan(legado);
  assert.equal(legado.groupId, "legado-1");
  assert.equal(legado.frontPosition, 1);
  assert.ok(!("subId" in legado), "subId legado deve ser descartado");
});

test("payload de sincronização leva frente e não leva sub_id nem clima", () => {
  const api = loadAppApi();
  const plano = api.blankPlan("Intervalo", { ownerId: "user-1", frontPosition: 2, frontName: "Frente sul" });
  const payload = api.planToDatabase(plano);
  assert.equal(payload.group_id, plano.groupId);
  assert.equal(payload.front_position, 2);
  assert.equal(payload.front_name, "Frente sul");
  assert.ok(!("sub_id" in payload), "sub_id não deve mais ser enviado");
  for (const campo of ["weather", "weather_note", "weather_recorded_at"]) {
    assert.ok(!(campo in payload), `${campo} saiu do produto e não pode voltar no payload`);
  }
});

test("leitura do banco reconstrói a frente", () => {
  const api = loadAppApi();
  const plano = api.databaseToPlan({
    client_id: "c1", id: "db1", group_id: "g1", front_position: 3, front_name: "Frente A", interval_steps: []
  });
  assert.equal(plano.groupId, "g1");
  assert.equal(plano.frontPosition, 3);
  assert.equal(plano.frontName, "Frente A");
  assert.ok(!("weather" in plano), "o plano não deve mais carregar clima");
});

test("silêncio só acusa intervalo em execução parado além do limite", () => {
  const api = loadAppApi();
  const antigo = new Date(Date.now() - 40 * 60000);
  const parado = {
    updatedAt: antigo.toISOString(), completedAt: null, status: "executing",
    steps: [{ actualStart: stampLocal(antigo), actualEnd: "" }]
  };
  assert.ok(api.silenceMinutes(parado) >= 39, "40 minutos sem registro devem acusar silêncio");

  const agora = new Date();
  const ativo = {
    updatedAt: agora.toISOString(), completedAt: null, status: "executing",
    steps: [{ actualStart: stampLocal(agora), actualEnd: "" }]
  };
  assert.equal(api.silenceMinutes(ativo), null);
  assert.equal(api.silenceMinutes({ ...parado, completedAt: antigo.toISOString() }), null, "intervalo encerrado não fica em silêncio");
  assert.equal(api.silenceMinutes({ ...parado, steps: [] }), null, "intervalo sem execução não fica em silêncio");
});

test("portal agrupa frentes em um intervalo e herda a pior leitura", () => {
  const api = loadPortalApi();
  const agora = new Date("2026-08-23T05:00:00");
  const base = {
    group_id: "g1", interval_date: "2026-08-23", window_start: "2026-08-23T01:00:00",
    window_end: "2026-08-23T04:00:00", status: "executing", coordinator_type: "infrastructure",
    updated_at: "2026-08-23T04:58:00"
  };
  const step = (extra) => Object.assign({
    position: 0, activity_name: "Etapa", planned_start: "2026-08-23T02:00:00",
    planned_end: "2026-08-23T03:00:00", actual_start: null, actual_end: null,
    actual_notes: "", status: "pending"
  }, extra);

  const frenteConcluida = { ...base, id: "p1", front_position: 1, interval_steps: [step({ actual_start: "2026-08-23T02:00:00", actual_end: "2026-08-23T03:00:00", status: "completed" })] };
  const frenteAtrasada = { ...base, id: "p2", front_position: 2, front_name: "Frente sul", interval_steps: [step({ actual_start: "2026-08-23T02:30:00", status: "running", planned_end: "2026-08-23T04:30:00" })] };
  const avulso = { ...base, group_id: "g2", id: "p3", front_position: 1, interval_steps: [step({ actual_start: "2026-08-23T02:00:00", status: "running" })] };

  const grupos = api.groupPlans([frenteAtrasada, frenteConcluida, avulso]);
  assert.equal(grupos.length, 2, "três frentes em dois bloqueios");
  const bloqueio = grupos.find((grupo) => grupo.id === "g1");
  assert.deepEqual(Array.from(bloqueio.fronts, (front) => front.id), ["p1", "p2"], "frentes vêm na ordem da posição");

  const metrics = api.groupMetrics(bloqueio, agora);
  assert.equal(metrics.steps, 2);
  assert.equal(metrics.resolved, 1);
  assert.equal(metrics.progress, 50);
  assert.equal(metrics.status, "executing");
  assert.equal(metrics.variance, 30, "o intervalo herda o pior desvio entre as frentes");
  assert.equal(metrics.deadline, "late");
});

test("card agrupado usa o mesmo marco da pagina de acompanhamento", () => {
  const api = loadPortalApi();
  const step = (position, plannedStart, plannedEnd, actualStart) => ({
    position, activity_name: `Etapa ${position + 1}`, planned_start: plannedStart,
    planned_end: plannedEnd, actual_start: actualStart, actual_end: null,
    actual_notes: "", status: "running"
  });
  const base = {
    group_id: "raquel", interval_date: "2026-08-25", window_start: "2026-08-25T08:00:00",
    window_end: "2026-08-25T18:00:00", status: "executing", updated_at: "2026-08-25T11:15:00"
  };
  const group = api.groupPlans([
    { ...base, id: "141200", front_position: 1, interval_steps: [step(0, "2026-08-25T10:00:00", "2026-08-25T10:40:00", "2026-08-25T08:58:00")] },
    { ...base, id: "141800", front_position: 2, interval_steps: [step(0, "2026-08-25T10:30:00", "2026-08-25T10:50:00", "2026-08-25T08:55:00")] }
  ])[0];
  const metrics = api.groupMetrics(group, new Date("2026-08-25T11:15:00"));
  assert.equal(metrics.variance, -62, "o grupo herda a frente menos adiantada, sem atraso correndo pelo fim aberto");
  assert.equal(metrics.deadline, "ahead");
  assert.match(api.cardMarkup(group), /Adiantado/);
});

test("intervalo só é concluído quando todas as frentes são", () => {
  const api = loadPortalApi();
  const frente = (status) => ({ id: `p-${status}`, group_id: "g", status, front_position: 1, interval_steps: [], updated_at: "2026-08-23T04:00:00" });
  const parcial = { id: "g", fronts: [frente("completed"), frente("executing")], lead: frente("completed") };
  assert.equal(api.groupMetrics(parcial, new Date("2026-08-23T05:00:00")).status, "executing");
  const inteiro = { id: "g", fronts: [frente("completed"), { ...frente("completed"), id: "p2" }], lead: frente("completed") };
  assert.equal(api.groupMetrics(inteiro, new Date("2026-08-23T05:00:00")).status, "completed");
});

test("resumo gerencial conta intervalos e frentes separadamente", () => {
  const api = loadPortalApi();
  const frente = (id, group) => ({ id, group_id: group, status: "executing", interval_date: "2026-08-23", service_type: "Socaria", coordinator_type: "infrastructure", interval_steps: [] });
  const resumo = api.managementSummary([frente("a", "g1"), frente("b", "g1"), frente("c", "g2")]);
  assert.deepEqual(Array.from(resumo.kpis.find((kpi) => kpi[0] === "Total de intervalos")), ["Total de intervalos", 2]);
  assert.deepEqual(Array.from(resumo.kpis.find((kpi) => kpi[0] === "Frentes de serviço")), ["Frentes de serviço", 3]);
});

test("estrutura das telas de frente e encerramento", () => {
  const planning = read("index.html");
  for (const marca of ['id="front-strip"', 'id="front-count"', 'name="frontName"', 'name="location"']) {
    assert.ok(planning.includes(marca), `planejamento: ausente ${marca}`);
  }
  const execution = read("executar.html");
  for (const marca of [
    'id="front-strip"',
    'id="execution-silence"', 'id="execution-finish-panel"', 'id="closing-fronts"',
    'id="finish-execution-button"', 'id="closing-description"'
  ]) {
    assert.ok(execution.includes(marca), `execução: ausente ${marca}`);
  }
  const app = read("app.js");
  for (const marca of [
    'cloudClient.rpc("finalize_interval_plan"',
    "function closingState()",
    "const SHARED_INTERVAL_FIELDS",
    "if (plan.completedAt) continue;"
  ]) {
    assert.ok(app.includes(marca), `app.js: ausente ${marca}`);
  }
});

test("preencher data e hora não é interrompido por redesenho", () => {
  const app = read("app.js");

  // A atualização automática troca a store inteira e redesenha a página. Como
  // o updated_at local nunca coincide com o do servidor depois de salvar, isso
  // caía logo após cada edição e apagava o campo meio preenchido.
  const refresh = app.split("async function refreshCloudStore()")[1].split("\n  }")[0];
  assert.ok(refresh.includes("if (isEditingField()) return;"), "a atualização precisa esperar o campo ser liberado");
  assert.ok(app.includes("function isEditingField()"), "falta o teste de campo em edição");
  assert.ok(
    /\["INPUT", "TEXTAREA", "SELECT"\]\.includes\(active\.tagName\)/.test(app),
    "campo de texto, área de texto e seletor contam como edição em curso"
  );

  // O change dispara durante o blur: redesenhar ali mata o campo que o Tab
  // acabou de escolher.
  assert.ok(app.includes("function preserveFocusWithin(root, render)"), "falta o auxiliar que devolve o foco");
  assert.ok(/setSelectionRange\(start, end\)/.test(app), "o cursor precisa voltar para onde estava");
  assert.ok(
    (app.match(/preserveFocusWithin\(/g) || []).length >= 4,
    "os redesenhos de etapa precisam passar pelo auxiliar"
  );
  assert.ok(
    !/^      renderSteps\(\);$/m.test(app.split("function renderPage()")[1] || ""),
    "renderPage não pode redesenhar as etapas sem preservar o foco"
  );

  // Planejamento e execução adiam o redesenho para o foco assentar.
  const planejamento = app.split('stepsRoot.addEventListener("change"')[1].split("});")[0];
  assert.ok(/setTimeout\(\(\) => \{[\s\S]*preserveFocusWithin\(stepsRoot, renderSteps\)/.test(planejamento), "o planejamento deve adiar o redesenho");
  assert.ok(app.includes("function agendarRedesenho()"), "a execução deve adiar o redesenho");
});

test("o acompanhamento liga as frentes do mesmo bloqueio", () => {
  const shared = read("acompanhar.html");
  for (const marca of ['id="shared-front-bar"', 'id="shared-front-strip"', 'id="shared-front-count"']) {
    assert.ok(shared.includes(marca), `acompanhamento: ausente ${marca}`);
  }

  const app = read("app.js");
  assert.ok(app.includes("function renderSharedFronts()"), "a página precisa desenhar a faixa de frentes");
  assert.ok(app.includes("function selectSharedFront(key)"), "trocar de frente precisa ser uma ação da página");
  assert.ok(/bar\.hidden = sharedFronts\.length < 2;/.test(app), "com uma frente só a faixa não aparece");
  // O link publico manda a frente escolhida; o modo autenticado troca o plano.
  assert.ok(/body: JSON\.stringify\(activeFront \? \{ token, front: activeFront \} : \{ token \}\)/.test(app), "o token precisa carregar a frente escolhida");
  assert.ok(/url\.searchParams\.set\("front", key\)/.test(app), "a frente escolhida deve ficar na URL");
  assert.ok(/url\.searchParams\.set\("plan", key\)/.test(app), "no modo autenticado a troca é por plano");
  assert.ok(/\.eq\("group_id", plan\.group_id \|\| plan\.id\)/.test(app), "as irmãs vêm pelo group_id, sob a mesma RLS");
  // Quem serve a frente e a funcao: o cliente segue a decisao dela.
  assert.ok(/activeFront = payload\.plan\?\.client_id \|\| "";/.test(app), "a faixa deve seguir a frente que a função devolveu");

  const edge = read("supabase/functions/interval-share/index.ts");
  assert.ok(edge.includes('.eq("group_id", anchor.group_id)'), "a função precisa enxergar o bloqueio inteiro");
  assert.ok(
    edge.includes("groupPlans.find((front) => front.client_id === requestedFront)"),
    "a frente pedida é resolvida dentro do grupo"
  );
  assert.ok(
    /ownerMember\.id === anchor\.coordinator_member_id/.test(edge),
    "a autorização do dono continua ancorada na frente do link"
  );
  assert.ok(/const fronts = groupPlans\.map\(/.test(edge), "a lista de frentes deve ser montada para a navegação");
  assert.ok(!/fronts = groupPlans\.map\([\s\S]{0,400}interval_steps/.test(edge), "a lista de frentes não pode carregar etapas");
});

test("PWA registra service worker, manifesto e ícone próprios", () => {
  const manifest = JSON.parse(read("manifest.webmanifest"));
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.scope, "./");
  assert.ok(manifest.icons.length >= 1, "manifesto precisa declarar ícone");
  assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"), "manifesto precisa de ícone maskable");

  const sw = read("sw.js");
  for (const marca of [
    "self.addEventListener(\"install\"",
    "self.addEventListener(\"activate\"",
    "self.addEventListener(\"fetch\"",
    "if (url.origin !== self.location.origin) return;",
    "networkFirst",
    "cacheFirst"
  ]) {
    assert.ok(sw.includes(marca), `sw.js: ausente ${marca}`);
  }
  // A biblioteca do Supabase é asset nosso e entra no pré-cache; o que não
  // pode entrar é resposta de dados da API, que viraria informação velha
  // exibida como atual. O corte por origem acima é o que garante isso.
  assert.ok(!/supabase\.co/i.test(sw), "o service worker não pode conhecer o endpoint de dados");
  assert.ok(stripJsComments(sw).includes("assets/supabase.min.js"), "a biblioteca precisa estar disponível offline");

  for (const page of ["index.html", "executar.html", "dashboard.html", "gestao.html", "admin.html", "conta.html", "login.html", "acompanhar.html", "recuperar-senha.html"]) {
    const source = read(page);
    assert.ok(source.includes('rel="manifest"'), `${page}: manifesto não declarado`);
    assert.ok(source.includes("assets/pwa.js"), `${page}: registro do service worker ausente`);
  }

  const guard = read("assets/auth-guard.js");
  assert.ok(guard.includes("navigator.onLine"), "sem rede, a sessão expirada não pode expulsar para o login");
});

test("a SUB não existe mais em código, telas nem sincronização", () => {
  for (const file of ["index.html", "executar.html", "gestao.html", "admin.html", "conta.html", "app.js", "assets/portal.js"]) {
    const source = read(file);
    assert.ok(!/\bsub_id\b/.test(source), `${file} ainda cita sub_id`);
    assert.ok(!/Selecione a SUB/.test(source), `${file} ainda oferece escolha de SUB`);
  }
  const removal = read("supabase/migrations/20260823090000_remove_sub_catalog.sql");
  for (const marca of [
    "alter table public.interval_plans drop column if exists sub_id;",
    "alter table public.user_profiles drop column if exists sub_id;",
    "alter table public.organization_members drop column if exists sub_id;",
    "drop table if exists public.coordinator_sub_assignments;",
    "drop table if exists public.subs;",
    "drop trigger if exists user_profiles_sync_primary_coordinator_sub on public.user_profiles;"
  ]) {
    assert.ok(removal.includes(marca), `migração de remoção: ausente ${marca}`);
  }
  const funcoesReescritas = stripSqlComments(removal).split("alter table public.interval_plans drop column")[0];
  assert.ok(!/sub_id/.test(funcoesReescritas), "as funções reescritas não podem mais citar sub_id");
});

test("o clima saiu do produto inteiro", () => {
  // A pergunta abria a execução e nunca foi respondida: zero registros nas três
  // colunas. Sem alimentação não vira indicador nem explica desvio, e ocupava o
  // topo da tela que o coordenador usa com pressa.
  for (const file of [
    "app.js", "assets/portal.js", "executar.html", "styles.css",
    "supabase/functions/interval-share/index.ts"
  ]) {
    const source = read(file);
    assert.ok(!/weather/i.test(source), `${file} ainda cita clima`);
  }
  assert.ok(!/Como está o clima/.test(read("executar.html")), "o painel de clima deve ter saído da execução");

  const removal = read("supabase/migrations/20260824120000_remove_interval_weather.sql");
  for (const marca of [
    "drop column if exists weather,",
    "drop column if exists weather_note,",
    "drop column if exists weather_recorded_at;",
    "create or replace function public.sync_interval_plan("
  ]) {
    assert.ok(removal.includes(marca), `migração de remoção do clima: ausente ${marca}`);
  }
  // A sincronizacao reescrita nao pode citar as colunas que acabaram de cair.
  const sync = stripSqlComments(removal).split("alter table public.interval_plans")[0];
  assert.ok(!/weather/.test(sync), "a sincronização reescrita não pode mais citar clima");
  // E nao pode ter levado junto o que divide a tela com ele.
  for (const preservado of ["front_position", "front_name", "group_id", "contractor_name", "foreman_name"]) {
    assert.ok(sync.includes(preservado), `a remoção do clima não pode levar ${preservado} junto`);
  }
});

test("encerramento vale para o intervalo inteiro, não para a frente", () => {
  const fronts = read("supabase/migrations/20260823100000_interval_fronts_weather_and_closure.sql");
  for (const marca of [
    "add column if not exists group_id uuid",
    "add column if not exists front_position integer not null default 1",
    "check (front_position between 1 and 12)",
    "create or replace function public.close_interval(p_group_id uuid)",
    "INTERVAL_HAS_OPEN_STEPS",
    "INTERVAL_FRONT_WITHOUT_STEPS",
    "Este intervalo pertence a outro responsavel.",
    "Um intervalo comporta no maximo 12 frentes.",
    "new.group_id := old.group_id;"
  ]) {
    assert.ok(fronts.includes(marca), `migração de frentes: ausente ${marca}`);
  }

  // A validacao da finalizacao passou a olhar o grupo: encerrar uma frente
  // sozinha deixaria o bloqueio meio fechado no historico.
  const guard = fronts.split("create or replace function private.guard_interval_plan")[1].split("$function$;")[0];
  assert.ok(guard.includes("where front.group_id = old.group_id"), "a finalização precisa validar todas as frentes do grupo");
  assert.ok(!/step\.plan_id = old\.id/.test(guard), "a validação não pode mais olhar só a linha finalizada");

  // finalize_interval_plan continua existindo e delega para o grupo, para nao
  // quebrar quem ja chamava a RPC por plano.
  const finalize = fronts.split("create or replace function public.finalize_interval_plan")[1];
  assert.ok(finalize.includes("public.close_interval(target.group_id)"), "a finalização por plano deve delegar para o intervalo");
});

test("a frente nova ocupa a menor vaga livre, não o tamanho da lista", () => {
  const api = loadAppApi();
  // Buraco na numeração: outro aparelho apagou a Frente 2 e a renumeração
  // ainda não chegou. Com fronts.length + 1 a nova cairia na posição 3, junto
  // com uma que já existe, e as duas se chamariam "Frente 3".
  assert.equal(api.nextFrontPosition([{ frontPosition: 1 }, { frontPosition: 3 }]), 2);
  assert.equal(api.nextFrontPosition([{ frontPosition: 1 }, { frontPosition: 2 }]), 3);
  assert.equal(api.nextFrontPosition([]), 1);
  // Doze ocupadas: não existe décima terceira posição para pedir ao banco.
  const cheio = Array.from({ length: 12 }, (_, indice) => ({ frontPosition: indice + 1 }));
  assert.equal(api.nextFrontPosition(cheio), null);
  // E o limite é o mesmo dos dois lados.
  const app = stripJsComments(read("app.js"));
  assert.ok(app.includes("const MAX_FRONTS = 12;"), "o limite do cliente precisa continuar em 12");
  assert.ok(!app.includes("frontPosition: fronts.length + 1"), "a posição não pode voltar a sair do tamanho da lista");
});

test("o banco recusa posição fora da faixa em vez de truncar em silêncio", () => {
  const sql = stripSqlComments(read("supabase/migrations/20260824190000_group_fields_and_front_position.sql"));
  assert.ok(!sql.includes("least(12"), "o clamp silencioso não pode voltar: ele grava 12 e responde sucesso");
  assert.ok(sql.includes("INTERVAL_FRONT_POSITION_OUT_OF_RANGE"), "posição fora da faixa precisa levantar erro");
  assert.ok(sql.includes("coalesce(requested_front_position, front_position)"), "a atualização deve usar a posição validada");
});

test("frente concluída não é alterada pela propagação nem enfileirada", () => {
  const api = loadAppApi();
  const aberta = api.blankPlan("Renovação km 141", { title: "Renovação km 141" });
  const encerrada = api.blankPlan("Renovação km 141", {
    groupId: aberta.groupId, frontPosition: 2, completedAt: "2026-08-20T18:00:00.000Z", status: "completed"
  });
  api.setStore({ version: 4, activePlanId: aberta.id, plans: [aberta, encerrada], deletedPlanIds: [] });
  aberta.title = "Renovação km 141 — revisada";
  api.propagateSharedFields(aberta);
  assert.equal(encerrada.title, "Renovação km 141",
    "a frente encerrada não pode mudar na tela: o servidor recusaria a gravação e o refresh desfaria");

  // E a origem encerrada não propaga nada.
  encerrada.title = "Título que ninguém pediu";
  assert.equal(api.propagateSharedFields(encerrada), false);
  assert.equal(aberta.title, "Renovação km 141 — revisada");
});

test("o encerramento devolve a revisão de cada frente, não só a da que apertou o botão", () => {
  const sql = stripSqlComments(read("supabase/migrations/20260824190000_group_fields_and_front_position.sql"));
  assert.ok(sql.includes("'fronts_detail', fronts_detail"), "close_interval precisa devolver o detalhe por frente");
  assert.ok(sql.includes("'revision', plan.revision"), "o detalhe precisa trazer a revisão de cada frente");
  assert.ok(sql.includes("'fronts_detail', resultado->'fronts_detail'"), "finalize_interval_plan precisa repassar o detalhe");

  const app = stripJsComments(read("app.js"));
  assert.ok(app.includes("data?.fronts_detail"), "o cliente precisa adotar as revisões devolvidas");
  assert.ok(app.includes("front.revision = Number(confirmada.revision)"),
    "sem isso as irmãs ficam com revisão velha, mascarada pelo pulo de plano concluído");
});

test("o banco garante que as frentes de um grupo compartilhem janela, data, título e local", () => {
  const sql = stripSqlComments(read("supabase/migrations/20260824190000_group_fields_and_front_position.sql"));
  assert.ok(sql.includes("create or replace function private.propagate_interval_group_fields()"),
    "faltou a propagação no banco: hoje só o cliente propaga");
  assert.ok(sql.includes("create trigger interval_plans_propagate_group"), "a propagação precisa de gatilho");

  const propagacao = sql.split("function private.propagate_interval_group_fields")[1].split("$function$;")[0];
  for (const campo of ["title = new.title", "interval_date = new.interval_date", "window_start = new.window_start", "window_end = new.window_end", "location = new.location"]) {
    assert.ok(propagacao.includes(campo), `a propagação precisa cobrir ${campo}`);
  }
  assert.ok(propagacao.includes("revision = sibling.revision"),
    "incrementar a revisão das irmãs faria a fila do cliente bater em SYNC_CONFLICT e travar");
  assert.ok(propagacao.includes("sibling.completed_at is null"), "frente encerrada é histórico e não se reescreve");
  assert.ok(propagacao.includes("pg_trigger_depth() > 1"), "sem corte de profundidade a propagação se chama para sempre");

  // A frente que chega adota o grupo; não é ela que dita a janela.
  const guard = sql.split("function private.guard_interval_plan")[1].split("$function$;")[0];
  assert.ok(guard.includes("new.window_start := group_lead.window_start"),
    "uma frente nova não pode entrar no grupo com outra janela");
});

test("quem encerrou o intervalo é gravado com nome e aparece nas telas e na exportação", () => {
  const sql = stripSqlComments(read("supabase/migrations/20260824193000_record_who_closed_the_interval.sql"));
  assert.ok(sql.includes("add column if not exists closed_by_name text"), "faltou a coluna com o nome");
  assert.ok(sql.includes("new.closed_by_name := coalesce(nullif(new.closed_by_name, ''), member.full_name"),
    "o nome precisa ser carimbado no encerramento, não resolvido na exibição");
  assert.ok(sql.includes("new.closed_by_name := old.closed_by_name"),
    "uma atualização posterior não pode apagar quem encerrou");

  const api = loadAppApi();
  assert.equal(api.closureCredit({ completedAt: null }), "");
  const credito = api.closureCredit({ completedAt: "2026-08-20T18:30:00.000Z", closedByName: "Raquel Klein" });
  assert.ok(credito.startsWith("Raquel Klein · "), `crédito inesperado: ${credito}`);

  // Tela, exportação e Edge Function: os três lugares que não liam o dado.
  const app = stripJsComments(read("app.js"));
  assert.ok(app.includes("closedByName: row.closed_by_name"), "o cliente precisa ler a coluna");
  assert.ok(app.includes("Intervalo encerrado por ${credito}"), "a execução precisa mostrar quem encerrou");
  assert.ok(app.includes('["Encerrado por", closureCredit(plan)]'), "o acompanhamento precisa mostrar quem encerrou");
  assert.ok(app.includes('excelCell(1, 8, "Encerrado por", 3)'), "o Excel do intervalo precisa registrar quem encerrou");

  const portal = stripJsComments(read("assets/portal.js"));
  assert.ok(portal.includes("function closureCredit"), "o portal precisa saber montar o crédito");
  assert.ok(portal.includes("detail-closure"), "o detalhe gerencial precisa mostrar quem encerrou");
  assert.ok(portal.includes('"Encerrado por"'), "a exportação gerencial precisa da coluna");

  assert.ok(read("supabase/functions/interval-share/index.ts").includes("closed_by_name"),
    "o link compartilhado também precisa trazer o dado");
  assert.ok(read("styles.css").includes(".detail-closure"), "o aviso precisa de estilo");
});

test("a concessão do CCO estica o prazo sem apagar a janela planejada", () => {
  const api = loadAppApi();
  const plano = api.blankPlan("Renovação km 141", {
    date: "2026-09-01",
    windowStart: "2026-09-01T08:00",
    windowEnd: "2026-09-01T12:00",
    ccoGrantMinutes: 30,
    ccoGrantUnit: "minutes"
  });
  const timeline = api.buildTimeline(plano);
  // A janela continua sendo a planejada; quem soma é o prazo.
  assert.equal(timeline.windowEnd, 12 * 60);
  assert.equal(timeline.grant, 30);
  assert.equal(timeline.deadline, 12 * 60 + 30);
  assert.equal(api.planDeadlineStamp(plano), "2026-09-01T12:30");
  assert.equal(api.ccoGrantLabel(plano), "30 min");

  // Em horas o rótulo respeita a unidade digitada, e o prazo é o mesmo minuto.
  const emHoras = api.blankPlan("Renovação km 141", {
    date: "2026-09-01", windowStart: "2026-09-01T08:00", windowEnd: "2026-09-01T12:00",
    ccoGrantMinutes: 120, ccoGrantUnit: "hours"
  });
  assert.equal(api.ccoGrantLabel(emHoras), "2 h");
  assert.equal(api.planDeadlineStamp(emHoras), "2026-09-01T14:00");

  // Sem concessão, prazo e fim de janela são a mesma coisa.
  const semConcessao = api.blankPlan("Renovação km 141", {
    date: "2026-09-01", windowStart: "2026-09-01T08:00", windowEnd: "2026-09-01T12:00"
  });
  assert.equal(api.buildTimeline(semConcessao).deadline, 12 * 60);
  assert.equal(api.ccoGrantLabel(semConcessao), "");
});

test("o saldo final do intervalo é medido contra o prazo concedido", () => {
  const api = loadAppApi();
  const monta = (grant) => {
    const plano = api.blankPlan("Renovação km 141", {
      date: "2026-09-01", windowStart: "2026-09-01T08:00", windowEnd: "2026-09-01T12:00",
      ccoGrantMinutes: grant, ccoGrantUnit: "minutes"
    });
    plano.steps = [{
      id: "s1", name: "Etapa", plannedStart: "2026-09-01T08:00", plannedEnd: "2026-09-01T12:00",
      actualStart: "2026-09-01T08:00", actualEnd: "2026-09-01T12:20",
      actualNotes: "", executionStatus: "completed", skipReason: ""
    }];
    return api.executionStatus(plano, api.buildTimeline(plano));
  };
  // Terminou 20 min depois do fim da janela.
  assert.equal(monta(0).operational.value, 20);
  // Com 30 min concedidos, os mesmos 20 minutos viram 10 de folga.
  assert.equal(monta(30).operational.value, -10);
});

test("o ajuste de início desloca janela e etapas pelo mesmo tanto", () => {
  const api = loadAppApi();
  const plano = api.blankPlan("Renovação km 141", {
    date: "2026-09-01", windowStart: "2026-09-01T08:00", windowEnd: "2026-09-01T12:00"
  });
  plano.steps = [
    { id: "s1", name: "A", plannedStart: "2026-09-01T08:00", plannedEnd: "2026-09-01T09:00", actualStart: "", actualEnd: "", actualNotes: "", executionStatus: "pending", skipReason: "" },
    { id: "s2", name: "B", plannedStart: "2026-09-01T09:00", plannedEnd: "2026-09-01T10:00", actualStart: "", actualEnd: "", actualNotes: "", executionStatus: "pending", skipReason: "" }
  ];
  assert.equal(api.shiftPlanSchedule(plano, 30), true);
  assert.equal(plano.windowStart, "2026-09-01T08:30");
  assert.equal(plano.steps[0].plannedStart, "2026-09-01T08:30");
  assert.equal(plano.steps[1].plannedEnd, "2026-09-01T10:30");
  // O fim da janela não se move: esticar o prazo é papel da concessão do CCO,
  // e misturar as duas apagaria de quem partiu cada decisão.
  assert.equal(plano.windowEnd, "2026-09-01T12:00");
  // Deslocamento negativo antecipa.
  api.shiftPlanSchedule(plano, -30);
  assert.equal(plano.windowStart, "2026-09-01T08:00");
  assert.equal(plano.steps[0].plannedStart, "2026-09-01T08:00");
  assert.equal(api.shiftPlanSchedule(plano, 0), false);
});

test("o ajuste em bloco deixa de valer assim que a execução registra horário", () => {
  const api = loadAppApi();
  const plano = api.blankPlan("Renovação km 141");
  plano.steps = [{ id: "s1", name: "A", plannedStart: "2026-09-01T08:00", plannedEnd: "2026-09-01T09:00", actualStart: "", actualEnd: "", actualNotes: "", executionStatus: "pending", skipReason: "" }];
  assert.equal(api.hasStartedExecution(plano), false);
  plano.steps[0].actualStart = "2026-09-01T08:35";
  assert.equal(api.hasStartedExecution(plano), true);

  const app = stripJsComments(read("app.js"));
  assert.ok(app.includes("frontsOf(plan).some(hasStartedExecution)"),
    "o impedimento precisa olhar o grupo: o bloqueio abriu tarde para todas as frentes");
  assert.ok(app.includes("A execução já registrou horário real; o ajuste em bloco não vale mais."),
    "o clique precisa recusar mesmo se o estado virar entre o desenho e o toque");
});

test("acrescentar etapa acontece ao lado da etapa, não só no topo da página", () => {
  const app = stripJsComments(read("app.js"));
  assert.ok(app.includes('data-action="insert"'), "faltou o atalho na linha da etapa");
  assert.ok(app.includes("plan.steps.splice(index + 1, 0, step);"), "a etapa nova entra logo depois da atual");
  // O listener recebe o evento; sem o wrapper ele viraria a posição de inserção.
  assert.ok(app.includes('$("#add-step-button").addEventListener("click", () => addStep());'),
    "o botão do topo precisa continuar acrescentando no fim");
  assert.ok(read("styles.css").includes(".row-action.add-below"), "o atalho precisa de estilo próprio");
});

test("a concessão do CCO chega ao planejamento, ao relatório e ao banco", () => {
  const planning = read("index.html");
  for (const marca of ['name="ccoGrantAmount"', 'name="ccoGrantUnit"', 'id="grant-deadline"', 'id="shift-apply"', 'id="shift-unit"']) {
    assert.ok(planning.includes(marca), `planejamento: ausente ${marca}`);
  }
  // Os painéis do planejamento numeram de 01 a 04 sem buraco.
  assert.deepEqual([...planning.matchAll(/step-number(?: light)?">(\d\d)</g)].map((m) => m[1]), ["01", "02", "03", "04"]);

  const app = stripJsComments(read("app.js"));
  assert.ok(app.includes("cco_grant_minutes: ccoGrantMinutes(plan)"), "o payload precisa levar a concessão");
  assert.ok(app.includes("ccoGrantMinutes: Number(row.cco_grant_minutes"), "a leitura precisa trazer a concessão");
  assert.ok(app.includes('["Concessão do CCO"'), "o acompanhamento precisa mostrar a concessão");
  assert.ok(app.includes("prazo final ${stampShort(planDeadlineStamp(plan))}"), "o Excel do intervalo precisa registrar o prazo final");
  assert.ok(app.includes('"ccoGrantMinutes", "ccoGrantUnit"'), "a concessão descreve o bloqueio e acompanha as frentes");

  const portal = stripJsComments(read("assets/portal.js"));
  assert.ok(portal.includes("plannedEnd + ccoGrantMinutes(plan)"),
    "sem somar aqui o card gerencial marcaria em vermelho um intervalo que a execução mostra no prazo");
  assert.ok(portal.includes('"Concessão do CCO"'), "a exportação gerencial precisa da coluna");

  const sql = stripSqlComments(read("supabase/migrations/20260825090000_cco_grant.sql"));
  assert.ok(sql.includes("add column if not exists cco_grant_minutes integer not null default 0"), "faltou a coluna");
  assert.ok(sql.includes("check (cco_grant_minutes between 0 and 1440)"), "faltou o limite no banco");
  assert.ok(sql.includes("INTERVAL_CCO_GRANT_OUT_OF_RANGE"), "valor fora da faixa precisa ser recusado, não truncado");
  assert.ok(sql.includes("cco_grant_minutes = new.cco_grant_minutes"), "a concessão acompanha o bloqueio nas frentes irmãs");
  assert.ok(sql.includes("new.cco_grant_minutes := group_lead.cco_grant_minutes"), "a frente nova adota a concessão do grupo");
  assert.ok(read("supabase/functions/interval-share/index.ts").includes("cco_grant_minutes"),
    "o link compartilhado também precisa trazer a concessão");
});


test("o horário realizado é legível: campo com fonte própria e largura inteira", () => {
  const app = stripJsComments(read("app.js"));
  // O input morava dentro do label e herdava os 10px dele; agora é irmão, com
  // for/id ligando os dois para o clique no rótulo continuar focando o campo.
  assert.ok(app.includes('<label for="realizado-inicio-${step.id}">Início</label>'), "o rótulo precisa apontar para o campo");
  assert.ok(app.includes('<input id="realizado-inicio-${step.id}" data-field="actualStart"'), "o campo precisa do id que o rótulo aponta");
  assert.ok(app.includes('<label for="realizado-fim-${step.id}">Fim</label>'), "o mesmo vale para o fim");
  assert.ok(!/<label>Início<input/.test(app), "o campo não pode voltar para dentro do rótulo");

  const styles = read("styles.css");
  const entrada = styles.split(".time-entry {")[1].split("}")[0];
  assert.ok(entrada.includes('grid-template-areas: "rotulo agora" "campo campo"'),
    "o Agora sobe para a linha do rótulo e o campo fica com a largura inteira");

  const campo = styles.split(".time-entry input {")[1].split("}")[0];
  assert.ok(/font-weight: 700/.test(campo), "o valor digitado precisa ter o peso de um dado, não de uma legenda");
  assert.ok(/font-variant-numeric: tabular-nums/.test(campo), "dígitos de largura fixa param de dançar enquanto se digita");
  // Um datetime-local nativo pede cerca de 16px de largura por pixel de fonte:
  // a 15px são 243px, e nenhuma coluna desta tela tem isso. Aumentar a fonte
  // foi o que cortou o valor da primeira vez.
  const corpo = Number(/font-size: (\d+)px/.exec(campo)[1]);
  assert.ok(corpo >= 12 && corpo <= 13, `o corpo precisa caber na coluna: ${corpo}px`);

  // Duas colunas fixas cortavam entre 1000 e 1170px, onde a grade ainda tem
  // três colunas mas já estreitou. auto-fit só abre a segunda quando ela cabe.
  assert.ok(styles.includes("grid-template-columns: repeat(auto-fit, minmax(215px, 1fr))"),
    "as entradas precisam decidir sozinhas quantas colunas cabem");

  // No celular a entrada ocupa a linha toda e o Agora volta para o lado do
  // campo, onde recupera o alvo de toque.
  const movel = styles.split("@media (max-width: 720px) {")[1];
  assert.ok(movel.includes('.time-entry { grid-template-areas: "rotulo rotulo" "campo agora"'),
    "no celular o Agora não cabe na linha do rótulo sem encolher o alvo de toque");
  assert.ok(/\.now-button \{ height: 48px/.test(movel), "o alvo de toque do Agora não pode cair abaixo de 44px");

  // Até 380px nem isso basta: o botão desce para baixo do campo.
  const estreito = styles.split("@media (max-width: 380px) {")[1].split("\n}")[0];
  assert.ok(estreito.includes('grid-template-areas: "rotulo" "campo" "agora"'),
    "nos aparelhos mais estreitos o Agora precisa sair da linha do campo");
  assert.ok(estreito.includes(".now-button { width: 100%"), "e ocupar a linha inteira, mantendo a altura de toque");

  // Na impressão o Agora some; com as áreas de duas colunas sobrando, o campo
  // herdaria uma faixa vazia ao lado.
  const impressao = styles.split("@media print {")[1];
  assert.ok(impressao.includes('grid-template-areas: "rotulo" "campo"'), "a impressão precisa voltar para uma coluna só");
});

console.log("fronts-and-closure: frentes, silêncio, encerramento, PWA e remoção da SUB aprovados");
