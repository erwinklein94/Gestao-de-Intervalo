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
  'id="interval-detail"',
  'id="interval-detail-content"'
], "estrutura da visão gerencial");

assert.deepEqual(attributeValues(management, "data-view-button"), ["delays", "running", "history", "overview"]);
assert.deepEqual(attributeValues(management, "data-view"), ["delays", "running", "history", "overview"]);
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

// Integrações estruturais das páginas existentes que receberam as novas funções.
const account = read("conta.html");
includesAll(account, ['id="account-history"', 'id="account-admin-link"', 'id="account-examples"', "gestao.html?view=history", "SUBs sob responsabilidade"], "histórico e atalhos da Minha Conta");

const planning = read("index.html");
includesAll(planning, ['name="subId"', "SUB responsável"], "seleção da SUB no planejamento");

const execution = read("executar.html");
includesAll(execution, [
  'id="execution-comments-panel"',
  'id="execution-comments"',
  'id="execution-comment-form"',
  'id="execution-comment-feedback"',
  'id="execution-comments-locked"'
], "comentários da execução");

const shared = read("acompanhar.html");
assert.deepEqual(attributeValues(shared, "data-shared-tab"), ["plan", "execution", "dashboard"]);
assert.deepEqual(attributeValues(shared, "data-shared-view"), ["plan", "execution", "dashboard"]);
includesAll(shared, ['id="shared-plan-summary"', 'id="shared-planning-notes"', 'id="shared-planned-steps"', 'id="shared-comments"'], "acompanhamento público somente leitura");

const styles = read("styles.css");
includesAll(styles, [
  ".management-tabs",
  ".portal-filter-grid",
  ".interval-card",
  ".interval-card.is-late",
  ".interval-detail-dialog",
  ".demo-banner",
  ".admin-form",
  ".admin-row",
  ".comments-list"
], "estilos dos componentes novos");
assert.match(styles, /@media \(max-width: 720px\)/, "componentes devem compartilhar o breakpoint móvel principal");
let braceBalance = 0;
for (const character of styles.replace(/\/\*[\s\S]*?\*\//g, "")) {
  if (character === "{") braceBalance += 1;
  if (character === "}") braceBalance -= 1;
  assert.ok(braceBalance >= 0, "CSS não pode fechar um bloco inexistente");
}
assert.equal(braceBalance, 0, "todos os blocos CSS devem ser fechados");

console.log("pages-structure: portal, administração e integrações estruturais aprovados");
