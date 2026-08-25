"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const migrationDirectory = path.join(root, "supabase", "migrations");
const migration = fs.readdirSync(migrationDirectory)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .map((file) => fs.readFileSync(path.join(migrationDirectory, file), "utf8"))
  .join("\n");
const app = read("app.js");
const createUser = read("supabase/functions/create-site-user/index.ts");
const share = read("supabase/functions/interval-share/index.ts");
const commentAuthorization = read("supabase/migrations/20260821152000_restrict_comments_to_operators.sql");
const hierarchyMigration = read("supabase/migrations/20260821190000_remodel_profile_hierarchy.sql");
const sharedManagerMigration = read("supabase/migrations/20260821193000_allow_shared_manager_scope.sql");
const coordinatorScopeBackfill = read("supabase/migrations/20260821161000_backfill_requested_coordinator_scope.sql");

function containsAll(source, values, label) {
  for (const value of values) assert.ok(source.includes(value), `${label}: ausente ${value}`);
}

containsAll(migration, [
  "'director', 'executive_manager', 'consultant'",
  "create table if not exists public.datasets",
  "create table if not exists public.organization_members",
  "create table if not exists public.interval_comments",
  "create table if not exists public.interval_sync_receipts",
  "create table if not exists public.interval_audit_log",
  "create table public.site_access_audit",
  "Enabled users register own access",
  "Editors read site access audit",
  "create or replace function private.can_read_plan",
  "create or replace function private.can_write_plan",
  "create or replace function public.sync_interval_plan",
  "pg_advisory_xact_lock",
  "SYNC_CONFLICT",
  "interval_sync_receipts_operation_key unique (actor_id, device_id, operation_id)",
  "interval_comments_client_key unique (plan_id, author_user_id, client_id)",
  "new.status := 'completed'",
  "new.completed_at := old.completed_at",
  "private.actual_role() = 'editor'",
  "security invoker",
  "generate_series(100, 103)"
], "estrutura segura do banco");

containsAll(hierarchyMigration, [
  "'coordinator', 'specialist', 'editor'",
  "when 'executive_manager' then exists",
  "create or replace function private.can_read_plan",
  "create or replace function private.can_write_plan",
  "create or replace function private.can_read_member",
  "target_role in ('coordinator', 'specialist')",
  "manager.manager_id = private.current_member_id()",
  "p_subordinate_ids uuid[]",
  "'infrastructure', 'superstructure', 'modernization'",
  "new.sub_id := case when tg_op = 'UPDATE' then old.sub_id else null end",
  "revoke all on public.subs, public.coordinator_sub_assignments from authenticated",
  "security invoker",
  "drop trigger if exists user_profiles_sync_primary_coordinator_sub"
], "Especialista, hierarquia gerencial e retirada de SUB");
assert.ok(!hierarchyMigration.includes("when 'executive_manager' then true"), "Gerente Executivo não pode receber escopo global");
assert.ok(!hierarchyMigration.includes("delete from public.coordinator_sub_assignments"), "vínculos históricos de SUB devem ser preservados");

containsAll(sharedManagerMigration, [
  "create table public.manager_operator_assignments",
  "primary key (manager_member_id, operator_member_id)",
  "alter table public.manager_operator_assignments enable row level security",
  "assignment.manager_member_id = private.current_member_id()",
  "assignment.operator_member_id = target_coordinator_id",
  "on conflict do nothing",
  "manager_id is null",
  "security invoker"
], "escopo compartilhado entre Gerentes");
assert.ok(!sharedManagerMigration.includes("set manager_id = p_target_user_id\n+    where id = any(normalized_ids);"), "novo vínculo não pode reatribuir Coordenador de outro Gerente");

containsAll(coordinatorScopeBackfill, [
  "private.real_dataset_id()",
  "lower(coordinator_auth.email) = 'raquel.klein@rumolog.com'",
  "manager.role = 'manager'",
  "plan.manager_member_id is null"
], "reparo idempotente do escopo legado da Coordenadora");
assert.ok(!coordinatorScopeBackfill.includes("lower(btrim(plan.coordinator))"), "texto livre não pode reatribuir um plano legado");

