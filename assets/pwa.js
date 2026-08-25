(function () {
  "use strict";

  const EDITOR_TRANSITION_KEY = "gestaoIntervaloRumo.editorPageTransitions";
  let editorTransitionActive = false;
  let transitionNavigationStarted = false;
  let transitionCleanupTimer = null;

  function editorTransitionPreference() {
    return localStorage.getItem(EDITOR_TRANSITION_KEY) === "enabled";
  }

  function supportsMotion() {
    return !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  }

  function applyEditorPageTransitions(role) {
    editorTransitionActive = role === "editor" && editorTransitionPreference() && supportsMotion();
    document.documentElement.classList.toggle("editor-page-transitions", editorTransitionActive);
    document.body.classList.remove("page-transition-enter", "page-transition-exit");
    if (!editorTransitionActive) return;

    // Aplicar depois que o perfil foi validado evita animar páginas de outros
    // perfis. Duas animações curtas formam a troca sem mascarar carregamentos.
    document.body.classList.add("page-transition-enter");
    clearTimeout(transitionCleanupTimer);
    transitionCleanupTimer = setTimeout(() => {
      document.body.classList.remove("page-transition-enter");
    }, 360);
  }

  function setEditorPageTransitions(enabled) {
    if (enabled) localStorage.setItem(EDITOR_TRANSITION_KEY, "enabled");
    else localStorage.removeItem(EDITOR_TRANSITION_KEY);
    applyEditorPageTransitions("editor");
  }

  document.addEventListener("click", (event) => {
    if (!editorTransitionActive || transitionNavigationStarted || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest?.("a[href]");
    if (!link || link.target === "_blank" || link.hasAttribute("download")) return;

    const destination = new URL(link.href, location.href);
    if (!["http:", "https:"].includes(destination.protocol) || destination.origin !== location.origin) return;
    const sameDocument = destination.pathname === location.pathname && destination.search === location.search;
    if (sameDocument) return;

    event.preventDefault();
    transitionNavigationStarted = true;
    document.body.classList.remove("page-transition-enter");
    document.body.classList.add("page-transition-exit");
    setTimeout(() => location.assign(destination.href), 190);
  });

  window.EditorPageTransitions = {
    apply: applyEditorPageTransitions,
    isEnabled: editorTransitionPreference,
    setEnabled: setEditorPageTransitions
  };

  function installBackToTopButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "back-to-top";
    button.textContent = "Subir";
    button.setAttribute("aria-label", "Subir para o início da página");
    button.hidden = true;

    const updateVisibility = () => {
      button.hidden = window.scrollY < 240;
    };

    button.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    window.addEventListener("scroll", updateVisibility, { passive: true });
    document.body.append(button);
    updateVisibility();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installBackToTopButton, { once: true });
  } else {
    installBackToTopButton();
  }

  if (!("serviceWorker" in navigator)) return;
  // file:// e http em rede não registram service worker; só https e localhost.
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  if (location.protocol !== "https:" && !local) return;

  // Se já havia um controlador, a troca significa versão nova assumindo o
  // comando: recarrega uma vez para a aba não continuar rodando o app antigo.
  // Na primeira instalação não há o que recarregar.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(new URL("sw.js", document.baseURI).href, { scope: "./" })
      .catch((error) => console.warn("Service worker não registrado.", error));
  });
})();
