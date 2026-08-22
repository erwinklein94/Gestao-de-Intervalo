"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

const management = fs.readFileSync("gestao.html", "utf8");
const portal = fs.readFileSync("assets/portal.js", "utf8");
const values = (attribute) => [...management.matchAll(new RegExp(`${attribute}="([^"]+)"`, "g"))].map((match) => match[1]);

assert.deepEqual(values("data-view-button"), ["running", "history", "overview"]);
assert.deepEqual(values("data-view"), ["running", "history", "overview"]);
assert.match(portal, /const allowed = \["running", "history", "overview"\]/);
assert.match(portal, /if \(!allowed\.includes\(view\)\) view = "running"/);
assert.match(portal, /get\("view"\) \|\| "running"/);

console.log("management-views: somente execução, histórico e dashboard geral");