for (const table of ["interval_plans", "interval_steps", "user_profiles", "datasets", "subs", "organization_members", "coordinator_sub_assignments", "manager_operator_assignments", "interval_comments", "interval_sync_receipts", "interval_audit_log", "site_access_audit"]) {
  assert.ok(migration.includes(`alter table public.${table} enable row level security`), `RLS deve estar ativa em ${table}`);
}
assert.ok(commentAuthorization.includes("private.can_write_plan(plan.dataset_id, plan.coordinator_member_id)"), "comentários devem exigir permissão operacional");
assert.ok(!commentAuthorization.includes("private.can_read_plan"), "permissão de leitura não pode autorizar comentários");

// Encerramento e vinculo entre frentes sao decisao de banco, nao de tela.
const frontsMigration = read("supabase/migrations/20260823100000_interval_fronts_weather_and_closure.sql");
containsAll(frontsMigration, [
  "create or replace function public.close_interval(p_group_id uuid)",
  "revoke all on function public.close_interval(uuid) from public, anon;",
  "grant execute on function public.close_interval(uuid) to authenticated;",
  "not private.can_write_plan(plan.dataset_id, plan.coordinator_member_id)",
  "Este intervalo pertence a outro responsavel.",
  "new.group_id := old.group_id;",
  "security definer"
], "encerramento do intervalo e propriedade das frentes");
assert.ok(
  frontsMigration.includes("public.close_interval(target.group_id)"),
  "finalizar um plano deve encerrar o intervalo do qual ele faz parte"
);

// A remocao da SUB nao pode levar junto o escopo de Gerente nem a empreiteira.
const subRemoval = read("supabase/migrations/20260823090000_remove_sub_catalog.sql");
containsAll(subRemoval, [
  "drop table if exists public.subs;",
  "alter table public.interval_plans drop column if exists sub_id;",
  "private.actual_role() in ('manager', 'coordinator', 'specialist')",
  "contractor_name = coalesce(p_plan->>'contractor_name', '')"
], "remoção da SUB preservando escopo de Gerente e dados da empreiteira");

containsAll(app, [
  'const OUTBOX_KEY = "gestaoIntervaloRumo.outbox"',
  'const DEVICE_KEY = "gestaoIntervaloRumo.deviceId"',
  "writeStoreLocally();",
  'type: "plan_sync"',
  'type: "comment_create"',
  'type: "comment_delete"',
  'cloudClient.rpc("sync_interval_plan"',
  'item.state = "conflict"',
  'setSyncState("Sem conexão", "offline")',
  "syncRetryTimer = setTimeout",
  "window.addEventListener(\"online\""
], "fila offline durável");

containsAll(app, [
  "const UUID_PATTERN =",
  "bytes[6] = (bytes[6] & 0x0f) | 0x40",
  "bytes[8] = (bytes[8] & 0x3f) | 0x80",
  "if (UUID_PATTERN.test(item.operationId || \"\")) return",
  'item.state = "pending"'
], "UUID válido em HTTP e reparo da fila local existente");

containsAll(app, [
  'setSyncState(navigator.onLine ? "Salvando…" : "Sem conexão"',
  "if (!navigator.onLine) writeStoreLocally();",
  "function enqueueDirtyPlans(saveRecoveryCopy = !navigator.onLine)",
  "if (saveRecoveryCopy) saveOutbox();",
  "/Intervalos concluidos fazem parte do historico/i",
  'showToast("Alteração cancelada: intervalos concluídos pertencem ao histórico.")'
], "banco primeiro quando online e contingência local apenas em falha");

containsAll(createUser, [
  'editor.role !== "editor"',
  "password.length < 8",
  '"executive_manager"',
  '"specialist"',
  "classification",
  "subordinateIds",
  "validateSubordinates",
  "replaceDirectReports",
  'admin.from("manager_operator_assignments").upsert',
  "profile_needs_review: false",
  'admin.from("user_profiles").delete()',
  'admin.from("organization_members").delete()',
  "admin.auth.admin.deleteUser"
], "criação protegida de usuários");

containsAll(share, [
  ".eq(\"token_hash\", tokenHash)",
  '.eq("code", "real").eq("kind", "real")',
  '["editor", "manager", "coordinator", "specialist"].includes(ownerProfile.role)',
  '.select("author_name,author_role,author_role_gender,content,created_at")',
  '.is("deleted_at", null)',
  '"Cache-Control": "no-store"',
  '"X-Content-Type-Options": "nosniff"'
], "acompanhamento externo protegido");

console.log("security-offline-structure: RLS, hierarquia, histórico, outbox e Edge Functions aprovados");
