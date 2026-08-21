"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const JSZip = require("../assets/jszip.min.js");

const root = path.join(__dirname, "..");

function downloadDocument(page = "test") {
  return {
    body: { dataset: { page }, classList: { add() {}, remove() {} } },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ click() {}, set href(value) { this._href = value; }, get href() { return this._href; } })
  };
}

function testUrl() {}
testUrl.createObjectURL = () => "blob:test";
testUrl.revokeObjectURL = () => {};

function loadAppApi() {
  const sandbox = {
    console,
    crypto: { randomUUID: () => "test-id" },
    document: downloadDocument(),
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout: (callback) => callback(),
    clearTimeout,
    window: { __GESTAO_TEST_MODE__: true, __GESTAO_USER_ID__: null, addEventListener: () => {} },
    JSZip,
    Blob,
    URL: testUrl
  };
  sandbox.window.window = sandbox.window;
  vm.runInNewContext(fs.readFileSync(path.join(root, "app.js"), "utf8"), sandbox, { filename: "app.js" });
  return sandbox.window.__GESTAO_TEST_API__;
}

function loadPortalApi() {
  const sandbox = {
    console,
    crypto: { randomUUID: () => "test-id" },
    document: downloadDocument("management"),
    setTimeout: (callback) => callback(),
    clearTimeout,
    window: { __GESTAO_TEST_MODE__: true },
    JSZip,
    Blob,
    URL: testUrl
  };
  sandbox.window.window = sandbox.window;
  vm.runInNewContext(fs.readFileSync(path.join(root, "assets", "portal.js"), "utf8"), sandbox, { filename: "assets/portal.js" });
  return sandbox.window.__GESTAO_PORTAL_TEST_API__;
}

async function workbookXml(blob, file) {
  const zip = await JSZip.loadAsync(Buffer.from(await blob.arrayBuffer()));
  const entry = zip.file(file);
  assert.ok(entry, `arquivo ${file} deve existir no .xlsx`);
  return entry.async("string");
}

test("Excel do intervalo contém dados e barras gráficas", async () => {
  const { exportPlanToXlsx } = loadAppApi();
  const blob = await exportPlanToXlsx({
    title: "Intervalo de teste",
    date: "2026-08-21",
    serviceType: "Socaria",
    coordinator: "Coordenação teste",
    location: "Trecho teste",
    windowStart: "08:00",
    windowEnd: "10:00",
    notes: "Planejamento",
    executionNotes: "Execução",
    steps: [{ id: "step-1", name: "Atividade", plannedStart: "08:00", plannedEnd: "09:00", actualStart: "08:05", actualEnd: "09:10", executionStatus: "completed", actualNotes: "Concluída" }]
  });
  const sheet = await workbookXml(blob, "xl/worksheets/sheet1.xml");
  assert.match(sheet, /PROGRAMADO X REALIZADO/);
  assert.match(sheet, /conditionalFormatting sqref="E10:E10"/);
  assert.match(sheet, /conditionalFormatting sqref="H10:H10"/);
  assert.match(sheet, /<autoFilter ref="A9:K10"/);
});

test("Excel gerencial contém escopo, indicadores e gráficos filtráveis", async () => {
  const { exportManagementToXlsx } = loadPortalApi();
  const blob = await exportManagementToXlsx([{
    title: "Intervalo gerencial",
    interval_date: "2026-08-21",
    status: "completed",
    coordinator_type: "infrastructure",
    service_type: "Socaria",
    managerName: "Gerente teste",
    coordinatorName: "Coordenador teste",
    subCode: "SUB 001",
    location: "Trecho teste",
    window_start: "2026-08-21T08:00:00",
    window_end: "2026-08-21T10:00:00",
    interval_steps: [{ position: 0, activity_name: "Atividade", planned_start: "2026-08-21T08:00:00", planned_end: "2026-08-21T10:00:00", actual_start: "2026-08-21T08:00:00", actual_end: "2026-08-21T10:15:00", status: "completed" }]
  }]);
  const sheet = await workbookXml(blob, "xl/worksheets/sheet1.xml");
  assert.match(sheet, /VISÃO GERENCIAL/);
  assert.match(sheet, /RESUMO E GRÁFICOS/);
  assert.match(sheet, /DADOS DOS INTERVALOS/);
  assert.match(sheet, /type="dataBar"/);
  assert.match(sheet, /<autoFilter ref="A\d+:L\d+"/);
});
