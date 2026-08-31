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
const { buildTimeline, executionStatus, intervalElapsedTime, snapshotSignature } = sandbox.window.__GESTAO_TEST_API__;

// Desde que os horarios do intervalo passaram a guardar data e hora, app.js
// so aceita carimbo completo (STAMP_PATTERN, YYYY-MM-DDTHH:MM): relogio puro
// devolve null em stampToAbsolute e a linha do tempo sai inteira vazia. Os
// cenarios continuam escritos em relogio, que e como se fala deles em campo;
// o dia do intervalo entra aqui, num lugar so.
function anchorClocks(candidate) {
  const anchor = (value) => (/^\d{2}:\d{2}$/.test(value || "") ? `${candidate.date}T${value}` : value);
  return {
    ...candidate,
    windowStart: anchor(candidate.windowStart),
    windowEnd: anchor(candidate.windowEnd),
    steps: candidate.steps.map((step) => ({
      ...step,
      plannedStart: anchor(step.plannedStart),
      plannedEnd: anchor(step.plannedEnd),
      actualStart: anchor(step.actualStart),
      actualEnd: anchor(step.actualEnd)
    }))
  };
}

function plan(steps, overrides = {}) {
  return anchorClocks({
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
  });
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
  // 09:15 agora. A etapa 1 abriu 5 min cedo mas ja passou dos 60 min planejados;
  // 2 e 3 nao comecaram. Todas so podem terminar daqui a 60 min: 10:15 contra
  // prazo 10:00. Em paralelo, nao em cascata -- senao seriam tres horas.
  assert.equal(status.delay, 15, "o saldo é o término projetado contra o prazo, sem cascatear etapas sobrepostas");
  assert.equal(status.operational.type, "active-start");
}

{
  const candidate = plan([
    { plannedStart: "08:00", plannedEnd: "09:00", actualStart: "07:55" },
    { plannedStart: "08:30", plannedEnd: "09:30", actualStart: "08:20" },
    { plannedStart: "09:00", plannedEnd: "10:00" }
  ]);
  const status = statusOf(candidate);
  // Duas etapas abertas alem da propria duracao e a terceira sem comecar: o
  // adiantamento do inicio (−10) ja foi consumido e nao aparece mais no saldo.
  assert.equal(status.delay, 15, "iniciar adiantado não sustenta o saldo depois que a etapa estoura a duração");
  assert.equal(status.active.length, 2, "as duas etapas permanecem simultaneamente em andamento");
}

{
  const candidate = plan([
    { plannedStart: "08:00", plannedEnd: "09:00", actualStart: "08:05", actualEnd: "09:10" },
    { plannedStart: "08:30", plannedEnd: "09:30", actualStart: "08:20" }
  ]);
  const status = statusOf(candidate);
  // A etapa 2 ainda esta dentro da duracao planejada (08:20 + 60 = 09:20), logo
  // o adiantamento continua valendo: 09:20 contra o prazo 10:00.
  assert.equal(status.delay, -40, "etapa aberta dentro da duração planejada preserva o adiantamento");
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
  // Nada comecou: as duas etapas so podem sair agora, em paralelo, e terminam
  // 10:15 contra o prazo 10:00.
  assert.equal(status.delay, 15, "sem nenhum início realizado, o saldo é o plano inteiro empurrado para agora");
  assert.equal(status.operational.step.id, "step-1");
  assert.equal(status.operational.type, "waiting-overdue");
}

{
  // Regressao do caso real: etapa aberta muito alem da propria duracao. Pela
  // regra anterior -- desvio de INICIO do marco mais avancado -- este intervalo
  // aparecia como "adiantado 60 min" enquanto o termino ja passava do prazo.
  const candidate = plan([
    { plannedStart: "08:00", plannedEnd: "09:00", actualStart: "07:00" },
    { plannedStart: "09:00", plannedEnd: "10:00" }
  ]);
  const status = statusOf(candidate);
  assert.equal(status.delay, 15, "começar cedo e não fechar a etapa é atraso, não adiantamento");
  assert.equal(status.projectedEnd, status.deadline + 15, "o saldo é exatamente a distância entre término previsto e prazo");
}

console.log("schedule-status: 6 cenários aprovados");

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
  const steps = [{ client_id: "step-1", status: "running" }];
  const local = snapshotSignature({ database_id: null, client_id: "plan-1", title: "Plano" }, steps);
  const confirmed = snapshotSignature({ database_id: "server-plan-id", client_id: "plan-1", title: "Plano" }, steps);
  const edited = snapshotSignature({ database_id: "server-plan-id", client_id: "plan-1", title: "Plano revisado" }, steps);
  assert.equal(local, confirmed, "a confirmação do ID do servidor não deve gerar uma nova operação offline");
  assert.notEqual(confirmed, edited, "edições feitas durante a sincronização precisam gerar uma nova operação");
}

console.log("offline-signature: idempotência e reedição aprovadas");
