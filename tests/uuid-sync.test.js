"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const uidSource = app.slice(app.indexOf("  function uid()"), app.indexOf("  function todayISO()"));
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function generatedId(crypto) {
  return vm.runInNewContext(`${uidSource}; uid()`, { crypto, Uint8Array, Array, Math });
}

assert.match(generatedId({
  getRandomValues(bytes) {
    bytes.forEach((_, index) => { bytes[index] = index; });
    return bytes;
  }
}), uuidPattern, "fallback com getRandomValues deve produzir UUID v4");

assert.match(generatedId({}), uuidPattern, "fallback sem Web Crypto também deve produzir UUID v4");

console.log("uuid-sync: UUID v4 válido fora de contexto HTTPS aprovado");
