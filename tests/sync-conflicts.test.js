"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const quiet = { warn() {}, error() {}, log() {} };

// A fatia de sincronizacao roda isolada, mas precisa de duas funcoes que moram
// fora dela. Carregar o app inteiro no modo de teste e a forma de obte-las sem
// reescrever a conversao de linha do banco dentro do teste.
function appApi(agoraIso = "2026-08-31T18:30:00") {
  const fixedNow = new Date(agoraIso).getTime();
  const sandbox = {
    console: quiet, crypto: { randomUUID: () => "test-id" },
    Date: class extends Date { static now() { return fixedNow; } },
    document: { body: { dataset: { page: "test" } } },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    setTimeout, clearTimeout,
    window: { __GESTAO_TEST_MODE__: true, __GESTAO_USER_ID__: null, addEventListener: () => {} }
  };
  sandbox.window.window = sandbox.window;
  vm.runInNewContext(app, sandbox, { filename: "app.js" });
  return sandbox.window.__GESTAO_TEST_API__;
}
const API = appApi();
const fatia = app.slice(app.indexOf("  function scheduleCloudSync("), app.indexOf("  function showToast("));

function syncHarness(config) {
  const timers = new Map();
  const chamadas = [];
  const avisos = [];
  const erros = [];
  let timerId = 0;
  const context = {
    console: { error: (...args) => erros.push(args.map(String).join(" ")), warn() {} },
    navigator: { onLine: true },
    currentUser: { id: "user-1" }, cloudSyncing: false, cloudSyncPending: false,
    cloudTimer: null, syncRetryTimer: null, deviceId: "device-1",
    store: config.store, outbox: config.outbox, dirtyPlanIds: new Set(config.dirty || []),
    planToDatabase: API.planToDatabase,
    // stepsToDatabase nao esta na API de teste; aqui interessa o fluxo da fila,
    // nao o formato exato do payload.
    stepsToDatabase: (plan) => plan.steps.map((step) => ({
      client_id: step.id, activity_name: step.name || "", planned_start: step.plannedStart || null,
      planned_end: step.plannedEnd || null, actual_start: step.actualStart || null,
      actual_end: step.actualEnd || null, actual_notes: step.actualNotes || "",
      status: step.executionStatus || "pending", skip_reason: step.skipReason || ""
    })),
    databaseToPlan: API.databaseToPlan,
    pluralize: (n, um, varios) => `${n} ${n === 1 ? um : varios}`,
    uid: () => `op-${(timerId += 1)}`,
    pageRefreshHandler: null,
    loadCloudStore: async () => {},
    setTimeout: (callback, delay) => { const id = (timerId += 1); timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    saveOutbox() {}, writeStoreLocally() {}, setSyncState() {},
    showToast: (mensagem) => avisos.push(mensagem),
    cloudClient: {
      rpc: async (_nome, args) => { chamadas.push(args); return config.rpc(args, chamadas.length); },
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => config.remoto() }) }),
        insert: async () => ({ error: null }),
        update: () => ({ eq: async () => ({ error: null }) })
      })
    }
  };
  vm.runInNewContext(fatia, context);
  return { context, timers, chamadas, avisos, erros };
}

const CONFLITO = { code: "PT409", message: "SYNC_CONFLICT: expected 60, found 79" };

const etapa = (id, nome, ps, pe, inicio, fim) => ({
  id, name: nome, plannedStart: ps, plannedEnd: pe, actualStart: inicio || "", actualEnd: fim || "",
  actualNotes: "", executionStatus: fim ? "completed" : inicio ? "running" : "pending", skipReason: ""
});

