"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");

const app = read("app.js");
const execution = read("executar.html");
const shared = read("acompanhar.html");
const edge = read("supabase/functions/interval-share/index.ts");
const migration = read("supabase/migrations/20260909101209_add_interval_photos.sql");

for (const marker of ["execution-photo-form", "execution-photo-input", "execution-photos", "execution-photo-feedback", "execution-photos-locked"]) {
  assert.ok(execution.includes(`id="${marker}"`), `execução sem ${marker}`);
}
for (const marker of ["shared-photos", "shared-photo-count"]) {
  assert.ok(shared.includes(`id="${marker}"`), `acompanhamento sem ${marker}`);
}

assert.match(app, /\.storage\.from\(INTERVAL_PHOTO_BUCKET\)\.upload\(/);
assert.match(app, /\.from\("interval_photos"\)\.insert\(/);
assert.match(app, /plan\.status !== "executing"/);
assert.match(app, /createSignedUrls\(paths, expiresIn\)/);
assert.match(app, /photoGalleryHtml\(sharedPhotos/);
assert.match(app, /data-photo-delete/);
assert.match(app, /\.delete\(\)\.eq\("id", photo\.id\)\.eq\("author_user_id", currentUser\.id\)/);

assert.match(edge, /\.from\("interval_photos"\)/);
assert.match(edge, /createSignedUrls\(photos\.map/);
assert.match(edge, /photos: visiblePhotos/);

assert.match(migration, /create table public\.interval_photos/);
assert.match(migration, /alter table public\.interval_photos enable row level security/);
assert.match(migration, /private\.interval_accepts_comments\(new\.plan_id\)/);
assert.match(migration, /create policy "Authorized members read interval photos"/);
assert.match(migration, /create policy "Authorized members upload interval photos"/);
assert.match(migration, /not exists \(\s*select 1 from public\.interval_photos photo/);
assert.match(migration, /grant select, insert on public\.interval_photos to authenticated/);
assert.doesNotMatch(migration, /grant[^;]*(update|delete)[^;]*public\.interval_photos/i, "fotos registradas não podem ser alteradas ou removidas pelo cliente");

const deleteMigration = read("supabase/migrations/20260909163000_allow_photo_authors_to_delete_during_execution.sql");
assert.match(deleteMigration, /author_user_id = \(select auth\.uid\(\)\)/);
assert.match(deleteMigration, /private\.interval_accepts_comments\(plan_id\)/);
assert.match(deleteMigration, /grant select, insert, delete on public\.interval_photos to authenticated/);

console.log("interval-photos: upload imutável e acompanhamento protegidos");
