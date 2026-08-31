"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const quiet = { error() {}, warn() {} };

test("F5 preserva planos já salvos sem usar constantes antes da inicialização", () => {
  const saved = JSON.stringify({
    version: 4, activePlanId: "saved-plan", pendingSync: true, deletedPlanIds: [],
    plans: [{ id: "saved-plan", title: "Registro offline", date: "2026-08-31", frontPosition: 2,
      ccoGrantMinutes: 60, ccoGrantUnit: "hours", windowStart: "2026-08-31T22:00", windowEnd: "2026-09-01T02:00",
      steps: [{ id: "step-1", name: "Etapa registrada", plannedStart: "2026-08-31T23:00", plannedEnd: "2026-09-01T00:00", actualStart: "2026-08-31T23:05", actualNotes: "Manter registro" }] }]
  });
  for (const page of ["execution", "planning", "account"]) {
    const warnings = [];
    const context = {
      console: { warn: (...args) => warnings.push(args) },
      crypto: { randomUUID: () => "new-blank-plan" },
      document: { body: { dataset: { page } }, addEventListener() {} },
      localStorage: {
        getItem: (key) => key === "gestaoIntervaloRumo.v1.user-1" ? saved : null,
        setItem() { assert.fail("carregar não deve sobrescrever dados locais"); },
        removeItem() { assert.fail("carregar não deve excluir dados locais"); }
      },
      navigator: { onLine: true }, setTimeout, clearTimeout,
      window: { __GESTAO_TEST_MODE__: true, __GESTAO_USER_ID__: "user-1", addEventListener() {} }
    };
    vm.runInNewContext(read("app.js"), context, { filename: "app.js" });
    assert.equal(warnings.length, 0, warnings.map((entry) => entry.join(" ")).join("\n"));
    const store = context.window.__GESTAO_TEST_API__.getStore();
    assert.equal(store.activePlanId, "saved-plan");
    assert.equal(store.pendingSync, true);
    assert.equal(store.plans[0].frontPosition, 2);
    assert.equal(store.plans[0].ccoGrantMinutes, 60);
    assert.equal(store.plans[0].steps[0].actualStart, "2026-08-31T23:05");
    assert.equal(store.plans[0].steps[0].actualNotes, "Manter registro");
  }
});

function startup() {
  const children = [];
  const classes = new Set(["auth-checking"]);
  const context = {
    window: {}, console: quiet, setTimeout, clearTimeout, AbortController, Response,
    fetch: async () => new Response("ok"), location: { reload() {} },
    document: {
      documentElement: { classList: { contains: (name) => classes.has(name) } },
      body: { append: (node) => children.push(node) },
      createElement: () => ({ style: {}, setAttribute() {}, append() {}, addEventListener() {}, focus() {}, remove() { children.splice(children.indexOf(this), 1); } })
    }
  };
  vm.runInNewContext(read("assets/startup.js"), context);
  context.window.AppStartup.ready();
  return { api: context.window.AppStartup, context, children, classes };
}

test("sessão expirada chega ao SDK para renovação, sem perder dados online ou offline", () => {
  for (const onLine of [true, false]) {
    const classes = new Set();
    const token = "header." + Buffer.from(JSON.stringify({ sub: "user-1", exp: 1 })).toString("base64url") + ".signature";
    const context = {
      window: {}, URL, atob, navigator: { onLine },
      localStorage: { getItem: () => JSON.stringify({ access_token: token, refresh_token: "test-only" }) },
      location: { href: "https://example.test/index.html", replace() { assert.fail("sessão renovável não deve ser descartada"); } },
      document: { documentElement: { classList: { add: (name) => classes.add(name) } } }
    };
    vm.runInNewContext(read("assets/auth-guard.js"), context);
    assert.equal(context.window.__GESTAO_USER_ID__, "user-1");
    assert.ok(classes.has("auth-checking"), "conteúdo continua protegido até validar perfil");
  }
});

test("guard ainda redireciona quando não há sessão ou token é inválido", () => {
  for (const raw of [null, '{', JSON.stringify({ access_token: 'invalid' })]) {
    let destination;
    vm.runInNewContext(read("assets/auth-guard.js"), {
      URL, atob, localStorage: { getItem: () => raw },
      location: { href: "https://example.test/index.html", replace: (url) => { destination = url; } }
    });
    assert.equal(destination, "https://example.test/login.html");
  }
});

test("espera travada termina; erro oferece nova tentativa sem liberar conteúdo protegido", async () => {
  const { api, children, classes } = startup();
  await assert.rejects(api.wait(new Promise(() => {}), 5), /demorou/);
  assert.equal(await api.wait(Promise.resolve(42), 5), 42);
  api.fail(new Error("offline"));
  api.fail(new Error("repeated"));
  assert.equal(children.length, 1);
  assert.ok(classes.has("auth-checking"));
  api.ready();
  assert.equal(children.length, 0, "recuperação remove aviso");
});

test("fetch preserva HTTP de erro e respeita cancelamento do chamador", async () => {
  const { api, context } = startup();
  context.fetch = async () => new Response('{"error":"unavailable"}', { status: 503 });
  const result = await api.fetch("https://example.test");
  assert.equal(result.status, 503);
  assert.equal((await result.json()).error, "unavailable");
  const controller = new AbortController();
  controller.abort();
  context.fetch = async (_, options) => { assert.ok(options.signal.aborted); throw new Error("aborted"); };
  await assert.rejects(api.fetch("https://example.test", { signal: controller.signal }), /aborted/);
});

