const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const login = fs.readFileSync(path.join(root, "login.html"), "utf8");
const edge = fs.readFileSync(path.join(root, "supabase/functions/request-password-reset/index.ts"), "utf8");

test("password reset is an administrative request instead of an auth recovery email", () => {
  assert.match(app, /functions\/v1\/request-password-reset/);
  assert.doesNotMatch(app, /resetPasswordForEmail\(email/);
  assert.match(login, /Solicitar alteração de senha/);
  assert.match(app, /Solicitação enviada ao Editor/);
});

test("the public function keeps account existence private and notifies the configured editor", () => {
  assert.match(edge, /PASSWORD_RESET_NOTIFY_EMAIL/);
  assert.match(edge, /erwinklein1994@gmail\.com/);
  assert.match(edge, /if \(profile\?\.enabled && !await notifyEditor/);
  assert.match(edge, /return response\(origin, \{ status: "received" \}, 202\)/);
  assert.match(edge, /Confirme a identidade do solicitante/);
});
