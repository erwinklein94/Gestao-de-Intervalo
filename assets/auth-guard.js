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
      if (!claims.sub) throw new Error("Sessão inválida");
      // Sem rede, mandar para o login não protege nada: nenhuma chamada ao
      // servidor passa de qualquer forma, e o RLS continua sendo quem autoriza.
      // Expulsar aqui só tiraria do coordenador o acesso ao que ele mesmo
      // registrou offline. A sessão é revalidada assim que houver conexão.
      // Um access token expirado ainda pode ter refresh token válido. O SDK
      // renova a sessão antes de consultar o perfil; o guard não a descarta.
      window.__GESTAO_USER_ID__ = claims.sub;
      document.documentElement.classList.add("auth-checking");
    }
  } catch (error) {
    location.replace(loginPage.href);
  }
})();
