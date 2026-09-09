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


// A foto baixada uma vez fica na tela: nem o endereco assinado nem o HTML da
// galeria sao refeitos a cada atualizacao do intervalo.
assert.match(app, /async function withSignedPhotoUrls\(client, rows, expiresIn = 3600, known = \[\]\)/);
assert.match(app, /reusable\.set\(photo\.storage_path, photo\)/, "endereço ainda válido precisa ser reaproveitado");
assert.match(app, /const missing = photos\.filter\(\(photo\) => !reusable\.has\(photo\.storage_path\)\)/);
assert.match(app, /withSignedPhotoUrls\(cloudClient, data \|\| \[\], 3600, photos\)/);
assert.match(app, /withSignedPhotoUrls\(internalClient, photoRows \|\| \[\], 3600, sharedPhotos\)/);
assert.match(app, /function reusePhotoUrls\(incoming, previous\)/);
assert.match(app, /sharedPhotos = reusePhotoUrls\(metadata\.photos, sharedPhotos\)/);
assert.match(app, /if \(gallery\.dataset\.signature !== signature\)/, "a galeria só é redesenhada quando muda");
assert.match(app, /if \(grid\.dataset\.signature === signature\) return;/, "o anexo só é redesenhado quando muda");
assert.match(app, /if \(sharedGallery\.dataset\.signature !== sharedSignature\)/);

// O autor gira a propria foto e o angulo vale na tela e no PDF.
assert.match(app, /function photoRotation\(photo\)/);
assert.match(app, /\[0, 90, 180, 270\]\.includes\(value\) \? value : 0/);
assert.match(app, /async function rotatePhoto\(button\)/);
assert.match(app, /\.update\(\{ rotation: photoRotation\(photo\) \}\)\.eq\("id", photo\.id\)\.eq\("author_user_id", currentUser\.id\)/);
assert.match(app, /data-photo-rotate="\$\{escapeHtml\(photo\.id\)\}"/);
assert.match(app, /data-rotation="\$\{rotation\}"/, "a miniatura carrega o ângulo");
assert.match(app, /data-photo-rotation="\$\{rotation\}"/, "o visualizador recebe o ângulo pelo link");
assert.match(app, /class="print-photo-frame" data-rotation="\$\{photoRotation\(photo\)\}"/);
assert.match(app, /can_rotate: photo\.author_user_id === currentUser\.id/);
assert.match(app, /rotate\(\$\{rotation\}deg\)/, "o visualizador aplica o giro no transform");
assert.match(app, /function photoFitScale\(\)/, "girada, a foto precisa de ajuste próprio para caber");

