(function () {
  "use strict";
  const loginPage = new URL("login.html", location.href);
  try {
    const raw = localStorage.getItem("sb-rzsybguxlueorjpsstmu-auth-token");
    const session = raw ? JSON.parse(raw) : null;
    const token = session?.access_token || session?.currentSession?.access_token;
    if (!token) location.replace(loginPage.href);
    else {
      const encoded = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const claims = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")));
      if (!claims.sub || (claims.exp && claims.exp * 1000 <= Date.now())) throw new Error("Sessão expirada");
      window.__GESTAO_USER_ID__ = claims.sub;
      document.documentElement.classList.add("auth-checking");
    }
  } catch (error) {
    location.replace(loginPage.href);
  }
})();
