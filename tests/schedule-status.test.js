"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const fixedNow = new Date("2026-08-20T09:15:00").getTime();
const sandbox = {
  console,
  crypto: { randomUUID: () => "test-id" },
  Date: class extends Date { static now() { return fixedNow; } },
  document: { body: { dataset: { page: "test" } } },
  localStorage: { getItem: () => null, setItem: () => {} },
  setTimeout,
  clearTimeout,
  window: {
    __GESTAO_TEST_MODE__: true,
    __GESTAO_USER_ID__: null,
    addEventListener: () => {}
  }
};
sandbox.window.window = sandbox.window;

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
vm.runInNewContext(source, sandbox, { filename: "app.js" });
const { adjustedDeadline, buildTimeline, executionStatus, intervalElapsedTime } = sandbox.window.__GESTAO_TEST_API__;

function plan(steps, overrides = {}) {
  return {
    date: "2026-08-20",
    windowStart: "08:00",
    windowEnd: "10:00",
    steps: steps.map((step, index) => ({
      id: `step-${index + 1}`,
      name: `Etapa ${index + 1}`,
      plannedStart: "",
      plannedEnd: "",
      actualStart: "",
      actualEnd: "",
      executionStatus: "pending",
      ...step
    })),
    ...overrides
  };
}

function statusOf(candidate) {
  return executionStatus(candidate, buildTimeline(candidate));
}

{
  const candidate = plan([
    { plannedStart: "08:00", plannedEnd: "09:00", actualStart: "07:55" },
    { plannedStart: "08:30", plannedEnd: "09:30" },
    { plannedStart: "09:00", plannedEnd: "10:00" }
  ]);
  const status = statusOf(candidate);
  assert.equal(status.delay, -5, "etapas futuras sobrepostas não criam atraso em cascata");
  assert.equal(status.operational.type, "active-start");
}

{
  const candidate = plan([
    { plannedStart: "08:00", plannedEnd: "09:00", actualStart: "07:55" },
    { plannedStart: "08:30", plannedEnd: "09:30", actualStart: "08:20" },
    { plannedStart: "09:00", plannedEnd: "10:00" }
  ]);
  const status = statusOf(candidate);
  assert.equal(status.delay, -10, "o marco iniciado mais avançado governa a situação geral");
  assert.equal(status.active.length, 2, "as duas etapas permanecem simultaneamente em andamento");
}

{
  const candidate = plan([
    { plannedStart: "08:00", plannedEnd: "09:00", actualStart: "08:05", actualEnd: "09:10" },
    { plannedStart: "08:30", plannedEnd: "09:30", actualStart: "08:20" }
  ]);
  const status = statusOf(candidate);
  assert.equal(status.delay, -10, "uma etapa anterior concluída com atraso não supera o marco posterior adiantado");
}

{
  const candidate = plan([
    { plannedStart: "08:00", plannedEnd: "09:00", actualStart: "08:02", actualEnd: "09:03" },
    { plannedStart: "08:30", plannedEnd: "09:30", actualStart: "08:25", actualEnd: "09:40" },
    { plannedStart: "09:00", plannedEnd: "10:00", actualStart: "08:55", actualEnd: "09:50" }
  ]);
  const status = statusOf(candidate);
  assert.equal(status.delay, -10, "ao encerrar, o último término real é comparado com o prazo final");
  assert.equal(status.operational.type, "interval-complete");
}

{
  const candidate = plan([
    { plannedStart: "08:00", plannedEnd: "09:00" },
    { plannedStart: "08:30", plannedEnd: "09:30" }
  ]);
  const status = statusOf(candidate);
  assert.equal(status.delay, 75, "sem marcos, somente a primeira etapa da sequência define o atraso");
  assert.equal(status.operational.step.id, "step-1");
}

console.log("schedule-status: 5 cenários aprovados");

{
  const candidate = plan([
    { plannedStart: "08:00", plannedEnd: "09:00", actualStart: "08:00", actualEnd: "09:00" },
    { plannedStart: "08:30", plannedEnd: "09:30", actualStart: "08:30" }
  ]);
  const timeline = buildTimeline(candidate);
  const elapsed = intervalElapsedTime(timeline, statusOf(candidate).nowAbs);
  assert.equal(elapsed.minutes, 75, "o tempo do intervalo deve ir do primeiro início até agora");
  assert.equal(elapsed.finished, false);
}

{
  const candidate = plan([
    { plannedStart: "08:00", plannedEnd: "09:00", actualStart: "08:00", actualEnd: "09:10" },
    { plannedStart: "08:30", plannedEnd: "10:00", actualStart: "08:20", actualEnd: "09:50" }
  ]);
  const timeline = buildTimeline(candidate);
  const elapsed = intervalElapsedTime(timeline, statusOf(candidate).nowAbs);
  assert.equal(elapsed.minutes, 110, "intervalo encerrado deve congelar no último término real");
  assert.equal(elapsed.finished, true);
}

{
  const candidate = plan([{ plannedStart: "08:00", plannedEnd: "09:00" }]);
  const timeline = buildTimeline(candidate);
  assert.equal(intervalElapsedTime(timeline, statusOf(candidate).nowAbs).minutes, null, "sem início realizado não há tempo gasto");
}

console.log("interval-elapsed: 3 cenários aprovados");

{
  assert.equal(adjustedDeadline(18 * 60 + 31, -18), 18 * 60 + 13, "prazo final deve incorporar o adiantamento previsto");
  assert.equal(adjustedDeadline(18 * 60 + 31, 12), 18 * 60 + 43, "prazo final deve incorporar o atraso previsto");
  assert.equal(adjustedDeadline(18 * 60 + 31, null), 18 * 60 + 31, "sem projeção deve manter o prazo planejado");
}

console.log("adjusted-deadline: 3 cenários aprovados");
