"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sandbox = {
  console,
  crypto: { randomUUID: () => "test-id" },
  document: {},
  window: { __GESTAO_TEST_MODE__: true }
};
sandbox.window.window = sandbox.window;

const source = fs.readFileSync(path.join(__dirname, "..", "assets", "portal.js"), "utf8");
vm.runInNewContext(source, sandbox, { filename: "assets/portal.js" });

const api = sandbox.window.__GESTAO_PORTAL_TEST_API__;
assert.ok(api, "portal.js deve expor a API de testes no modo de teste");

const {
  timeToMinutes,
  alignTime,
  intervalMetrics,
  filterPlans,
  roleScopeDescription,
  roleCapabilities
} = api;

function makeStep(overrides = {}) {
  return {
    position: 0,
    activity_name: "Etapa",
    planned_start: "08:00:00",
    planned_end: "09:00:00",
    actual_start: null,
    actual_end: null,
    actual_notes: "",
    status: "pending",
    ...overrides
  };
}

function makePlan(overrides = {}) {
  return {
    id: "plan-default",
    title: "Intervalo padrão",
    location: "Trecho padrão",
    service_type: "Manutenção",
    coordinatorName: "Coordenação padrão",
    managerName: "Gerência padrão",
    subCode: "SUB 001",
    manager_member_id: "manager-default",
    coordinator_member_id: "coordinator-default",
    sub_id: 1,
    coordinator_type: "infrastructure",
    interval_date: "2026-08-21",
    window_start: "08:00:00",
    window_end: "10:00:00",
    status: "completed",
    interval_steps: [],
    ...overrides
  };
}

