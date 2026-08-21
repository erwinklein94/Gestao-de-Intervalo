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

containsAll(coordinatorScopeBackfill, [
  "private.real_dataset_id()",
  "lower(coordinator_auth.email) = 'raquel.klein@rumolog.com'",
  "manager.role = 'manager'",
  "plan.manager_member_id is null"
], "reparo idempotente do escopo legado da Coordenadora");
assert.ok(!coordinatorScopeBackfill.includes("lower(btrim(plan.coordinator))"), "texto livre não pode reatribuir um plano legado");

for (const table of ["interval_plans", "interval_steps", "user_profiles", "datasets", "subs", "organization_members", "coordinator_sub_assignments", "interval_comments", "interval_sync_receipts", "interval_audit_log"]) {
  assert.ok(migration.includes(`alter table public.${table} enable row level security`), `RLS deve estar ativa em ${table}`);
}
assert.ok(commentAuthorization.includes("private.can_write_plan(plan.dataset_id, plan.coordinator_member_id)"), "comentários devem exigir permissão operacional");
assert.ok(!commentAuthorization.includes("private.can_read_plan"), "permissão de leitura não pode autorizar comentários");

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

containsAll(createUser, [
  'editor.role !== "editor"',
  "password.length < 8",
  '"executive_manager"',
  '"specialist"',
  "classification",
  "subordinateIds",
  "validateSubordinates",
  "replaceDirectReports",
  "profile_needs_review: false",
  'admin.from("user_profiles").delete()',
  'admin.from("organization_members").delete()',
  "admin.auth.admin.deleteUser"
], "criação protegida de usuários");

containsAll(share, [
  ".eq(\"token_hash\", tokenHash)",
  '.eq("code", "real").eq("kind", "real")',
  '.eq("is_example", false)',
  '["editor", "coordinator", "specialist"].includes(ownerProfile.role)',
  '.select("author_name,author_role,content,created_at")',
  '.is("deleted_at", null)',
  '"Cache-Control": "no-store"',
  '"X-Content-Type-Options": "nosniff"'
], "acompanhamento externo protegido");

console.log("security-offline-structure: RLS, hierarquia, histórico, outbox e Edge Functions aprovados");
