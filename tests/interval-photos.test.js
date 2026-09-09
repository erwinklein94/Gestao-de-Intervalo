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

// O clique na miniatura abre o visualizador com zoom, sem perder o link para o original.
const styles = read("styles.css");
assert.match(app, /data-photo-view="\$\{escapeHtml\(photo\.signed_url\)\}"/);
assert.match(app, /target="_blank" rel="noopener noreferrer" data-photo-view=/, "o link original precisa continuar disponível sem JS");
assert.match(app, /closest\("\[data-photo-view\]"\)/);
assert.match(app, /function openPhotoViewer/);
assert.match(app, /function setPhotoZoom/);
assert.match(app, /event\.key === "Escape"/);
assert.match(app, /touch-action|pointerdown/, "o visualizador precisa tratar arrasto por toque");
assert.match(styles, /\.photo-viewer-stage \{[^}]*touch-action: none;/);
assert.match(styles, /body\.has-photo-viewer \{ overflow: hidden; \}/);


// As fotos voltam no fim do PDF, maiores e duas por linha, sem partir na virada
// da pagina, e a planilha ganha uma aba propria com os mesmos registros.
assert.ok(execution.includes('id="execution-photo-appendix"'), "execução sem anexo fotográfico");
assert.ok(shared.includes('id="shared-photo-appendix"'), "acompanhamento sem anexo fotográfico");
for (const page of [execution, shared]) {
  assert.ok(page.includes('class="photo-appendix-grid"'), "anexo sem grade de fotos");
  assert.ok(page.includes("data-appendix-count"), "anexo sem contagem de fotos");
}
assert.match(app, /function photoAppendixHtml/);
assert.match(app, /renderPhotoAppendix\("execution-photo-appendix", photos\)/);
assert.match(app, /renderPhotoAppendix\("shared-photo-appendix", sharedPhotos\)/);
assert.match(app, /appendix\.dataset\.empty = photos\.length \? "false" : "true"/);
assert.match(app, /function waitForPrintImages/, "o PDF precisa esperar as fotos carregarem");
assert.match(app, /waitForPrintImages\(\)\.then\(\(\) => setTimeout\(\(\) => window\.print\(\)/);

assert.match(app, /function photosSheetXml/);
assert.match(app, /async function exportPlanToXlsx\(plan, photos = \[\]\)/);
assert.match(app, /worksheets\.file\("sheet2\.xml", photosSheetXml\(/);
assert.match(app, /<sheet name="Fotos" sheetId="2" r:id="rId3"\/>/);
assert.match(app, /Id="rId3"[^>]*Target="worksheets\/sheet2\.xml"/, "a aba de fotos precisa do relacionamento rId3");
assert.match(app, /PartName="\/xl\/worksheets\/sheet2\.xml"/, "a aba de fotos precisa entrar no Content_Types");
assert.match(app, /<f>HYPERLINK\(/, "o link da foto vai como fórmula clicável");
assert.match(app, /exportPlanToXlsx\(plan, await planPhotosForExport\(plan, knownPhotos\)\)/);

assert.match(styles, /^\.photo-appendix \{ display: none; \}$/m, "o anexo não aparece na tela");
assert.match(styles, /\.photo-appendix \{ display: block; break-before: page; page-break-before: always; \}/);
assert.match(styles, /\.photo-appendix\[data-empty="true"\] \{ display: none !important; \}/);
assert.match(styles, /\.photo-appendix-grid \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/, "o anexo imprime duas fotos por linha");
assert.match(styles, /\.execution-step, \.execution-photo, \.print-photo[^{]*\{ break-inside: avoid; page-break-inside: avoid; \}/);
assert.doesNotMatch(styles, /\.execution-step \{ break-inside: auto;/, "etapa não pode partir na virada da página");
assert.match(styles, /tr, img, figure \{ break-inside: avoid; page-break-inside: avoid; \}/);
assert.match(styles, /thead \{ display: table-header-group; \}/, "cabeçalho de tabela se repete a cada página");

console.log("interval-photos: upload imutável, zoom, anexo no PDF e aba de fotos na planilha");
