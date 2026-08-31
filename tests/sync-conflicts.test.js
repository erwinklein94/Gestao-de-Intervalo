"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function syncHarness(error, editedDuringSync = true) {
  const timers = new Map();
  const persisted = {};
  let timerId = 0;
  let calls = 0;
  const payload = { database_id: null, client_id: "plan-1", title: "Cópia local" };
  const item = { type: "plan_sync", planId: "plan-1", state: "pending", attempts: 0,
    operationId: "operation-1", deviceId: "device-1", baseRevision: 37,
    planPayload: payload, stepsPayload: [], signature: JSON.stringify([payload, []]) };
  const context = {
    console: { error() {} }, navigator: { onLine: true },
    cloudClient: { rpc: async () => { calls++; return { error, data: error ? null : { plan_id: "database-1", revision: 38 } }; } },
    currentUser: { id: "user-1" }, cloudSyncing: false, cloudSyncPending: false,
    cloudTimer: null, syncRetryTimer: null,
    store: { pendingSync: true, deletedPlanIds: [], plans: [{ id: "plan-1", revision: 37, title: "Cópia local" }] },
    outbox: [item], dirtyPlanIds: new Set(editedDuringSync ? ["plan-1"] : []),
    planToDatabase: () => payload, stepsToDatabase: () => [],
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    saveOutbox() { persisted.outbox = JSON.parse(JSON.stringify(context.outbox)); },
    writeStoreLocally() { persisted.store = JSON.parse(JSON.stringify(context.store)); },
    setSyncState() {}, showToast() {}
  };
  vm.runInNewContext(app.slice(app.indexOf("  function scheduleCloudSync("), app.indexOf("  function showToast(")), context);
  return { context, timers, persisted, item, calls: () => calls };
}

for (const error of [
  { code: "PT409", message: "SYNC_CONFLICT: expected 37, found 71" },
  { code: "PT409", message: "SYNC_OPERATION_PAYLOAD_MISMATCH" },
  { code: "40001", message: "SYNC_CONFLICT: expected 37, found 71" }
]) {
  test(`conflito ${error.code}/${error.message} preserva fila e não repete automaticamente`, async () => {
    const { context, timers, persisted, item, calls } = syncHarness(error);
    const originalPayload = JSON.stringify(item.planPayload);
    await context.syncStoreToCloud();
    assert.equal(calls(), 1);
    assert.equal(item.state, "conflict");
    assert.equal(timers.size, 0, "edições pendentes não devem contornar a pausa do conflito");
    assert.equal(persisted.outbox[0].baseRevision, 37);
    assert.equal(JSON.stringify(persisted.outbox[0].planPayload), originalPayload);
    assert.equal(persisted.store.pendingSync, true);
    assert.equal(context.dirtyPlanIds.has("plan-1"), true);
    await context.syncStoreToCloud();
    assert.equal(calls(), 1, "nem uma nova tentativa deve reenviar um conflito não resolvido");
    assert.equal(timers.size, 0);
  });
}

test("falha transitória respeita backoff mesmo com alterações durante o envio", async () => {
  const { context, timers, persisted } = syncHarness({ code: "503", message: "Unavailable" });
  await context.syncStoreToCloud();
  assert.equal(timers.size, 1, "não deve agendar uma segunda tentativa imediata no finally");
  assert.equal([...timers.values()][0].delay, 2000);
  assert.equal(persisted.outbox[0].state, "pending");
  assert.equal(persisted.store.pendingSync, true);
});

test("sincronização confirmada continua removendo a operação e atualizando a revisão", async () => {
  const { context, timers, calls } = syncHarness(null, false);
  await context.syncStoreToCloud();
  assert.equal(calls(), 1);
  assert.equal(context.outbox.length, 0);
  assert.equal(context.store.plans[0].revision, 38);
  assert.equal(context.store.pendingSync, false);
  assert.equal(timers.size, 0);
});