assert.match(styles, /\.execution-photo img\[data-rotation="90"\] \{ --giro: 90deg; --ajuste: 1\.3334; \}/);
assert.match(styles, /\.execution-photo img\[data-rotation="180"\] \{ --giro: 180deg; \}/);
assert.match(styles, /\.execution-photo img\[data-rotation="270"\] \{ --giro: 270deg; --ajuste: 1\.3334; \}/);
assert.match(styles, /\.print-photo-frame \{ height: 72mm; display: flex;/, "centralizar por grid deixa a foto estourar a moldura");
assert.match(styles, /\.photo-viewer-stage \{[^}]*display: flex;/);
assert.match(styles, /\.print-photo-frame\[data-rotation="90"\] img, \.print-photo-frame\[data-rotation="270"\] img \{ max-width: 72mm; max-height: 72mm; \}/);

const rotation = read("supabase/migrations/20260909174500_add_interval_photo_rotation.sql");
assert.match(rotation, /add column rotation smallint not null default 0/);
assert.match(rotation, /check \(rotation in \(0, 90, 180, 270\)\)/);
assert.match(rotation, /grant update \(rotation\) on public\.interval_photos to authenticated/, "o UPDATE só pode alcançar a coluna rotation");
assert.doesNotMatch(rotation, /grant update on public\.interval_photos/, "nenhum UPDATE amplo pode ser concedido");
assert.match(rotation, /create policy "Authors rotate own photos"/);
assert.match(rotation, /using \(author_user_id = \(select auth\.uid\(\)\)\)/);
assert.match(rotation, /create trigger interval_photos_rotation_guard/);
assert.match(rotation, /Somente a orientacao da foto pode ser alterada\./);
assert.match(edge, /caption,rotation,author_name/, "o link compartilhado precisa enviar a orientação");


// Página de Fotos: antes, durante e depois do intervalo, no mesmo lugar.
const photosPage = read("fotos.html");
assert.match(photosPage, /<body[^>]*data-page="photos"/);
for (const phase of ["before", "during", "after"]) {
  assert.ok(photosPage.includes(`data-phase="${phase}"`), `fotos.html sem a seção ${phase}`);
  assert.ok(photosPage.includes(`data-phase-gallery="${phase}"`), `fotos.html sem a galeria ${phase}`);
  assert.ok(photosPage.includes(`data-phase-form="${phase}"`), `fotos.html sem o envio ${phase}`);
  assert.ok(photosPage.includes(`data-phase-input="${phase}"`), `fotos.html sem o seletor de arquivo ${phase}`);
  assert.ok(photosPage.includes(`data-phase-locked="${phase}"`), `fotos.html sem o aviso ${phase}`);
  assert.ok(photosPage.includes(`id="photos-appendix-${phase}"`), `fotos.html sem o anexo ${phase}`);
}
// O PDF abre pelo resumo gerencial e só então mostra os três momentos.
assert.ok(photosPage.includes('class="photos-report"'), "fotos.html sem o resumo gerencial do PDF");
for (const marker of ["dashboard-plan-selector", "dashboard-title", "dashboard-progress", "dashboard-timeline", "duration-chart", "completion-ring", "variance-chart", "dashboard-table-body"]) {
  assert.ok(photosPage.includes(`id="${marker}"`), `resumo gerencial sem ${marker}`);
}
assert.ok(photosPage.includes('id="export-photos-pdf"'), "fotos.html sem a exportação em PDF");
assert.match(app, /function photosPage\(\)/);
assert.match(app, /if \(page === "photos"\) photosPage\(\);/);
assert.match(app, /\["planning", "execution", "dashboard", "photos"\]\.includes\(page\)/, "a rota de Fotos é dos perfis operacionais");
assert.match(app, /\["fotos\.html", "Fotos", "photos"\]/, "o menu precisa levar à página de Fotos");
assert.match(app, /dashboardPage\(\);\n    const refreshReport = pageRefreshHandler;/, "o resumo do PDF reaproveita o painel");
assert.match(app, /\$\("#export-photos-pdf"\)\?\.addEventListener/);
assert.match(app, /"Exportar PDF", "photos-printing"/);
assert.match(styles, /body\.photos-printing \.photos-report \{ display: block; \}/);
assert.match(styles, /body\.photos-printing \.photo-phases \{ display: none !important; \}/);
assert.match(styles, /^\.photos-report \{ display: none; \}$/m, "o resumo gerencial não se repete na tela");

// A tela de Execução continua registrando só o durante.
assert.match(app, /phase: "during"/, "o envio da execução é sempre do momento durante");
assert.match(app, /\(data \|\| \[\]\)\.filter\(\(photo\) => photoPhase\(photo\) === "during"\)/);
assert.match(app, /async function uploadPhotosToPlan\(\{ plan, files, caption = "", phase = "during", report/);
assert.match(app, /function phaseAcceptsPhotos\(plan, phase\)/);
assert.match(app, /if \(phase === "before"\) return \["planning", "executing", "completed"\]\.includes\(status\);/);
assert.match(app, /if \(phase === "during" \|\| phase === "after"\) return \["executing", "completed"\]\.includes\(status\);/);
assert.match(app, /PHOTO_PHASE_LABELS\[photoPhase\(photo\)\]/, "a planilha e o anexo mostram o momento");

const phase = read("supabase/migrations/20260910090000_add_interval_photo_phase.sql");
assert.match(phase, /add column phase text not null default 'during'/);
assert.match(phase, /check \(phase in \('before', 'during', 'after'\)\)/);
assert.match(phase, /when 'before' then plan\.status in \('planning', 'executing', 'completed'\)/);
assert.match(phase, /when 'during' then plan\.status in \('executing', 'completed'\)/);
assert.match(phase, /when 'after' then plan\.status in \('executing', 'completed'\)/);
assert.match(phase, /create policy "Authorized members attach photos in open phases"/);
assert.match(phase, /with check \(private\.interval_accepts_photos\(plan_id, phase\)\)/);
assert.match(phase, /or new\.phase <> old\.phase/, "o giro não pode mudar o momento da foto");
assert.match(phase, /private\.interval_accepts_any_photo\(/, "o upload no storage não conhece o momento");
assert.match(edge, /rotation,phase,author_name/, "o link compartilhado precisa enviar o momento");


// O acompanhamento tambem separa as fotos por momento, em aba propria.
assert.ok(shared.includes('data-shared-tab="photos"'), "acompanhamento sem a aba Fotos");
assert.ok(shared.includes('data-shared-view="photos"'), "acompanhamento sem a visão de fotos");
for (const phase of ["before", "during", "after"]) {
  assert.ok(shared.includes(`data-shared-gallery="${phase}"`), `acompanhamento sem a galeria ${phase}`);
  assert.ok(shared.includes(`data-shared-photo-count="${phase}"`), `acompanhamento sem o contador ${phase}`);
  assert.ok(shared.includes(`id="shared-photo-appendix-${phase}"`), `acompanhamento sem o anexo ${phase}`);
}
assert.ok(!shared.includes('id="shared-photos"'), "a galeria única saiu da aba Execução");
assert.ok(shared.includes('id="shared-steps"'), "a aba Execução mantém as etapas");
assert.ok(shared.includes('id="shared-comments"'), "a aba Execução mantém os comentários");
assert.match(app, /\["plan", "execution", "photos", "dashboard"\]\.includes\(requestedView\)/, "o link precisa aceitar a visão de fotos");
assert.match(app, /renderPhotoAppendix\(`shared-photo-appendix-\$\{phase\}`, list\)/);
assert.match(app, /\[data-shared-gallery="\$\{phase\}"\]/);
assert.match(styles, /body\.shared-printing #shared-photos-view \{ display:none !important; \}/);


// O mesmo trecho volta com titulo parecido semana após semana: a data no
// seletor é o que permite escolher o intervalo certo.
assert.match(app, /const dateLabel = plan\.date \? new Date\(`\$\{plan\.date\}T12:00:00`\)\.toLocaleDateString\("pt-BR"\) : "";/);
assert.match(app, /const label = \[\s*\n\s*plan\.title \|\| "Plano sem nome",/);


// O menu cresceu para seis destinos: o circulo do numero nao pode achatar nem
// o rotulo quebrar a fileira.
assert.match(styles, /\.primary-nav a span \{[^}]*flex: 0 0 auto;/, "o círculo do número não pode encolher");
assert.match(styles, /\.primary-nav a span \{[^}]*width: 23px;[^}]*height: 23px;/);
assert.match(styles, /\.primary-nav a \{[^}]*white-space: nowrap;/, "o rótulo em duas linhas desalinha o menu");
assert.match(styles, /\.brand span \{[^}]*white-space: nowrap; \}/);
assert.match(styles, /\.primary-nav a \{[^}]*flex-direction: column; justify-content: flex-start;/, "empilhado, o número fica ancorado no topo");
assert.match(styles, /grid-template-columns: repeat\(var\(--nav-count, 5\), minmax\(0, 1fr\)\)/, "a nav acompanha a quantidade de destinos");


// O menu principal e definido em um lugar so: duplicado, ele divergia -- quem
// abria o Historico ficava sem Fotos no cabecalho.
const startup = read("assets/startup.js");
const portal = read("assets/portal.js");
assert.match(startup, /function navigationLinks\(role\)/);
assert.match(startup, /function renderNavigation\(nav, role, page\)/);
assert.match(startup, /window\.AppStartup = \{[^}]*navigationLinks, renderNavigation \}/);
assert.match(startup, /\["fotos\.html", "Fotos", "photos"\]/);
assert.match(app, /window\.AppStartup\.renderNavigation\(\$\("\.primary-nav"\), currentProfile\.role, page\)/);
assert.match(portal, /window\.AppStartup\.renderNavigation\(\$\("\[data-role-nav\]"\), role, document\.body\.dataset\.page\)/);
assert.doesNotMatch(app, /links = \[\["index\.html"/, "a lista de destinos não pode voltar a ser duplicada");
assert.doesNotMatch(portal, /links = \[\["index\.html"/, "a lista de destinos não pode voltar a ser duplicada");
assert.match(startup, /nav\.style\.setProperty\("--nav-count", links\.length\)/);

// O cabeçalho estático é o primeiro quadro da mesma navegação: se divergir da
// lista do JS, o menu salta assim que o perfil carrega.
for (const page of ["index.html", "executar.html", "dashboard.html", "fotos.html"]) {
  const markup = read(page);
  for (const destino of ["index.html", "executar.html", "dashboard.html", "fotos.html", "gestao.html?view=history", "conta.html"]) {
    assert.ok(markup.includes(`href="${destino}"`), `${page}: cabeçalho sem o destino ${destino}`);
  }
  assert.ok(markup.includes('style="--nav-count:6"'), `${page}: cabeçalho sem a contagem de destinos`);
  assert.equal((markup.match(/<a class="active" href="[^"]*" aria-current="page"><span>/g) || []).length, 1,
    `${page}: o cabeçalho precisa marcar exatamente uma página atual`);
}


// A marca da Rumo sai das telas; ficam as cores e o nome do sistema.
const logoPages = fs.readdirSync(root).filter((file) => file.endsWith(".html") && file !== "_syntax.html");
for (const page of logoPages) {
  const markup = read(page);
  assert.doesNotMatch(markup, /rumo-logo/, `${page} ainda carrega a marca em imagem`);
  assert.ok(markup.includes("Gestão de Intervalo"), `${page} sem o nome do sistema`);
}
assert.ok(!fs.existsSync(path.join(root, "assets/rumo-logo-white.png")), "o arquivo da marca precisa sair do repositório");
assert.ok(!fs.existsSync(path.join(root, "assets/rumo-logo-blue.png")), "o arquivo da marca precisa sair do repositório");
assert.ok(fs.existsSync(path.join(root, "assets/icon.svg")), "o ícone próprio do app continua");
assert.doesNotMatch(read("sw.js"), /rumo-logo/, "o cache offline não pode pedir um arquivo que não existe mais");
for (const page of logoPages) {
  const markup = read(page);
  if (markup.includes('rel="icon"')) assert.match(markup, /rel="icon" href="assets\/icon\.svg"/, `${page}: favicon precisa ser o ícone próprio`);
}
assert.doesNotMatch(styles, /\.brand img/, "sem imagem no cabeçalho, a regra não tem alvo");
assert.doesNotMatch(styles, /\.site-footer img/);
assert.doesNotMatch(styles, /\.login-brand-panel > img/);
assert.doesNotMatch(styles, /print-header img/);
// O nome do sistema e a unica identidade que restou: nao pode ser escondido.
assert.doesNotMatch(styles, /\.brand span \{ display: none; \}/, "o nome do sistema não pode sumir em tela nenhuma");
assert.match(styles, /\.brand \{[^}]*font-size: 16px;[^}]*font-weight: 800;/, "o nome assume o peso que era da marca");
assert.match(styles, /\.brand span \{ white-space: nowrap; \}/);

console.log("interval-photos: antes, durante e depois; giro do autor, cache das imagens e relatório fotográfico");
