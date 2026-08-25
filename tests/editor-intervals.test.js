"use strict";

// A visao do sistema inteiro, do Editor: todos os intervalos separados por
// status, com os mesmos cards, filtros e modal da visao gerencial.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const stripJsComments = (source) => source.replace(/^\s*\/\/.*$/gm, "");

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

test("a visão do sistema é do Editor, e separa os intervalos por status", () => {
  const pagina = read("intervalos.html");
  assert.match(pagina, /<body[^>]*data-page="intervals"/);
  assert.match(pagina, /<html[^>]*class="auth-checking"/);
  assert.ok(pagina.indexOf("assets/auth-guard.js") < pagina.indexOf("assets/portal.js"),
    "a proteção de autenticação precisa carregar antes do portal");

  // As três listas pedidas, cada uma com sua grade e sua contagem.
  for (const status of ["planning", "executing", "completed"]) {
    assert.ok(pagina.includes(`id="${status}-cards"`), `faltou a grade de ${status}`);
    assert.ok(pagina.includes(`data-result-count="${status}"`), `faltou a contagem de ${status}`);
    assert.ok(pagina.includes(`data-status-column="${status}"`), `faltou a coluna de ${status}`);
  }
  // Data e hora dos dados, no topo.
  assert.ok(pagina.includes('id="intervals-updated"'), "faltou o carimbo de atualização");
  assert.ok(pagina.includes('id="intervals-refresh"'), "faltou o botão de atualizar");
  // Modal de prévia, com o mesmo dialog da gestão.
  assert.ok(pagina.includes('id="interval-detail"') && pagina.includes('id="interval-detail-content"'),
    "a prévia usa o mesmo modal da visão gerencial");

  // Os filtros usam os mesmos data-filter da gestão: é o que faz filterPlans,
  // currentFilters e populateFilters valerem para as duas telas sem cópia.
  const filtros = [...pagina.matchAll(/data-filter="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(filtros, ["manager", "coordinator", "classification", "status", "deadline", "service", "dateFrom", "dateTo", "query"]);

  const portal = stripJsComments(read("assets/portal.js"));
  assert.ok(portal.includes('["intervalos.html", "Intervalos", "intervals"]'), "o Editor precisa do link na navegação");
  assert.ok(portal.includes('if (document.body.dataset.page === "intervals")'), "faltou a rota da página");
  assert.ok(/dataset\.page === "intervals"[\s\S]{0,400}?actualProfile\.role !== "editor"/.test(portal),
    "a página é só do Editor: qualquer outro perfil precisa ser mandado de volta");
  assert.ok(portal.includes("function renderIntervals()"), "faltou o desenho da página");
  assert.ok(portal.includes("intervalsFetchedAt = new Date();"), "o carimbo precisa nascer da busca, não do desenho");
  // Sem o segundo relógio o carimbo congela entre uma busca e outra.
  assert.ok(portal.includes("setInterval(renderIntervalsFreshness, 5000)"), "o carimbo precisa envelhecer à vista");
});

test("a visão do sistema reaproveita card, métricas e filtros da gestão", () => {
  const api = loadPortalApi();
  const hoje = "2026-09-01";
  const etapa = (over) => ({ position: 0, activity_name: "Etapa", planned_start: `${hoje}T08:00:00`, planned_end: `${hoje}T10:00:00`, ...over });
  const plano = (over) => ({
    id: over.id, group_id: over.group_id || over.id, client_id: over.id, front_position: over.front_position || 1,
    title: over.title, interval_date: hoje, location: "km 141", service_type: "Socaria",
    window_start: `${hoje}T08:00:00`, window_end: `${hoje}T10:00:00`,
    coordinator_type: "infrastructure", coordinatorName: "Coord", managerName: "Ger",
    coordinator_member_id: "c1", manager_member_id: "m1", interval_steps: [], ...over
  });
  const dados = [
    plano({ id: "p1", title: "No papel", status: "planning", interval_steps: [etapa({ status: "pending" })] }),
    plano({ id: "p2", title: "Atrasado", status: "executing", interval_steps: [etapa({ actual_start: `${hoje}T08:40:00`, status: "running" })] }),
    plano({ id: "p3", title: "Fechado", status: "completed", interval_steps: [etapa({ actual_start: `${hoje}T08:00:00`, actual_end: `${hoje}T10:20:00`, status: "completed" })] }),
    // Duas frentes do mesmo bloqueio precisam virar um card só.
    plano({ id: "p4a", group_id: "g4", title: "Duas frentes", status: "executing", interval_steps: [etapa({ actual_start: `${hoje}T08:00:00`, status: "running" })] }),
    plano({ id: "p4b", group_id: "g4", title: "Duas frentes", status: "executing", front_position: 2, interval_steps: [etapa({ actual_start: `${hoje}T09:30:00`, status: "running" })] })
  ];

  const grupos = api.groupPlans(dados).map((g) => ({ ...g, metrics: api.groupMetrics(g) }));
  assert.equal(grupos.length, 4, "cinco frentes, quatro bloqueios");
  const porStatus = (s) => grupos.filter((g) => g.metrics.status === s).map((g) => g.lead.title);
  assert.deepEqual(porStatus("planning"), ["No papel"]);
  assert.deepEqual(porStatus("executing").sort(), ["Atrasado", "Duas frentes"]);
  assert.deepEqual(porStatus("completed"), ["Fechado"]);

  // Verde no prazo, vermelho em atraso — a mesma dinâmica dos cards da gestão.
  const classe = (titulo) => api.cardMarkup(grupos.find((g) => g.lead.title === titulo));
  assert.match(classe("No papel"), /interval-card is-on-time/);
  assert.match(classe("Atrasado"), /interval-card is-late/);
  // O bloqueio herda a pior leitura das suas frentes.
  assert.match(classe("Duas frentes"), /interval-card is-late/);
  assert.match(classe("Duas frentes"), /2 frentes/);
  // O card é o gatilho do modal.
  assert.match(classe("Atrasado"), /data-plan-detail="p2"/);

  // Os filtros pedidos funcionam sobre os mesmos dados.
  assert.equal(api.filterPlans(dados, { status: "executing" }).length, 3);
  assert.equal(api.filterPlans(dados, { classification: "infrastructure" }).length, 5);
  assert.equal(api.filterPlans(dados, { coordinator: "c1" }).length, 5);
  assert.equal(api.filterPlans(dados, { coordinator: "outro" }).length, 0);
  assert.equal(api.filterPlans(dados, { dateFrom: "2030-01-01" }).length, 0);
  assert.deepEqual(api.filterPlans(dados, { query: "fechado" }).map((p) => p.title), ["Fechado"]);
});

console.log("editor-intervals: visão do sistema, status, cards e filtros aprovados");
