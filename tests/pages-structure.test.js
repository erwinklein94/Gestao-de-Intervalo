"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
const pages = fs.readdirSync(root).filter((file) => file.endsWith(".html"));

function includesAll(source, values, message) {
  values.forEach((value) => assert.ok(source.includes(value), `${message}: ausente ${value}`));
}

function attributeValues(source, attribute) {
  return [...source.matchAll(new RegExp(`${attribute}="([^"]+)"`, "g"))].map((match) => match[1]);
}

pages.forEach((page) => {
  assert.ok(read(page).includes("assets/pwa.js"), `${page} deve carregar os recursos compartilhados`);
});
includesAll(read("assets/pwa.js"), [
  'className = "back-to-top"',
  'button.textContent = "Subir"',
  'window.scrollTo({ top: 0, behavior: "smooth" })'
], "atalho compartilhado para subir a página");

const management = read("gestao.html");
assert.match(management, /<html[^>]*class="auth-checking"/);
assert.match(management, /<body[^>]*data-page="management"/);
assert.ok(management.indexOf("assets/auth-guard.js") < management.indexOf("assets/portal.js"), "proteção de autenticação deve carregar antes do portal");
includesAll(management, [
  "data-role-nav",
  'id="infra-cards"',
  'id="super-cards"',
  'id="modernization-cards"',
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

assert.deepEqual(attributeValues(management, "data-view-button"), ["running", "history", "overview"]);
assert.deepEqual(attributeValues(management, "data-view"), ["running", "history", "overview"]);
assert.match(management, /class="management-tabs"[^>]*role="tablist"/, "áreas gerenciais devem ser um conjunto acessível de botões");
assert.deepEqual(attributeValues(management, "data-filter"), [
  "manager",
  "coordinator",
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
  'value="specialist"',
  'name="classification"',
  'value="modernization"',
  'name="subordinateIds"',
  'multiple size="5"',
  "data-subordinates-field",
  'id="admin-users"'
], "estrutura da administração");
assert.ok(!admin.includes("SUB"), "administração não deve expor cadastro de SUB");

const audit = read("auditoria.html");
assert.match(audit, /<body[^>]*data-page="audit"/);
assert.ok(audit.indexOf("assets/auth-guard.js") < audit.indexOf("assets/portal.js"), "proteção de autenticação deve carregar antes da auditoria");
includesAll(audit, ['id="audit-last-updated"', 'id="audit-refresh"', 'id="audit-accesses"', 'id="audit-empty"', 'id="audit-change-requests"', 'id="audit-requests-empty"', "100 acessos mais recentes", "Nome do usuário", "E-mail", "Página acessada", "Data e horário"], "estrutura da auditoria de acessos e solicitações");
includesAll(read("assets/portal.js"), ['["auditoria.html", "Auditoria", "audit"]', 'async function registerSiteAccess()', 'async function loadAuditAccesses()', '.from("site_access_audit")', '.limit(100)', '.from("profile_change_requests")', '.from("user_profiles")', '.select("id,full_name,role")', 'profileNames.get(access.user_id)', 'access.user_id !== currentUser.id', 'profileRoles.get(access.user_id) !== "editor"'], "navegação, atualização e exclusão dos acessos de Editor na auditoria");

// Integrações estruturais das páginas existentes que receberam as novas funções.
const account = read("conta.html");
includesAll(account, ['id="account-history"', 'id="account-password-form"', 'name="currentPassword"', 'name="newPassword"', 'id="account-change-request-card"', 'id="account-change-request-form"', 'name="message"', 'id="account-change-request-feedback"', 'id="account-transition-card"', 'id="account-transition-toggle"', 'id="account-transition-status"'], "histórico, troca de senha, transição experimental e solicitação ao Editor da Minha Conta");
assert.ok(!account.includes("SUB"), "Minha Conta não deve exibir SUB");
assert.ok(!account.includes("account-shortcut"), "Minha Conta não deve exibir atalhos");
assert.ok(!read("app.js").includes("const roleLabel = roleLabel("), "Minha Conta não deve ocultar a função roleLabel com uma variável local");
includesAll(read("app.js"), [
  "const profileRoleLabel = roleLabel(currentProfile.role, currentProfile.role_gender)",
  '$("#account-role").textContent = profileRoleLabel',
  '$("#account-detail-role").textContent = profileRoleLabel',
  'const showsPersonalHistory = ![...READ_ONLY_MANAGEMENT_ROLES, "editor"].includes(currentProfile.role)',
  '$("#account-history-card").hidden = !showsPersonalHistory',
  "if (showsPersonalHistory) await renderAccountHistory()"
], "Minha Conta deve preencher a função flexionada sem interromper os demais dados");
includesAll(read("assets/pwa.js"), [
  'EDITOR_TRANSITION_KEY = "gestaoIntervaloRumo.editorPageTransitions"',
  'role === "editor" && editorTransitionPreference(userId)',
  "function saveTransitionOrigin(link, destination)",
  'window.addEventListener("pagereveal"',
  'pseudoElement: "::view-transition-new(root)"',
  'classList.add("page-transition-circle-enter")',
  "window.EditorPageTransitions"
], "transição opcional e exclusiva do Editor");
includesAll(read("app.js"), [
  "function bindEditorPageTransitionPreference()",
  'currentProfile.role !== "editor"',
  "transitions.setEnabled(enabled, currentUser.id)",
  "bindEditorPageTransitionPreference()"
], "controle da transição na Minha Conta do Editor");
assert.ok(read("assets/portal.js").includes("window.EditorPageTransitions?.apply(actualProfile.role, currentUser.id)"), "portal deve ativar a preferência somente após validar o perfil");

const planning = read("index.html");
includesAll(planning, [
  'name="coordinator"',
  'id="export-button"',
  'id="export-plan-pdf"',
  'id="front-strip"',
  'name="frontName"'
], "responsável, frentes e exportações do planejamento");
assert.ok(!planning.includes("SUB"), "planejamento não deve exigir SUB");

const execution = read("executar.html");
includesAll(execution, [
  'id="execution-comments-panel"',
  'id="execution-comments"',
  'id="execution-comment-form"',
  'id="execution-comment-feedback"',
  'id="execution-comments-locked"',
  'id="export-execution-xlsx"',
  'id="print-button"',
  'assets/jszip.min.js',
  'id="front-strip"',
  'id="execution-silence"',
  'id="closing-fronts"'
], "comentários, frentes, silêncio e encerramento da execução");

const dashboard = read("dashboard.html");
includesAll(dashboard, ['id="export-dashboard-xlsx"', 'id="export-dashboard-pdf"', 'assets/jszip.min.js'], "exportações do dashboard");

const shared = read("acompanhar.html");
assert.deepEqual(attributeValues(shared, "data-shared-tab"), ["plan", "execution", "dashboard"]);
assert.deepEqual(attributeValues(shared, "data-shared-view"), ["plan", "execution", "dashboard"]);
includesAll(shared, ['assets/supabase.min.js', 'assets/jszip.min.js', 'id="export-shared-xlsx"', 'id="export-shared-pdf"', 'id="shared-plan-summary"', 'id="shared-planning-notes"', 'id="shared-planned-steps"', 'id="shared-comments"', 'id="shared-access-title"', 'id="shared-access-description"'], "acompanhamento público e autenticado somente leitura");
includesAll(read("app.js"), [
  // Deixou de ser const porque trocar de frente reaponta o plano exibido.
  'let requestedPlanId = params.get("plan")',
  'const requestedView = params.get("view")',
  'async function loadInternalPlan()',
  '.eq("id", requestedPlanId)',
  'access_mode: "profile"',
  "function exportPageToPdf",
  "async function exportPlanFromButton",
  'type="dataBar"'
], "carregamento autenticado do acompanhamento completo");
includesAll(read("app.js"), [
  "function renderSharedSubtitle(plan, sharedFront)",
  'responsibleName.className = "shared-responsible-name"',
  "responsibleName.textContent = plan.coordinator"
], "destaque seguro do nome do responsável no acompanhamento");

const styles = read("styles.css");
includesAll(styles, ["@view-transition { navigation: auto; }", "::view-transition-old(root)", "::view-transition-new(root)", "html.editor-page-transitions body.page-transition-circle-enter", "@keyframes editor-page-circle-enter", "@media (prefers-reduced-motion: reduce)"], "expansão circular acessível da navegação do Editor");
assert.ok(styles.includes(".shared-responsible-name { color: var(--yellow); font-size: 1.1em;"), "nome do responsável deve usar o amarelo Rumo com aumento discreto");
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
  ".admin-form",
  ".admin-row",
  ".comments-list",
  ".front-tab",
  ".silence-chip",
  ".card-silence",
  ".closing-fronts",
  ".management-tabs button .tab-badge"
], "estilos dos componentes novos");
includesAll(styles, [
  // Uma linha so para a navegação do topo. Com auto-fit e mínimo de 92px, uma
  // tela de 375px só acomodava três colunas e "Conta" descia sozinha para uma
  // segunda linha, engordando o cabeçalho de todas as páginas.
  "grid-template-columns: repeat(var(--nav-count, 4), minmax(0, 1fr))",
  ".management-tabs { grid-template-columns: repeat(2, minmax(0, 1fr)); }",
  ".shared-tabs,\n  .detail-tabs { grid-template-columns: repeat(3, minmax(0, 1fr)); }",
  "max-height: calc(100dvh - 12px)",
  "padding: 14px 14px max(24px, env(safe-area-inset-bottom))",
  ".portal-filter-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }"
], "navegação compacta e modais seguros no celular");
// O CSS agora conta com --nav-count para saber quantas colunas abrir; quem
// publica essa contagem é o portal.js, ao montar a navegação por perfil. Se um
// dos dois lados sumir, a barra volta a quebrar em duas linhas em silêncio.
const portal = read("assets/portal.js");
assert.match(portal, /nav\.style\.setProperty\("--nav-count", links\.length\)/, "o portal precisa publicar quantos destinos o perfil tem");
assert.ok(styles.includes("var(--nav-count, 4)"), "o CSS precisa consumir a contagem publicada pelo portal");