// O servidor parou na revisao 79; o aparelho seguiu registrando depois disso.
const linhaDoServidor = () => ({
  id: "db-1", client_id: "plan-1", user_id: "user-1", dataset_id: "ds", revision: 79, status: "executing",
  title: "Reforço de Pavimento", interval_date: "2026-08-31", coordinator: "Coordenação",
  window_start: "2026-08-31T08:40:00", window_end: "2026-08-31T18:40:00",
  group_id: "plan-1", front_position: 1, is_locked: true,
  interval_steps: [
    { client_id: "s1", position: 0, activity_name: "Talas", planned_start: "2026-08-31T08:40:00", planned_end: "2026-08-31T08:50:00", actual_start: "2026-08-31T08:40:00", actual_end: "2026-08-31T08:57:00", status: "completed", revision: 1 },
    { client_id: "s2", position: 1, activity_name: "Grade", planned_start: "2026-08-31T08:50:00", planned_end: "2026-08-31T09:20:00", actual_start: "2026-08-31T08:57:00", actual_end: "2026-08-31T09:30:00", status: "completed", revision: 1 },
    { client_id: "s3", position: 2, activity_name: "Escavação", planned_start: "2026-08-31T09:20:00", planned_end: "2026-08-31T11:20:00", actual_start: "2026-08-31T09:30:00", actual_end: null, status: "running", revision: 1 },
    { client_id: "s4", position: 3, activity_name: "Rachão", planned_start: "2026-08-31T11:20:00", planned_end: "2026-08-31T12:40:00", actual_start: "2026-08-31T10:00:00", actual_end: "2026-08-31T12:50:00", status: "completed", revision: 1 }
  ]
});

const planoLocal = () => ({
  id: "plan-1", databaseId: "db-1", ownerId: "user-1", datasetId: "ds", revision: 60, status: "executing",
  title: "Reforço de Pavimento", date: "2026-08-31", coordinator: "Coordenação", groupId: "plan-1", frontPosition: 1,
  windowStart: "2026-08-31T08:40", windowEnd: "2026-08-31T18:40", locked: true, completedAt: null,
  deletedStepIds: [], steps: [
    etapa("s1", "Talas", "2026-08-31T08:40", "2026-08-31T08:50", "2026-08-31T08:40", "2026-08-31T08:57"),
    // Divergência real: o aparelho gravou 09:35 onde o servidor já tem 09:30.
    etapa("s2", "Grade", "2026-08-31T08:50", "2026-08-31T09:20", "2026-08-31T08:57", "2026-08-31T09:35"),
    // Registro da tarde, que só existe no aparelho.
    etapa("s3", "Escavação", "2026-08-31T09:20", "2026-08-31T11:20", "2026-08-31T09:30", "2026-08-31T15:10"),
    // O servidor tem 12:50 aqui e o aparelho não tem nada: não pode sumir.
    etapa("s4", "Rachão", "2026-08-31T11:20", "2026-08-31T12:40", "2026-08-31T10:00", ""),
    // Etapa criada no aparelho, que o servidor ainda não conhece.
    etapa("s5", "Pedra 3", "2026-08-31T12:40", "2026-08-31T13:40", "2026-08-31T16:20", "")
  ]
});

const itemTravado = () => ({
  type: "plan_sync", planId: "plan-1", state: "conflict", attempts: 3, operationId: "op-antiga",
  deviceId: "device-1", baseRevision: 60, planPayload: { client_id: "plan-1", title: "retrato antigo" },
  stepsPayload: [], signature: "assinatura-antiga"
});

