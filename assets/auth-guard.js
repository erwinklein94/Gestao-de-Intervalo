(function () {
  "use strict";
  const loginPage = new URL("login.html", location.href);
  try {
    const raw = localStorage.getItem("sb-rzsybguxlueorjpsstmu-auth-token");
    const session = raw ? JSON.parse(raw) : null;
    if (!session?.access_token && !session?.currentSession?.access_token) location.replace(loginPage.href);
    else document.documentElement.classList.add("auth-checking");
  } catch (error) {
    location.replace(loginPage.href);
  }
})();