assert.match(styles, /@media \(max-width: 720px\)/, "componentes devem compartilhar o breakpoint móvel principal");
let braceBalance = 0;
for (const character of styles.replace(/\/\*[\s\S]*?\*\//g, "")) {
  if (character === "{") braceBalance += 1;
  if (character === "}") braceBalance -= 1;
  assert.ok(braceBalance >= 0, "CSS não pode fechar um bloco inexistente");
}
assert.equal(braceBalance, 0, "todos os blocos CSS devem ser fechados");


// Um /* que nunca abriu faz o parser engolir a regra seguinte inteira, sem
// erro nenhum: foi assim que .front-bar passou dois commits sem display:grid.
const semComentarios = styles.replace(/\/\*[\s\S]*?\*\//g, "");
assert.ok(!semComentarios.includes("*/"), "há um */ sem /* correspondente: a regra logo abaixo dele é descartada pelo navegador");
assert.ok(!semComentarios.includes("/*"), "há um /* que nunca fecha");
assert.match(styles, /^\.front-bar \{[^}]*display: grid/m, "a faixa de frentes precisa continuar chegando ao navegador");

// Execução no celular: o caminho até as etapas.
const compactacao = styles.indexOf("Execucao no celular");
assert.ok(compactacao > -1, "o bloco que encolhe o topo da execução no celular sumiu");
assert.ok(compactacao < styles.indexOf("@media print"), "a compactação móvel precisa vir antes de @media print, senão ela vence na hora de gerar o PDF");
includesAll(styles.slice(compactacao), [
  ".status-value strong { font-size: 54px; }",
  ".execution-heading h1 { font-size: 21px; line-height: 1.15; }",
  ".execution-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }",
  ".metric-card { min-height: 0;",
  ".metric-card.emphasis { grid-column: 1 / -1; }",
  ".execution-panel .panel-heading { padding: 13px 16px 11px;"
], "compactação do topo da execução no celular");
// A previsão ocupa a linha toda no celular; na impressão a grade tem 5 colunas
// e ela precisa voltar a ser um cartão comum.
assert.match(styles.slice(styles.indexOf("@media print")), /\.metric-card\.emphasis \{ grid-column: auto;/, "a previsão não pode esticar por cinco colunas no PDF");
// Os valores grandes de antes não podem sobreviver em outro bloco e vencer no
// final da cascata.
["font-size: 68px", "min-height: 118px"].forEach((morto) => {
  assert.ok(!styles.includes(morto), `sobrou a medida antiga ${morto}, que reverteria a compactação`);
});

console.log("pages-structure: portal, administração e integrações estruturais aprovados");
