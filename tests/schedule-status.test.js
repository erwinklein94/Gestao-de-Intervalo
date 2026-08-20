"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const fixedNow = new Date("2026-08-20T09:15:00").getTime();
const sandbox = {
  console,
  crypto: { randomUUID: () => "test-id" },
  Date: class extends Date {
    static now() { return fixedNow; }
  },
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

const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
vm.runInNewContext(appSource, sandbox, { filename: "app.js" });
const { buildTimeline, finalDeadlineStatus, totalScheduleDeviation } = sandbox.window.__GESTAO_TEST_API__;

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

function deviationOf(candidate) {
  const timeline = buildTimeline(candidate);
  return totalScheduleDeviation(candidate, timeline);
}

{
  const candidate = plan([
    { plannedStart: "08:00", plannedEnd: "09:00", actualStart: "07:55" },
    { plannedStart: "08:30", plannedEnd: "09:30" },
    { plannedStart: "09:00", plannedEnd: "10:00" }
  ]);
  const result = deviationOf(candidate);
  assert.equal(result.value, -5, "etapas futuras sobrepostas não devem criar atraso em cascata");
  assert.equal(result.type, "active-start");
}

{
  const candidate = plan([
    { plannedStart: "08:00", plannedEnd: "09:00", actualStart: "07:55" },
    { plannedStart: "08:30", plannedEnd: "09:30", actualStart: "08:20" },
    { plannedStart: "09:00", plannedEnd: "10:00" }
  ]);
  const result = deviationOf(candidate);
  assert.equal(result.value, -10, "o marco iniciado mais avançado na sequência deve governar o status");
  assert.equal(result.type, "concurrent-active");
  assert.equal(result.activeSteps.length, 2);
}

{
  const candidate = plan([
    { plannedStart: "08:00", plannedEnd: "09:00", actualStart: "07:55" },
    { plannedStart: "08:30", plannedEnd: "09:30", actualStart: "08:20" }
  ]);
  const timeline = buildTimeline(candidate);
  const deadline = finalDeadlineStatus(candidate, timeline);
  assert.equal(deadline.value, 0, "execução antes do prazo final deve permanecer sem atraso final");
  assert.equal(deadline.type, "within-deadline");
}

{
  const candidate = plan([
    { plannedStart: "08:00", plannedEnd: "09:00", actualStart: "08:02", actualEnd: "09:03" },
    { plannedStart: "08:30", plannedEnd: "09:30", actualStart: "08:25", actualEnd: "09:40" },
    { plannedStart: "09:00", plannedEnd: "10:00", actualStart: "08:55", actualEnd: "09:50" }
  ]);
  const result = deviationOf(candidate);
  assert.equal(result.value, -10, "ao encerrar, deve comparar o último término real com o prazo final");
  assert.equal(result.type, "interval-complete");
}

{
  const candidate = plan([
    { plannedStart: "08:00", plannedEnd: "09:00" },
    { plannedStart: "08:30", plannedEnd: "09:30" }
  ]);
  const result = deviationOf(candidate);
  assert.equal(result.value, 75, "sem qualquer marco, somente a primeira etapa da sequência pode apontar atraso");
  assert.equal(result.step.id, "step-1");
}

console.log("schedule-status: 5 cenários aprovados");
