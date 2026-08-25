(function () {
  "use strict";

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
