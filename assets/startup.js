(function () {
  "use strict";

  const TIMEOUT = 20000;
  let panel;

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
  window.AppStartup = { wait, fetch: fetchWithTimeout, fail, ready };
})();