function localDateISO(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function ids(rows) {
  return rows.map((row) => row.id);
}

// Conversão e alinhamento de horários que atravessam a meia-noite.
assert.equal(timeToMinutes("08:35:00"), 515);
assert.equal(timeToMinutes("valor inválido"), null);
assert.equal(alignTime("01:30:00", 23 * 60), 25 * 60 + 30);
assert.equal(alignTime(null, 23 * 60), null);

// Intervalo concluído com atraso: o último término real governa o desvio final.
{
  const plan = makePlan({
    interval_steps: [
      makeStep({ position: 0, status: "completed", actual_start: "08:00:00", actual_end: "09:00:00" }),
      makeStep({ position: 1, planned_start: "09:00:00", planned_end: "10:00:00", status: "completed", actual_start: "09:00:00", actual_end: "10:17:00" })
    ]
  });
  const metrics = intervalMetrics(plan);
  assert.equal(metrics.progress, 100);
  assert.equal(metrics.resolved, 2);
  assert.equal(metrics.variance, 17);
  assert.equal(metrics.deadline, "late");
}

// Intervalo concluído adiantado e reconhecimento de etapa não executada.
{
  const plan = makePlan({
    window_end: "09:50:00",
    interval_steps: [
      makeStep({ position: 0, status: "completed", actual_start: "08:00:00", actual_end: "09:40:00" }),
      makeStep({ position: 1, status: "skipped" })
    ]
  });
  const metrics = intervalMetrics(plan);
  assert.equal(metrics.progress, 100);
  assert.equal(metrics.resolved, 2);
  assert.equal(metrics.variance, -10);
  assert.equal(metrics.deadline, "ahead");
}

// Janela noturna: 02:15 pertence ao dia seguinte e representa 15 min de atraso.
{
  const plan = makePlan({
    window_start: "22:00:00",
    window_end: "02:00:00",
    interval_steps: [
      makeStep({
        planned_start: "22:00:00",
        planned_end: "02:00:00",
        status: "completed",
        actual_start: "22:00:00",
        actual_end: "02:15:00"
      })
    ]
  });
  assert.equal(intervalMetrics(plan).variance, 15);
}

// Em execução, o marco operacional mais avançado prevalece sobre uma etapa anterior.
{
  const plan = makePlan({
    status: "executing",
    interval_date: "2026-08-20",
    interval_steps: [
      makeStep({ position: 0, planned_end: "08:30:00", status: "completed", actual_start: "08:05:00", actual_end: "08:40:00" }),
      makeStep({ position: 1, planned_start: "08:30:00", planned_end: "09:00:00", status: "running", actual_start: "08:25:00" })
    ]
  });
  const metrics = intervalMetrics(plan, new Date(2026, 7, 21, 10, 30));
  assert.equal(metrics.progress, 50);
  assert.equal(metrics.variance, -5);
  assert.equal(metrics.deadline, "ahead");
}

// Uma etapa aberta no dia corrente passa a refletir o atraso contra o próprio fim.
{
  const now = new Date(2026, 7, 21, 10, 30);
  const plan = makePlan({
    status: "executing",
    interval_date: localDateISO(now),
    interval_steps: [makeStep({ status: "running", actual_start: "08:00:00", planned_end: "09:00:00" })]
  });
  const metrics = intervalMetrics(plan, now);
  assert.equal(metrics.variance, 90);
  assert.equal(metrics.deadline, "late");
}

const plans = [
  makePlan({
    id: "late-infra",
    title: "Ponte Norte",
    location: "Trecho Azul",
    service_type: "Renovação de linha",
    coordinatorName: "Carla Coordenação",
    managerName: "Marina Gerência",
    subCode: "SUB 010",
    manager_member_id: "manager-1",
    coordinator_member_id: "coordinator-1",
    sub_id: 10,
    interval_date: "2026-08-21",
    interval_steps: [makeStep({ status: "completed", actual_start: "08:00:00", actual_end: "10:20:00" })]
  }),
  makePlan({
    id: "ahead-super",
    title: "Drenagem Sul",
    location: "Pátio Verde",
    service_type: "Drenagem",
    coordinatorName: "Carlos Operação",
    managerName: "Miguel Gerência",
    subCode: "SUB 020",
    manager_member_id: "manager-2",
    coordinator_member_id: "coordinator-2",
    sub_id: 20,
    coordinator_type: "superstructure",
    interval_date: "2026-08-20",
    interval_steps: [makeStep({ status: "completed", actual_start: "08:00:00", actual_end: "09:50:00" })]
  }),
  makePlan({
    id: "planning-infra",
    title: "Inspeção Leste",
    location: "Trecho Branco",
    service_type: "Inspeção",
    coordinatorName: "Clara Campo",
    managerName: "Marina Gerência",
    subCode: "SUB 030",
    manager_member_id: "manager-1",
    coordinator_member_id: "coordinator-3",
    sub_id: 30,
    interval_date: "2026-08-22",
    status: "planning"
  })
];

assert.deepEqual(ids(filterPlans(plans, { manager: "manager-1" })), ["late-infra", "planning-infra"]);
assert.deepEqual(ids(filterPlans(plans, { coordinator: "coordinator-2" })), ["ahead-super"]);
assert.deepEqual(ids(filterPlans(plans, { sub: "10" })), ["late-infra"]);
assert.deepEqual(ids(filterPlans(plans, { classification: "superstructure" })), ["ahead-super"]);
assert.deepEqual(ids(filterPlans(plans, { status: "planning" })), ["planning-infra"]);
assert.deepEqual(ids(filterPlans(plans, { deadline: "late" })), ["late-infra"]);
assert.deepEqual(ids(filterPlans(plans, { deadline: "ahead" })), ["ahead-super"]);
assert.deepEqual(ids(filterPlans(plans, { service: "Drenagem" })), ["ahead-super"]);
assert.deepEqual(ids(filterPlans(plans, { dateFrom: "2026-08-21", dateTo: "2026-08-21" })), ["late-infra"]);
assert.deepEqual(ids(filterPlans(plans, { query: "marina gerência" })), ["late-infra", "planning-infra"]);
assert.deepEqual(ids(filterPlans(plans, { query: "sub 020" })), ["ahead-super"]);

// Filtros combinados não ampliam o escopo e continuam respeitando todos os critérios.
assert.deepEqual(ids(filterPlans(plans, {
  manager: "manager-1",
  classification: "infrastructure",
  deadline: "late",
  query: "ponte"
})), ["late-infra"]);

assert.equal(roleScopeDescription("director"), roleScopeDescription("consultant"));
assert.equal(roleScopeDescription("executive_manager"), roleScopeDescription("director"));
assert.match(roleScopeDescription("director"), /Toda a operação/);
assert.match(roleScopeDescription("manager"), /Somente Coordenadores vinculados/);
assert.match(roleScopeDescription("coordinator"), /Seus próprios intervalos/);
assert.match(roleScopeDescription("editor"), /acesso às ferramentas administrativas/);

assert.deepEqual(JSON.parse(JSON.stringify(roleCapabilities("director"))), {
  canUseManagement: true,
  canOperateIntervals: false,
  canAdminister: false,
  organizationWide: true,
  readOnly: true
});
assert.deepEqual(JSON.parse(JSON.stringify(roleCapabilities("consultant"))), JSON.parse(JSON.stringify(roleCapabilities("director"))));
assert.deepEqual(JSON.parse(JSON.stringify(roleCapabilities("executive_manager"))), JSON.parse(JSON.stringify(roleCapabilities("director"))));
assert.equal(roleCapabilities("manager").organizationWide, false);
assert.equal(roleCapabilities("manager").readOnly, true);
assert.equal(roleCapabilities("coordinator").canOperateIntervals, true);
assert.equal(roleCapabilities("coordinator").canAdminister, false);
assert.equal(roleCapabilities("editor").canAdminister, true);
assert.equal(roleCapabilities("editor").readOnly, false);

console.log("portal: métricas, filtros e descrições de escopo aprovados");
