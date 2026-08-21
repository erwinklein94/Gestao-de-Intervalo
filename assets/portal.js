(function () {
  "use strict";

  const SUPABASE_URL = "https://rzsybguxlueorjpsstmu.supabase.co";
  const SUPABASE_KEY = "sb_publishable_sHHGnU3rob-unvk-_CCdcA_Ut4omY23";
  const THEME_KEY = "gestaoIntervaloRumo.theme";
  const DEMO_KEY = "gestaoIntervaloRumo.dataset";
  const PERSONA_KEY = "gestaoIntervaloRumo.demoPersona";
  const ROLE_LABELS = {
    director: "Diretor", executive_manager: "Gerente Executivo",
    consultant: "Consultor", manager: "Gerente",
    coordinator: "Coordenador", editor: "Editor"
  };
  const READ_ONLY_GLOBAL_ROLES = ["director", "executive_manager", "consultant"];
  const TYPE_LABELS = { infrastructure: "Infraestrutura", superstructure: "Superestrutura" };
  const STATUS_LABELS = { planning: "Planejamento", executing: "Em execução", completed: "Concluído", cancelled: "Cancelado" };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  function timeToMinutes(value) {
    const match = /^(\d{2}):(\d{2})/.exec(value || "");
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  }

  function alignTime(value, anchor) {
    let minutes = timeToMinutes(value);
    if (minutes == null) return null;
    while (anchor != null && minutes < anchor - 720) minutes += 1440;
    return minutes;
  }

  function formatMinutes(value) {
    if (!Number.isFinite(value)) return "—";
    const absolute = Math.abs(Math.round(value));
    return absolute >= 60 ? `${Math.floor(absolute / 60)}h ${String(absolute % 60).padStart(2, "0")}min` : `${absolute} min`;
  }

  function isResolved(step) {
    return ["completed", "skipped"].includes(step.status) || Boolean(step.actual_end) || String(step.actual_notes || "").startsWith("[[ETAPA_NAO_EXECUTADA]]");
  }

  function intervalMetrics(plan, now = new Date()) {
    const steps = [...(plan.interval_steps || [])].sort((a, b) => a.position - b.position);
    const windowStart = timeToMinutes(plan.window_start);
    const windowEnd = alignTime(plan.window_end, windowStart);
    const resolved = steps.filter(isResolved).length;
    const progress = steps.length ? Math.round((resolved / steps.length) * 100) : 0;
    let variance = null;

    if (plan.status === "completed") {
      const actualEnds = steps.map((step) => alignTime(step.actual_end, windowStart)).filter(Number.isFinite);
      if (actualEnds.length && windowEnd != null) variance = Math.max(...actualEnds) - windowEnd;
    } else if (plan.status === "executing") {
      const milestones = [];
      steps.forEach((step) => {
        const plannedStart = alignTime(step.planned_start, windowStart);
        const plannedEnd = alignTime(step.planned_end, plannedStart ?? windowStart);
        const actualStart = alignTime(step.actual_start, windowStart);
        const actualEnd = alignTime(step.actual_end, actualStart ?? windowStart);
        if (actualEnd != null && plannedEnd != null) milestones.push({ position: step.position * 2 + 1, variance: actualEnd - plannedEnd });
        else if (actualStart != null && plannedStart != null) milestones.push({ position: step.position * 2, variance: actualStart - plannedStart });
      });
      if (milestones.length) variance = milestones.sort((a, b) => b.position - a.position)[0].variance;
      const sameDay = plan.interval_date === new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      const running = steps.filter((step) => step.actual_start && !step.actual_end && !isResolved(step));
      if (sameDay && running.length) {
        let current = now.getHours() * 60 + now.getMinutes();
        if (windowStart != null && current < windowStart - 720) current += 1440;
        const worst = running.map((step) => {
          const plannedEnd = alignTime(step.planned_end, windowStart);
          return plannedEnd == null ? null : current - plannedEnd;
        }).filter(Number.isFinite);
        if (worst.length) variance = Math.max(variance ?? -Infinity, ...worst);
      }
    }

    const deadline = variance == null || Math.abs(variance) < 1 ? "ontime" : variance > 0 ? "late" : "ahead";
    return { steps, resolved, progress, variance: variance == null ? null : Math.round(variance), deadline };
  }

  function filterPlans(plans, filters) {
    const query = String(filters.query || "").trim().toLocaleLowerCase("pt-BR");
    return plans.filter((plan) => {
      const metrics = intervalMetrics(plan);
      if (filters.manager && plan.manager_member_id !== filters.manager) return false;
      if (filters.coordinator && plan.coordinator_member_id !== filters.coordinator) return false;
      if (filters.sub && String(plan.sub_id || "") !== filters.sub) return false;
      if (filters.classification && plan.coordinator_type !== filters.classification) return false;
      if (filters.status && plan.status !== filters.status) return false;
      if (filters.deadline && metrics.deadline !== filters.deadline) return false;
      if (filters.service && plan.service_type !== filters.service) return false;
      if (filters.dateFrom && (!plan.interval_date || plan.interval_date < filters.dateFrom)) return false;
      if (filters.dateTo && (!plan.interval_date || plan.interval_date > filters.dateTo)) return false;
      if (query && ![plan.title, plan.location, plan.service_type, plan.coordinatorName, plan.managerName, plan.subCode].join(" ").toLocaleLowerCase("pt-BR").includes(query)) return false;
      return true;
    });
  }

  function roleScopeDescription(role) {
    if (role === "manager") return "Somente Coordenadores vinculados à sua gestão e seus respectivos intervalos.";
    if (role === "coordinator") return "Seus próprios intervalos, do planejamento ao histórico.";
    if (READ_ONLY_GLOBAL_ROLES.includes(role)) return "Toda a operação cadastrada, em modo somente leitura.";
    return "Visão completa da operação e acesso às ferramentas administrativas.";
  }

  function roleCapabilities(role) {
    return {
      canUseManagement: ["director", "executive_manager", "consultant", "manager", "coordinator", "editor"].includes(role),
      canOperateIntervals: ["coordinator", "editor"].includes(role),
      canAdminister: role === "editor",
      organizationWide: [...READ_ONLY_GLOBAL_ROLES, "editor"].includes(role),
      readOnly: [...READ_ONLY_GLOBAL_ROLES, "manager"].includes(role)
    };
  }

  if (window.__GESTAO_TEST_MODE__) {
    window.__GESTAO_PORTAL_TEST_API__ = { timeToMinutes, alignTime, intervalMetrics, filterPlans, roleScopeDescription, roleCapabilities };
    return;
  }

  let baseClient;
  let dataClient;
  let currentUser;
  let actualProfile;
  let effectiveProfile;
  let demoMode = false;
  let personas = [];
  let plans = [];
  let members = [];
  let subs = [];
  let toastTimer;

  function initializeTheme() {
    let theme = "light";
    try { theme = localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light"; } catch {}
    const apply = () => {
      const dark = theme === "dark";
      document.documentElement.dataset.theme = dark ? "dark" : "light";
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
      $$('[data-theme-toggle]').forEach((button) => {
        button.setAttribute("aria-pressed", String(dark));
        $("span", button).textContent = dark ? "☀" : "☾";
        $("b", button).textContent = dark ? "Tema claro" : "Tema escuro";
      });
    };
    apply();
    $$('[data-theme-toggle]').forEach((button) => button.addEventListener("click", () => {
      theme = theme === "dark" ? "light" : "dark";
      try { localStorage.setItem(THEME_KEY, theme); } catch {}
      apply();
    }));
  }

  function showToast(message) {
    const toast = $("#toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
  }

  function setState(message, kind = "ok") {
    const state = $("#portal-state");
    if (!state) return;
    state.textContent = message;
    state.dataset.syncState = kind;
  }

  function createClient(headers = {}) {
    return window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      global: { headers }
    });
  }

  function renderNavigation(role) {
    const nav = $("[data-role-nav]");
    if (!nav) return;
    const page = document.body.dataset.page;
    let links;
    if (demoMode) {
      links = [["gestao.html", "Gestão", "management"]];
    } else if (role === "coordinator") {
      links = [["index.html", "Planejar", "planning"], ["executar.html", "Executar", "execution"], ["dashboard.html", "Dashboard", "dashboard"], ["gestao.html?view=history", "Histórico", "management"], ["conta.html", "Minha conta", "account"]];
    } else if (role === "editor") {
      links = [["gestao.html", "Gestão", "management"], ["index.html", "Planejar", "planning"], ["executar.html", "Executar", "execution"], ["dashboard.html", "Dashboard", "dashboard"], ["admin.html", "Administração", "admin"], ["conta.html", "Minha conta", "account"]];
    } else if (roleCapabilities(role).canUseManagement) {
      links = [["gestao.html", "Gestão", "management"], ["conta.html", "Minha conta", "account"]];
    } else {
      links = [["conta.html", "Minha conta", "account"]];
    }
    nav.style.setProperty("--nav-count", links.length);
    nav.innerHTML = links.map(([href, label, target], index) => `<a href="${href}" class="${page === target ? "active" : ""}" ${page === target ? 'aria-current="page"' : ""}><span>${index + 1}</span>${escapeHtml(label)}</a>`).join("");
  }

  async function configureContext() {
    demoMode = sessionStorage.getItem(DEMO_KEY) === "demo" && actualProfile.role === "editor";
    if (!demoMode) {
      sessionStorage.removeItem(DEMO_KEY);
      sessionStorage.removeItem(PERSONA_KEY);
      dataClient = baseClient;
      effectiveProfile = actualProfile;
      return;
    }
    const demoBootstrapClient = createClient({ "x-dataset-context": "demo" });
    const { data, error } = await demoBootstrapClient.rpc("list_demo_personas");
    if (error) throw error;
    personas = data || [];
    const selected = sessionStorage.getItem(PERSONA_KEY);
    effectiveProfile = personas.find((persona) => persona.id === selected) || personas.find((persona) => persona.role === "editor") || personas[0];
    if (!effectiveProfile) throw new Error("Nenhuma persona de demonstração disponível.");
    sessionStorage.setItem(PERSONA_KEY, effectiveProfile.id);
    dataClient = createClient({ "x-dataset-context": "demo", "x-demo-persona-id": effectiveProfile.id });
  }

  function decoratePlans(rows) {
    const memberMap = new Map(members.map((member) => [member.id, member]));
    const subMap = new Map(subs.map((sub) => [String(sub.id), sub]));
    return (rows || []).map((plan) => {
      const coordinator = memberMap.get(plan.coordinator_member_id);
      const manager = memberMap.get(plan.manager_member_id);
      const sub = subMap.get(String(plan.sub_id || ""));
      return {
        ...plan,
        coordinatorName: coordinator?.full_name || plan.coordinator || "Não informado",
        managerName: manager?.full_name || "Não informado",
        subCode: sub?.code || "Sem SUB",
        subName: sub?.name || "",
        interval_steps: (plan.interval_steps || []).sort((a, b) => a.position - b.position),
        interval_comments: (plan.interval_comments || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      };
    });
  }

  async function loadScopedData() {
    setState("Atualizando dados…", "syncing");
    const memberColumns = "id,dataset_id,code,full_name,role,enabled,manager_id,sub_id,coordinator_type,profile_needs_review";
    const [memberResult, subResult, planResult] = await Promise.all([
      dataClient.from("organization_members").select(memberColumns).eq("enabled", true).order("full_name"),
      dataClient.from("subs").select("id,code,name,operation,sort_order,active").order("sort_order"),
      dataClient.from("interval_plans").select("*,interval_steps(*),interval_comments(*)").order("interval_date", { ascending: false })
    ]);
    const error = memberResult.error || subResult.error || planResult.error;
    if (error) throw error;
    members = memberResult.data || [];
    subs = subResult.data || [];
    plans = decoratePlans(planResult.data);
    setState("Atualizado agora", "ok");
  }

  function optionMarkup(rows, valueKey, label) {
    return rows.map((row) => `<option value="${escapeHtml(row[valueKey])}">${escapeHtml(label(row))}</option>`).join("");
  }

  function populateFilters() {
    const managers = members.filter((member) => member.role === "manager" && plans.some((plan) => plan.manager_member_id === member.id));
    const coordinators = members.filter((member) => member.role === "coordinator" && plans.some((plan) => plan.coordinator_member_id === member.id));
    const usedSubs = subs.filter((sub) => plans.some((plan) => String(plan.sub_id) === String(sub.id)));
    const services = [...new Set(plans.map((plan) => plan.service_type).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
    $('[data-filter="manager"]').innerHTML = '<option value="">Todos</option>' + optionMarkup(managers, "id", (row) => row.full_name);
    $('[data-filter="coordinator"]').innerHTML = '<option value="">Todos</option>' + optionMarkup(coordinators, "id", (row) => row.full_name);
    $('[data-filter="sub"]').innerHTML = '<option value="">Todas</option>' + optionMarkup(usedSubs, "id", (row) => `${row.code} · ${row.name}`);
    $('[data-filter="service"]').innerHTML = '<option value="">Todos</option>' + services.map((service) => `<option value="${escapeHtml(service)}">${escapeHtml(service)}</option>`).join("");
  }

  function currentFilters() {
    return Object.fromEntries($$("[data-filter]").map((field) => [field.dataset.filter, field.value]));
  }

  function deadlineMarkup(metrics) {
    if (metrics.variance == null) return '<span class="deadline neutral">Sem desvio calculado</span>';
    if (metrics.variance > 0) return `<span class="deadline late">Atrasado · +${formatMinutes(metrics.variance)}</span>`;
    if (metrics.variance < 0) return `<span class="deadline ahead">Adiantado · −${formatMinutes(metrics.variance)}</span>`;
    return '<span class="deadline ontime">No prazo</span>';
  }

  function cardMarkup(plan) {
    const metrics = intervalMetrics(plan);
    const date = plan.interval_date ? new Date(`${plan.interval_date}T12:00:00`).toLocaleDateString("pt-BR") : "Sem data";
    return `<button class="interval-card ${metrics.deadline === "late" ? "is-late" : metrics.deadline === "ahead" ? "is-ahead" : "is-on-time"}" type="button" data-plan-detail="${escapeHtml(plan.id)}">
      <span class="interval-card-top"><b>${escapeHtml(STATUS_LABELS[plan.status] || plan.status)}</b><i>${escapeHtml(TYPE_LABELS[plan.coordinator_type] || "Sem classificação")}</i></span>
      <strong class="interval-card-title">${escapeHtml(plan.title || "Intervalo sem título")}</strong>
      <span class="interval-card-location">${escapeHtml(plan.location || "Local não informado")} · ${date}</span>
      <span class="interval-card-people"><small>Gerente</small><b>${escapeHtml(plan.managerName)}</b><small>Coordenador</small><b>${escapeHtml(plan.coordinatorName)}</b></span>
      <span class="interval-card-tags"><i>${escapeHtml(plan.subCode)}</i><i>${escapeHtml(plan.service_type || "Tipo não informado")}</i><i>${escapeHtml((plan.window_start || "—").slice(0, 5))}–${escapeHtml((plan.window_end || "—").slice(0, 5))}</i></span>
      <span class="interval-card-progress"><span><i style="width:${metrics.progress}%"></i></span><b>${metrics.progress}%</b></span>
      ${deadlineMarkup(metrics)}
    </button>`;
  }

  function emptyMarkup(message) {
    return `<div class="portal-empty"><strong>Nenhum intervalo encontrado</strong><span>${escapeHtml(message)}</span></div>`;
  }

  function setCount(name, count, noun = "resultado") {
    const node = $(`[data-result-count="${name}"]`);
    if (node) node.textContent = `${count} ${count === 1 ? noun : `${noun}s`}`;
  }

  function renderBars(root, entries, tone = "blue") {
    const max = Math.max(1, ...entries.map((entry) => entry.value));
    root.innerHTML = entries.length ? entries.map((entry) => `<div class="portal-bar"><span>${escapeHtml(entry.label)}</span><div><i class="${tone}" style="width:${Math.max(2, entry.value / max * 100)}%"></i></div><b>${escapeHtml(entry.display ?? entry.value)}</b></div>`).join("") : emptyMarkup("Não há dados suficientes para este gráfico.");
  }

  function renderOverview(filtered) {
    const completed = filtered.filter((plan) => plan.status === "completed");
    const completedMetrics = completed.map((plan) => intervalMetrics(plan));
    const late = completedMetrics.filter((metric) => metric.variance > 0).length;
    const ahead = completedMetrics.filter((metric) => metric.variance < 0).length;
    const onTime = completedMetrics.filter((metric) => metric.variance === 0).length;
    const within = ahead + onTime;
    const infra = filtered.filter((plan) => plan.coordinator_type === "infrastructure").length;
    const superstructure = filtered.filter((plan) => plan.coordinator_type === "superstructure").length;
    const average = completedMetrics.filter((metric) => metric.variance != null).reduce((sum, metric, _, all) => sum + metric.variance / all.length, 0);
    const kpis = [
      ["Total de intervalos", filtered.length, "No período e filtros atuais"],
      ["Em execução", filtered.filter((plan) => plan.status === "executing").length, "Frentes simultâneas"],
      ["Dentro do prazo", within, completed.length ? `${Math.round(within / completed.length * 100)}% dos concluídos` : "Sem concluídos"],
      ["Fora do prazo", late, completed.length ? `${Math.round(late / completed.length * 100)}% dos concluídos` : "Sem concluídos"],
      ["Atraso médio", completedMetrics.length ? formatMinutes(Math.max(0, average)) : "—", "Entre os concluídos"],
      ["Adiantamentos", ahead, "Intervalos concluídos antes do prazo"]
    ];
    $("#overview-kpis").innerHTML = kpis.map(([label, value, note], index) => `<article class="dashboard-kpi ${index === 3 && late ? "alert" : ""}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>`).join("");
    renderBars($("#classification-chart"), [{ label: "Infraestrutura", value: infra }, { label: "Superestrutura", value: superstructure }]);
    renderBars($("#punctuality-chart"), [{ label: "Dentro do prazo", value: within }, { label: "Fora do prazo", value: late }], "deadline-tone");
    const serviceCounts = Object.entries(filtered.reduce((result, plan) => { const key = plan.service_type || "Não informado"; result[key] = (result[key] || 0) + 1; return result; }, {})).sort((a, b) => b[1] - a[1]);
    renderBars($("#service-chart"), serviceCounts.map(([label, value]) => ({ label, value })));
    const recent = completed.slice().sort((a, b) => String(b.interval_date).localeCompare(String(a.interval_date))).slice(0, 8);
    $("#trend-chart").innerHTML = recent.length ? recent.map((plan) => { const metric = intervalMetrics(plan); return `<button type="button" data-plan-detail="${plan.id}"><span><strong>${escapeHtml(plan.title)}</strong><small>${escapeHtml(plan.interval_date || "Sem data")} · ${escapeHtml(plan.coordinatorName)}</small></span>${deadlineMarkup(metric)}</button>`; }).join("") : emptyMarkup("Conclua intervalos para formar a tendência.");
    setCount("overview", filtered.length, "intervalo");
  }

  function renderManagement() {
    const filtered = filterPlans(plans, currentFilters());
    const delays = filtered.filter((plan) => plan.status === "executing" && intervalMetrics(plan).variance > 0).sort((a, b) => intervalMetrics(b).variance - intervalMetrics(a).variance);
    const running = filtered.filter((plan) => plan.status === "executing");
    const history = filtered.filter((plan) => plan.status === "completed").sort((a, b) => String(b.interval_date).localeCompare(String(a.interval_date)));
    $("#delay-cards").innerHTML = delays.length ? delays.map(cardMarkup).join("") : emptyMarkup("Nenhuma execução atrasada corresponde aos filtros.");
    const infra = running.filter((plan) => plan.coordinator_type === "infrastructure");
    const superstructure = running.filter((plan) => plan.coordinator_type === "superstructure");
    $("#infra-cards").innerHTML = infra.length ? infra.map(cardMarkup).join("") : emptyMarkup("Nenhuma frente de Infraestrutura em execução.");
    $("#super-cards").innerHTML = superstructure.length ? superstructure.map(cardMarkup).join("") : emptyMarkup("Nenhuma frente de Superestrutura em execução.");
    $("#history-cards").innerHTML = history.length ? history.map(cardMarkup).join("") : emptyMarkup("Nenhum intervalo concluído corresponde aos filtros.");
    setCount("delays", delays.length);
    setCount("running", running.length);
    setCount("history", history.length);
    $("#hero-live-count").textContent = plans.filter((plan) => plan.status === "executing").length;
    renderOverview(filtered);
  }

  function commentMarkup(comment, plan) {
    const canDelete = !demoMode
      && ["coordinator", "editor"].includes(actualProfile.role)
      && plan.status === "executing"
      && !comment.deleted_at
      && comment.author_user_id === currentUser.id;
    if (comment.deleted_at) return "";
    return `<article class="interval-comment" data-comment-id="${comment.id}"><header><span><strong>${escapeHtml(comment.author_name)}</strong><i>${escapeHtml(ROLE_LABELS[comment.author_role] || comment.author_role)}</i></span><time>${new Date(comment.created_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</time></header><p>${escapeHtml(comment.content)}</p>${canDelete ? '<button type="button" data-comment-delete>Excluir meu comentário</button>' : ""}</article>`;
  }

  function planTabMarkup(plan) {
    const steps = plan.interval_steps || [];
    return `<div class="detail-summary-grid"><div><span>Título</span><strong>${escapeHtml(plan.title || "—")}</strong></div><div><span>Tipo</span><strong>${escapeHtml(plan.service_type || "—")}</strong></div><div><span>Local</span><strong>${escapeHtml(plan.location || "—")}</strong></div><div><span>Data e janela</span><strong>${escapeHtml(plan.interval_date || "—")} · ${escapeHtml((plan.window_start || "—").slice(0, 5))}–${escapeHtml((plan.window_end || "—").slice(0, 5))}</strong></div><div><span>Gerente</span><strong>${escapeHtml(plan.managerName)}</strong></div><div><span>Coordenador</span><strong>${escapeHtml(plan.coordinatorName)}</strong></div><div><span>SUB</span><strong>${escapeHtml(plan.subCode)}</strong></div><div><span>Classificação</span><strong>${escapeHtml(TYPE_LABELS[plan.coordinator_type] || "—")}</strong></div></div><article class="detail-note"><span>Observações de planejamento</span><p>${escapeHtml(plan.planning_notes || "Nenhuma observação registrada.")}</p></article><div class="detail-step-list">${steps.map((step, index) => `<article><span>${String(index + 1).padStart(2, "0")}</span><div><strong>${escapeHtml(step.activity_name || `Etapa ${index + 1}`)}</strong><small>Planejado · ${escapeHtml((step.planned_start || "—").slice(0, 5))}–${escapeHtml((step.planned_end || "—").slice(0, 5))}</small></div></article>`).join("") || emptyMarkup("Este plano não possui etapas.")}</div>`;
  }

  function executionTabMarkup(plan) {
    const metrics = intervalMetrics(plan);
    const comments = plan.interval_comments || [];
    const canComment = !demoMode
      && plan.status === "executing"
      && (actualProfile.role === "editor" || (actualProfile.role === "coordinator" && plan.user_id === currentUser.id));
    return `<div class="detail-status ${metrics.deadline}">${deadlineMarkup(metrics)}<strong>${metrics.progress}% concluído</strong><span>${metrics.resolved} de ${metrics.steps.length} etapas encerradas</span></div><div class="detail-step-list execution-readonly">${metrics.steps.map((step, index) => `<article><span>${isResolved(step) ? "✓" : String(index + 1).padStart(2, "0")}</span><div><strong>${escapeHtml(step.activity_name || `Etapa ${index + 1}`)}</strong><small>Planejado ${escapeHtml((step.planned_start || "—").slice(0, 5))}–${escapeHtml((step.planned_end || "—").slice(0, 5))} · Realizado ${escapeHtml((step.actual_start || "—").slice(0, 5))}–${escapeHtml((step.actual_end || "—").slice(0, 5))}</small>${step.actual_notes ? `<p>${escapeHtml(String(step.actual_notes).replace(/^\[\[ETAPA_NAO_EXECUTADA\]\]\s*/, "Não executada · "))}</p>` : ""}</div></article>`).join("") || emptyMarkup("Nenhuma etapa registrada.")}</div><article class="detail-note"><span>Registro geral da execução</span><p>${escapeHtml(plan.execution_notes || "Nenhuma observação registrada.")}</p></article><section class="comments-panel"><header><div><p class="section-kicker">Registro permanente</p><h3>Comentários da execução</h3></div><span>${comments.filter((comment) => !comment.deleted_at).length}</span></header><div class="comments-list">${comments.map((comment) => commentMarkup(comment, plan)).join("") || emptyMarkup("Ainda não há comentários neste intervalo.")}</div>${canComment ? '<form id="detail-comment-form"><label class="field"><span>Novo comentário</span><textarea name="content" maxlength="2000" rows="3" required placeholder="Registre uma atualização relevante"></textarea></label><button class="button button-secondary" type="submit">Adicionar comentário</button><span class="auth-feedback"></span></form>' : `<p class="comments-locked">${demoMode ? "Comentários desativados no ambiente de exemplos." : "Após o encerramento, os comentários tornam-se permanentes."}</p>`}</section>`;
  }

  function dashboardTabMarkup(plan) {
    const metrics = intervalMetrics(plan);
    const plannedTotal = metrics.steps.reduce((sum, step) => { const start = timeToMinutes(step.planned_start); const end = alignTime(step.planned_end, start); return sum + (start != null && end != null ? end - start : 0); }, 0);
    const actualTotal = metrics.steps.reduce((sum, step) => { const start = timeToMinutes(step.actual_start); const end = alignTime(step.actual_end, start); return sum + (start != null && end != null ? end - start : 0); }, 0);
    return `<div class="overview-kpis detail-kpis"><article class="dashboard-kpi"><span>Progresso</span><strong>${metrics.progress}%</strong><small>${metrics.resolved} de ${metrics.steps.length} etapas</small></article><article class="dashboard-kpi"><span>Tempo programado</span><strong>${formatMinutes(plannedTotal)}</strong><small>Somatório das etapas</small></article><article class="dashboard-kpi"><span>Tempo realizado</span><strong>${actualTotal ? formatMinutes(actualTotal) : "—"}</strong><small>Etapas já concluídas</small></article><article class="dashboard-kpi ${metrics.deadline === "late" ? "alert" : ""}"><span>Desvio do intervalo</span><strong>${metrics.variance == null ? "—" : `${metrics.variance > 0 ? "+" : metrics.variance < 0 ? "−" : ""}${formatMinutes(metrics.variance)}`}</strong><small>${metrics.deadline === "late" ? "Fora do prazo" : metrics.deadline === "ahead" ? "Adiantado" : "Dentro do prazo"}</small></article></div><div class="detail-progress-list">${metrics.steps.map((step) => { const start = timeToMinutes(step.planned_start); const end = alignTime(step.planned_end, start); const actualStart = timeToMinutes(step.actual_start); const actualEnd = alignTime(step.actual_end, actualStart); const planned = start != null && end != null ? end - start : 0; const actual = actualStart != null && actualEnd != null ? actualEnd - actualStart : 0; return `<div><span>${escapeHtml(step.activity_name || "Etapa")}</span><div><i style="width:${Math.min(100, planned ? actual / planned * 100 : 0)}%"></i></div><b>${actual ? formatMinutes(actual) : "Aguardando"}</b></div>`; }).join("")}</div>`;
  }

  async function reloadComments(plan) {
    const { data, error } = await dataClient.from("interval_comments").select("*").eq("plan_id", plan.id).order("created_at");
    if (error) throw error;
    plan.interval_comments = data || [];
  }

  async function createShare(plan, feedback) {
    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const token = btoa(String.fromCharCode(...tokenBytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const tokenHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
    const { data, error } = await dataClient.from("interval_share_links").upsert({ plan_id: plan.id, owner_id: currentUser.id, token_hash: tokenHash, token_hint: token.slice(-6), expires_at: expiresAt, revoked_at: null, last_accessed_at: null }, { onConflict: "plan_id" }).select("id").single();
    if (error) throw error;
    sessionStorage.setItem(`intervalShareToken.${data.id}`, token);
    const link = new URL("acompanhar.html", location.href); link.searchParams.set("token", token);
    await navigator.clipboard.writeText(link.href);
    feedback.textContent = "Link válido por 3 dias copiado.";
  }

  function openPlanDetail(planId, initialTab = "plan") {
    const plan = plans.find((candidate) => candidate.id === planId);
    if (!plan) return;
    const dialog = $("#interval-detail");
    const root = $("#interval-detail-content");
    const shareAllowed = !demoMode
      && ["editor", "coordinator"].includes(actualProfile.role)
      && plan.user_id === currentUser.id;
    root.innerHTML = `<header class="detail-dialog-header"><div><p class="section-kicker">Página de acompanhamento do intervalo</p><h2>${escapeHtml(plan.title || "Intervalo")}</h2><span>${escapeHtml(plan.location || "Local não informado")} · ${escapeHtml(plan.coordinatorName)}</span></div><button type="button" data-detail-close aria-label="Fechar">×</button></header><nav class="detail-tabs" aria-label="Detalhes do intervalo" role="tablist"><button type="button" role="tab" data-detail-tab="plan">Plano do intervalo</button><button type="button" role="tab" data-detail-tab="execution">Execução do intervalo</button><button type="button" role="tab" data-detail-tab="dashboard">Dashboard do intervalo</button></nav><div class="detail-dialog-body"><section role="tabpanel" data-detail-view="plan">${planTabMarkup(plan)}</section><section role="tabpanel" data-detail-view="execution">${executionTabMarkup(plan)}</section><section role="tabpanel" data-detail-view="dashboard">${dashboardTabMarkup(plan)}</section>${shareAllowed ? '<div class="detail-share"><button class="button button-ghost" type="button" data-create-share>Gerar link de acompanhamento</button><span class="auth-feedback"></span></div>' : ""}</div>`;
    const activate = (tab) => {
      $$('[data-detail-tab]', root).forEach((button) => { const active = button.dataset.detailTab === tab; button.classList.toggle("active", active); button.setAttribute("aria-selected", String(active)); });
      $$('[data-detail-view]', root).forEach((view) => { view.hidden = view.dataset.detailView !== tab; });
    };
    activate(initialTab);
    $('[data-detail-close]', root).addEventListener("click", () => dialog.close());
    $$('[data-detail-tab]', root).forEach((button) => button.addEventListener("click", () => activate(button.dataset.detailTab)));
    $("#detail-comment-form", root)?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const feedback = $(".auth-feedback", form);
      const content = form.content.value.trim();
      if (!content) return;
      feedback.textContent = navigator.onLine ? "Salvando…" : "Sem conexão. Tente novamente quando o sinal retornar.";
      if (!navigator.onLine) return;
      const { error } = await dataClient.from("interval_comments").insert({ client_id: uid(), dataset_id: plan.dataset_id, plan_id: plan.id, author_user_id: currentUser.id, author_name: actualProfile.full_name || "Usuário", author_role: actualProfile.role, content });
      if (error) { feedback.textContent = error.message; return; }
      await reloadComments(plan);
      openPlanDetail(plan.id, "execution");
      showToast("Comentário adicionado ao histórico.");
    });
    root.addEventListener("click", async (event) => {
      const deleteButton = event.target.closest("[data-comment-delete]");
      if (deleteButton) {
        const comment = deleteButton.closest("[data-comment-id]");
        const { error } = await dataClient.from("interval_comments").update({ deleted_at: new Date().toISOString() }).eq("id", comment.dataset.commentId);
        if (error) { showToast(error.message); return; }
        await reloadComments(plan); openPlanDetail(plan.id, "execution"); showToast("Comentário removido.");
      }
    });
    $('[data-create-share]', root)?.addEventListener("click", async (event) => {
      const button = event.currentTarget; const feedback = $(".auth-feedback", button.parentElement); button.disabled = true; feedback.textContent = "Gerando link…";
      try { await createShare(plan, feedback); } catch (error) { feedback.textContent = "Não foi possível gerar o link."; console.error(error); } finally { button.disabled = false; }
    });
    dialog.showModal();
  }

  function activateManagementView(view) {
    const allowed = ["delays", "running", "history", "overview"];
    if (view === "dashboard") view = "overview";
    if (!allowed.includes(view)) view = "delays";
    $$('[data-view-button]').forEach((button) => {
      const active = button.dataset.viewButton === view;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    $$('[data-view]').forEach((section) => { section.hidden = section.dataset.view !== view; });
    const url = new URL(location.href); url.searchParams.set("view", view); history.replaceState(null, "", url);
  }

  async function initializeManagement() {
    await loadScopedData();
    populateFilters();
    $("#hero-role").textContent = ROLE_LABELS[effectiveProfile.role] || effectiveProfile.role;
    $("#scope-description").textContent = roleScopeDescription(effectiveProfile.role);
    renderManagement();
    activateManagementView(new URLSearchParams(location.search).get("view") || "delays");
    $$('[data-view-button]').forEach((button) => button.addEventListener("click", () => activateManagementView(button.dataset.viewButton)));
    $$("[data-filter]").forEach((field) => field.addEventListener(field.type === "search" ? "input" : "change", renderManagement));
    $("#clear-filters").addEventListener("click", () => { $$("[data-filter]").forEach((field) => { field.value = ""; }); renderManagement(); });
    $(".management-workspace").addEventListener("click", (event) => { const card = event.target.closest("[data-plan-detail]"); if (card) openPlanDetail(card.dataset.planDetail); });
    $("#interval-detail").addEventListener("click", (event) => { if (event.target === event.currentTarget) event.currentTarget.close(); });

    if (demoMode) {
      $("#demo-banner").hidden = false;
      const selector = $("#demo-persona");
      const managerById = new Map(personas.map((persona) => [persona.id, persona.full_name]));
      selector.innerHTML = personas.map((persona) => `<option value="${persona.id}" ${persona.id === effectiveProfile.id ? "selected" : ""}>${escapeHtml(ROLE_LABELS[persona.role])} · ${escapeHtml(persona.full_name)}${persona.manager_id ? ` · ${escapeHtml(managerById.get(persona.manager_id) || "")}` : ""}</option>`).join("");
      selector.addEventListener("change", () => { sessionStorage.setItem(PERSONA_KEY, selector.value); location.reload(); });
      $("#exit-demo").addEventListener("click", () => { sessionStorage.removeItem(DEMO_KEY); sessionStorage.removeItem(PERSONA_KEY); location.replace("gestao.html"); });
    }
    setInterval(async () => { if (document.hidden) return; try { await loadScopedData(); renderManagement(); } catch (error) { console.warn(error); setState("Erro ao atualizar", "error"); } }, 15000);
  }

  async function loadAdminData() {
    setState("Atualizando cadastros…", "syncing");
    const [profileResult, subResult, assignmentResult] = await Promise.all([
      baseClient.from("user_profiles").select("id,email,full_name,role,enabled,manager_id,sub_id,coordinator_type,profile_needs_review,organization_member_id,created_at").order("created_at", { ascending: false }),
      baseClient.from("subs").select("id,code,name,operation,sort_order,active").order("sort_order"),
      baseClient.from("coordinator_sub_assignments").select("coordinator_member_id,sub_id")
    ]);
    if (profileResult.error || subResult.error || assignmentResult.error) throw profileResult.error || subResult.error || assignmentResult.error;
    const assignmentsByMember = new Map();
    (assignmentResult.data || []).forEach((assignment) => {
      const assigned = assignmentsByMember.get(assignment.coordinator_member_id) || [];
      assigned.push(Number(assignment.sub_id));
      assignmentsByMember.set(assignment.coordinator_member_id, assigned);
    });
    members = (profileResult.data || []).map((profile) => ({
      ...profile,
      sub_ids: assignmentsByMember.get(profile.organization_member_id) || (profile.sub_id == null ? [] : [Number(profile.sub_id)])
    }));
    subs = subResult.data || [];
    setState("Cadastros atualizados", "ok");
  }

  function adminManagerOptions(selected = "") {
    return '<option value="">Selecione</option>' + members.filter((profile) => profile.role === "manager" && profile.enabled).map((profile) => `<option value="${profile.id}" ${profile.id === selected ? "selected" : ""}>${escapeHtml(profile.full_name || profile.email)}</option>`).join("");
  }

  function adminSubOptions(selectedIds = []) {
    const selected = new Set(selectedIds.map(Number));
    return subs.filter((sub) => sub.active || selected.has(Number(sub.id))).map((sub) => `<option value="${sub.id}" ${selected.has(Number(sub.id)) ? "selected" : ""}>${escapeHtml(sub.code)} · ${escapeHtml(sub.name)}</option>`).join("");
  }

  function selectedSubIds(select) {
    return Array.from(select.selectedOptions, (option) => Number(option.value)).filter(Number.isSafeInteger);
  }

  function updateCreateCoordinatorFields() {
    const form = $("#admin-user-form");
    const coordinator = form.role.value === "coordinator";
    $$('[data-coordinator-field]', form).forEach((field) => { field.hidden = !coordinator; $("select", field).required = coordinator; });
  }

  function renderAdminUsers() {
    const query = $("#user-search").value.trim().toLocaleLowerCase("pt-BR");
    const rows = members.filter((profile) => !query || `${profile.full_name} ${profile.email}`.toLocaleLowerCase("pt-BR").includes(query));
    $("#admin-users").innerHTML = rows.length ? rows.map((profile) => `<form class="admin-row user-admin-row" data-user-id="${profile.id}"><div class="admin-row-identity"><strong>${escapeHtml(profile.full_name || "Sem nome")}</strong><span>${escapeHtml(profile.email)}</span>${profile.profile_needs_review ? '<i>Cadastro precisa de revisão</i>' : ""}</div><label><span>Nome</span><input name="fullName" value="${escapeHtml(profile.full_name)}" required maxlength="120"></label><label><span>Perfil</span><select name="role">${Object.entries(ROLE_LABELS).map(([value, label]) => `<option value="${value}" ${profile.role === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><label data-edit-coordinator ${profile.role === "coordinator" ? "" : "hidden"}><span>Gerente</span><select name="managerId">${adminManagerOptions(profile.manager_id)}</select></label><label data-edit-coordinator class="admin-sub-field" ${profile.role === "coordinator" ? "" : "hidden"}><span>SUBs</span><select name="subIds" multiple size="4" title="Use Ctrl para selecionar mais de uma SUB">${adminSubOptions(profile.sub_ids)}</select></label><label data-edit-coordinator ${profile.role === "coordinator" ? "" : "hidden"}><span>Classificação</span><select name="coordinatorType"><option value="infrastructure" ${profile.coordinator_type === "infrastructure" ? "selected" : ""}>Infraestrutura</option><option value="superstructure" ${profile.coordinator_type === "superstructure" ? "selected" : ""}>Superestrutura</option></select></label><label class="admin-enabled"><span>Conta ativa</span><input name="enabled" type="checkbox" ${profile.enabled ? "checked" : ""} ${profile.id === currentUser.id ? "disabled" : ""}></label><div class="admin-row-actions"><button class="button button-ghost" type="submit">Salvar</button><span class="auth-feedback"></span></div></form>`).join("") : emptyMarkup("Nenhuma conta corresponde à busca.");
    $$(".user-admin-row").forEach((form) => {
      const updateCoordinatorFields = () => {
        const show = form.role.value === "coordinator";
        $$('[data-edit-coordinator]', form).forEach((field) => {
          field.hidden = !show;
          $("select", field).required = show;
        });
      };
      updateCoordinatorFields();
      form.role.addEventListener("change", updateCoordinatorFields);
      form.addEventListener("submit", async (event) => {
        event.preventDefault(); const feedback = $(".auth-feedback", form); const coordinator = form.role.value === "coordinator";
        const subIds = coordinator ? selectedSubIds(form.subIds) : [];
        if (coordinator && (!form.managerId.value || !subIds.length || !form.coordinatorType.value)) { feedback.textContent = "Gerente, uma ou mais SUBs e classificação são obrigatórios."; return; }
        feedback.textContent = "Salvando…";
        const { error } = await baseClient.rpc("update_site_user_profile", {
          p_target_user_id: form.dataset.userId,
          p_full_name: form.fullName.value.trim(),
          p_role: form.role.value,
          p_enabled: form.enabled.disabled ? true : form.enabled.checked,
          p_manager_id: coordinator ? form.managerId.value : null,
          p_sub_ids: subIds,
          p_coordinator_type: coordinator ? form.coordinatorType.value : null
        });
        if (error) { feedback.textContent = error.message; return; }
        feedback.textContent = "Salvo."; await loadAdminData(); renderAdminUsers();
      });
    });
  }

  function renderAdminSubs() {
    const query = $("#sub-search").value.trim().toLocaleLowerCase("pt-BR");
    const rows = subs.filter((sub) => !query || `${sub.code} ${sub.name} ${sub.operation || ""}`.toLocaleLowerCase("pt-BR").includes(query));
    $("#admin-subs").innerHTML = rows.length ? rows.map((sub) => `<form class="admin-row sub-admin-row" data-sub-id="${sub.id}"><label><span>Código</span><input name="code" value="${escapeHtml(sub.code)}" required maxlength="30"></label><label><span>Nome</span><input name="name" value="${escapeHtml(sub.name)}" required maxlength="120"></label><label><span>Operação</span><input name="operation" value="${escapeHtml(sub.operation || "")}" maxlength="120"></label><label><span>Ordem</span><input name="sortOrder" type="number" min="0" value="${sub.sort_order}"></label><label class="admin-enabled"><span>Ativa</span><input name="active" type="checkbox" ${sub.active ? "checked" : ""}></label><div class="admin-row-actions"><button class="button button-ghost" type="submit">Salvar</button><span class="auth-feedback"></span></div></form>`).join("") : emptyMarkup("Nenhuma SUB corresponde à busca.");
    $$(".sub-admin-row").forEach((form) => form.addEventListener("submit", async (event) => {
      event.preventDefault(); const feedback = $(".auth-feedback", form); feedback.textContent = "Salvando…";
      const { error } = await baseClient.from("subs").update({ code: form.code.value.trim().toUpperCase(), name: form.name.value.trim(), operation: form.operation.value.trim() || null, sort_order: Number(form.sortOrder.value), active: form.active.checked }).eq("id", form.dataset.subId);
      if (error) { feedback.textContent = error.message; return; }
      feedback.textContent = "Salva."; await loadAdminData(); renderAdminSubs();
    }));
  }

  async function initializeAdmin() {
    await loadAdminData();
    $("#admin-user-form").managerId.innerHTML = adminManagerOptions();
    $("#admin-user-form").subIds.innerHTML = adminSubOptions();
    updateCreateCoordinatorFields();
    $("#admin-user-form").role.addEventListener("change", updateCreateCoordinatorFields);
    renderAdminUsers(); renderAdminSubs();
    $("#user-search").addEventListener("input", renderAdminUsers);
    $("#sub-search").addEventListener("input", renderAdminSubs);
    $$('[data-admin-tab]').forEach((button) => button.addEventListener("click", () => {
      $$('[data-admin-tab]').forEach((candidate) => {
        const active = candidate === button;
        candidate.classList.toggle("active", active);
        candidate.setAttribute("aria-selected", String(active));
      });
      $$('[data-admin-view]').forEach((view) => { view.hidden = view.dataset.adminView !== button.dataset.adminTab; });
    }));
    $("#admin-user-form").addEventListener("submit", async (event) => {
      event.preventDefault(); const form = event.currentTarget; const feedback = $("#admin-user-feedback"); const coordinator = form.role.value === "coordinator";
      const subIds = coordinator ? selectedSubIds(form.subIds) : [];
      if (coordinator && (!form.managerId.value || !subIds.length || !form.coordinatorType.value)) { feedback.textContent = "Gerente, uma ou mais SUBs e classificação são obrigatórios."; return; }
      feedback.textContent = "Criando conta…";
      const { data, error } = await baseClient.functions.invoke("create-site-user", { body: { fullName: form.fullName.value.trim(), email: form.email.value.trim(), password: form.password.value, role: form.role.value, managerId: coordinator ? form.managerId.value : null, subIds, coordinatorType: coordinator ? form.coordinatorType.value : null } });
      if (error || data?.error) { feedback.textContent = data?.error || error.message; return; }
      feedback.textContent = "Conta criada e habilitada."; form.reset(); form.role.value = "coordinator"; await loadAdminData(); form.managerId.innerHTML = adminManagerOptions(); form.subIds.innerHTML = adminSubOptions(); updateCreateCoordinatorFields(); renderAdminUsers();
    });
    $("#sub-form").addEventListener("submit", async (event) => {
      event.preventDefault(); const form = event.currentTarget; const feedback = $("#sub-feedback"); feedback.textContent = "Adicionando…";
      const { error } = await baseClient.from("subs").insert({ code: form.code.value.trim().toUpperCase(), name: form.name.value.trim(), operation: form.operation.value.trim() || null, sort_order: Number(form.sortOrder.value), active: true, source_document: "Cadastro administrativo", source_page: 1 });
      if (error) { feedback.textContent = error.message; return; }
      feedback.textContent = "SUB adicionada."; form.reset(); await loadAdminData(); renderAdminSubs();
    });
  }

  async function initialize() {
    initializeTheme();
    if (!window.supabase?.createClient) throw new Error("Biblioteca de dados indisponível.");
    baseClient = createClient();
    const { data: { session } } = await baseClient.auth.getSession();
    currentUser = session?.user;
    if (!currentUser) { location.replace("login.html"); return; }
    const { data: profile, error } = await baseClient.from("user_profiles").select("id,email,full_name,role,enabled,manager_id,sub_id,coordinator_type,organization_member_id").eq("id", currentUser.id).single();
    if (error || !profile?.enabled) { await baseClient.auth.signOut(); location.replace("login.html?status=disabled"); return; }
    actualProfile = profile;
    await configureContext();
    if (!roleCapabilities(effectiveProfile.role).canUseManagement) { location.replace("conta.html"); return; }
    renderNavigation(effectiveProfile.role);
    if (document.body.dataset.page === "admin") {
      if (actualProfile.role !== "editor" || demoMode) { location.replace("gestao.html"); return; }
      await initializeAdmin();
    } else {
      await initializeManagement();
    }
    document.documentElement.classList.remove("auth-checking");
  }

  initialize().catch((error) => {
    console.error("Falha ao inicializar portal.", error);
    setState("Erro ao carregar", "error");
    document.documentElement.classList.remove("auth-checking");
    showToast("Não foi possível carregar esta página. Tente novamente.");
  });
})();
