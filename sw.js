// Service worker do Gestão de Intervalo.
//
// A fila offline (outbox) já garantia que o registro feito sem sinal não se
// perde. O que faltava era o passo anterior: sem rede, a página nem abria.
// Este arquivo guarda o app inteiro no dispositivo, para que o coordenador
// consiga abrir a execução em um trecho sem cobertura e continuar registrando.
//
// Escopo deliberado: só o mesmo domínio entra no cache. Chamadas ao Supabase
// passam direto para a rede -- respostas de dados guardadas aqui virariam
// informação velha exibida como se fosse atual, que é exatamente o erro que
// esta operação não pode cometer.

const VERSION = "20260824-3";
const CACHE = `gestao-intervalo-${VERSION}`;

const SHELL = [
  "./",
  "index.html",
  "executar.html",
  "dashboard.html",
  "gestao.html",
  "admin.html",
  "conta.html",
  "login.html",
  "recuperar-senha.html",
  "acompanhar.html",
  `styles.css?v=${VERSION}`,
  `app.js?v=${VERSION}`,
  `assets/portal.js?v=${VERSION}`,
  "assets/auth-guard.js",
  "assets/pwa.js",
  "assets/supabase.min.js",
  "assets/jszip.min.js",
  "assets/rumo-logo-blue.png",
  "assets/rumo-logo-white.png",
  "assets/icon.svg",
  "manifest.webmanifest"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Um arquivo indisponível não pode derrubar o pré-cache inteiro, que é o
    // que aconteceria com cache.addAll.
    await Promise.all(SHELL.map((path) => cache.add(path).catch((error) => {
      console.warn("Não foi possível pré-carregar", path, error);
    })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

// Navegação: rede primeiro, para que um deploy novo apareça de imediato; o
// cache só entra quando a rede falha.
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true });
    return cached || await cache.match("index.html") || Response.error();
  }
}

// Estáticos: cache primeiro para abrir rápido, com atualização em segundo
// plano para a próxima visita já pegar a versão nova.
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request).then((response) => {
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  return cached || await network || Response.error();
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Supabase, fontes e qualquer outra origem seguem sem interferência.
  if (url.origin !== self.location.origin) return;
  event.respondWith(request.mode === "navigate" ? networkFirst(request) : cacheFirst(request));
});