test("conflito herdado de outra sessão é mesclado e reenviado, sem perder registro", async () => {
  const store = { pendingSync: true, deletedPlanIds: [], plans: [planoLocal()] };
  const { context, timers, chamadas, avisos } = syncHarness({
    store, outbox: [itemTravado()],
    remoto: () => ({ data: linhaDoServidor(), error: null }),
    rpc: (_args, n) => (n === 1
      ? { error: CONFLITO, data: null }
      : { error: null, data: { plan_id: "db-1", revision: 80, status: "executing" } })
  });

  await context.syncStoreToCloud();
  const plano = store.plans[0];
  const passo = (id) => plano.steps.find((item) => item.id === id);

  assert.equal(chamadas.length, 2, "o item preso é retentado uma vez e o resultado do merge é reenviado");
  assert.equal(chamadas[1].p_expected_revision, 79, "o reenvio parte da revisão atual do servidor, não da antiga");
  assert.equal(passo("s3").actualEnd, "2026-08-31T15:10", "registro que só existia no aparelho sobrevive");
  assert.equal(passo("s4").actualEnd, "2026-08-31T12:50", "registro que só existia no servidor sobrevive");
  assert.equal(passo("s2").actualEnd, "2026-08-31T09:30", "com valores diferentes nos dois lados, vale o do servidor");
  assert.equal(passo("s5").actualStart, "2026-08-31T16:20", "etapa criada no aparelho continua na lista");
  assert.equal(passo("s3").executionStatus, "completed", "o estado da etapa vem do horário que sobreviveu");
  assert.equal(context.outbox.length, 0, "a fila esvazia");
  assert.equal(plano.revision, 80);
  assert.match(avisos.join(" | "), /Conflito resolvido/, "o usuário é avisado de que houve divergência");
  assert.equal(timers.size, 0, "resolver o conflito não pode virar rajada de retentativa");
});

test("conflito sem resolução não trava os outros intervalos da fila", async () => {
  const outro = Object.assign(planoLocal(), {
    id: "plan-2", databaseId: "db-2", revision: 5, groupId: "plan-2",
    steps: [etapa("x1", "Etapa", "2026-08-31T08:00", "2026-08-31T09:00", "2026-08-31T08:00", "")]
  });
  const store = { pendingSync: true, deletedPlanIds: [], plans: [planoLocal(), outro] };
  const { context, timers, chamadas } = syncHarness({
    store, outbox: [itemTravado()], dirty: ["plan-2"],
    // Sem conseguir ler a versão do servidor, o merge não acontece.
    remoto: () => ({ data: null, error: { message: "leitura indisponível" } }),
    rpc: (args) => (args.p_plan.client_id === "plan-2"
      ? { error: null, data: { plan_id: "db-2", revision: 6, status: "executing" } }
      : { error: CONFLITO, data: null })
  });

  await context.syncStoreToCloud();
  const enviados = chamadas.map((item) => item.p_plan.client_id);

  assert.ok(enviados.includes("plan-2"), "o intervalo sem conflito continua subindo");
  assert.equal(enviados.filter((id) => id === "plan-1").length, 1, "o plano em conflito não é reenviado às cegas");
  assert.equal(context.outbox.length, 1);
  assert.equal(context.outbox[0].state, "conflict", "o item fica guardado para a próxima rodada");
  assert.equal(timers.size, 0, "uma tentativa de merge por rodada, sem repetição imediata");
});

test("falha transitória continua respeitando a espera progressiva", async () => {
  const store = { pendingSync: true, deletedPlanIds: [], plans: [planoLocal()] };
  const { context, timers } = syncHarness({
    store, outbox: [], dirty: ["plan-1"],
    remoto: () => ({ data: null, error: null }),
    rpc: () => ({ error: { code: "503", message: "Unavailable" }, data: null })
  });

  await context.syncStoreToCloud();
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 2000);
  assert.equal(context.outbox.length, 1);
  assert.equal(context.outbox[0].state, "pending", "a fila é preservada para a próxima tentativa");
});

test("sincronização confirmada continua removendo a operação e atualizando a revisão", async () => {
  const store = { pendingSync: true, deletedPlanIds: [], plans: [planoLocal()] };
  const { context, timers, chamadas } = syncHarness({
    store, outbox: [], dirty: ["plan-1"],
    remoto: () => ({ data: null, error: null }),
    rpc: () => ({ error: null, data: { plan_id: "db-1", revision: 61, status: "executing" } })
  });

  await context.syncStoreToCloud();
  assert.equal(chamadas.length, 1);
  assert.equal(context.outbox.length, 0);
  assert.equal(store.plans[0].revision, 61);
  assert.equal(store.pendingSync, false);
  assert.equal(timers.size, 0);
});
