"use strict";

// Frentes de servico, clima, deteccao de silencio, encerramento explicito,
// PWA e remocao da SUB.

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
  assert.equal(plano.weather, "");
});

test("frentes do mesmo intervalo se enxergam e recebem rótulo em ordem", () => {
  const api = loadAppApi();
  const primeira = api.blankPlan("Renovação km 141");
  const segunda = api.blankPlan("Renovação km 141", { groupId: primeira.groupId, frontPosition: 2 });
  api.setStore({ version: 4, activePlanId: primeira.id, plans: [primeira, segunda], deletedPlanIds: [] });
  assert.equal(api.frontsOf(primeira).length, 2);
  assert.equal(api.frontLabel(primeira), "Frente 1");
  assert.equal(api.frontLabel(segunda), "Frente 2");
  segunda.frontName = "Frente sul";
  assert.equal(api.frontLabel(segunda), "Frente sul");
});

test("dados do bloqueio se propagam entre frentes; dados da frente não", () => {
  const api = loadAppApi();
  const primeira = api.blankPlan("Original");
  const segunda = api.blankPlan("Original", { groupId: primeira.groupId, frontPosition: 2 });
  api.setStore({ version: 4, activePlanId: primeira.id, plans: [primeira, segunda], deletedPlanIds: [] });

  primeira.title = "Renovação km 200";
  primeira.location = "km 200+000";
  primeira.windowEnd = "2026-08-23T05:00";
  assert.equal(api.propagateSharedFields(primeira), true);
  assert.equal(segunda.title, "Renovação km 200");
  assert.equal(segunda.location, "km 200+000");
  assert.equal(segunda.windowEnd, "2026-08-23T05:00");

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

test("payload de sincronização leva frente e clima e não leva sub_id", () => {
  const api = loadAppApi();
  const plano = api.blankPlan("Intervalo", { ownerId: "user-1", frontPosition: 2, frontName: "Frente sul" });
  plano.weather = "rain";
  plano.weatherNote = "chuva desde as 02h";
  const payload = api.planToDatabase(plano);
  assert.equal(payload.group_id, plano.groupId);
  assert.equal(payload.front_position, 2);
  assert.equal(payload.front_name, "Frente sul");
  assert.equal(payload.weather, "rain");
  assert.equal(payload.weather_note, "chuva desde as 02h");
  assert.ok(!("sub_id" in payload), "sub_id não deve mais ser enviado");
});

test("leitura do banco reconstrói frente e clima", () => {
  const api = loadAppApi();
  const plano = api.databaseToPlan({
    client_id: "c1", id: "db1", group_id: "g1", front_position: 3, front_name: "Frente A",
    weather: "storm", weather_note: "raio", weather_recorded_at: "2026-08-23T03:00:00Z", interval_steps: []
  });
  assert.equal(plano.groupId, "g1");
  assert.equal(plano.frontPosition, 3);
  assert.equal(plano.frontName, "Frente A");
  assert.equal(plano.weather, "storm");
});

test("clima fora do vocabulário fechado é descartado na normalização", () => {
  const api = loadAppApi();
  const plano = { id: "p1", steps: [], weather: "furacão" };
  api.normalizePlan(plano);
  assert.equal(plano.weather, "");
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
  const frenteAtrasada = { ...base, id: "p2", front_position: 2, front_name: "Frente sul", interval_steps: [step({ actual_start: "2026-08-23T02:00:00", status: "running", planned_end: "2026-08-23T04:30:00" })] };
  const avulso = { ...base, group_id: "g2", id: "p3", front_position: 1, interval_steps: [step({ actual_start: "2026-08-23T02:00:00", status: "running" })] };

  const grupos = api.groupPlans([frenteAtrasada, frenteConcluida, avulso]);
  assert.equal(grupos.length, 2, "três frentes em dois bloqueios");
  const bloqueio = grupos.find((grupo) => grupo.id === "g1");
  assert.deepEqual(bloqueio.fronts.map((front) => front.id), ["p1", "p2"], "frentes vêm na ordem da posição");

  const metrics = api.groupMetrics(bloqueio, agora);
  assert.equal(metrics.steps, 2);
  assert.equal(metrics.resolved, 1);
  assert.equal(metrics.progress, 50);
  assert.equal(metrics.status, "executing");
  assert.equal(metrics.variance, 30, "o intervalo herda o pior desvio entre as frentes");
  assert.equal(metrics.deadline, "late");
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
  assert.deepEqual(resumo.kpis.find((kpi) => kpi[0] === "Total de intervalos"), ["Total de intervalos", 2]);
  assert.deepEqual(resumo.kpis.find((kpi) => kpi[0] === "Frentes de serviço"), ["Frentes de serviço", 3]);
});

test("estrutura das telas de frente, clima e encerramento", () => {
  const planning = read("index.html");
  for (const marca of ['id="front-strip"', 'id="front-count"', 'name="frontName"', 'name="location"']) {
    assert.ok(planning.includes(marca), `planejamento: ausente ${marca}`);
  }
  const execution = read("executar.html");
  for (const marca of [
    'id="front-strip"', 'id="weather-choices"', 'id="weather-note"', 'id="weather-stamp"',
    'id="execution-silence"', 'id="execution-finish-panel"', 'id="closing-fronts"',
    'id="finish-execution-button"', 'id="closing-description"'
  ]) {
    assert.ok(execution.includes(marca), `execução: ausente ${marca}`);
  }
  const app = read("app.js");
  for (const marca of [
    'cloudClient.rpc("finalize_interval_plan"',
    "function closingState()",
    "const WEATHER_OPTIONS",
    "const SHARED_INTERVAL_FIELDS",
    "if (plan.completedAt) continue;"
  ]) {
    assert.ok(app.includes(marca), `app.js: ausente ${marca}`);
  }
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

test("encerramento vale para o intervalo inteiro, não para a frente", () => {
  const fronts = read("supabase/migrations/20260823100000_interval_fronts_weather_and_closure.sql");
  for (const marca of [
    "add column if not exists group_id uuid",
    "add column if not exists front_position integer not null default 1",
    "check (front_position between 1 and 12)",
    "check (weather in ('', 'clear', 'cloudy', 'drizzle', 'rain', 'storm', 'fog', 'wind', 'heat', 'cold'))",
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

console.log("fronts-weather-closure: frentes, clima, silêncio, encerramento, PWA e remoção da SUB aprovados");