function portal({ profileError = null, enabled = true, session = { user: { id: "test-user" } } } = {}) {
  const { api } = startup();
  const state = { ready: false, signedOut: false, pageLoaded: false, redirect: null };
  const query = { select() { return this; }, eq() { return this; }, single: async () => ({ data: profileError ? null : { role: "editor", enabled }, error: profileError }) };
  const client = {
    auth: { getSession: async () => ({ data: { session }, error: null }), signOut: async () => { state.signedOut = true; } },
    from: () => query
  };
  const context = {
    window: { supabase: { createClient() {} }, AppStartup: { ...api, ready: () => { state.ready = true; } } },
    document: { body: { dataset: { page: "admin" } }, documentElement: { classList: { remove() {} } } },
    console: quiet, initializeTheme() {}, createClient: () => client,
    configureContext() { context.effectiveProfile = context.actualProfile; },
    roleCapabilities: () => ({ canUseManagement: true }), renderNavigation() {},
    registerSiteAccess: () => new Promise(() => {}), // auditoria indisponível
    initializeAdmin: async () => { state.pageLoaded = true; },
    location: { replace: (url) => { state.redirect = url; } }
  };
  const source = read("assets/portal.js");
  vm.runInNewContext(source.slice(source.indexOf("  async function initialize() {"), source.indexOf("  initialize().catch")), context);
  return { run: () => context.initialize(), state };
}

test("formulário redireciona após login e libera o botão se o perfil falhar", async () => {
  for (const failProfile of [false, true]) {
    let submit;
    let destination;
    const button = { disabled: false, textContent: "Entrar no sistema" };
    const feedback = { textContent: "" };
    const form = { email: { value: "test@example.test" }, password: { value: "synthetic-test-only" }, addEventListener: (_, handler) => { submit = handler; } };
    const { api } = startup();
    const query = { select() { return this; }, eq() { return this; }, single: async () => ({ data: failProfile ? null : { enabled: true, role: "editor" }, error: failProfile ? new Error("offline") : null }) };
    const context = {
      URLSearchParams, console: quiet,
      window: { AppStartup: api },
      location: { search: "", replace: (url) => { destination = url; } },
      $: (selector) => selector === "#login-form" ? form : selector === "#login-feedback" ? feedback : button,
      cloudClient: {
        auth: {
          signInWithPassword: async () => ({ data: { user: { id: "test-user" } }, error: null }),
          signOut() { assert.fail("erro de rede não deve encerrar sessão"); }
        },
        from: () => query
      }
    };
    const source = read("app.js");
    const landing = source.slice(source.indexOf("  function landingPageForRole("), source.indexOf("  function routeAllowedForRole("));
    const login = source.slice(source.indexOf("  function loginPage() {"), source.indexOf('    $("#forgot-password")')) + "\n  }";
    vm.runInNewContext(landing + login + "\nloginPage();", context);
    await submit({ preventDefault() {} });
    assert.equal(button.disabled, false);
    if (failProfile) {
      assert.equal(destination, undefined);
      assert.match(feedback.textContent, /conexão/);
    } else assert.equal(destination, "admin.html");
  }
});

test("após login de Editor o portal abre mesmo com auditoria travada", async () => {
  const { run, state } = portal();
  const { api } = startup();
  await api.wait(run(), 100);
  assert.equal(state.pageLoaded, true);
  assert.equal(state.ready, true);
  assert.equal(state.signedOut, false);
});

test("falha de perfil não desabilita conta nem encerra sessão", async () => {
  const { run, state } = portal({ profileError: new Error("network failed") });
  await assert.rejects(run(), /network failed/);
  assert.equal(state.signedOut, false);
  assert.equal(state.redirect, null);
  assert.equal(state.ready, false);
  assert.equal(state.pageLoaded, false);
});

test("conta realmente desabilitada e sessão ausente continuam sem acesso", async () => {
  const disabled = portal({ enabled: false });
  await disabled.run();
  assert.equal(disabled.state.signedOut, true);
  assert.equal(disabled.state.redirect, "login.html?status=disabled");
  assert.equal(disabled.state.pageLoaded, false);
  const absent = portal({ session: null });
  await absent.run();
  assert.equal(absent.state.redirect, "login.html");
  assert.equal(absent.state.pageLoaded, false);
});

test("arquivos de inicialização versionados carregam antes do aplicativo e entram no cache offline", () => {
  const root = path.join(__dirname, "..");
  for (const file of fs.readdirSync(root).filter((name) => name.endsWith(".html"))) {
    const html = read(file);
    assert.ok(html.indexOf("assets/startup.js?") > 0);
    const app = html.search(/(?:app\.js|assets\/portal\.js)\?/);
    assert.ok(html.indexOf("assets/startup.js?") < app, file);
  }
  const sw = read("sw.js");
  assert.ok(sw.includes("assets/startup.js?v=${VERSION}"));
  assert.ok(!sw.slice(sw.indexOf("async function cacheFirst")).includes("ignoreSearch: true"));
});
