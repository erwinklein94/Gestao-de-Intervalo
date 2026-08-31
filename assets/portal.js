(function () {
  "use strict";

  const SUPABASE_URL = "https://rzsybguxlueorjpsstmu.supabase.co";
  const SUPABASE_KEY = "sb_publishable_sHHGnU3rob-unvk-_CCdcA_Ut4omY23";
  const THEME_KEY = "gestaoIntervaloRumo.theme";
  const ROLE_LABELS = {
    director: "Diretor", executive_manager: "Gerente Executivo",
    consultant: "Consultor", manager: "Gerente",
    coordinator: "Coordenador", specialist: "Especialista", editor: "Editor"
  };
  // Gerente e Especialista nao flexionam; os demais tem forma feminina propria.
  const ROLE_LABELS_FEMININE = {
    director: "Diretora", executive_manager: "Gerente Executiva",
    consultant: "Consultora", coordinator: "Coordenadora", editor: "Editora"
  };
  const GENDER_LABELS = { masculine: "Masculino", feminine: "Feminino" };

  // Sem tratamento informado cai na forma masculina, que e como o sistema
  // exibia antes de o campo existir.
  function roleLabel(role, gender) {
    if (gender === "feminine" && ROLE_LABELS_FEMININE[role]) return ROLE_LABELS_FEMININE[role];
    return ROLE_LABELS[role] || role;
  }

  function profileRoleLabel(profile) {
    return roleLabel(profile?.role, profile?.role_gender);
  }
  const READ_ONLY_ROLES = ["director", "executive_manager", "consultant"];
  const TYPE_LABELS = { infrastructure: "Infraestrutura", superstructure: "Superestrutura", modernization: "Modernização" };
  const CLASSIFICATION_ORDER = ["superstructure", "infrastructure", "modernization"];
  const SINGLE_CLASSIFICATION_ROLES = ["coordinator", "specialist"];
  const ORG_ROLE_ORDER = ["editor", "director", "executive_manager", "consultant", "manager", "coordinator", "specialist"];
  const STATUS_LABELS = { planning: "Planejamento", executing: "Em execução", completed: "Concluído", cancelled: "Cancelado" };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
  const escapeXml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&apos;", '"': "&quot;" })[character]);
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  function excelColumn(index) {
    let result = "";
    let value = index;
    while (value > 0) {
      value--;
      result = String.fromCharCode(65 + (value % 26)) + result;
      value = Math.floor(value / 26);
    }
    return result;
  }

  function excelCell(column, row, value, style = 5) {
    const reference = `${excelColumn(column)}${row}`;
    if (value === null || value === undefined || value === "") return `<c r="${reference}" s="${style}"/>`;
    if (typeof value === "number" && Number.isFinite(value)) return `<c r="${reference}" s="${style}"><v>${value}</v></c>`;
    return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
  }

  // Os horarios sao timestamps de parede local ("2026-08-13T22:00:00"), entao o
  // dia e dado e nao precisa mais ser inferido para intervalos que viram a noite.
  function stampMinutes(value) {
    if (!value) return null;
    const parsed = Date.parse(String(value).replace(" ", "T"));
    return Number.isFinite(parsed) ? parsed / 60000 : null;
  }

  function stampClock(value) {
    return value ? String(value).slice(11, 16) : "—";
  }

  // Mostra so a hora quando cai no dia de referencia do intervalo; fora dele,
  // acrescenta o dia para deixar a virada explicita.
  function stampLabel(value, referenceDate) {
    if (!value) return "—";
    const text = String(value).replace(" ", "T");
    const day = text.slice(0, 10);
    const clock = text.slice(11, 16);
    if (!referenceDate || day === referenceDate) return clock;
    return `${clock} ${day.slice(8, 10)}/${day.slice(5, 7)}`;
  }

  function formatMinutes(value) {
    if (!Number.isFinite(value)) return "—";
    const absolute = Math.abs(Math.round(value));
    return absolute >= 60 ? `${Math.floor(absolute / 60)}h ${String(absolute % 60).padStart(2, "0")}min` : `${absolute} min`;
  }

  function isResolved(step) {
    return ["completed", "skipped"].includes(step.status) || Boolean(step.actual_end) || String(step.actual_notes || "").startsWith("[[ETAPA_NAO_EXECUTADA]]");
  }

  function isSkipped(step) {
    return step.status === "skipped" || String(step.actual_notes || "").startsWith("[[ETAPA_NAO_EXECUTADA]]");
  }

  function intervalMetrics(plan, now = new Date()) {
    const steps = [...(plan.interval_steps || [])].sort((a, b) => a.position - b.position);
    // O prazo do intervalo e o fim da janela mais o que o CCO concedeu. Sem
    // somar aqui, o card gerencial marcaria em vermelho um intervalo que a tela
    // de execucao mostra dentro do prazo.
    const plannedEnd = stampMinutes(plan.window_end);
    const windowEnd = plannedEnd == null ? null : plannedEnd + ccoGrantMinutes(plan);
    const resolved = steps.filter(isResolved).length;
    const progress = steps.length ? Math.round((resolved / steps.length) * 100) : 0;
    let variance = null;

    if (plan.status === "completed") {
      const actualEnds = steps.map((step) => stampMinutes(step.actual_end)).filter(Number.isFinite);
      if (actualEnds.length && windowEnd != null) variance = Math.max(...actualEnds) - windowEnd;
    } else if (plan.status === "executing") {
      // Mesma regra da pagina de acompanhamento: o saldo vem do marco mais
      // avancado da sequencia. Enquanto a etapa esta aberta, so existe inicio
      // real para comparar; o termino nao pode virar atraso antes de ser
      // registrado. Isso tambem permite frentes concomitantes sem falso atraso.
      const reached = steps
        .filter((step) => !isSkipped(step) && stampMinutes(step.actual_start) != null)
        .sort((a, b) => a.position - b.position);
      const frontier = reached.at(-1) || null;
      if (frontier) {
        const actualEnd = stampMinutes(frontier.actual_end);
        const plannedEnd = stampMinutes(frontier.planned_end);
        const actualStart = stampMinutes(frontier.actual_start);
        const plannedStart = stampMinutes(frontier.planned_start);
        variance = actualEnd != null && plannedEnd != null
          ? actualEnd - plannedEnd
          : actualStart != null && plannedStart != null ? actualStart - plannedStart : null;
      } else {
        const firstPending = steps.find((step) => !isSkipped(step) && !isResolved(step));
        const plannedStart = stampMinutes(firstPending?.planned_start);
        const current = now.getTime() / 60000;
        if (plannedStart != null && current > plannedStart) variance = current - plannedStart;
      }
    }

    const deadline = variance == null || Math.abs(variance) < 1 ? "ontime" : variance > 0 ? "late" : "ahead";
    return { steps, resolved, progress, variance: variance == null ? null : Math.round(variance), deadline };
  }

  // ---------------------------------------------------------------------------
  // Frentes: um bloqueio da via pode ter varios servicos correndo em paralelo.
  // Cada frente e uma linha de interval_plans; o group_id as reune de volta no
  // intervalo que a gestao enxerga. Contar frentes como intervalos inflaria
  // todo indicador desta tela.
  // ---------------------------------------------------------------------------
  const SILENCE_MINUTES = 20;

  function stampEpoch(value) {
    if (!value) return null;
    const parsed = Date.parse(String(value).replace(" ", "T"));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function lastActivityEpoch(plan) {
    const marks = [stampEpoch(plan.updated_at)];
    (plan.interval_steps || []).forEach((step) => {
      marks.push(stampEpoch(step.actual_start));
      marks.push(stampEpoch(step.actual_end));
    });
    (plan.interval_comments || []).forEach((comment) => marks.push(stampEpoch(comment.created_at)));
    const valid = marks.filter(Number.isFinite);
    return valid.length ? Math.max(...valid) : null;
  }

  // Mesma regra do app: o rotulo sai da posicao gravada, nunca do indice na
  // lista. A exportacao percorre frentes soltas e nao teria lista para indexar.
  function frontLabel(plan) {
    return String(plan.front_name || "").trim() || `Frente ${plan.front_position || 1}`;
  }

  // Concessao do CCO: tempo extra autorizado para o termino. Guardado ao lado
  // da janela, nao dentro dela, para o relatorio poder mostrar as duas coisas.
  function ccoGrantMinutes(plan) {
    const value = Number(plan?.cco_grant_minutes);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.min(1440, Math.round(value));
  }

  function ccoGrantLabel(plan) {
    const minutes = ccoGrantMinutes(plan);
    if (!minutes) return "";
    if (plan.cco_grant_unit !== "hours") return `${minutes} min`;
    const horas = minutes / 60;
    return `${(Number.isInteger(horas) ? String(horas) : String(Number(horas.toFixed(2)))).replace(".", ",")} h`;
  }

  // Quem encerrou e quando. O nome chega gravado na propria linha: closed_by
  // guarda um id de auth.users, e organization_members.auth_user_id nao esta
  // entre as colunas que este perfil pode ler -- por isso o id sozinho nunca
  // deu para exibir.
  function closureCredit(plan) {
    if (!plan?.completed_at) return "";
    const quando = new Date(plan.completed_at);
    const carimbo = Number.isNaN(quando.getTime())
      ? ""
      : quando.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
    const quem = String(plan.closed_by_name || "").trim();
    if (quem && carimbo) return `${quem} · ${carimbo}`;
    return quem || carimbo || "";
  }

  function groupPlans(plans) {
    const byGroup = new Map();
    plans.forEach((plan) => {
      const key = plan.group_id || plan.id;
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(plan);
    });
    return [...byGroup.entries()].map(([id, fronts]) => {
      fronts.sort((a, b) => (a.front_position || 1) - (b.front_position || 1)
        || String(a.created_at).localeCompare(String(b.created_at)));
      return { id, fronts, lead: fronts[0] };
    });
  }

  // O intervalo herda a pior leitura das suas frentes: quem esta atrasado e o
  // bloqueio, ainda que apenas uma frente esteja segurando a devolucao.
  function groupMetrics(group, now = new Date()) {
    const parts = group.fronts.map((plan) => intervalMetrics(plan, now));
    const steps = parts.reduce((sum, part) => sum + part.steps.length, 0);
    const resolved = parts.reduce((sum, part) => sum + part.resolved, 0);
    const variances = parts.map((part) => part.variance).filter(Number.isFinite);
    const variance = variances.length ? Math.max(...variances) : null;
    const status = group.fronts.every((plan) => plan.status === "completed")
      ? "completed"
      : group.fronts.some((plan) => plan.status === "executing")
        ? "executing"
        : group.fronts.every((plan) => plan.status === "cancelled")
          ? "cancelled"
          : "planning";
    const activity = group.fronts.map(lastActivityEpoch).filter(Number.isFinite);
    const lastActivity = activity.length ? Math.max(...activity) : null;
    const silence = status === "executing" && lastActivity != null
      ? Math.floor((now.getTime() - lastActivity) / 60000)
      : null;
    return {
      parts, steps, resolved, variance, status,
      progress: steps ? Math.round((resolved / steps) * 100) : 0,
      deadline: variance == null || Math.abs(variance) < 1 ? "ontime" : variance > 0 ? "late" : "ahead",
      silence: silence != null && silence >= SILENCE_MINUTES ? silence : null
    };
  }

  function filterPlans(plans, filters) {
    const query = String(filters.query || "").trim().toLocaleLowerCase("pt-BR");
    return plans.filter((plan) => {
      const metrics = intervalMetrics(plan);
      if (filters.manager && plan.manager_member_id !== filters.manager) return false;
      if (filters.coordinator && plan.coordinator_member_id !== filters.coordinator) return false;
      if (filters.classification && plan.coordinator_type !== filters.classification) return false;
      if (filters.status && plan.status !== filters.status) return false;
      if (filters.deadline && metrics.deadline !== filters.deadline) return false;
      if (filters.service && plan.service_type !== filters.service) return false;
      if (filters.dateFrom && (!plan.interval_date || plan.interval_date < filters.dateFrom)) return false;
      if (filters.dateTo && (!plan.interval_date || plan.interval_date > filters.dateTo)) return false;
      if (query && ![plan.title, plan.location, plan.service_type, plan.coordinatorName, plan.managerName].join(" ").toLocaleLowerCase("pt-BR").includes(query)) return false;
      return true;
    });
  }

  function roleScopeDescription(role) {
    if (role === "executive_manager") return "Gerentes sob sua gestão e todos os intervalos de seus Coordenadores e Especialistas.";
    if (role === "manager") return "Seus próprios intervalos e os intervalos dos Coordenadores e Especialistas vinculados à sua gestão.";
    if (["coordinator", "specialist"].includes(role)) return "Seus próprios intervalos, do planejamento ao histórico.";
    if (["director", "consultant"].includes(role)) return "Todos os Coordenadores e Especialistas, em modo somente leitura.";
    return "Visão completa da operação e acesso às ferramentas administrativas.";
  }

  function roleCapabilities(role) {
    return {
      canUseManagement: ["director", "executive_manager", "consultant", "manager", "coordinator", "specialist", "editor"].includes(role),
      canOperateIntervals: ["manager", "coordinator", "specialist", "editor"].includes(role),
      canAdminister: role === "editor",
      organizationWide: ["director", "consultant", "editor"].includes(role),
      readOnly: READ_ONLY_ROLES.includes(role)
    };
  }

  if (window.__GESTAO_TEST_MODE__) {
    window.__GESTAO_PORTAL_TEST_API__ = {
      stampMinutes, stampLabel, intervalMetrics, filterPlans, roleScopeDescription,
      roleCapabilities, managementSummary, exportManagementToXlsx,
      groupPlans, groupMetrics, frontLabel, lastActivityEpoch, SILENCE_MINUTES,
      cardMarkup, ccoGrantLabel, closureCredit, STATUS_LABELS
    };
    return;
  }

  let baseClient;
  let dataClient;
  let currentUser;
  let actualProfile;
  let effectiveProfile;
  let plans = [];
  let members = [];
  let managerAssignments = [];
  let accessRequests = [];
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
      global: { headers, fetch: window.AppStartup.fetch }
    });
  }

  function renderNavigation(role) {
    const nav = $("[data-role-nav]");
    if (!nav) return;
    const page = document.body.dataset.page;
    let links;
    if (role === "manager") {
      links = [["index.html", "Planejar", "planning"], ["executar.html", "Executar", "execution"], ["dashboard.html", "Dashboard", "dashboard"], ["gestao.html", "Gestão", "management"], ["conta.html", "Minha conta", "account"]];
    } else if (["coordinator", "specialist"].includes(role)) {
      links = [["index.html", "Planejar", "planning"], ["executar.html", "Executar", "execution"], ["dashboard.html", "Dashboard", "dashboard"], ["gestao.html?view=history", "Histórico", "management"], ["conta.html", "Minha conta", "account"]];
    } else if (role === "editor") {
      // O Editor administra o sistema; nao planeja nem executa intervalos, mas
      // enxerga todos eles -- e a unica funcao que enxerga.
      links = [["intervalos.html", "Intervalos", "intervals"], ["admin.html", "Administração", "admin"], ["auditoria.html", "Auditoria", "audit"], ["conta.html", "Minha conta", "account"]];
    } else if (roleCapabilities(role).canUseManagement) {
      links = [["gestao.html", "Gestão", "management"], ["conta.html", "Minha conta", "account"]];
    } else {
      links = [["conta.html", "Minha conta", "account"]];
    }
    nav.style.setProperty("--nav-count", links.length);
    nav.innerHTML = links.map(([href, label, target], index) => `<a href="${href}" class="${page === target ? "active" : ""}" ${page === target ? 'aria-current="page"' : ""}><span>${index + 1}</span>${escapeHtml(label)}</a>`).join("");
  }

  function configureContext() {
    dataClient = baseClient;
    effectiveProfile = actualProfile;
  }

  function decoratePlans(rows) {
    const memberMap = new Map(members.map((member) => [member.id, member]));
    return (rows || []).map((plan) => {
      const coordinator = memberMap.get(plan.coordinator_member_id);
      const manager = memberMap.get(plan.manager_member_id);
      return {
        ...plan,
        coordinatorName: coordinator?.full_name || plan.coordinator || "Não informado",
        managerName: manager?.full_name || "Não informado",
        interval_steps: (plan.interval_steps || []).sort((a, b) => a.position - b.position),
        interval_comments: (plan.interval_comments || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      };
    });
  }

  async function loadScopedData() {
    setState("Atualizando dados…", "syncing");
    const memberColumns = "id,dataset_id,code,full_name,role,role_gender,enabled,manager_id,coordinator_type,profile_needs_review";
    const [memberResult, planResult] = await Promise.all([
      dataClient.from("organization_members").select(memberColumns).eq("enabled", true).order("full_name"),
      dataClient.from("interval_plans").select("*,interval_steps(*),interval_comments(*)").order("interval_date", { ascending: false })
    ]);
    const error = memberResult.error || planResult.error;
    if (error) throw error;
    members = memberResult.data || [];
    plans = decoratePlans(planResult.data);
    setState("Atualizado agora", "ok");
  }

  function optionMarkup(rows, valueKey, label) {
    return rows.map((row) => `<option value="${escapeHtml(row[valueKey])}">${escapeHtml(label(row))}</option>`).join("");
  }

  function populateFilters() {
    const managers = members.filter((member) => member.role === "manager" && plans.some((plan) => plan.manager_member_id === member.id));
    const coordinators = members.filter((member) => ["coordinator", "specialist"].includes(member.role) && plans.some((plan) => plan.coordinator_member_id === member.id));
    const services = [...new Set(plans.map((plan) => plan.service_type).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
    $('[data-filter="manager"]').innerHTML = '<option value="">Todos</option>' + optionMarkup(managers, "id", (row) => row.full_name);
    $('[data-filter="coordinator"]').innerHTML = '<option value="">Todos</option>' + optionMarkup(coordinators, "id", (row) => row.full_name);
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

  function cardMarkup(group) {
    const plan = group.lead;
    const metrics = groupMetrics(group);
    const date = plan.interval_date ? new Date(`${plan.interval_date}T12:00:00`).toLocaleDateString("pt-BR") : "Sem data";
    const services = [...new Set(group.fronts.map((front) => front.service_type).filter(Boolean))];
    const fronts = group.fronts.length > 1 ? `<i class="tag-fronts">${group.fronts.length} frentes</i>` : "";
    const silence = metrics.silence != null
      ? `<span class="card-silence" title="A última movimentação registrada neste intervalo foi há ${formatMinutes(metrics.silence)}. Silêncio prolongado costuma indicar problema em campo.">Sem atualização há ${escapeHtml(formatMinutes(metrics.silence))}</span>`
      : "";
    return `<button class="interval-card ${metrics.deadline === "late" ? "is-late" : metrics.deadline === "ahead" ? "is-ahead" : "is-on-time"}${metrics.silence != null ? " is-silent" : ""}" type="button" data-plan-detail="${escapeHtml(plan.id)}">
      <span class="interval-card-top"><b>${escapeHtml(STATUS_LABELS[metrics.status] || metrics.status)}</b><i>${escapeHtml(TYPE_LABELS[plan.coordinator_type] || "Sem classificação")}</i></span>
      <strong class="interval-card-title">${escapeHtml(plan.title || "Intervalo sem título")}</strong>
      <span class="interval-card-location">${escapeHtml(plan.location || "Local não informado")} · ${date}</span>
      <span class="interval-card-people"><small>Gerente</small><b>${escapeHtml(plan.managerName)}</b><small>Responsável</small><b>${escapeHtml(plan.coordinatorName)}</b></span>
      <span class="interval-card-tags"><i>${escapeHtml(services.join(" · ") || "Tipo não informado")}</i><i>${escapeHtml(stampLabel(plan.window_start, plan.interval_date))}–${escapeHtml(stampLabel(plan.window_end, plan.interval_date))}</i>${fronts}</span>
      <span class="interval-card-progress"><span><i style="width:${metrics.progress}%"></i></span><b>${metrics.progress}%</b></span>
      ${deadlineMarkup(metrics)}${silence}
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
    const modernization = filtered.filter((plan) => plan.coordinator_type === "modernization").length;
    const average = completedMetrics.filter((metric) => metric.variance != null).reduce((sum, metric, _, all) => sum + metric.variance / all.length, 0);
    // Um bloqueio com duas frentes e um intervalo, nao dois.
    const intervals = new Set(filtered.map((plan) => plan.group_id || plan.id)).size;
    const executingIntervals = new Set(filtered.filter((plan) => plan.status === "executing").map((plan) => plan.group_id || plan.id)).size;
    const kpis = [
      ["Total de intervalos", intervals, filtered.length === intervals ? "No período e filtros atuais" : `${filtered.length} frentes no período`],
      ["Em execução", executingIntervals, "Bloqueios abertos agora"],
      ["Dentro do prazo", within, completed.length ? `${Math.round(within / completed.length * 100)}% dos concluídos` : "Sem concluídos"],
      ["Fora do prazo", late, completed.length ? `${Math.round(late / completed.length * 100)}% dos concluídos` : "Sem concluídos"],
      ["Atraso médio", completedMetrics.length ? formatMinutes(Math.max(0, average)) : "—", "Entre os concluídos"],
      ["Adiantamentos", ahead, "Intervalos concluídos antes do prazo"]
    ];
    $("#overview-kpis").innerHTML = kpis.map(([label, value, note], index) => `<article class="dashboard-kpi ${index === 3 && late ? "alert" : ""}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>`).join("");
    renderBars($("#classification-chart"), [{ label: "Superestrutura", value: superstructure }, { label: "Infraestrutura", value: infra }, { label: "Modernização", value: modernization }]);
    renderBars($("#punctuality-chart"), [{ label: "Dentro do prazo", value: within }, { label: "Fora do prazo", value: late }], "deadline-tone");
    const serviceCounts = Object.entries(filtered.reduce((result, plan) => { const key = plan.service_type || "Não informado"; result[key] = (result[key] || 0) + 1; return result; }, {})).sort((a, b) => b[1] - a[1]);
    renderBars($("#service-chart"), serviceCounts.map(([label, value]) => ({ label, value })));
    const recent = completed.slice().sort((a, b) => String(b.interval_date).localeCompare(String(a.interval_date))).slice(0, 8);
    $("#trend-chart").innerHTML = recent.length ? recent.map((plan) => { const metric = intervalMetrics(plan); return `<button type="button" data-plan-detail="${plan.id}"><span><strong>${escapeHtml(plan.title)}</strong><small>${escapeHtml(plan.interval_date || "Sem data")} · ${escapeHtml(plan.coordinatorName)}</small></span>${deadlineMarkup(metric)}</button>`; }).join("") : emptyMarkup("Conclua intervalos para formar a tendência.");
    setCount("overview", intervals, "intervalo");
  }

  function selectedFilterSummary() {
    const entries = $$('[data-filter]').map((field) => {
      const label = field.closest("label")?.querySelector("span")?.textContent?.trim() || "Filtro";
      const value = field.tagName === "SELECT" ? field.selectedOptions[0]?.textContent?.trim() : field.value.trim();
      const empty = !field.value || ["Todos", "Todas"].includes(value);
      return empty ? null : `${label}: ${value}`;
    }).filter(Boolean);
    return entries.length ? entries.join(" · ") : "Sem filtros adicionais · todo o escopo autorizado";
  }

  function managementSummary(filtered) {
    const completed = filtered.filter((plan) => plan.status === "completed");
    const metrics = completed.map((plan) => intervalMetrics(plan));
    const late = metrics.filter((metric) => metric.variance > 0).length;
    const ahead = metrics.filter((metric) => metric.variance < 0).length;
    const onTime = metrics.filter((metric) => metric.variance === 0).length;
    const averageDelayValues = metrics.map((metric) => metric.variance).filter((value) => Number.isFinite(value) && value > 0);
    const averageDelay = averageDelayValues.length ? Math.round(averageDelayValues.reduce((sum, value) => sum + value, 0) / averageDelayValues.length) : 0;
    const classification = [
      ["Superestrutura", filtered.filter((plan) => plan.coordinator_type === "superstructure").length],
      ["Infraestrutura", filtered.filter((plan) => plan.coordinator_type === "infrastructure").length],
      ["Modernização", filtered.filter((plan) => plan.coordinator_type === "modernization").length]
    ];
    const punctuality = [["No prazo", onTime], ["Adiantado", ahead], ["Em atraso", late]];
    const services = Object.entries(filtered.reduce((result, plan) => {
      const key = plan.service_type || "Não informado";
      result[key] = (result[key] || 0) + 1;
      return result;
    }, {})).sort((a, b) => b[1] - a[1]);
    const intervals = new Set(filtered.map((plan) => plan.group_id || plan.id)).size;
    const kpis = [
      ["Total de intervalos", intervals],
      ["Frentes de serviço", filtered.length],
      ["Em execução", new Set(filtered.filter((plan) => plan.status === "executing").map((plan) => plan.group_id || plan.id)).size],
      ["Concluídos", new Set(completed.map((plan) => plan.group_id || plan.id)).size],
      ["Dentro do prazo", onTime + ahead],
      ["Fora do prazo", late],
      ["Atraso médio (min)", averageDelay]
    ];
    return { classification, punctuality, services, kpis };
  }

  async function exportManagementToXlsx(filtered) {
    if (typeof JSZip === "undefined") throw new Error("Gerador de Excel indisponível");
    const summary = managementSummary(filtered);
    const chartRows = Math.max(summary.classification.length, summary.punctuality.length, summary.services.length, summary.kpis.length, 1);
    const dataHeaderRow = 8 + chartRows;
    const dataStartRow = dataHeaderRow + 1;
    const rows = [];
    rows.push(`<row r="1" ht="30" customHeight="1">${excelCell(1, 1, "GESTÃO DE INTERVALO - VISÃO GERENCIAL", 1)}</row>`);
    rows.push(`<row r="2">${excelCell(1, 2, `Gerado em ${new Date().toLocaleString("pt-BR")}`, 5)}</row>`);
    rows.push(`<row r="3" ht="30" customHeight="1">${excelCell(1, 3, selectedFilterSummary(), 9)}</row>`);
    rows.push(`<row r="5" ht="24" customHeight="1">${excelCell(1, 5, "RESUMO E GRÁFICOS", 2)}</row>`);
    rows.push(`<row r="6">${excelCell(1, 6, "Classificação", 4)}${excelCell(2, 6, "Quantidade", 4)}${excelCell(4, 6, "Pontualidade", 4)}${excelCell(5, 6, "Quantidade", 4)}${excelCell(7, 6, "Tipo de intervalo", 4)}${excelCell(8, 6, "Quantidade", 4)}${excelCell(10, 6, "Indicador", 4)}${excelCell(11, 6, "Valor", 4)}</row>`);
    for (let index = 0; index < chartRows; index++) {
      const row = index + 7;
      const classification = summary.classification[index] || [];
      const punctuality = summary.punctuality[index] || [];
      const service = summary.services[index] || [];
      const kpi = summary.kpis[index] || [];
      rows.push(`<row r="${row}">${excelCell(1, row, classification[0])}${excelCell(2, row, classification[1])}${excelCell(4, row, punctuality[0])}${excelCell(5, row, punctuality[1])}${excelCell(7, row, service[0])}${excelCell(8, row, service[1])}${excelCell(10, row, kpi[0])}${excelCell(11, row, kpi[1])}</row>`);
    }
    rows.push(`<row r="${dataHeaderRow - 1}" ht="24" customHeight="1">${excelCell(1, dataHeaderRow - 1, "DADOS DOS INTERVALOS", 2)}</row>`);
    // "Encerrado por" fecha a tabela: era o dado que o banco guardava desde o
    // primeiro encerramento e que nao aparecia em lugar nenhum.
    const headers = ["Título", "Data", "Status", "Situação do prazo", "Desvio (min)", "Progresso (%)", "Gerente", "Responsável", "Classificação", "Tipo", "Local", "Janela", "Concessão do CCO", "Encerrado por"];
    rows.push(`<row r="${dataHeaderRow}" ht="28" customHeight="1">${headers.map((header, index) => excelCell(index + 1, dataHeaderRow, header, 4)).join("")}</row>`);
    // Cada linha e uma frente; o titulo carrega o nome dela quando o bloqueio
    // tem mais de uma, para as linhas nao parecerem duplicadas.
    const groupSizes = filtered.reduce((result, plan) => {
      const key = plan.group_id || plan.id;
      result[key] = (result[key] || 0) + 1;
      return result;
    }, {});
    filtered.forEach((plan, index) => {
      const row = dataStartRow + index;
      const metrics = intervalMetrics(plan);
      const deadline = metrics.variance == null || metrics.variance === 0 ? "No prazo" : metrics.variance > 0 ? "Em atraso" : "Adiantado";
      const title = groupSizes[plan.group_id || plan.id] > 1
        ? `${plan.title || ""} · ${frontLabel(plan)}`
        : plan.title;
      const values = [title, plan.interval_date, STATUS_LABELS[plan.status] || plan.status, deadline, metrics.variance, metrics.progress, plan.managerName, plan.coordinatorName, TYPE_LABELS[plan.coordinator_type] || "Não informado", plan.service_type, plan.location, `${stampLabel(plan.window_start, plan.interval_date)}-${stampLabel(plan.window_end, plan.interval_date)}`, ccoGrantLabel(plan) || "—", closureCredit(plan)];
      rows.push(`<row r="${row}" ht="25" customHeight="1">${values.map((value, column) => excelCell(column + 1, row, value, [0, 9, 10].includes(column) ? 9 : 5)).join("")}</row>`);
    });
    const lastRow = Math.max(dataHeaderRow, dataStartRow + filtered.length - 1);
    const barRange = (column, count, priority, color) => count ? `<conditionalFormatting sqref="${column}7:${column}${6 + count}"><cfRule type="dataBar" priority="${priority}"><dataBar showValue="1"><cfvo type="min"/><cfvo type="max"/><color rgb="${color}"/></dataBar></cfRule></conditionalFormatting>` : "";
    const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="${dataHeaderRow}" topLeftCell="A${dataStartRow}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols><col min="1" max="1" width="34" customWidth="1"/><col min="2" max="6" width="16" customWidth="1"/><col min="7" max="8" width="25" customWidth="1"/><col min="9" max="10" width="18" customWidth="1"/><col min="11" max="12" width="24" customWidth="1"/><col min="13" max="13" width="18" customWidth="1"/><col min="14" max="14" width="30" customWidth="1"/></cols><sheetData>${rows.join("")}</sheetData><autoFilter ref="A${dataHeaderRow}:N${lastRow}"/><mergeCells count="4"><mergeCell ref="A1:N1"/><mergeCell ref="A3:N3"/><mergeCell ref="A5:N5"/><mergeCell ref="A${dataHeaderRow - 1}:N${dataHeaderRow - 1}"/></mergeCells>${barRange("B", summary.classification.length, 1, "FF003865")}${barRange("E", summary.punctuality.length, 2, "FF22A884")}${barRange("H", summary.services.length, 3, "FF32A6E6")}</worksheet>`;
    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="10"/><name val="Verdana"/></font><font><b/><sz val="16"/><color rgb="FFFFFFFF"/><name val="Verdana"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Verdana"/></font></fonts><fills count="8"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF003865"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF32A6E6"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE5EBEE"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE9F8F2"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF0ED"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF6D1"/></patternFill></fill></fills><borders count="2"><border/><border><left style="thin"><color rgb="FFCAD6DD"/></left><right style="thin"><color rgb="FFCAD6DD"/></right><top style="thin"><color rgb="FFCAD6DD"/></top><bottom style="thin"><color rgb="FFCAD6DD"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="10"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0"/><xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0"/><xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0"><alignment wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0"/><xf numFmtId="0" fontId="0" fillId="6" borderId="1" xfId="0"/><xf numFmtId="0" fontId="0" fillId="7" borderId="1" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`);
    zip.folder("_rels").file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
    const xl = zip.folder("xl");
    xl.file("workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Resumo e dados" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`);
    xl.folder("_rels").file("workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    xl.folder("worksheets").file("sheet1.xml", sheetXml);
    xl.file("styles.xml", stylesXml);
    const blob = await zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", compression: "DEFLATE" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `visao-gerencial-${new Date().toISOString().slice(0, 10)}.xlsx`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    return blob;
  }

  // rotulo vem preenchido na visao do Editor, que nao tem abas para consultar.
  function exportManagementToPdf(button, rotulo = null) {
    const activeButton = $('[data-view-button].active');
    const viewLabel = rotulo || activeButton?.textContent?.trim() || "Visão gerencial";
    $("#portal-print-title").textContent = rotulo ? rotulo : `Visão gerencial - ${viewLabel}`;
    $("#portal-print-filters").textContent = `${profileRoleLabel(effectiveProfile)} · ${selectedFilterSummary()} · ${new Date().toLocaleString("pt-BR")}`;
    const previousTitle = document.title;
    document.title = `visao-gerencial-${viewLabel.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
    document.body.classList.add("portal-printing");
    button.disabled = true;
    button.textContent = "Preparando PDF…";
    const restore = () => {
      document.title = previousTitle;
      document.body.classList.remove("portal-printing");
      button.disabled = false;
      button.textContent = "Exportar PDF";
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    setTimeout(() => window.print(), 80);
  }

  // Um numero discreto sobre a aba "Em execução": quantos intervalos em
  // andamento estao atrasados agora. E a resposta a pergunta que o gerente
  // faria ao abrir a tela, dada antes de ele precisar procurar.
  function renderDelayBadge(count) {
    const button = $('[data-view-button="running"]');
    if (!button) return;
    let badge = $(".tab-badge", button);
    if (!count) {
      badge?.remove();
      button.removeAttribute("title");
      button.removeAttribute("aria-describedby");
      return;
    }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "tab-badge";
      badge.id = "running-delay-badge";
      button.appendChild(badge);
    }
    const texto = count === 1
      ? "1 intervalo em execução está em atraso agora."
      : `${count} intervalos em execução estão em atraso agora.`;
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.title = `${texto} Abra “Em execução” para ver quais.`;
    badge.setAttribute("aria-label", texto);
    button.title = badge.title;
    button.setAttribute("aria-describedby", "running-delay-badge");
  }

  function renderManagement() {
    const filtered = filterPlans(plans, currentFilters());
    const groups = groupPlans(filtered).map((group) => ({ ...group, metrics: groupMetrics(group) }));
    const running = groups.filter((group) => group.metrics.status === "executing");
    const history = groups.filter((group) => group.metrics.status === "completed")
      .sort((a, b) => String(b.lead.interval_date).localeCompare(String(a.lead.interval_date)));
    const byType = (type) => running.filter((group) => group.lead.coordinator_type === type);
    const infra = byType("infrastructure");
    const superstructure = byType("superstructure");
    const modernization = byType("modernization");
    $("#infra-cards").innerHTML = infra.length ? infra.map(cardMarkup).join("") : emptyMarkup("Nenhuma frente de Infraestrutura em execução.");
    $("#super-cards").innerHTML = superstructure.length ? superstructure.map(cardMarkup).join("") : emptyMarkup("Nenhuma frente de Superestrutura em execução.");
    $("#modernization-cards").innerHTML = modernization.length ? modernization.map(cardMarkup).join("") : emptyMarkup("Nenhuma frente de Modernização em execução.");
    $("#history-cards").innerHTML = history.length ? history.map(cardMarkup).join("") : emptyMarkup("Nenhum intervalo concluído corresponde aos filtros.");
    setCount("running", running.length);
    setCount("history", history.length);
    renderDelayBadge(running.filter((group) => group.metrics.variance > 0).length);
    $("#hero-live-count").textContent = groupPlans(plans).filter((group) => groupMetrics(group).status === "executing").length;
    renderOverview(filtered);
  }

  function commentMarkup(comment, plan) {
    const canDelete = ["manager", "coordinator", "specialist", "editor"].includes(actualProfile.role)
      && plan.status === "executing"
      && !comment.deleted_at
      && comment.author_user_id === currentUser.id;
    if (comment.deleted_at) return "";
    return `<article class="interval-comment" data-comment-id="${comment.id}"><header><span><strong>${escapeHtml(comment.author_name)}</strong><i>${escapeHtml(roleLabel(comment.author_role, comment.author_role_gender))}</i></span><time>${new Date(comment.created_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</time></header><p>${escapeHtml(comment.content)}</p>${canDelete ? '<button type="button" data-comment-delete>Excluir meu comentário</button>' : ""}</article>`;
  }

  function planTabMarkup(plan) {
    const steps = plan.interval_steps || [];
    return `<div class="detail-summary-grid"><div><span>Título</span><strong>${escapeHtml(plan.title || "—")}</strong></div><div><span>Tipo</span><strong>${escapeHtml(plan.service_type || "—")}</strong></div><div><span>Local</span><strong>${escapeHtml(plan.location || "—")}</strong></div><div><span>Data e janela</span><strong>${escapeHtml(plan.interval_date || "—")} · ${escapeHtml(stampLabel(plan.window_start, plan.interval_date))}–${escapeHtml(stampLabel(plan.window_end, plan.interval_date))}</strong></div><div><span>Gerente</span><strong>${escapeHtml(plan.managerName)}</strong></div><div><span>Responsável</span><strong>${escapeHtml(plan.coordinatorName)}</strong></div><div><span>Classificação</span><strong>${escapeHtml(TYPE_LABELS[plan.coordinator_type] || "—")}</strong></div></div><article class="detail-note"><span>Observações de planejamento</span><p>${escapeHtml(plan.planning_notes || "Nenhuma observação registrada.")}</p></article><div class="detail-step-list">${steps.map((step, index) => `<article><span>${String(index + 1).padStart(2, "0")}</span><div><strong>${escapeHtml(step.activity_name || `Etapa ${index + 1}`)}</strong><small>Planejado · ${escapeHtml(stampLabel(step.planned_start, plan.interval_date))}–${escapeHtml(stampLabel(step.planned_end, plan.interval_date))}</small></div></article>`).join("") || emptyMarkup("Este plano não possui etapas.")}</div>`;
  }

  function executionTabMarkup(plan) {
    const metrics = intervalMetrics(plan);
    const comments = plan.interval_comments || [];
    const canComment = plan.status === "executing"
      && (actualProfile.role === "editor" || (["manager", "coordinator", "specialist"].includes(actualProfile.role) && plan.user_id === currentUser.id));
    const quiet = plan.status === "executing" && lastActivityEpoch(plan) != null
      ? Math.floor((Date.now() - lastActivityEpoch(plan)) / 60000)
      : null;
    const silenceMarkup = quiet != null && quiet >= SILENCE_MINUTES
      ? `<p class="detail-silence">Sem atualização há ${escapeHtml(formatMinutes(quiet))}.</p>`
      : "";
    // Quem encerrou: dado que o banco guardava desde sempre e que nenhuma tela
    // mostrava.
    const credito = closureCredit(plan);
    const closureMarkup = credito ? `<p class="detail-closure">Encerrado por ${escapeHtml(credito)}.</p>` : "";
    return `<div class="detail-status ${metrics.deadline}">${deadlineMarkup(metrics)}<strong>${metrics.progress}% concluído</strong><span>${metrics.resolved} de ${metrics.steps.length} etapas encerradas</span></div>${silenceMarkup}${closureMarkup}<div class="detail-step-list execution-readonly">${metrics.steps.map((step, index) => `<article><span>${isResolved(step) ? "✓" : String(index + 1).padStart(2, "0")}</span><div><strong>${escapeHtml(step.activity_name || `Etapa ${index + 1}`)}</strong><small>Planejado ${escapeHtml(stampLabel(step.planned_start, plan.interval_date))}–${escapeHtml(stampLabel(step.planned_end, plan.interval_date))} · Realizado ${escapeHtml(stampLabel(step.actual_start, plan.interval_date))}–${escapeHtml(stampLabel(step.actual_end, plan.interval_date))}</small>${step.actual_notes ? `<p>${escapeHtml(String(step.actual_notes).replace(/^\[\[ETAPA_NAO_EXECUTADA\]\]\s*/, "Não executada · "))}</p>` : ""}</div></article>`).join("") || emptyMarkup("Nenhuma etapa registrada.")}</div><article class="detail-note"><span>Registro geral da execução</span><p>${escapeHtml(plan.execution_notes || "Nenhuma observação registrada.")}</p></article><section class="comments-panel"><header><div><p class="section-kicker">Registro permanente</p><h3>Comentários da execução</h3></div><span>${comments.filter((comment) => !comment.deleted_at).length}</span></header><div class="comments-list">${comments.map((comment) => commentMarkup(comment, plan)).join("") || emptyMarkup("Ainda não há comentários neste intervalo.")}</div>${canComment ? '<form id="detail-comment-form"><label class="field"><span>Novo comentário</span><textarea name="content" maxlength="2000" rows="3" required placeholder="Registre uma atualização relevante"></textarea></label><button class="button button-secondary" type="submit">Adicionar comentário</button><span class="auth-feedback"></span></form>' : `<p class="comments-locked">Após o encerramento, os comentários tornam-se permanentes.</p>`}</section>`;
  }

  function dashboardTabMarkup(plan) {
    const metrics = intervalMetrics(plan);
    const plannedTotal = metrics.steps.reduce((sum, step) => { const start = stampMinutes(step.planned_start); const end = stampMinutes(step.planned_end); return sum + (start != null && end != null ? end - start : 0); }, 0);
    const actualTotal = metrics.steps.reduce((sum, step) => { const start = stampMinutes(step.actual_start); const end = stampMinutes(step.actual_end); return sum + (start != null && end != null ? end - start : 0); }, 0);
    return `<div class="overview-kpis detail-kpis"><article class="dashboard-kpi"><span>Progresso</span><strong>${metrics.progress}%</strong><small>${metrics.resolved} de ${metrics.steps.length} etapas</small></article><article class="dashboard-kpi"><span>Tempo programado</span><strong>${formatMinutes(plannedTotal)}</strong><small>Somatório das etapas</small></article><article class="dashboard-kpi"><span>Tempo realizado</span><strong>${actualTotal ? formatMinutes(actualTotal) : "—"}</strong><small>Etapas já concluídas</small></article><article class="dashboard-kpi ${metrics.deadline === "late" ? "alert" : ""}"><span>Desvio do intervalo</span><strong>${metrics.variance == null ? "—" : `${metrics.variance > 0 ? "+" : metrics.variance < 0 ? "−" : ""}${formatMinutes(metrics.variance)}`}</strong><small>${metrics.deadline === "late" ? "Fora do prazo" : metrics.deadline === "ahead" ? "Adiantado" : "Dentro do prazo"}</small></article></div><div class="detail-progress-list">${metrics.steps.map((step) => { const start = stampMinutes(step.planned_start); const end = stampMinutes(step.planned_end); const actualStart = stampMinutes(step.actual_start); const actualEnd = stampMinutes(step.actual_end); const planned = start != null && end != null ? end - start : 0; const actual = actualStart != null && actualEnd != null ? actualEnd - actualStart : 0; return `<div><span>${escapeHtml(step.activity_name || "Etapa")}</span><div><i style="width:${Math.min(100, planned ? actual / planned * 100 : 0)}%"></i></div><b>${actual ? formatMinutes(actual) : "Aguardando"}</b></div>`; }).join("")}</div>`;
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

  function fullTrackingUrl(plan, view = "plan") {
    const link = new URL("acompanhar.html", location.href);
    link.searchParams.set("plan", plan.id);
    link.searchParams.set("view", ["plan", "execution", "dashboard"].includes(view) ? view : "plan");
    return link.href;
  }

  function openPlanDetail(planId, initialTab = "plan") {
    const plan = plans.find((candidate) => candidate.id === planId);
    if (!plan) return;
    const dialog = $("#interval-detail");
    const root = $("#interval-detail-content");
    const shareAllowed = ["editor", "manager", "coordinator", "specialist"].includes(actualProfile.role)
      && plan.user_id === currentUser.id;
    // Frentes do mesmo bloqueio: o dialogo abre uma, mas deixa trocar sem
    // voltar para os cards.
    const fronts = plans
      .filter((candidate) => (candidate.group_id || candidate.id) === (plan.group_id || plan.id))
      .sort((a, b) => (a.front_position || 1) - (b.front_position || 1)
        || String(a.created_at).localeCompare(String(b.created_at)));
    const frontStrip = fronts.length > 1
      ? `<div class="front-strip detail-fronts" role="tablist" aria-label="Frentes deste intervalo">${fronts.map((front) => `<button class="front-tab${front.id === plan.id ? " is-active" : ""}" type="button" role="tab" aria-selected="${front.id === plan.id}" data-detail-front="${escapeHtml(front.id)}"><b>${escapeHtml(frontLabel(front))}</b><small>${escapeHtml(front.service_type || STATUS_LABELS[front.status] || "")}</small></button>`).join("")}</div>`
      : "";
    root.innerHTML = `<header class="detail-dialog-header"><div><p class="section-kicker">Prévia do acompanhamento do intervalo</p><h2>${escapeHtml(plan.title || "Intervalo")}</h2><span>${escapeHtml(plan.location || "Local não informado")} · ${escapeHtml(plan.coordinatorName)}${fronts.length > 1 ? ` · ${escapeHtml(frontLabel(plan))} de ${fronts.length}` : ""}</span></div><button type="button" data-detail-close aria-label="Fechar">×</button></header>${frontStrip}<div class="detail-full-page-bar"><span><strong>Quer ver todos os detalhes?</strong><small>Abra o acompanhamento completo com plano, execução e dashboard.</small></span><a class="button button-secondary" data-full-tracking-link href="${escapeHtml(fullTrackingUrl(plan, initialTab))}">Abrir página completa <i aria-hidden="true">↗</i></a></div><nav class="detail-tabs" aria-label="Detalhes do intervalo" role="tablist"><button type="button" role="tab" data-detail-tab="plan">Plano do intervalo</button><button type="button" role="tab" data-detail-tab="execution">Execução do intervalo</button><button type="button" role="tab" data-detail-tab="dashboard">Dashboard do intervalo</button></nav><div class="detail-dialog-body"><section role="tabpanel" data-detail-view="plan">${planTabMarkup(plan)}</section><section role="tabpanel" data-detail-view="execution">${executionTabMarkup(plan)}</section><section role="tabpanel" data-detail-view="dashboard">${dashboardTabMarkup(plan)}</section>${shareAllowed ? '<div class="detail-share"><button class="button button-ghost" type="button" data-create-share>Gerar link público temporário</button><span class="auth-feedback"></span></div>' : ""}</div>`;
    const activate = (tab) => {
      $$('[data-detail-tab]', root).forEach((button) => { const active = button.dataset.detailTab === tab; button.classList.toggle("active", active); button.setAttribute("aria-selected", String(active)); });
      $$('[data-detail-view]', root).forEach((view) => { view.hidden = view.dataset.detailView !== tab; });
      $('[data-full-tracking-link]', root).href = fullTrackingUrl(plan, tab);
    };
    activate(initialTab);
    $('[data-detail-close]', root).addEventListener("click", () => dialog.close());
    $$('[data-detail-tab]', root).forEach((button) => button.addEventListener("click", () => activate(button.dataset.detailTab)));
    $$('[data-detail-front]', root).forEach((button) => button.addEventListener("click", () => {
      const current = $$('[data-detail-tab]', root).find((tab) => tab.classList.contains("active"))?.dataset.detailTab || initialTab;
      openPlanDetail(button.dataset.detailFront, current);
    }));
    $("#detail-comment-form", root)?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const feedback = $(".auth-feedback", form);
      const content = form.content.value.trim();
      if (!content) return;
      feedback.textContent = navigator.onLine ? "Salvando…" : "Sem conexão. Tente novamente quando o sinal retornar.";
      if (!navigator.onLine) return;
      const { error } = await dataClient.from("interval_comments").insert({ client_id: uid(), dataset_id: plan.dataset_id, plan_id: plan.id, author_user_id: currentUser.id, author_name: actualProfile.full_name || "Usuário", author_role: actualProfile.role, author_role_gender: actualProfile.role_gender || null, content });
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
    const allowed = ["running", "history", "overview"];
    if (view === "dashboard") view = "overview";
    if (!allowed.includes(view)) view = "running";
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
    $("#hero-role").textContent = profileRoleLabel(effectiveProfile);
    $("#scope-description").textContent = roleScopeDescription(effectiveProfile.role);
    renderManagement();
    activateManagementView(new URLSearchParams(location.search).get("view") || "running");
    $$('[data-view-button]').forEach((button) => button.addEventListener("click", () => activateManagementView(button.dataset.viewButton)));
    $$("[data-filter]").forEach((field) => field.addEventListener(field.type === "search" ? "input" : "change", renderManagement));
    $("#clear-filters").addEventListener("click", () => { $$("[data-filter]").forEach((field) => { field.value = ""; }); renderManagement(); });
    $("#export-management-xlsx").addEventListener("click", async () => {
      const button = $("#export-management-xlsx");
      button.disabled = true;
      button.textContent = "Gerando planilha…";
      try {
        await exportManagementToXlsx(filterPlans(plans, currentFilters()));
        showToast("Planilha do escopo atual exportada.");
      } catch (error) {
        console.error(error);
        showToast("Não foi possível gerar a planilha.");
      } finally {
        button.disabled = false;
        button.textContent = "Exportar Excel";
      }
    });
    $("#export-management-pdf").addEventListener("click", () => exportManagementToPdf($("#export-management-pdf")));
    $(".management-workspace").addEventListener("click", (event) => { const card = event.target.closest("[data-plan-detail]"); if (card) openPlanDetail(card.dataset.planDetail); });
    $("#interval-detail").addEventListener("click", (event) => { if (event.target === event.currentTarget) event.currentTarget.close(); });

    setInterval(async () => { if (document.hidden) return; try { await loadScopedData(); renderManagement(); } catch (error) { console.warn(error); setState("Erro ao atualizar", "error"); } }, 15000);
  }

  // ---------------------------------------------------------------------------
  // Visao do sistema inteiro, do Editor. A gestao recorta por hierarquia e
  // separa por classificacao; aqui o recorte e o status, porque a pergunta e
  // outra: quantos intervalos existem, e em que pe esta cada um.
  // ---------------------------------------------------------------------------
  let intervalsFetchedAt = null;

  function renderIntervalsFreshness() {
    const carimbo = $("#intervals-updated");
    const nota = $("#intervals-updated-note");
    if (!carimbo || !intervalsFetchedAt) return;
    carimbo.textContent = intervalsFetchedAt.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "medium" });
    const segundos = Math.max(0, Math.round((Date.now() - intervalsFetchedAt.getTime()) / 1000));
    nota.textContent = segundos < 10
      ? "Agora mesmo · atualiza sozinho a cada 30 s"
      : `Há ${segundos < 60 ? `${segundos} s` : formatMinutes(Math.floor(segundos / 60))} · atualiza sozinho a cada 30 s`;
  }

  function renderIntervals() {
    const filtered = filterPlans(plans, currentFilters());
    const groups = groupPlans(filtered).map((group) => ({ ...group, metrics: groupMetrics(group) }));
    // Um bloqueio cancelado nao esta em planejamento nem concluido; ele entra
    // no historico para nao sumir da tela sem explicacao.
    const porStatus = (status) => groups.filter((group) => group.metrics.status === status);
    const planejamento = porStatus("planning")
      .sort((a, b) => String(a.lead.interval_date).localeCompare(String(b.lead.interval_date)));
    const execucao = porStatus("executing")
      .sort((a, b) => (b.metrics.variance ?? -Infinity) - (a.metrics.variance ?? -Infinity));
    const concluidos = [...porStatus("completed"), ...porStatus("cancelled")]
      .sort((a, b) => String(b.lead.interval_date).localeCompare(String(a.lead.interval_date)));

    $("#planning-cards").innerHTML = planejamento.length
      ? planejamento.map(cardMarkup).join("")
      : emptyMarkup("Nenhum intervalo em planejamento corresponde aos filtros.");
    $("#executing-cards").innerHTML = execucao.length
      ? execucao.map(cardMarkup).join("")
      : emptyMarkup("Nenhum intervalo em execução corresponde aos filtros.");
    $("#completed-cards").innerHTML = concluidos.length
      ? concluidos.map(cardMarkup).join("")
      : emptyMarkup("Nenhum intervalo concluído corresponde aos filtros.");

    setCount("planning", planejamento.length, "intervalo");
    setCount("executing", execucao.length, "intervalo");
    setCount("completed", concluidos.length, "intervalo");
    renderIntervalsFreshness();
  }

  async function refreshIntervals() {
    await loadScopedData();
    intervalsFetchedAt = new Date();
    renderIntervals();
  }

  async function initializeIntervals() {
    await refreshIntervals();
    populateFilters();

    $$("[data-filter]").forEach((field) => field.addEventListener(field.type === "search" ? "input" : "change", renderIntervals));
    $("#intervals-clear-filters").addEventListener("click", () => {
      $$("[data-filter]").forEach((field) => { field.value = ""; });
      renderIntervals();
    });

    const botaoAtualizar = $("#intervals-refresh");
    botaoAtualizar.addEventListener("click", async () => {
      botaoAtualizar.disabled = true;
      botaoAtualizar.textContent = "Atualizando…";
      try { await refreshIntervals(); } catch (error) { console.warn(error); setState("Erro ao atualizar", "error"); }
      botaoAtualizar.disabled = false;
      botaoAtualizar.textContent = "Atualizar agora";
    });

    $("#export-intervals-xlsx").addEventListener("click", async () => {
      const button = $("#export-intervals-xlsx");
      button.disabled = true;
      button.textContent = "Gerando planilha…";
      try {
        await exportManagementToXlsx(filterPlans(plans, currentFilters()));
        showToast("Planilha dos intervalos filtrados exportada.");
      } catch (error) {
        console.error(error);
        showToast("Não foi possível gerar a planilha.");
      } finally {
        button.disabled = false;
        button.textContent = "Exportar Excel";
      }
    });
    $("#export-intervals-pdf").addEventListener("click", () => exportManagementToPdf($("#export-intervals-pdf"), "Todos os intervalos"));

    $(".intervals-board").addEventListener("click", (event) => {
      const card = event.target.closest("[data-plan-detail]");
      if (card) openPlanDetail(card.dataset.planDetail);
    });
    $("#interval-detail").addEventListener("click", (event) => { if (event.target === event.currentTarget) event.currentTarget.close(); });

    // O carimbo do topo so significa alguma coisa se envelhecer a vista: sem
    // este segundo relogio ele ficaria congelado entre uma busca e outra,
    // dizendo "atualizado" sobre um dado de dez minutos atras.
    setInterval(renderIntervalsFreshness, 5000);
    setInterval(async () => {
      if (document.hidden) return;
      try { await refreshIntervals(); } catch (error) { console.warn(error); setState("Erro ao atualizar", "error"); }
    }, 30000);
  }

  async function loadAdminData() {
    setState("Atualizando cadastros…", "syncing");
    const [profilesResult, assignmentsResult] = await Promise.all([
      baseClient.from("user_profiles")
        .select("id,email,full_name,role,role_gender,enabled,manager_id,coordinator_type,coordinator_types,profile_needs_review,organization_member_id,created_at")
        .order("created_at", { ascending: false }),
      baseClient.from("manager_operator_assignments").select("manager_member_id,operator_member_id")
    ]);
    if (profilesResult.error) throw profilesResult.error;
    if (assignmentsResult.error) throw assignmentsResult.error;
    members = profilesResult.data || [];
    managerAssignments = assignmentsResult.data || [];
    const { data: requests, error: requestsError } = await baseClient.from("access_requests")
      .select("id,full_name,email,requested_role,requested_role_gender,requested_classifications,message,created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: true });
    if (requestsError) throw requestsError;
    accessRequests = requests || [];
    setState("Cadastros atualizados", "ok");
  }

  function renderAccessRequests() {
    const root = $("#access-requests");
    if (!root) return;
    const badge = $("#access-requests-count");
    if (badge) {
      badge.hidden = accessRequests.length === 0;
      badge.textContent = String(accessRequests.length);
    }
    root.innerHTML = accessRequests.length ? accessRequests.map((request) => {
      const classificacoes = (request.requested_classifications || [])
        .map((entry) => TYPE_LABELS[entry] || entry).join(" · ");
      const quando = new Date(request.created_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
      return `<article class="admin-row access-request-row" data-request-id="${escapeHtml(request.id)}">
        <div class="admin-row-identity">
          <strong>${escapeHtml(request.full_name)}</strong>
          <span>${escapeHtml(request.email)}</span>
          <i>Pedido em ${escapeHtml(quando)}</i>
        </div>
        <label><span>Função</span><select data-request-role>${Object.entries(ROLE_LABELS)
          .filter(([value]) => value !== "editor")
          .map(([value, label]) => `<option value="${value}" ${request.requested_role === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
        <label><span>Tratamento</span>${genderSelectMarkup(request.requested_role_gender, "requestGender")}</label>
        <label><span>Classificação pedida</span><strong class="access-request-value">${escapeHtml(classificacoes || "—")}</strong></label>
        ${request.message ? `<label><span>Mensagem</span><p class="access-request-message">${escapeHtml(request.message)}</p></label>` : "<span></span>"}
        <div class="admin-row-actions">
          <button class="button button-secondary" type="button" data-request-action="approve">Aprovar</button>
          <button class="button button-ghost" type="button" data-request-action="reject">Recusar</button>
          <span class="auth-feedback"></span>
        </div>
      </article>`;
    }).join("") : emptyMarkup("Nenhuma solicitação aguardando decisão.");

    $$(".access-request-row", root).forEach((row) => {
      const feedback = $(".auth-feedback", row);
      row.addEventListener("click", async (event) => {
        const button = event.target.closest("[data-request-action]");
        if (!button) return;
        const approving = button.dataset.requestAction === "approve";
        if (!approving && !confirm("Recusar esta solicitação? Ela não poderá ser reaberta.")) return;
        $$("[data-request-action]", row).forEach((item) => { item.disabled = true; });
        feedback.textContent = approving ? "Criando conta…" : "Recusando…";
        const { error } = approving
          ? await baseClient.rpc("approve_access_request", {
              p_request_id: row.dataset.requestId,
              p_role: $("[data-request-role]", row).value,
              p_classifications: null,
              p_role_gender: $("[name='requestGender']", row).value || null
            })
          : await baseClient.rpc("reject_access_request", { p_request_id: row.dataset.requestId, p_note: "" });
        if (error) {
          feedback.textContent = error.message;
          $$("[data-request-action]", row).forEach((item) => { item.disabled = false; });
          return;
        }
        showToast(approving ? "Conta criada. A pessoa já pode entrar com a senha que escolheu." : "Solicitação recusada.");
        await loadAdminData();
        renderAccessRequests();
        renderAdminUsers();
        renderOrgChart();
      });
    });
  }

  function hierarchyRole(role) {
    if (role === "executive_manager") return { roles: ["manager"], label: "Gerentes sob gestão" };
    if (role === "manager") return { roles: ["coordinator", "specialist"], label: "Coordenadores e Especialistas sob gestão" };
    return null;
  }

  function subordinateOptions(role, supervisorId = "") {
    const hierarchy = hierarchyRole(role);
    if (!hierarchy) return "";
    const supervisor = members.find((profile) => profile.id === supervisorId);
    const assignedOperatorIds = new Set(managerAssignments
      .filter((assignment) => assignment.manager_member_id === supervisor?.organization_member_id)
      .map((assignment) => assignment.operator_member_id));
    return members
      .filter((profile) => hierarchy.roles.includes(profile.role) && profile.enabled && profile.id !== supervisorId)
      .sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email, "pt-BR"))
      .map((profile) => {
        const selected = role === "manager"
          ? assignedOperatorIds.has(profile.organization_member_id)
          : profile.manager_id === supervisorId;
        return `<option value="${profile.id}" ${selected ? "selected" : ""}>${escapeHtml(profile.full_name || profile.email)} · ${escapeHtml(profileRoleLabel(profile))}</option>`;
      })
      .join("");
  }

  function selectedIds(select) {
    return Array.from(select?.selectedOptions || [], (option) => option.value).filter(Boolean);
  }

  // "Não informado" continua valendo: cai na forma masculina, sem inventar
  // tratamento para os perfis cadastrados antes deste campo existir.
  function genderSelectMarkup(current, name = "roleGender") {
    const options = [["", "Não informado"], ["masculine", "Masculino"], ["feminine", "Feminino"]]
      .map(([value, label]) => `<option value="${value}" ${(current || "") === value ? "selected" : ""}>${label}</option>`)
      .join("");
    return `<select name="${name}">${options}</select>`;
  }

  function allowsManyClassifications(role) {
    return !SINGLE_CLASSIFICATION_ROLES.includes(role);
  }

  // Editor administra o sistema e nao responde por classificacao alguma.
  function hasClassification(role) {
    return role !== "editor";
  }

  function profileClassifications(profile) {
    if (!hasClassification(profile?.role)) return [];
    const list = Array.isArray(profile?.coordinator_types) ? profile.coordinator_types : [];
    const known = list.filter((entry) => CLASSIFICATION_ORDER.includes(entry));
    if (known.length) return CLASSIFICATION_ORDER.filter((entry) => known.includes(entry));
    return profile?.coordinator_type ? [profile.coordinator_type] : ["infrastructure"];
  }

  // Coordenador e Especialista respondem por uma unica classificacao, para que o
  // intervalo criado por eles nunca fique ambiguo. As demais funcoes acumulam.
  function classificationFieldMarkup(role, selected, required = false) {
    const many = allowsManyClassifications(role);
    const chosen = many ? selected : selected.slice(0, 1);
    const options = CLASSIFICATION_ORDER
      .map((value) => `<option value="${value}" ${chosen.includes(value) ? "selected" : ""}>${escapeHtml(TYPE_LABELS[value])}</option>`)
      .join("");
    return `<span>${many ? "Classificações" : "Classificação"}${required ? " *" : ""}</span><select name="classification" required ${many ? 'multiple size="3"' : ""}>${options}</select>${many ? '<small class="field-help">Selecione uma ou mais. No computador, use Ctrl para combinar.</small>' : ""}`;
  }

  function selectedClassifications(form) {
    const select = form.classification;
    const chosen = select?.multiple ? selectedIds(select) : [select?.value].filter(Boolean);
    return CLASSIFICATION_ORDER.filter((entry) => chosen.includes(entry));
  }

  function refreshClassificationField(form, fallback, required = false) {
    const field = $("[data-classification-field]", form);
    if (!field) return;
    const previous = selectedClassifications(form);
    const selected = previous.length ? previous : fallback;
    // O campo e removido do DOM para o Editor: um select required apenas
    // escondido continua participando da validacao e travaria o envio.
    field.hidden = !hasClassification(form.role.value);
    field.innerHTML = field.hidden ? "" : classificationFieldMarkup(form.role.value, selected, required);
  }

  function classificationChips(profile) {
    return profileClassifications(profile)
      .map((entry) => `<i class="org-chip org-chip-${entry}">${escapeHtml(TYPE_LABELS[entry])}</i>`)
      .join("");
  }

  function extraManagerNames(profile) {
    if (!SINGLE_CLASSIFICATION_ROLES.includes(profile.role) || !profile.organization_member_id) return [];
    const primary = members.find((candidate) => candidate.id === profile.manager_id);
    return managerAssignments
      .filter((assignment) => assignment.operator_member_id === profile.organization_member_id)
      .map((assignment) => members.find((candidate) => candidate.organization_member_id === assignment.manager_member_id))
      .filter((manager) => manager && manager.organization_member_id !== primary?.organization_member_id)
      .map((manager) => manager.full_name || manager.email);
  }

  function orgCardMarkup(profile, directCount, alsoResponsible) {
    const chips = classificationChips(profile);
    const details = [
      directCount ? `<b>${directCount}</b> subordinado${directCount > 1 ? "s" : ""} direto${directCount > 1 ? "s" : ""}` : "",
      alsoResponsible?.length ? `Também responde por ${escapeHtml(alsoResponsible.join(", "))}` : ""
    ].filter(Boolean).join(" · ");
    const legend = [
      `${profile.full_name || "Sem nome"} · ${profile.email}`,
      extraManagerNames(profile).length ? `Também sob ${extraManagerNames(profile).join(", ")}` : ""
    ].filter(Boolean).join("\n");
    return `<article class="org-node ${profile.enabled ? "" : "is-disabled"}" data-role="${escapeHtml(profile.role)}" title="${escapeHtml(legend)}">
      <span class="org-node-role">${escapeHtml(profileRoleLabel(profile))}</span>
      <strong>${escapeHtml(profile.full_name || "Sem nome")}</strong>
      <span class="org-node-email">${escapeHtml(profile.email)}</span>
      ${chips ? `<span class="org-node-chips">${chips}</span>` : ""}
      ${details ? `<span class="org-node-meta">${details}</span>` : ""}
      ${profile.enabled ? "" : '<span class="org-node-flag">Conta inativa</span>'}
    </article>`;
  }

  // Um grupo reune os gestores que respondem exatamente pelo mesmo time. Eles
  // sao desenhados lado a lado e os subordinados aparecem uma unica vez abaixo
  // do grupo, em vez de um card repetido por gestor.
  function orgGroupMarkup(group) {
    const heads = group.heads.map((head) =>
      orgCardMarkup(head.profile, head.directCount, head.alsoResponsible)).join("");
    const isShared = group.heads.length > 1;
    return `<li>
      ${isShared
        ? `<div class="org-coheads"><span class="org-coheads-label">Gestão compartilhada</span><div class="org-coheads-cards">${heads}</div></div>`
        : heads}
      ${group.children.length ? `<ul>${group.children.map(orgGroupMarkup).join("")}</ul>` : ""}
    </li>`;
  }

  function renderOrgChart() {
    const root = $("#admin-org-chart");
    if (!root) return;
    // O Editor administra o sistema e nao ocupa posicao na hierarquia.
    const ranked = members.filter((profile) => profile.role !== "editor");
    const byId = new Map(ranked.map((profile) => [profile.id, profile]));
    const byMemberId = new Map(ranked
      .filter((profile) => profile.organization_member_id)
      .map((profile) => [profile.organization_member_id, profile]));
    const rank = (profile) => {
      const position = ORG_ROLE_ORDER.indexOf(profile.role);
      return position === -1 ? ORG_ROLE_ORDER.length : position;
    };
    const byName = (a, b) => rank(a) - rank(b)
      || (a.full_name || a.email).localeCompare(b.full_name || b.email, "pt-BR");

    // Time de cada Gerente, vindo dos vinculos; quem nao tem vinculo cai no
    // gestor primario, para nao sumir do organograma.
    const teamByManager = new Map();
    const addToTeam = (managerId, operatorId) => {
      if (!teamByManager.has(managerId)) teamByManager.set(managerId, new Set());
      teamByManager.get(managerId).add(operatorId);
    };
    managerAssignments.forEach((assignment) => {
      const manager = byMemberId.get(assignment.manager_member_id);
      const operator = byMemberId.get(assignment.operator_member_id);
      if (manager && operator) addToTeam(manager.id, operator.id);
    });
    ranked.forEach((profile) => {
      if (!SINGLE_CLASSIFICATION_ROLES.includes(profile.role)) return;
      const linked = [...teamByManager.values()].some((team) => team.has(profile.id));
      if (linked || !profile.manager_id || !byId.has(profile.manager_id)) return;
      addToTeam(profile.manager_id, profile.id);
    });

    const childrenOf = (profile) => {
      const team = teamByManager.get(profile.id);
      if (team?.size) return [...team].map((id) => byId.get(id)).filter(Boolean);
      return ranked.filter((candidate) => candidate.manager_id === profile.id);
    };

    // Cada operador entra no organograma uma unica vez: o primeiro grupo que o
    // reivindica o desenha, e os demais gestores dele viram texto no card.
    const claimed = new Set();
    const buildGroups = (siblings) => {
      const groups = [];
      const byTeamKey = new Map();
      siblings.slice().sort(byName).forEach((profile) => {
        const team = teamByManager.get(profile.id);
        const key = team?.size ? [...team].sort().join("|") : null;
        const head = { profile, directCount: team?.size || childrenOf(profile).length, alsoResponsible: [] };
        if (key && byTeamKey.has(key)) { byTeamKey.get(key).heads.push(head); return; }
        const group = { heads: [head], children: [], key };
        if (key) byTeamKey.set(key, group);
        groups.push(group);
      });

      groups.forEach((group) => {
        const owned = childrenOf(group.heads[0].profile)
          .filter((child) => !claimed.has(child.id));
        const taken = childrenOf(group.heads[0].profile)
          .filter((child) => claimed.has(child.id))
          .map((child) => child.full_name || child.email);
        if (taken.length) group.heads.forEach((head) => { head.alsoResponsible = taken; });
        owned.forEach((child) => claimed.add(child.id));
        group.children = buildGroups(owned);
      });
      return groups;
    };

    const roots = ranked.filter((profile) => !profile.manager_id || !byId.has(profile.manager_id));
    roots.forEach((profile) => claimed.add(profile.id));
    const tree = buildGroups(roots);
    root.innerHTML = tree.length
      ? `<ul class="org-tree">${tree.map(orgGroupMarkup).join("")}</ul>`
      : emptyMarkup("Nenhum perfil cadastrado.");
  }

  function updateCreateHierarchyFields() {
    const form = $("#admin-user-form");
    const hierarchy = hierarchyRole(form.role.value);
    const field = $("[data-subordinates-field]", form);
    field.hidden = !hierarchy;
    $("[data-subordinates-label]", field).textContent = hierarchy?.label || "Subordinados diretos";
    form.subordinateIds.innerHTML = subordinateOptions(form.role.value);
    refreshClassificationField(form, ["infrastructure"], true);
  }

  function renderAdminUsers() {
    const query = $("#user-search").value.trim().toLocaleLowerCase("pt-BR");
    const rows = members.filter((profile) => !query || `${profile.full_name} ${profile.email}`.toLocaleLowerCase("pt-BR").includes(query));
    $("#admin-users").innerHTML = rows.length ? rows.map((profile) => {
      const hierarchy = hierarchyRole(profile.role);
      return `<form class="admin-row user-admin-row" data-user-id="${profile.id}"><div class="admin-row-identity"><strong>${escapeHtml(profile.full_name || "Sem nome")}</strong><span>${escapeHtml(profile.email)}</span>${profile.profile_needs_review ? '<i>Cadastro precisa de revisão</i>' : ""}</div><label><span>Nome</span><input name="fullName" value="${escapeHtml(profile.full_name)}" required maxlength="120"></label><label><span>Função</span><select name="role">${Object.entries(ROLE_LABELS).map(([value, label]) => `<option value="${value}" ${profile.role === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><label><span>Tratamento</span>${genderSelectMarkup(profile.role_gender)}</label><label data-classification-field ${hasClassification(profile.role) ? "" : "hidden"}>${hasClassification(profile.role) ? classificationFieldMarkup(profile.role, profileClassifications(profile)) : ""}</label><label data-edit-subordinates class="admin-hierarchy-field" ${hierarchy ? "" : "hidden"}><span data-subordinates-label>${escapeHtml(hierarchy?.label || "Subordinados diretos")}</span><select name="subordinateIds" multiple size="4">${subordinateOptions(profile.role, profile.id)}</select></label><label class="admin-enabled"><span>Conta ativa</span><input name="enabled" type="checkbox" ${profile.enabled ? "checked" : ""} ${profile.id === currentUser.id ? "disabled" : ""}></label><div class="admin-row-actions"><button class="button button-ghost" type="submit">Salvar</button><span class="auth-feedback"></span></div></form>`;
    }).join("") : emptyMarkup("Nenhuma conta corresponde à busca.");
    $$(".user-admin-row").forEach((form) => {
      const profile = members.find((candidate) => candidate.id === form.dataset.userId);
      const updateHierarchyFields = () => {
        const hierarchy = hierarchyRole(form.role.value);
        const field = $("[data-edit-subordinates]", form);
        field.hidden = !hierarchy;
        $("[data-subordinates-label]", field).textContent = hierarchy?.label || "Subordinados diretos";
        form.subordinateIds.innerHTML = subordinateOptions(form.role.value, form.dataset.userId);
        refreshClassificationField(form, profileClassifications(profile));
      };
      form.role.addEventListener("change", updateHierarchyFields);
      form.addEventListener("submit", async (event) => {
        event.preventDefault(); const feedback = $(".auth-feedback", form);
        feedback.textContent = "Salvando…";
        const classifications = selectedClassifications(form);
        if (hasClassification(form.role.value) && !classifications.length) {
          feedback.textContent = "Selecione ao menos uma classificação."; return;
        }
        const { error } = await baseClient.rpc("update_site_user_profile", {
          p_target_user_id: form.dataset.userId,
          p_full_name: form.fullName.value.trim(),
          p_role: form.role.value,
          p_enabled: form.enabled.disabled ? true : form.enabled.checked,
          p_subordinate_ids: hierarchyRole(form.role.value) ? selectedIds(form.subordinateIds) : [],
          p_classifications: classifications,
          p_role_gender: form.roleGender.value || null
        });
        if (error) { feedback.textContent = error.message; return; }
        feedback.textContent = "Salvo."; await loadAdminData(); renderAdminUsers(); renderOrgChart();
      });
    });
  }

  async function initializeAdmin() {
    await loadAdminData();
    updateCreateHierarchyFields();
    $("#admin-user-form").role.addEventListener("change", updateCreateHierarchyFields);
    renderAdminUsers();
    renderOrgChart();
    renderAccessRequests();
    $("#user-search").addEventListener("input", renderAdminUsers);
    $("#admin-user-form").addEventListener("submit", async (event) => {
      event.preventDefault(); const form = event.currentTarget; const feedback = $("#admin-user-feedback");
      const classifications = selectedClassifications(form);
      if (hasClassification(form.role.value) && !classifications.length) {
        feedback.textContent = "Selecione ao menos uma classificação."; return;
      }
      feedback.textContent = "Criando conta…";
      const { data, error } = await baseClient.functions.invoke("create-site-user", { body: { fullName: form.fullName.value.trim(), email: form.email.value.trim(), password: form.password.value, role: form.role.value, classifications, roleGender: form.roleGender.value || null, subordinateIds: hierarchyRole(form.role.value) ? selectedIds(form.subordinateIds) : [] } });
      if (error || data?.error) { feedback.textContent = data?.error || error.message; return; }
      feedback.textContent = "Conta criada e habilitada."; form.reset(); form.role.value = "coordinator"; await loadAdminData(); updateCreateHierarchyFields(); renderAdminUsers(); renderOrgChart(); renderAccessRequests();
    });
  }

  const AUDIT_PAGE_LABELS = {
    planning: "Planejamento", execution: "Execução", dashboard: "Dashboard",
    management: "Gestão", admin: "Administração", audit: "Auditoria", account: "Minha conta"
  };

  async function registerSiteAccess() {
    const page = document.body.dataset.page || "desconhecida";
    const { error } = await baseClient.from("site_access_audit").insert({
      user_id: currentUser.id,
      email: actualProfile.email,
      page
    });
    if (error) console.warn("Não foi possível registrar o acesso.", error);
  }

  function auditRowMarkup(access, profileNames) {
    const timestamp = new Date(access.accessed_at);
    const userName = profileNames.get(access.user_id) || (access.user_id ? "Nome não disponível" : "Usuário removido");
    return `<tr><td><strong>${escapeHtml(userName)}</strong></td><td>${escapeHtml(access.email)}</td><td>${escapeHtml(AUDIT_PAGE_LABELS[access.page] || access.page)}</td><td><time datetime="${escapeHtml(access.accessed_at)}">${escapeHtml(timestamp.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "medium" }))}</time></td></tr>`;
  }

  function auditRequestMarkup(request) {
    const timestamp = new Date(request.created_at);
    return `<article class="chart-card audit-request-item"><header><strong>${escapeHtml(request.requester_email)}</strong><time datetime="${escapeHtml(request.created_at)}">${escapeHtml(timestamp.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "medium" }))}</time></header><p>${escapeHtml(request.message)}</p></article>`;
  }

  async function loadAuditAccesses() {
    const button = $("#audit-refresh");
    if (button) { button.disabled = true; button.textContent = "Atualizando…"; }
    setState("Atualizando auditoria…", "syncing");
    try {
      const [accessResult, requestResult, profileResult] = await Promise.all([
        baseClient.from("site_access_audit")
          .select("id,user_id,email,page,accessed_at")
          .order("accessed_at", { ascending: false })
          .limit(100),
        baseClient.from("profile_change_requests")
          .select("id,requester_email,message,created_at")
          .order("created_at", { ascending: false }),
        baseClient.from("user_profiles")
          .select("id,full_name,role")
      ]);
      if (accessResult.error) throw accessResult.error;
      if (requestResult.error) throw requestResult.error;
      if (profileResult.error) throw profileResult.error;
      const accesses = accessResult.data || [];
      const requests = requestResult.data || [];
      const profileNames = new Map((profileResult.data || []).map((profile) => [profile.id, profile.full_name || "Nome não informado"]));
      const profileRoles = new Map((profileResult.data || []).map((profile) => [profile.id, profile.role]));
      const visibleAccesses = accesses.filter((access) => access.user_id !== currentUser.id && profileRoles.get(access.user_id) !== "editor");
      $("#audit-accesses").innerHTML = visibleAccesses.map((access) => auditRowMarkup(access, profileNames)).join("");
      $("#audit-empty").hidden = visibleAccesses.length > 0;
      $("#audit-change-requests").innerHTML = requests.map(auditRequestMarkup).join("");
      $("#audit-requests-empty").hidden = requests.length > 0;
      const refreshedAt = new Date();
      $("#audit-last-updated").dateTime = refreshedAt.toISOString();
      $("#audit-last-updated").textContent = refreshedAt.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "medium" });
      setState("Auditoria atualizada", "ok");
    } catch (error) {
      console.error("Falha ao atualizar auditoria.", error);
      setState("Erro ao atualizar", "error");
      showToast("Não foi possível atualizar os acessos.");
    } finally {
      if (button) { button.disabled = false; button.textContent = "Atualizar agora"; }
    }
  }

  async function initializeAudit() {
    await loadAuditAccesses();
    $("#audit-refresh").addEventListener("click", loadAuditAccesses);
    setInterval(() => { if (!document.hidden) loadAuditAccesses(); }, 15000);
  }

  async function initialize() {
    initializeTheme();
    if (!window.supabase?.createClient) throw new Error("Biblioteca de dados indisponível.");
    baseClient = createClient();
    const { data: { session }, error: sessionError } = await window.AppStartup.wait(baseClient.auth.getSession());
    if (sessionError) throw sessionError;
    currentUser = session?.user;
    if (!currentUser) { location.replace("login.html"); return; }
    const { data: profile, error } = await baseClient.from("user_profiles").select("id,email,full_name,role,role_gender,enabled,manager_id,coordinator_type,organization_member_id").eq("id", currentUser.id).single();
    if (error) throw error;
    if (!profile?.enabled) { await window.AppStartup.wait(baseClient.auth.signOut({ scope: "local" })); location.replace("login.html?status=disabled"); return; }
    actualProfile = profile;
    configureContext();
    if (!roleCapabilities(effectiveProfile.role).canUseManagement) { location.replace("conta.html"); return; }
    renderNavigation(effectiveProfile.role);
    registerSiteAccess().catch((error) => console.warn("Não foi possível registrar o acesso.", error));
    if (document.body.dataset.page === "intervals") {
      // A visao do sistema inteiro e do Editor: a RLS ja devolve todos os
      // intervalos para ele, e para mais ninguem.
      if (actualProfile.role !== "editor") { location.replace("gestao.html"); return; }
      await initializeIntervals();
    } else if (["admin", "audit"].includes(document.body.dataset.page)) {
      if (actualProfile.role !== "editor") { location.replace("gestao.html"); return; }
      if (document.body.dataset.page === "admin") await initializeAdmin();
      else await initializeAudit();
    } else {
      // O Editor administra o sistema; a Gestao nao lhe cabe.
      if (actualProfile.role === "editor") { location.replace("admin.html"); return; }
      await initializeManagement();
    }
    document.documentElement.classList.remove("auth-checking");
    window.AppStartup.ready();
    window.EditorPageTransitions?.apply(actualProfile.role, currentUser.id);
  }

  initialize().catch((error) => {
    console.error("Falha ao inicializar portal.", error);
    setState("Erro ao carregar", "error");
    window.AppStartup.fail(error);
  });
})();
