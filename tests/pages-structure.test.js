"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function includesAll(source, values, message) {
  values.forEach((value) => assert.ok(source.includes(value), `${message}: ausente ${value}`));
}

function attributeValues(source, attribute) {
  return [...source.matchAll(new RegExp(`${attribute}="([^"]+)"`, "g"))].map((match) => match[1]);
}

const management = read("gestao.html");
assert.match(management, /<html[^>]*class="auth-checking"/);
assert.match(management, /<body[^>]*data-page="management"/);
assert.ok(management.indexOf("assets/auth-guard.js") < management.indexOf("assets/portal.js"), "proteção de autenticação deve carregar antes do portal");
includesAll(management, [
  "data-role-nav",
  'id="demo-banner"',
  'id="demo-persona"',
  'id="exit-demo"',
  'id="delay-cards"',
  'id="infra-cards"',
  'id="super-cards"',
  'id="history-cards"',
  'id="overview-kpis"',
  'id="classification-chart"',
  'id="punctuality-chart"',
  'id="service-chart"',
  'id="trend-chart"',
  'id="export-management-xlsx"',
  'id="export-management-pdf"',
  'id="portal-print-title"',
  'assets/jszip.min.js',
  'id="interval-detail"',
  'id="interval-detail-content"'
], "estrutura da visão gerencial");
includesAll(read("assets/portal.js"), [
  "data-full-tracking-link",
  "Abrir página completa",
  "function fullTrackingUrl",
  'link.searchParams.set("plan", plan.id)',
  'link.searchParams.set("view",'
], "atalho da prévia para o acompanhamento completo");
includesAll(read("assets/portal.js"), [
  "async function exportManagementToXlsx",
  "function exportManagementToPdf",
  'type="dataBar"',
  "selectedFilterSummary()"
], "exportações do escopo gerencial filtrado");

assert.deepEqual(attributeValues(management, "data-view-button"), ["delays", "running", "history", "overview"]);
assert.deepEqual(attributeValues(management, "data-view"), ["delays", "running", "history", "overview"]);
assert.match(management, /class="management-tabs"[^>]*role="tablist"/, "áreas gerenciais devem ser um conjunto acessível de botões");
assert.deepEqual(attributeValues(management, "data-filter"), [
  "manager",
  "coordinator",
  "sub",
  "classification",
  "status",
  "deadline",
  "service",
  "dateFrom",
  "dateTo",
  "query"
]);

const admin = read("admin.html");
assert.match(admin, /<html[^>]*class="auth-checking"/);
assert.match(admin, /<body[^>]*data-page="admin"/);
assert.ok(admin.indexOf("assets/auth-guard.js") < admin.indexOf("assets/portal.js"), "proteção de autenticação deve carregar antes da administração");
includesAll(admin, [
  "data-role-nav",
  'id="admin-user-form"',
  'name="fullName"',
  'name="email"',
  'name="password"',
  'name="role"',
  'value="director"',
  'value="executive_manager"',
  'Gerente Executivo',
  'value="consultant"',
  'value="manager"',
  'value="coordinator"',
  'value="editor"',
  'name="managerId"',
  'name="subIds"',
  'multiple size="5"',
  'name="coordinatorType"',
  "data-coordinator-field",
  'id="admin-users"',
  'id="sub-form"',
  'id="admin-subs"'
], "estrutura da administração");
assert.deepEqual(attributeValues(admin, "data-admin-tab"), ["users", "subs"]);
assert.deepEqual(attributeValues(admin, "data-admin-view"), ["users", "subs"]);
assert.match(admin, /class="admin-tabs"[^>]*role="tablist"/, "áreas administrativas devem ser um conjunto acessível de botões");

// Integrações estruturais das páginas existentes que receberam as novas funções.
const account = read("conta.html");
includesAll(account, ['id="account-history"', 'id="account-admin-link"', 'id="account-examples"', "gestao.html?view=history", "SUBs sob responsabilidade"], "histórico e atalhos da Minha Conta");

const planning = read("index.html");
includesAll(planning, ['name="subId"', "SUB responsável", 'id="export-button"', 'id="export-plan-pdf"'], "seleção da SUB e exportações do planejamento");

const execution = read("executar.html");
includesAll(execution, [
  'id="execution-comments-panel"',
  'id="execution-comments"',
  'id="execution-comment-form"',
  'id="execution-comment-feedback"',
  'id="execution-comments-locked"',
  'id="export-execution-xlsx"',
  'id="print-button"',
  'assets/jszip.min.js'
], "comentários da execução");

const dashboard = read("dashboard.html");
includesAll(dashboard, ['id="export-dashboard-xlsx"', 'id="export-dashboard-pdf"', 'assets/jszip.min.js'], "exportações do dashboard");

const shared = read("acompanhar.html");
assert.deepEqual(attributeValues(shared, "data-shared-tab"), ["plan", "execution", "dashboard"]);
assert.deepEqual(attributeValues(shared, "data-shared-view"), ["plan", "execution", "dashboard"]);
includesAll(shared, ['assets/supabase.min.js', 'assets/jszip.min.js', 'id="export-shared-xlsx"', 'id="export-shared-pdf"', 'id="shared-plan-summary"', 'id="shared-planning-notes"', 'id="shared-planned-steps"', 'id="shared-comments"', 'id="shared-access-title"', 'id="shared-access-description"'], "acompanhamento público e autenticado somente leitura");
includesAll(read("app.js"), [
  'const requestedPlanId = params.get("plan")',
  'const requestedView = params.get("view")',
  'async function loadInternalPlan()',
  '.eq("id", requestedPlanId)',
  'access_mode: "profile"',
  "function exportPageToPdf",
  "async function exportPlanFromButton",
  'type="dataBar"'
], "carregamento autenticado do acompanhamento completo");

const styles = read("styles.css");
includesAll(styles, [
  ".management-tabs",
  ".portal-filter-grid",
  ".interval-card",
  ".interval-card.is-late",
  ".interval-detail-dialog",
  ".detail-full-page-bar",
  ".page-export-bar",
  "body.portal-printing",
  "body.shared-printing",
  "body.planning-printing",
  ".interval-detail-dialog > div",
  "min-height: 0",
  "scrollbar-gutter: stable",
  ".demo-banner",
  ".admin-form",
  ".admin-row",
  ".comments-list"
], "estilos dos componentes novos");
includesAll(styles, [
  "grid-template-columns: repeat(auto-fit, minmax(92px, 1fr))",
  ".management-tabs { grid-template-columns: repeat(2, minmax(0, 1fr)); }",
  ".shared-tabs,\n  .detail-tabs { grid-template-columns: repeat(3, minmax(0, 1fr)); }",
  "max-height: calc(100dvh - 12px)",
  "padding: 14px 14px max(24px, env(safe-area-inset-bottom))",
  ".portal-filter-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }"
], "navegação compacta e modais seguros no celular");
assert.match(styles, /@media \(max-width: 720px\)/, "componentes devem compartilhar o breakpoint móvel principal");
let braceBalance = 0;
for (const character of styles.replace(/\/\*[\s\S]*?\*\//g, "")) {
  if (character === "{") braceBalance += 1;
  if (character === "}") braceBalance -= 1;
  assert.ok(braceBalance >= 0, "CSS não pode fechar um bloco inexistente");
}
assert.equal(braceBalance, 0, "todos os blocos CSS devem ser fechados");

console.log("pages-structure: portal, administração e integrações estruturais aprovados");
