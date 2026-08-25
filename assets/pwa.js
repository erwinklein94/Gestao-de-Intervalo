(function () {
  "use strict";

  const EDITOR_TRANSITION_KEY = "gestaoIntervaloRumo.editorPageTransitions";
  const EDITOR_TRANSITION_ORIGIN_KEY = "gestaoIntervaloRumo.editorTransitionOrigin";
  let editorTransitionActive = false;
  let transitionNavigationStarted = false;
  let transitionCleanupTimer = null;

  function transitionSetting() {
    const raw = localStorage.getItem(EDITOR_TRANSITION_KEY);
    if (raw === "enabled") return { enabled: true, userId: "" };
    try {
      const setting = JSON.parse(raw || "null");
      return setting && typeof setting === "object" ? setting : { enabled: false, userId: "" };
    } catch (_) {
      return { enabled: false, userId: "" };
    }
  }

  function editorTransitionPreference(userId = window.__GESTAO_USER_ID__ || "") {
    const setting = transitionSetting();
    return setting.enabled === true && (!setting.userId || !userId || setting.userId === userId);
  }

  function supportsMotion() {
    return !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  }

  function supportsCrossDocumentTransitions() {
    return "onpagereveal" in window && Boolean(window.CSS?.supports?.("view-transition-name: root"));
  }

  function readTransitionOrigin() {
    try {
      const origin = JSON.parse(sessionStorage.getItem(EDITOR_TRANSITION_ORIGIN_KEY) || "null");
      if (!origin || Date.now() - origin.createdAt > 8000) return null;
      const currentPath = `${location.pathname}${location.search}`;
      return origin.destination === currentPath ? origin : null;
    } catch (_) {
      return null;
    }
  }

  function saveTransitionOrigin(link, destination) {
    const bounds = link.getBoundingClientRect();
    sessionStorage.setItem(EDITOR_TRANSITION_ORIGIN_KEY, JSON.stringify({
      x: Math.round(bounds.left + bounds.width / 2),
      y: Math.round(bounds.top + bounds.height / 2),
      destination: `${destination.pathname}${destination.search}`,
      createdAt: Date.now()
    }));
  }

  function applyEditorPageTransitions(role, userId = window.__GESTAO_USER_ID__ || "") {
    const setting = transitionSetting();
    if (role === "editor" && setting.enabled && !setting.userId && userId) {
      localStorage.setItem(EDITOR_TRANSITION_KEY, JSON.stringify({ enabled: true, userId }));
    }
    editorTransitionActive = role === "editor" && editorTransitionPreference(userId) && supportsMotion();
    document.documentElement.classList.toggle("editor-page-transitions", editorTransitionActive);
    document.body.classList.remove("page-transition-circle-enter");
    if (!editorTransitionActive || supportsCrossDocumentTransitions()) return;

    const origin = readTransitionOrigin();
    if (!origin) return;
    sessionStorage.removeItem(EDITOR_TRANSITION_ORIGIN_KEY);
    document.body.style.setProperty("--transition-origin-x", `${origin.x}px`);
    document.body.style.setProperty("--transition-origin-y", `${origin.y}px`);
    document.body.classList.add("page-transition-circle-enter");
    clearTimeout(transitionCleanupTimer);
    transitionCleanupTimer = setTimeout(() => {
      document.body.classList.remove("page-transition-circle-enter");
    }, 760);
  }

  function setEditorPageTransitions(enabled, userId = window.__GESTAO_USER_ID__ || "") {
    if (enabled) localStorage.setItem(EDITOR_TRANSITION_KEY, JSON.stringify({ enabled: true, userId }));
    else localStorage.removeItem(EDITOR_TRANSITION_KEY);
    applyEditorPageTransitions("editor", userId);
  }

  // Na API nativa, a captura da página anterior permanece atrás da nova. A
  // página de destino então cresce em círculo a partir do link que foi usado.
  window.addEventListener("pagereveal", (event) => {
    const setting = transitionSetting();
    const sameEditor = setting.enabled && setting.userId && setting.userId === window.__GESTAO_USER_ID__;
    const origin = sameEditor && supportsMotion() ? readTransitionOrigin() : null;
    if (!event.viewTransition || !origin) return;
    sessionStorage.removeItem(EDITOR_TRANSITION_ORIGIN_KEY);
    const endRadius = Math.hypot(
      Math.max(origin.x, innerWidth - origin.x),
      Math.max(origin.y, innerHeight - origin.y)
    );
    event.viewTransition.ready.then(() => {
      document.documentElement.animate({
        clipPath: [
          `circle(0px at ${origin.x}px ${origin.y}px)`,
          `circle(${endRadius}px at ${origin.x}px ${origin.y}px)`
        ]
      }, {
        duration: 680,
        easing: "cubic-bezier(.2, .78, .22, 1)",
        fill: "both",
        pseudoElement: "::view-transition-new(root)"
      });
    }).catch(() => {});
  });

  document.addEventListener("click", (event) => {
    if (!editorTransitionActive || transitionNavigationStarted || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest?.("a[href]");
    if (!link || link.target === "_blank" || link.hasAttribute("download")) return;

    const destination = new URL(link.href, location.href);
    if (!["http:", "https:"].includes(destination.protocol) || destination.origin !== location.origin) return;
    const sameDocument = destination.pathname === location.pathname && destination.search === location.search;
    if (sameDocument) return;

    saveTransitionOrigin(link, destination);
    if (supportsCrossDocumentTransitions()) return;

    event.preventDefault();
    transitionNavigationStarted = true;
    link.classList.add("is-transition-origin");
    setTimeout(() => location.assign(destination.href), 130);
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
