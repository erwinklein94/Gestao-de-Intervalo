const assert = require("node:assert/strict");
const fs = require("node:fs");

const read = (file) => fs.readFileSync(file, "utf8");
const app = read("app.js");
const login = read("login.html");
const recovery = read("recuperar-senha.html");
const planning = read("index.html");
const execution = read("executar.html");
const shared = read("acompanhar.html");
const styles = read("styles.css");
const edge = read("supabase/functions/interval-share/index.ts");
const migration = read("supabase/migrations/20260822173000_add_execution_closure_and_plan_parties.sql");
const managerMigration = read("supabase/migrations/20260822180000_allow_managers_to_operate_intervals.sql");

assert.match(login, /id="forgot-password"/);
assert.match(recovery, /data-page="password-recovery"/);
assert.match(app, /functions\/v1\/request-password-reset/);
assert.doesNotMatch(app, /resetPasswordForEmail\(email/);
assert.match(app, /auth\.updateUser\(\{ password: form\.password\.value \}\)/);

assert.match(planning, /name="contractorName"/);
assert.match(planning, /name="foremanName"/);
assert.match(app, /contractor_name: plan\.contractorName/);
assert.match(app, /foreman_name: plan\.foremanName/);
assert.match(migration, /add column if not exists contractor_name/);
assert.match(migration, /add column if not exists foreman_name/);
assert.match(edge, /contractor_name,foreman_name/);

assert.match(execution, /id="finish-execution-button"/);
assert.match(app, /isOperatorRole\(currentProfile\?\.role\)/);
assert.match(app, /rpc\("finalize_interval_plan"/);
assert.match(migration, /private\.actual_role\(\) not in \('coordinator', 'specialist'\)/);
assert.match(migration, /grant execute on function public\.finalize_interval_plan\(uuid\) to authenticated/);
assert.match(migration, /when plan\.completed_at is not null then 'completed'/);
assert.match(managerMigration, /private\.actual_role\(\) not in \('manager', 'coordinator', 'specialist'\)/);
assert.match(managerMigration, /private\.actual_role\(\) in \('manager', 'coordinator', 'specialist'\)/);
assert.match(managerMigration, /when member\.role = 'manager' then member\.id/);
assert.match(app, /function isOperatorRole\(role\) \{ return \["manager", "coordinator", "specialist"\]/);
assert.match(app, /function operationalPlansQuery\(\)/);
assert.match(app, /eq\("coordinator_member_id", currentProfile\.organization_member_id\)/);
assert.match(edge, /\["editor", "manager", "coordinator", "specialist"\]\.includes\(ownerProfile\.role\)/);

assert.match(shared, /id="shared-live-state" hidden/);
assert.match(app, /status\.hidden = plan\.status !== "executing"/);
assert.match(styles, /\.shared-status\[hidden\] \{ display: none; \}/);

console.log("recuperação, novos campos, banner e encerramento: estrutura aprovada");
