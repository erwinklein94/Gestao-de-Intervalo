(function () {
  "use strict";

  const TIMEOUT = 20000;
  let panel;

  function createLoginAuth(sdk, url, key) {
    // Login explícito não deve esperar nem renovar uma sessão antiga.
    // Usa o SDK para gravar a nova sessão no mesmo armazenamento do app.
    return new sdk.AuthClient({
      url: `${url}/auth/v1`,
      headers: { apikey: key },
      storageKey: `sb-${new URL(url).hostname.split(".")[0]}-auth-token`,
      storage: localStorage,
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      skipAutoInitialize: true,
      fetch: fetchWithTimeout
    });
  }

  async function wait(operation, milliseconds = TIMEOUT) {
    let timer;
    try {
      return await Promise.race([
        operation,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("A conexão demorou demais. Tente novamente.")), milliseconds);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Cancela a requisição, inclusive se a resposta parar durante a leitura.
  async function fetchWithTimeout(input, options = {}) {
    const controller = new AbortController();
    const originalSignal = options.signal || input?.signal;
    const abort = () => controller.abort(originalSignal.reason);
    if (originalSignal?.aborted) abort();
    else originalSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      const response = await fetch(input, { ...options, signal: controller.signal });
      const body = await response.arrayBuffer();
      return new Response([204, 205, 304].includes(response.status) ? null : body, {
        status: response.status, statusText: response.statusText, headers: response.headers
      });
    } finally {
      clearTimeout(timer);
      originalSignal?.removeEventListener("abort", abort);
    }
  }

  function fail(error) {
    console.error("Falha ao abrir o sistema.", error);
    if (!document.body || panel) return;
    // Mantém a proteção das telas internas; somente o aviso fica visível.
    panel = document.createElement("section");
    panel.setAttribute("role", "alert");
    panel.style.cssText = "position:fixed;inset:0;z-index:2147483647;visibility:visible;pointer-events:auto;display:grid;place-content:center;gap:16px;padding:24px;background:#f2f5f6;color:#123047;font:16px/1.5 Verdana,sans-serif;text-align:center";
    const title = document.createElement("h1");
    title.textContent = "Não foi possível concluir o carregamento";
    const message = document.createElement("p");
    message.textContent = "Verifique sua conexão e tente novamente. Os registros salvos neste dispositivo foram preservados.";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Tentar novamente";
    retry.addEventListener("click", () => location.reload());
    panel.append(title, message, retry);
    document.body.append(panel);
    retry.focus();
  }

  function ready() {
    panel?.remove();
    panel = null;
    clearTimeout(watchdog);
  }

  // Também cobre falhas de carregamento dos scripts e esperas por locks de sessão.
  const watchdog = setTimeout(() => {
    if (document.documentElement.classList.contains("auth-checking")) fail(new Error("Tempo de abertura excedido."));
  }, 30000);

  // Menu principal, em um lugar so.
  //
  // A lista de destinos vivia duplicada no app.js e no assets/portal.js, e as
  // duas familias de paginas carregam um ou outro. Bastou a pagina de Fotos
  // entrar em um lado para o cabecalho ficar diferente conforme a pagina
  // aberta -- quem estava no Historico nao via Fotos no menu. Aqui a definicao
  // e unica; os dois arquivos so desenham o que esta escrito neste lugar.
  const OPERATIONAL_ROLES = ["manager", "coordinator", "specialist"];
  const MANAGEMENT_ONLY_ROLES = ["director", "executive_manager", "consultant"];

  function navigationLinks(role) {
    if (role === "manager") {
      return [
        ["index.html", "Planejar", "planning"],
        ["executar.html", "Executar", "execution"],
        ["dashboard.html", "Dashboard", "dashboard"],
        ["fotos.html", "Fotos", "photos"],
        ["gestao.html", "Gestão", "management"],
        ["conta.html", "Minha conta", "account"]
      ];
    }
    if (OPERATIONAL_ROLES.includes(role)) {
      return [
        ["index.html", "Planejar", "planning"],
        ["executar.html", "Executar", "execution"],
        ["dashboard.html", "Dashboard", "dashboard"],
        ["fotos.html", "Fotos", "photos"],
        ["gestao.html?view=history", "Histórico", "management"],
        ["conta.html", "Minha conta", "account"]
      ];
    }
    // O Editor administra o sistema; nao planeja nem executa intervalos.
    if (role === "editor") {
      return [
        ["intervalos.html", "Intervalos", "intervals"],
        ["admin.html", "Administração", "admin"],
        ["auditoria.html", "Auditoria", "audit"],
        ["conta.html", "Minha conta", "account"]
      ];
    }
    if (MANAGEMENT_ONLY_ROLES.includes(role)) {
      return [["gestao.html", "Gestão", "management"], ["conta.html", "Minha conta", "account"]];
    }
    return [["conta.html", "Minha conta", "account"]];
  }

  function renderNavigation(nav, role, page) {
    if (!nav) return;
    const links = navigationLinks(role);
    // A largura de cada destino no cabecalho empilhado sai daqui: sao de dois a
    // seis, conforme o perfil.
    nav.style.setProperty("--nav-count", links.length);
    nav.innerHTML = links.map(([href, label, target], index) => {
      const active = page === target;
      const safeLabel = label.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      return `<a href="${href}"${active ? ' class="active" aria-current="page"' : ""}><span>${index + 1}</span>${safeLabel}</a>`;
    }).join("");
  }

  window.AppStartup = { wait, fetch: fetchWithTimeout, fail, ready, createLoginAuth, navigationLinks, renderNavigation };
})();
