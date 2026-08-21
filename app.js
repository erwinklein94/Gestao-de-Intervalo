(function () {
  "use strict";

  const STORAGE_KEY = "gestaoIntervaloRumo.v1";
  const OUTBOX_KEY = "gestaoIntervaloRumo.outbox";
  const DEVICE_KEY = "gestaoIntervaloRumo.deviceId";
  const THEME_KEY = "gestaoIntervaloRumo.theme";
  const SKIPPED_PREFIX = "[[ETAPA_NAO_EXECUTADA]]";
  const SUPABASE_URL = "https://rzsybguxlueorjpsstmu.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_sHHGnU3rob-unvk-_CCdcA_Ut4omY23";
  const page = document.body.dataset.page;
  let currentUser = null;
  let currentProfile = null;
  let activeStorageKey = window.__GESTAO_USER_ID__ ? `${STORAGE_KEY}.${window.__GESTAO_USER_ID__}` : STORAGE_KEY;
  let store = loadStore();
  let saveTimer;
  let toastTimer;
  let cloudClient = null;
  let cloudTimer;
  let cloudSyncing = false;
  let cloudSyncPending = false;
  let localRevision = 0;
  let pageInitialized = false;
  let pageRefreshHandler = null;
  let cloudRefreshRunning = false;
  let cloudRefreshTimer = null;
  let outbox = [];
  let deviceId = "";
  let syncRetryTimer = null;
  const dirtyPlanIds = new Set();
  const ROLE_LABELS = { director: "Diretor", executive_manager: "Gerente Executivo", consultant: "Consultor", manager: "Gerente", coordinator: "Coordenador", specialist: "Especialista", editor: "Editor" };
  const READ_ONLY_MANAGEMENT_ROLES = ["director", "executive_manager", "consultant", "manager"];
  function isOperatorRole(role) { return ["coordinator", "specialist"].includes(role); }

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function initializeTheme() {
    let theme = "light";
    try {
      theme = localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
    } catch (error) {
      console.warn("Não foi possível ler a preferência de tema.", error);
    }

    function applyTheme(nextTheme) {
      const isDark = nextTheme === "dark";
      document.documentElement.dataset.theme = isDark ? "dark" : "light";
      document.documentElement.style.colorScheme = isDark ? "dark" : "light";
      $$('[data-theme-toggle]').forEach((button) => {
        button.setAttribute("aria-pressed", String(isDark));
        button.setAttribute("aria-label", isDark ? "Ativar tema claro" : "Ativar tema escuro");
        $("span", button).textContent = isDark ? "☀" : "☾";
        $("b", button).textContent = isDark ? "Tema claro" : "Tema escuro";
      });
    }

    applyTheme(theme);
    $$('[data-theme-toggle]').forEach((button) => button.addEventListener("click", () => {
      theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(THEME_KEY, theme);
      } catch (error) {
        console.warn("Não foi possível salvar a preferência de tema.", error);
      }
      applyTheme(theme);
    }));
  }

  function uid() {
    return (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function todayISO() {
    const now = new Date();
    const offset = now.getTimezoneOffset();
    return new Date(now.getTime() - offset * 60000).toISOString().slice(0, 10);
  }

  function blankStep() {
    return { id: uid(), name: "", plannedStart: "", plannedEnd: "", actualStart: "", actualEnd: "", actualNotes: "", executionStatus: "pending", skipReason: "" };
  }

  function blankPlan(title = "Novo plano") {
    return {
      id: uid(),
      title,
      serviceType: "",
      coordinator: isOperatorRole(currentProfile?.role) ? (currentProfile.full_name || "") : "",
      date: todayISO(),
      location: "",
      windowStart: "",
      windowEnd: "",
      notes: "",
      executionNotes: "",
      locked: false,
      lockedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ownerId: currentUser?.id || null,
      datasetId: null,
      coordinatorMemberId: isOperatorRole(currentProfile?.role) ? (currentProfile.organization_member_id || null) : null,
      managerMemberId: null,
      coordinatorType: currentProfile?.coordinator_type || null,
      status: "planning",
      completedAt: null,
      revision: 0,
      deletedStepIds: [],
      structureDirty: false,
      steps: [blankStep()]
    };
  }

  function examplePlan() {
    const created = new Date().toISOString();
    return {
      id: uid(),
      title: "Exemplo — Renovação de linha km 141+150",
      serviceType: "Renovação de linha",
      coordinator: "Coordenação de Via Permanente",
      date: todayISO(),
      location: "Linha Tronco — km 141+150",
      windowStart: "08:00",
      windowEnd: "12:00",
      notes: "Plano demonstrativo para teste. Recursos previstos: equipe de via, equipamentos de pequeno porte e apoio operacional.",
      executionNotes: "Execução demonstrativa: primeira frente liberada e equipe reposicionada para manter o ritmo do intervalo.",
      locked: true,
      lockedAt: created,
      createdAt: created,
      updatedAt: created,
      isExample: true,
      deletedStepIds: [],
      structureDirty: false,
      steps: [
        { id: uid(), name: "DDS e liberação da frente de serviço", plannedStart: "08:00", plannedEnd: "08:15", actualStart: "08:02", actualEnd: "08:18", actualNotes: "DDS realizado com toda a equipe e frente liberada após confirmação da proteção." },
        { id: uid(), name: "Desmontagem da grade existente", plannedStart: "08:15", plannedEnd: "09:00", actualStart: "08:18", actualEnd: "09:08", actualNotes: "Grade desmontada; houve cinco minutos adicionais para reposicionamento do equipamento." },
        { id: uid(), name: "Regularização e preparação da plataforma", plannedStart: "09:00", plannedEnd: "09:45", actualStart: "09:08", actualEnd: "09:50", actualNotes: "Plataforma regularizada e liberada para o lançamento da nova grade." },
        { id: uid(), name: "Lançamento e posicionamento da nova grade", plannedStart: "09:45", plannedEnd: "10:40", actualStart: "09:50", actualEnd: "", actualNotes: "Atividade em andamento no exemplo." },
        { id: uid(), name: "Fixação, alinhamento e nivelamento", plannedStart: "10:40", plannedEnd: "11:30", actualStart: "", actualEnd: "", actualNotes: "" },
        { id: uid(), name: "Inspeção final e liberação da via", plannedStart: "11:30", plannedEnd: "12:00", actualStart: "", actualEnd: "", actualNotes: "" }
      ]
    };
  }

  function loadStore() {
    try {
      const parsed = JSON.parse(localStorage.getItem(activeStorageKey));
      if (parsed && Array.isArray(parsed.plans) && parsed.plans.length) {
        normalizeStore(parsed);
        if (!parsed.plans.some((plan) => plan.id === parsed.activePlanId)) parsed.activePlanId = parsed.plans[0].id;
        return parsed;
      }
    } catch (error) {
      console.warn("Não foi possível ler os dados locais.", error);
    }
    const first = blankPlan();
    return { version: 4, activePlanId: first.id, plans: [first], deletedPlanIds: [] };
  }

  function normalizePlan(plan) {
    plan.steps = Array.isArray(plan.steps) ? plan.steps : [];
    plan.executionNotes = plan.executionNotes || "";
    plan.deletedStepIds = Array.isArray(plan.deletedStepIds) ? plan.deletedStepIds : [];
    plan.structureDirty = Boolean(plan.structureDirty);
    plan.ownerId = plan.ownerId || null;
    plan.datasetId = plan.datasetId || null;
    plan.coordinatorMemberId = plan.coordinatorMemberId || null;
    plan.managerMemberId = plan.managerMemberId || null;
    delete plan.subId;
    plan.coordinatorType = plan.coordinatorType || null;
    plan.status = plan.status || "planning";
    plan.completedAt = plan.completedAt || null;
    plan.revision = Number.isFinite(Number(plan.revision)) ? Number(plan.revision) : 0;
    plan.steps.forEach((step) => {
      step.id = step.id || uid();
      step.name = step.name || "";
      step.plannedStart = step.plannedStart || step.start || "";
      step.plannedEnd = step.plannedEnd || step.end || "";
      step.actualStart = step.actualStart || "";
      step.actualEnd = step.actualEnd || "";
      const parsedNotes = parseStoredActualNotes(step.actualNotes || "");
      step.actualNotes = parsedNotes.notes;
      step.executionStatus = step.executionStatus === "skipped" || parsedNotes.skipped ? "skipped" : step.executionStatus || "pending";
      step.skipReason = step.skipReason || parsedNotes.reason;
    });
  }

  function normalizeStore(candidate) {
    candidate.version = 4;
    candidate.deletedPlanIds = Array.isArray(candidate.deletedPlanIds) ? candidate.deletedPlanIds.map((item) => typeof item === "string" ? { clientId: item } : item) : [];
    candidate.plans.forEach(normalizePlan);
    return candidate;
  }

  function parseStoredActualNotes(raw) {
    const text = String(raw || "");
    if (!text.startsWith(SKIPPED_PREFIX)) return { skipped: false, reason: "", notes: text };
    const [statusLine, ...noteLines] = text.split("\n");
    return {
      skipped: true,
      reason: statusLine.slice(SKIPPED_PREFIX.length).trim(),
      notes: noteLines.join("\n").trim()
    };
  }

  function storedActualNotes(step) {
    if (step.executionStatus !== "skipped") return step.actualNotes || "";
    const statusLine = `${SKIPPED_PREFIX}${step.skipReason ? ` ${step.skipReason}` : ""}`;
    return step.actualNotes ? `${statusLine}\n${step.actualNotes}` : statusLine;
  }

  function writeStoreLocally() {
    localStorage.setItem(activeStorageKey, JSON.stringify(store));
  }

  function outboxStorageKey() {
    return currentUser ? `${OUTBOX_KEY}.${currentUser.id}` : OUTBOX_KEY;
  }

  function loadOutbox() {
    try {
      const parsed = JSON.parse(localStorage.getItem(outboxStorageKey()) || "[]");
      outbox = Array.isArray(parsed) ? parsed : [];
    } catch { outbox = []; }
    try {
      deviceId = localStorage.getItem(DEVICE_KEY) || uid();
      localStorage.setItem(DEVICE_KEY, deviceId);
    } catch { deviceId = uid(); }
  }

  function saveOutbox() {
    localStorage.setItem(outboxStorageKey(), JSON.stringify(outbox));
  }

  function setSyncState(label, state = "saved") {
    const node = $("#save-state");
    if (!node) return;
    node.textContent = label;
    node.dataset.syncState = state;
  }

  function selectPlan(planId) {
    if (!store.plans.some((plan) => plan.id === planId)) return false;
    store.activePlanId = planId;
    writeStoreLocally();
    return true;
  }

  function activePlan() {
    return store.plans.find((plan) => plan.id === store.activePlanId) || store.plans[0];
  }

  function persist(immediate = false) {
    const plan = activePlan();
    if (plan) plan.updatedAt = new Date().toISOString();
    store.pendingSync = Boolean(currentUser);
    if (plan) dirtyPlanIds.add(plan.id);
    localRevision += 1;
    writeStoreLocally();
    setSyncState(navigator.onLine ? "Salvo" : "Sem conexão", navigator.onLine ? "saved" : "offline");
    clearTimeout(saveTimer);
    saveTimer = null;
    if (immediate) scheduleCloudSync(true);
    else saveTimer = setTimeout(() => { saveTimer = null; scheduleCloudSync(false); }, 260);
  }

  function planToDatabase(plan) {
    return {
      database_id: plan.databaseId || null,
      user_id: plan.ownerId || currentUser.id,
      client_id: plan.id,
      title: plan.title || "",
      service_type: plan.serviceType || "",
      coordinator: plan.coordinator || "",
      interval_date: plan.date || null,
      location: plan.location || "",
      window_start: plan.windowStart || null,
      window_end: plan.windowEnd || null,
      planning_notes: plan.notes || "",
      execution_notes: plan.executionNotes || "",
      is_locked: Boolean(plan.locked),
      locked_at: plan.lockedAt || null,
      coordinator_member_id: plan.coordinatorMemberId || null,
      manager_member_id: plan.managerMemberId || null,
      sub_id: null,
      coordinator_type: plan.coordinatorType || null
    };
  }

  function stepsToDatabase(plan) {
    return plan.steps.map((step) => ({
      client_id: step.id,
      activity_name: step.name || "",
      planned_start: step.plannedStart || null,
      planned_end: step.plannedEnd || null,
      actual_start: step.actualStart || null,
      actual_end: step.actualEnd || null,
      actual_notes: storedActualNotes(step),
      status: step.executionStatus || "pending",
      skip_reason: step.skipReason || ""
    }));
  }

  function databaseToPlan(row) {
    return {
      id: row.client_id,
      databaseId: row.id,
      ownerId: row.user_id,
      datasetId: row.dataset_id,
      title: row.title,
      serviceType: row.service_type,
      coordinator: row.coordinator,
      date: row.interval_date || "",
      location: row.location,
      windowStart: (row.window_start || "").slice(0, 5),
      windowEnd: (row.window_end || "").slice(0, 5),
      notes: row.planning_notes,
      executionNotes: row.execution_notes,
      locked: row.is_locked,
      lockedAt: row.locked_at,
      isExample: row.is_example,
      coordinatorMemberId: row.coordinator_member_id,
      managerMemberId: row.manager_member_id,
      coordinatorType: row.coordinator_type,
      status: row.status || "planning",
      completedAt: row.completed_at,
      revision: Number(row.revision || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedStepIds: [],
      structureDirty: false,
      steps: (row.interval_steps || []).sort((a, b) => a.position - b.position).map((step) => {
        const parsedNotes = parseStoredActualNotes(step.actual_notes || "");
        return {
          id: step.client_id,
          databaseId: step.id,
          name: step.activity_name,
          plannedStart: (step.planned_start || "").slice(0, 5),
          plannedEnd: (step.planned_end || "").slice(0, 5),
          actualStart: (step.actual_start || "").slice(0, 5),
          actualEnd: (step.actual_end || "").slice(0, 5),
          actualNotes: parsedNotes.notes,
          executionStatus: step.status || (parsedNotes.skipped ? "skipped" : step.actual_end ? "completed" : step.actual_start ? "running" : "pending"),
          skipReason: step.skip_reason || parsedNotes.reason,
          revision: Number(step.revision || 0)
        };
      })
    };
  }

  function scheduleCloudSync(immediate = false) {
    if (!cloudClient || !currentUser) return;
    cloudSyncPending = true;
    if (cloudSyncing) return;
    clearTimeout(cloudTimer);
    cloudTimer = setTimeout(syncStoreToCloud, immediate ? 0 : 700);
  }

  function snapshotSignature(planPayload, stepsPayload) {
    const comparablePlan = { ...planPayload, database_id: null };
    return JSON.stringify([comparablePlan, stepsPayload]);
  }

  function enqueueDirtyPlans() {
    for (const planId of [...dirtyPlanIds]) {
      if (outbox.some((item) => item.planId === planId && item.state !== "done")) continue;
      const plan = store.plans.find((candidate) => candidate.id === planId);
      dirtyPlanIds.delete(planId);
      if (!plan) continue;
      const planPayload = planToDatabase(plan);
      const stepsPayload = stepsToDatabase(plan);
      outbox.push({
        type: "plan_sync", operationId: uid(), deviceId, planId,
        baseRevision: Number(plan.revision || 0), planPayload, stepsPayload,
        signature: snapshotSignature(planPayload, stepsPayload), attempts: 0,
        createdAt: new Date().toISOString(), state: "pending"
      });
    }
    saveOutbox();
  }

  async function syncStoreToCloud() {
    if (!cloudClient || !currentUser || cloudSyncing) return;
    if (!navigator.onLine) {
      setSyncState("Sem conexão", "offline");
      store.pendingSync = true;
      writeStoreLocally();
      return;
    }
    cloudSyncing = true;
    cloudSyncPending = false;
    clearTimeout(syncRetryTimer);
    setSyncState("Sincronizando", "syncing");
    try {
      if (store.deletedPlanIds?.length) {
        for (const deleted of [...store.deletedPlanIds]) {
          let request = cloudClient.from("interval_plans").delete();
          request = deleted.databaseId ? request.eq("id", deleted.databaseId) : request.eq("client_id", deleted.clientId).eq("user_id", deleted.ownerId || currentUser.id);
          const { error } = await request;
          if (error) throw error;
          store.deletedPlanIds = store.deletedPlanIds.filter((item) => item !== deleted);
          writeStoreLocally();
        }
      }

      enqueueDirtyPlans();
      while (outbox.length) {
        const item = outbox[0];
        if (item.state === "conflict") throw new Error("SYNC_CONFLICT_LOCAL");
        item.state = "syncing";
        item.attempts = Number(item.attempts || 0) + 1;
        saveOutbox();
        if (item.type === "comment_create") {
          const localPlan = store.plans.find((candidate) => candidate.id === item.planId);
          item.payload.plan_id ||= localPlan?.databaseId || null;
          item.payload.dataset_id ||= localPlan?.datasetId || null;
          if (!item.payload.plan_id) { item.state = "pending"; saveOutbox(); throw new Error("PLAN_AWAITING_SYNC"); }
          const { error } = await cloudClient.from("interval_comments").insert(item.payload);
          if (error && error.code !== "23505") { item.state = "pending"; saveOutbox(); throw error; }
          outbox.shift(); saveOutbox(); continue;
        }
        if (item.type === "comment_delete") {
          const { error } = await cloudClient.from("interval_comments").update({ deleted_at: item.deletedAt }).eq("id", item.commentId);
          if (error) { item.state = "pending"; saveOutbox(); throw error; }
          outbox.shift(); saveOutbox(); continue;
        }
        const { data, error } = await cloudClient.rpc("sync_interval_plan", {
          p_plan: item.planPayload,
          p_steps: item.stepsPayload,
          p_expected_revision: item.baseRevision,
          p_operation_id: item.operationId,
          p_device_id: item.deviceId
        });
        if (error) {
          if (/SYNC_CONFLICT|40001/.test(`${error.message} ${error.code}`)) {
            item.state = "conflict";
            saveOutbox();
            throw new Error("SYNC_CONFLICT_LOCAL");
          }
          item.state = "pending";
          saveOutbox();
          throw error;
        }
        const plan = store.plans.find((candidate) => candidate.id === item.planId);
        if (plan) {
          plan.databaseId = data.plan_id;
          plan.revision = Number(data.revision || plan.revision || 0);
          plan.status = data.status || plan.status;
          plan.deletedStepIds = [];
          plan.structureDirty = false;
          const latestPayload = planToDatabase(plan);
          const latestSteps = stepsToDatabase(plan);
          if (snapshotSignature(latestPayload, latestSteps) !== item.signature) dirtyPlanIds.add(plan.id);
        }
        outbox.shift();
        saveOutbox();
        enqueueDirtyPlans();
      }
      store.pendingSync = dirtyPlanIds.size > 0 || outbox.length > 0 || store.deletedPlanIds.length > 0;
      writeStoreLocally();
      setSyncState(store.pendingSync ? "Pendente de sincronização" : "Sincronizado", store.pendingSync ? "pending" : "saved");
    } catch (error) {
      console.error("Falha ao salvar no Supabase.", error);
      store.pendingSync = true;
      writeStoreLocally();
      const conflict = error.message === "SYNC_CONFLICT_LOCAL";
      setSyncState(conflict ? "Erro de sincronização" : navigator.onLine ? "Pendente de sincronização" : "Sem conexão", conflict ? "error" : navigator.onLine ? "pending" : "offline");
      showToast(conflict ? "Conflito detectado. A cópia local foi preservada para revisão." : "Sem confirmação do servidor. Os dados continuam salvos neste dispositivo.");
      if (!conflict && navigator.onLine) {
        const attempts = Math.max(1, Number(outbox[0]?.attempts || 1));
        syncRetryTimer = setTimeout(() => scheduleCloudSync(true), Math.min(30000, 1000 * 2 ** Math.min(attempts, 5)));
      }
    } finally {
      cloudSyncing = false;
      if (cloudSyncPending || dirtyPlanIds.size) {
        clearTimeout(cloudTimer);
        cloudTimer = setTimeout(syncStoreToCloud, 0);
      }
    }
  }

  function showToast(message) {
    const toast = $("#toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
  }

  function timeToMinutes(value) {
    if (!/^\d{2}:\d{2}$/.test(value || "")) return null;
    const [hours, minutes] = value.split(":").map(Number);
    return hours * 60 + minutes;
  }

  function formatMinutes(total) {
    if (!Number.isFinite(total)) return "—";
    const absolute = Math.abs(Math.round(total));
    const hours = Math.floor(absolute / 60);
    const minutes = absolute % 60;
    if (!hours) return `${minutes} min`;
    return `${hours}h ${String(minutes).padStart(2, "0")}min`;
  }

  function pluralize(count, singular, plural) {
    return `${count} ${count === 1 ? singular : plural}`;
  }

  function wholeMinutes(total) {
    if (!Number.isFinite(total)) return null;
    return total < 0 ? Math.ceil(total) : Math.floor(total);
  }

  function formatHoursMinutes(total) {
    if (!Number.isFinite(total)) return "—";
    const absolute = Math.abs(Math.round(total));
    return `${Math.floor(absolute / 60)}h ${String(absolute % 60).padStart(2, "0")}min`;
  }

  function absoluteToTime(total) {
    if (!Number.isFinite(total)) return "—";
    const normalized = ((Math.round(total) % 1440) + 1440) % 1440;
    return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
  }

  function absoluteToClock(total) {
    if (!Number.isFinite(total)) return "--:--:--";
    const totalSeconds = Math.floor(total * 60);
    const normalized = ((totalSeconds % 86400) + 86400) % 86400;
    const hours = Math.floor(normalized / 3600);
    const minutes = Math.floor((normalized % 3600) / 60);
    const clockSeconds = normalized % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(clockSeconds).padStart(2, "0")}`;
  }

  function bytesToBase64Url(bytes) {
    let binary = "";
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  async function sha256Hex(value) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function sharedUrl(token) {
    const url = new URL("acompanhar.html", location.href);
    url.searchParams.set("token", token);
    return url.href;
  }

  function nearestDay(raw, target) {
    if (raw == null || target == null) return raw;
    return [raw - 1440, raw, raw + 1440, raw + 2880].sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
  }

  function buildTimeline(plan) {
    const windowStart = timeToMinutes(plan.windowStart);
    let windowEnd = timeToMinutes(plan.windowEnd);
    if (windowStart != null && windowEnd != null && windowEnd <= windowStart) windowEnd += 1440;
    let previousStart = windowStart;
    const steps = plan.steps.map((step, index) => {
      let start = timeToMinutes(step.plannedStart);
      let end = timeToMinutes(step.plannedEnd);
      if (start != null && windowStart != null) {
        while (start < windowStart) start += 1440;
        if (previousStart != null && start + 720 < previousStart) start += 1440;
      }
      if (end != null && start != null) while (end <= start) end += 1440;
      if (start != null) previousStart = start;
      let actualStartMinutes = nearestDay(timeToMinutes(step.actualStart), start);
      let actualEndMinutes = nearestDay(timeToMinutes(step.actualEnd), end);
      if (actualStartMinutes != null && actualEndMinutes != null) {
        while (actualEndMinutes < actualStartMinutes) actualEndMinutes += 1440;
      }
      return {
        ...step,
        index,
        start,
        end,
        duration: start != null && end != null ? end - start : null,
        actualStartMinutes,
        actualEndMinutes,
        actualDuration: actualStartMinutes != null && actualEndMinutes != null ? actualEndMinutes - actualStartMinutes : null,
        skipped: step.executionStatus === "skipped"
      };
    });
    return { windowStart, windowEnd, duration: windowStart != null && windowEnd != null ? windowEnd - windowStart : null, steps };
  }

  function currentAbsolute(plan, timeline) {
    if (!plan.date || timeline.windowStart == null) return null;
    const startDate = new Date(`${plan.date}T00:00:00`);
    if (Number.isNaN(startDate.getTime())) return null;
    const absolute = (Date.now() - startDate.getTime()) / 60000;
    const lastPlannedEnd = timeline.windowEnd ?? Math.max(timeline.windowStart, ...timeline.steps.map((step) => step.end || timeline.windowStart));
    if (absolute < timeline.windowStart - 720) return null;
    if (absolute > lastPlannedEnd + 2160) return null;
    return absolute;
  }

  function isStepComplete(step) {
    return step.actualStartMinutes != null && step.actualEndMinutes != null;
  }

  function isStepSkipped(step) {
    return step.skipped || step.executionStatus === "skipped";
  }

  function isStepResolved(step) {
    return isStepComplete(step) || isStepSkipped(step);
  }

  function hasExecutionData(plan) {
    return Boolean(plan.executionNotes) || plan.steps.some((step) => step.actualStart || step.actualEnd || step.executionStatus === "skipped" || step.actualNotes);
  }

  function hasConcurrentExecution(timeline, nowAbs = null) {
    const intervals = timeline.steps
      .filter((step) => step.actualStartMinutes != null && !isStepSkipped(step))
      .map((step) => ({ start: step.actualStartMinutes, end: step.actualEndMinutes ?? nowAbs }))
      .filter((interval) => interval.end != null)
      .sort((a, b) => a.start - b.start);
    return intervals.some((interval, index) => index > 0 && interval.start < Math.max(...intervals.slice(0, index).map((previous) => previous.end)));
  }

  // Tempo corrido do intervalo em relógio, sem somar etapas concomitantes.
  // Enquanto houver execução aberta, mede do primeiro início real até agora.
  // Depois de encerrado, congela no último término real registrado.
  function intervalElapsedTime(timeline, nowAbs = null) {
    const executed = timeline.steps.filter((step) => !isStepSkipped(step) && step.actualStartMinutes != null);
    if (!executed.length) return { minutes: null, start: null, end: null, finished: false };

    const start = Math.min(...executed.map((step) => step.actualStartMinutes));
    const finished = timeline.steps.length > 0 && timeline.steps.every(isStepResolved);
    const completedEnds = timeline.steps
      .filter(isStepComplete)
      .map((step) => step.actualEndMinutes)
      .filter(Number.isFinite);
    const end = finished
      ? (completedEnds.length ? Math.max(...completedEnds) : null)
      : (nowAbs == null ? null : Math.max(start, nowAbs));

    return {
      minutes: end == null ? null : Math.max(0, end - start),
      start,
      end,
      finished
    };
  }

  // Desvio confirmado de UMA etapa. Uma etapa em andamento ainda não possui
  // término real: nesse estado, o marco comparável é o início. Isso evita que
  // uma frente aberta contamine o intervalo inteiro quando outras etapas podem
  // começar e avançar de forma concomitante.
  function stepScheduleDeviation(step, nowAbs = null) {
    if (isStepSkipped(step)) return null;
    if (isStepComplete(step) && step.end != null) return step.actualEndMinutes - step.end;
    if (step.actualStartMinutes != null && step.start != null) return step.actualStartMinutes - step.start;
    return null;
  }

  // Etapa que ainda não começou e já passou do horário planejado de início.
  // Não entra no saldo (a regra do saldo é o prazo final), mas precisa aparecer.
  function isStartOverdue(step, nowAbs) {
    return nowAbs != null && !isStepSkipped(step) && step.actualStartMinutes == null
      && step.start != null && nowAbs > step.start;
  }

  // Quanto da duração planejada uma etapa em andamento já consumiu.
  function stepDurationBurn(step, nowAbs) {
    if (nowAbs == null || isStepSkipped(step) || step.actualStartMinutes == null || step.actualEndMinutes != null) return null;
    const elapsed = Math.max(0, nowAbs - step.actualStartMinutes);
    const planned = step.duration != null ? step.duration : null;
    return { elapsed, planned, over: planned == null ? null : elapsed - planned };
  }

  // Fim planejado do trabalho que ainda faz parte do escopo. Etapas marcadas
  // como não executadas saem dos dois lados da conta (planejado e projetado),
  // para que retirar escopo não vire adiantamento fantasma.
  function plannedWorkEnd(timeline) {
    const ends = timeline.steps
      .filter((step) => !isStepSkipped(step))
      .map((step) => step.end)
      .filter((value) => Number.isFinite(value));
    if (!ends.length) return timeline.windowEnd;
    return Math.max(...ends);
  }

  function plannedOrder(step) {
    return step.index;
  }

  // Situação geral pelo marco mais avançado da sequência operacional. A ordem
  // não impede sobreposição nem exige que uma etapa termine para outra começar;
  // ela apenas define qual marco representa o avanço atual do cronograma.
  function operationalDeviation(timeline, nowAbs) {
    const completed = timeline.steps.filter(isStepComplete);
    if (timeline.steps.length && timeline.steps.every(isStepResolved)) {
      const finalEnds = completed.map((step) => step.actualEndMinutes).filter(Number.isFinite);
      const finalActualEnd = finalEnds.length ? Math.max(...finalEnds) : null;
      const plannedEnd = timeline.windowEnd ?? plannedWorkEnd(timeline);
      return { value: finalActualEnd == null || plannedEnd == null ? null : finalActualEnd - plannedEnd, type: "interval-complete", step: null };
    }

    const reached = timeline.steps
      .filter((step) => !isStepSkipped(step) && step.actualStartMinutes != null)
      .sort((a, b) => a.index - b.index);
    const frontier = reached.at(-1) || null;
    if (frontier) {
      return {
        value: stepScheduleDeviation(frontier, nowAbs),
        type: isStepComplete(frontier) ? "completed-milestone" : "active-start",
        step: frontier
      };
    }

    const firstPending = timeline.steps.find((step) => !isStepResolved(step));
    if (firstPending && nowAbs != null && firstPending.start != null && nowAbs > firstPending.start) {
      return { value: nowAbs - firstPending.start, type: "waiting-overdue", step: firstPending };
    }
    return { value: null, type: "not-started", step: firstPending || null };
  }

  // Projeta o termino de cada etapa e do intervalo inteiro.
  // Concluidas usam o realizado; em andamento assumem no minimo a duracao
  // planejada a partir do inicio real; pendentes herdam o encadeamento
  // planejado e nao podem comecar antes de agora.
  function executionProjection(plan, timeline) {
    const nowAbs = currentAbsolute(plan, timeline);
    const ordered = timeline.steps
      .filter((step) => !isStepSkipped(step))
      .slice()
      .sort((a, b) => plannedOrder(a) - plannedOrder(b) || a.index - b.index);

    const byStep = new Map();
    let chainEnd = null;
    let chainPlannedEnd = null;

    ordered.forEach((step) => {
      const duration = step.duration != null ? step.duration : 0;
      let projectedStart = null;
      let projectedEnd = null;
      let state = "pending";

      if (isStepComplete(step)) {
        state = "complete";
        projectedStart = step.actualStartMinutes;
        projectedEnd = step.actualEndMinutes;
      } else if (step.actualStartMinutes != null) {
        state = "running";
        projectedStart = step.actualStartMinutes;
        const naturalEnd = step.actualStartMinutes + duration;
        projectedEnd = nowAbs == null ? naturalEnd : Math.max(naturalEnd, nowAbs);
      } else if (step.start != null) {
        projectedStart = nowAbs == null ? step.start : Math.max(step.start, nowAbs);
        if (chainEnd != null && chainPlannedEnd != null && step.start >= chainPlannedEnd) {
          projectedStart = Math.max(projectedStart, chainEnd);
        }
        projectedEnd = projectedStart + duration;
      }

      byStep.set(step.id, { step, state, projectedStart, projectedEnd });

      if (Number.isFinite(projectedEnd)) chainEnd = chainEnd == null ? projectedEnd : Math.max(chainEnd, projectedEnd);
      if (Number.isFinite(step.end)) chainPlannedEnd = chainPlannedEnd == null ? step.end : Math.max(chainPlannedEnd, step.end);
    });

    const ends = Array.from(byStep.values()).map((entry) => entry.projectedEnd).filter((value) => Number.isFinite(value));
    const finished = timeline.steps.length > 0 && timeline.steps.every(isStepResolved);
    let projectedEnd = ends.length ? Math.max(...ends) : null;
    if (!finished && nowAbs != null && projectedEnd != null) projectedEnd = Math.max(projectedEnd, nowAbs);

    return { nowAbs, byStep, projectedEnd, finished };
  }

  // Situacao consolidada: quanto o intervalo INTEIRO esta atrasado em relacao
  // ao planejado, e quais etapas estao causando esse atraso.
  function executionStatus(plan, timeline) {
    const projection = executionProjection(plan, timeline);
    const nowAbs = projection.nowAbs;
    const steps = timeline.steps;

    const active = steps
      .filter((step) => step.actualStartMinutes != null && step.actualEndMinutes == null && !isStepSkipped(step))
      .sort((a, b) => a.actualStartMinutes - b.actualStartMinutes);
    const completed = steps.filter(isStepComplete);
    const skipped = steps.filter(isStepSkipped);
    const resolved = steps.filter(isStepResolved);
    const pending = steps.filter((step) => !isStepResolved(step) && step.actualStartMinutes == null);

    const measured = steps
      .filter((step) => !isStepSkipped(step))
      .map((step) => ({ step, deviation: stepScheduleDeviation(step, nowAbs) }))
      .filter((entry) => entry.deviation != null);

    // Só conta como atraso a partir de 1 minuto cheio, para o indicador não
    // oscilar por causa dos segundos que passam do horário programado.
    const isLate = (entry) => wholeMinutes(entry.deviation) > 0;
    const lateNow = measured
      .filter((entry) => isLate(entry) && !isStepComplete(entry.step))
      .sort((a, b) => b.deviation - a.deviation);
    const lateFinished = measured
      .filter((entry) => isLate(entry) && isStepComplete(entry.step))
      .sort((a, b) => b.deviation - a.deviation);
    const openMeasured = measured
      .filter((entry) => !isStepComplete(entry.step))
      .sort((a, b) => b.deviation - a.deviation);

    const critical = lateNow[0] || openMeasured[0] || null;
    const operational = operationalDeviation(timeline, nowAbs);
    const delay = nowAbs == null ? null : operational.value;

    // Projeção de relógio, usada nas previsões de término (não no saldo).
    const baseline = plannedWorkEnd(timeline);
    const projectedEnd = projection.projectedEnd;

    const started = completed.length > 0 || active.length > 0 || skipped.length > 0;
    return {
      projection, nowAbs, live: nowAbs != null, timeline,
      steps, active, pending, completed, skipped, resolved,
      measured, lateNow, lateFinished, critical,
      operational, baseline, projectedEnd, delay,
      started, finished: projection.finished
    };
  }

  // ---------------------------------------------------------------------------
  // Escala e marcações de hora da linha do tempo comparativa.
  // Escolhe um passo "redondo" (5, 10, 15, 30 min, 1h, 2h...) que caiba na
  // largura disponível, e alinha as marcas a horários cheios em vez de começar
  // no minuto quebrado do início da janela.
  // ---------------------------------------------------------------------------
  const TIMELINE_TICK_STEPS = [5, 10, 15, 20, 30, 60, 90, 120, 180, 240, 360, 720];

  function timelineScale(start, end, availablePx) {
    const span = Math.max(1, end - start);
    const usable = Number.isFinite(availablePx) && availablePx > 0 ? availablePx : 620;
    const maxLabels = Math.max(3, Math.min(16, Math.floor(usable / 52)));
    const step = TIMELINE_TICK_STEPS.find((value) => span / value <= maxLabels - 1) || TIMELINE_TICK_STEPS[TIMELINE_TICK_STEPS.length - 1];
    const ticks = [];
    for (let value = Math.ceil(start / step) * step; value <= end; value += step) ticks.push(value);
    if (!ticks.length) return { ticks: [start, end], step };
    // Mostra também as bordas reais quando elas não ficam coladas na primeira
    // ou na última marca redonda.
    if (ticks[0] - start > step * 0.45) ticks.unshift(start);
    if (end - ticks[ticks.length - 1] > step * 0.45) ticks.push(end);
    return { ticks, step };
  }

  // O eixo repete o mesmo grid das linhas do gráfico, para que as marcas fiquem
  // exatamente sobre as linhas de grade das faixas em qualquer largura.
  // Largura útil da faixa de barras. O gráfico pode ser montado com o container
  // ainda oculto (aba do acompanhamento compartilhado), quando clientWidth é 0;
  // nesse caso estima-se pela viewport em vez de cair num valor fixo.
  function timelineAvailablePx(host) {
    const hostWidth = host && host.clientWidth ? host.clientWidth : Math.max(320, window.innerWidth - 80);
    return hostWidth * (window.innerWidth <= 720 ? 0.95 : 0.57);
  }

  function timelineAxisHtml(ticks, start, span) {
    const labels = ticks.map((value) => {
      const percent = Math.max(0, Math.min(100, ((value - start) / span) * 100));
      const anchor = percent <= 1 ? "translateX(0)" : percent >= 99 ? "translateX(-100%)" : "translateX(-50%)";
      return `<span style="left:${percent}%;transform:${anchor}">${absoluteToTime(value)}</span>`;
    }).join("");
    return `<div class="timeline-axis" aria-hidden="true"><i></i><div class="timeline-axis-scale">${labels}</div><i></i></div>`;
  }

  // Linhas de grade desenhadas como gradiente, para não criar um elemento por
  // marca em cada uma das faixas do gráfico.
  function timelineGridStyle(ticks, start, span) {
    const line = "rgba(0,56,101,.13)";
    const stops = ["transparent 0"];
    ticks.forEach((value) => {
      const percent = Math.max(0, Math.min(100, ((value - start) / span) * 100));
      stops.push(`transparent calc(${percent}% - 1px)`, `${line} calc(${percent}% - 1px)`, `${line} ${percent}%`, `transparent ${percent}%`);
    });
    stops.push("transparent 100%");
    return `background-image:linear-gradient(90deg, ${stops.join(", ")})`;
  }

  // ---------------------------------------------------------------------------
  // Tooltip das barras da linha do tempo.
  // ---------------------------------------------------------------------------
  function timelineTipData(step, index, extra = {}) {
    const attrs = {
      "tip-key": `${step.id}:${extra.kind || "linha"}`,
      "tip-index": String(index + 1).padStart(2, "0"),
      "tip-name": step.name || `Etapa ${index + 1}`,
      "tip-planned": `${step.plannedStart || "—"} – ${step.plannedEnd || "—"}`,
      "tip-planned-duration": step.duration == null ? "" : formatMinutes(step.duration),
      "tip-actual": extra.actualText || "",
      "tip-actual-duration": extra.actualDurationText || "",
      "tip-status": extra.statusLabel || "",
      "tip-deviation": extra.deviationText || "",
      "tip-deviation-tone": extra.deviationTone || "",
      "tip-forecast": extra.forecastText || "",
      "tip-note": (step.actualNotes || step.skipReason || "").slice(0, 160),
      "tip-kind": extra.kind || ""
    };
    return Object.entries(attrs)
      .filter(([, value]) => value !== "" && value != null)
      .map(([key, value]) => `data-${key}="${escapeHtml(String(value))}"`)
      .join(" ");
  }

  function chartTooltipElement() {
    let tip = document.getElementById("chart-tooltip");
    if (!tip) {
      tip = document.createElement("div");
      tip.id = "chart-tooltip";
      tip.className = "chart-tooltip";
      tip.setAttribute("role", "tooltip");
      tip.hidden = true;
      document.body.appendChild(tip);
      document.addEventListener("click", (event) => {
        if (!pinnedChartTooltip) return;
        const clickedElement = event.target instanceof Element ? event.target : null;
        if (clickedElement?.closest("#chart-tooltip") || clickedElement?.closest("[data-tip-name]")) return;
        hideChartTooltip(true);
      });
    }
    return tip;
  }

  let pinnedChartTooltip = null;

  function hideChartTooltip(force = false) {
    if (pinnedChartTooltip && !force) return;
    const tip = document.getElementById("chart-tooltip");
    if (tip) {
      tip.hidden = true;
      tip.classList.remove("is-pinned");
      tip.setAttribute("role", "tooltip");
    }
    if (force) pinnedChartTooltip = null;
  }

  function cursorTimeForTooltip(target, clientX) {
    const track = target.closest("[data-track-start]");
    if (!track) return "";
    const rect = track.getBoundingClientRect();
    if (!rect.width) return "";
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const start = Number(track.dataset.trackStart);
    const span = Number(track.dataset.trackSpan);
    if (!Number.isFinite(start) || !Number.isFinite(span)) return "";
    return absoluteToTime(start + ratio * span);
  }

  function paintChartTooltip(target, clientX, clientY, pinned = false) {
    const tip = chartTooltipElement();
    const data = target.dataset;
    const row = (label, value, tone) => value
      ? `<div class="tip-row"><span>${label}</span><strong${tone ? ` class="tip-${tone}"` : ""}>${escapeHtml(value)}</strong></div>`
      : "";
    tip.innerHTML = `<div class="tip-head"><b>${escapeHtml(data.tipIndex || "")}</b><span>${escapeHtml(data.tipName || "")}</span>${
      data.tipKind ? `<i>${escapeHtml(data.tipKind)}</i>` : ""
    }</div>
      ${row("Programado", data.tipPlanned)}
      ${row("Duração programada", data.tipPlannedDuration)}
      ${row("Realizado", data.tipActual)}
      ${row("Duração realizada", data.tipActualDuration)}
      ${row("Situação", data.tipStatus)}
      ${row("Desvio", data.tipDeviation, data.tipDeviationTone)}
      ${row("Previsão de término", data.tipForecast)}
      ${row("Registro", data.tipNote)}
      ${(() => { const time = cursorTimeForTooltip(target, clientX); return time ? `<div class="tip-cursor">Cursor em ${escapeHtml(time)}</div>` : ""; })()}
      ${pinned ? '<div class="tip-pinned-hint">Fixado · clique fora para fechar</div>' : ""}`;
    tip.hidden = false;
    tip.classList.toggle("is-pinned", pinned);
    tip.setAttribute("role", pinned ? "dialog" : "tooltip");

    const rect = tip.getBoundingClientRect();
    const gap = 16;
    let left = clientX + gap;
    let top = clientY + gap;
    if (left + rect.width > window.innerWidth - 8) left = clientX - rect.width - gap;
    if (top + rect.height > window.innerHeight - 8) top = clientY - rect.height - gap;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, top)}px`;
  }

  function restorePinnedChartTooltip(container) {
    if (!pinnedChartTooltip || !container) return;
    const target = Array.from(container.querySelectorAll("[data-tip-key]"))
      .find((candidate) => candidate.dataset.tipKey === pinnedChartTooltip.key);
    if (!target) {
      hideChartTooltip(true);
      return;
    }
    const rect = target.getBoundingClientRect();
    paintChartTooltip(target, rect.left + rect.width / 2, rect.top, true);
  }

  function bindTimelineTooltip(container) {
    if (!container || container.dataset.tooltipBound === "1") return;
    container.dataset.tooltipBound = "1";
    chartTooltipElement();

    function handleMove(event) {
      if (pinnedChartTooltip) return;
      const target = event.target.closest("[data-tip-name]");
      if (!target) { hideChartTooltip(); return; }
      paintChartTooltip(target, event.clientX, event.clientY);
    }

    container.addEventListener("mousemove", handleMove);
    container.addEventListener("mouseleave", () => hideChartTooltip());
    container.addEventListener("click", (event) => {
      const target = event.target.closest("[data-tip-name]");
      if (!target) { hideChartTooltip(true); return; }
      const rect = target.getBoundingClientRect();
      pinnedChartTooltip = { key: target.dataset.tipKey };
      paintChartTooltip(target, rect.left + rect.width / 2, rect.top, true);
    });
    container.addEventListener("focusin", (event) => {
      if (pinnedChartTooltip) return;
      const target = event.target.closest("[data-tip-name]");
      if (!target) return;
      const rect = target.getBoundingClientRect();
      paintChartTooltip(target, rect.left + rect.width / 2, rect.bottom);
    });
    container.addEventListener("focusout", () => hideChartTooltip());
  }
  function stepLabel(step, fallbackIndex) {
    if (!step) return "Etapa";
    const position = step.index != null ? step.index : fallbackIndex || 0;
    return step.name || `Etapa ${position + 1}`;
  }

  function validatePlan(plan) {
    const timeline = buildTimeline(plan);
    const errors = [];
    const warnings = [];
    if (!plan.title.trim()) errors.push("informe o nome do plano");
    if (currentProfile?.role === "editor" && !plan.coordinatorMemberId) errors.push("selecione o Coordenador ou Especialista responsável");
    if (!plan.date) errors.push("informe a data");
    if (timeline.windowStart == null || timeline.windowEnd == null) errors.push("preencha a janela completa");
    if (plan.windowStart && plan.windowEnd && plan.windowStart === plan.windowEnd) errors.push("o início e o fim da janela não podem ser iguais");
    if (timeline.duration != null && timeline.duration > 720) warnings.push("a janela tem mais de 12 horas; confirme se atravessa a meia-noite");
    if (!plan.steps.length) errors.push("adicione ao menos uma etapa");
    timeline.steps.forEach((step, index) => {
      if (!step.name.trim() || step.start == null || step.end == null) errors.push(`complete a etapa ${index + 1}`);
      if (step.duration != null && step.duration > 720) errors.push(`a duração da etapa ${index + 1} supera 12 horas`);
      if (timeline.windowStart != null && step.start != null && step.start < timeline.windowStart) warnings.push(`a etapa ${index + 1} começa antes da janela`);
      if (timeline.windowEnd != null && step.end != null && step.end > timeline.windowEnd) errors.push(`a etapa ${index + 1} termina após a janela`);
      if (index > 0) {
        const previous = timeline.steps[index - 1];
        if (previous.end != null && step.start != null) {
          if (step.start < previous.end) warnings.push(`as etapas ${index} e ${index + 1} estão planejadas de forma concomitante`);
          else if (step.start > previous.end) warnings.push(`há ${formatMinutes(step.start - previous.end)} de folga antes da etapa ${index + 1}`);
        }
      }
    });
    return { valid: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)], timeline };
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function escapeXml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  }

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

  async function exportPlanToXlsx(plan) {
    if (typeof JSZip === "undefined") throw new Error("Gerador de Excel indisponível");
    const timeline = buildTimeline(plan);
    const headers = ["#", "Atividade", "Início programado", "Fim programado", "Duração programada (min)", "Início realizado", "Fim realizado", "Duração realizada (min)", "Desvio no cronograma (min)", "Situação", "O que foi realizado"];
    const nowAbs = currentAbsolute(plan, timeline);
    const dataRows = timeline.steps.map((step, index) => {
      const difference = stepScheduleDeviation(step, nowAbs);
      const roundedDifference = wholeMinutes(difference);
      const status = isStepSkipped(step)
        ? "Não executada"
        : isStepComplete(step)
        ? roundedDifference > 0 ? "Atrasado" : roundedDifference < 0 ? "Adiantado" : "No horário"
        : step.actualStartMinutes != null
          ? roundedDifference > 0 ? "Em andamento - atrasado" : roundedDifference < 0 ? "Em andamento - adiantado" : "Em andamento"
          : roundedDifference > 0 ? "Início atrasado" : "Aguardando";
      return [index + 1, step.name, step.plannedStart, step.plannedEnd, step.duration, step.actualStart, step.actualEnd, step.actualDuration, roundedDifference, status, step.actualNotes || step.skipReason];
    });
    const rows = [];
    rows.push(`<row r="1" ht="30" customHeight="1">${excelCell(1, 1, "GESTÃO DE INTERVALO — PROGRAMADO X REALIZADO", 1)}</row>`);
    rows.push(`<row r="2" ht="8" customHeight="1"></row>`);
    rows.push(`<row r="3">${excelCell(1, 3, "Nome do plano", 3)}${excelCell(4, 3, plan.title, 5)}${excelCell(7, 3, "Data", 3)}${excelCell(9, 3, plan.date, 5)}</row>`);
    rows.push(`<row r="4">${excelCell(1, 4, "Tipo de serviço", 3)}${excelCell(4, 4, plan.serviceType, 5)}${excelCell(7, 4, "Janela", 3)}${excelCell(9, 4, `${plan.windowStart || "—"}–${plan.windowEnd || "—"}`, 5)}</row>`);
    rows.push(`<row r="5">${excelCell(1, 5, "Responsável", 3)}${excelCell(4, 5, plan.coordinator, 5)}${excelCell(7, 5, "Local / trecho", 3)}${excelCell(9, 5, plan.location, 5)}</row>`);
    rows.push(`<row r="6" ht="34" customHeight="1">${excelCell(1, 6, "Observações do planejamento", 3)}${excelCell(4, 6, plan.notes, 9)}</row>`);
    rows.push(`<row r="7" ht="34" customHeight="1">${excelCell(1, 7, "Registro geral da execução", 3)}${excelCell(4, 7, plan.executionNotes, 9)}</row>`);
    rows.push(`<row r="8" ht="8" customHeight="1"></row>`);
    rows.push(`<row r="9" ht="28" customHeight="1">${headers.map((header, index) => excelCell(index + 1, 9, header, 4)).join("")}</row>`);
    dataRows.forEach((values, index) => {
      const rowNumber = index + 10;
      const normalizedStatus = String(values[9]).toLowerCase();
      const statusStyle = normalizedStatus.includes("atras") ? 7 : normalizedStatus.includes("adiant") || normalizedStatus === "no horário" ? 6 : 8;
      rows.push(`<row r="${rowNumber}" ht="32" customHeight="1">${values.map((value, columnIndex) => excelCell(columnIndex + 1, rowNumber, value, columnIndex === 9 ? statusStyle : columnIndex === 1 || columnIndex === 10 ? 9 : 5)).join("")}</row>`);
    });
    const lastRow = Math.max(9, dataRows.length + 9);
    const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="9" topLeftCell="A10" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols><col min="1" max="1" width="6" customWidth="1"/><col min="2" max="2" width="38" customWidth="1"/><col min="3" max="4" width="18" customWidth="1"/><col min="5" max="5" width="24" customWidth="1"/><col min="6" max="7" width="17" customWidth="1"/><col min="8" max="9" width="22" customWidth="1"/><col min="10" max="10" width="16" customWidth="1"/><col min="11" max="11" width="52" customWidth="1"/></cols><sheetData>${rows.join("")}</sheetData><autoFilter ref="A9:K${lastRow}"/><mergeCells count="17"><mergeCell ref="A1:K1"/><mergeCell ref="A3:C3"/><mergeCell ref="D3:F3"/><mergeCell ref="G3:H3"/><mergeCell ref="I3:K3"/><mergeCell ref="A4:C4"/><mergeCell ref="D4:F4"/><mergeCell ref="G4:H4"/><mergeCell ref="I4:K4"/><mergeCell ref="A5:C5"/><mergeCell ref="D5:F5"/><mergeCell ref="G5:H5"/><mergeCell ref="I5:K5"/><mergeCell ref="A6:C6"/><mergeCell ref="D6:K6"/><mergeCell ref="A7:C7"/><mergeCell ref="D7:K7"/></mergeCells>${lastRow >= 10 ? `<conditionalFormatting sqref="E10:E${lastRow}"><cfRule type="dataBar" priority="1"><dataBar showValue="1"><cfvo type="min"/><cfvo type="max"/><color rgb="FF003865"/></dataBar></cfRule></conditionalFormatting><conditionalFormatting sqref="H10:H${lastRow}"><cfRule type="dataBar" priority="2"><dataBar showValue="1"><cfvo type="min"/><cfvo type="max"/><color rgb="FF22A884"/></dataBar></cfRule></conditionalFormatting>` : ""}</worksheet>`;
    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="10"/><name val="Verdana"/></font><font><b/><sz val="16"/><color rgb="FFFFFFFF"/><name val="Verdana"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Verdana"/></font></fonts><fills count="8"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF003865"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF32A6E6"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE5EBEE"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE9F8F2"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF0ED"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF6D1"/></patternFill></fill></fills><borders count="2"><border/><border><left style="thin"><color rgb="FFCAD6DD"/></left><right style="thin"><color rgb="FFCAD6DD"/></right><top style="thin"><color rgb="FFCAD6DD"/></top><bottom style="thin"><color rgb="FFCAD6DD"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="10"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFont="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="6" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="7" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`);
    zip.folder("_rels").file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`);
    zip.folder("docProps").file("app.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Gestão de Intervalo</Application></Properties>`);
    zip.folder("docProps").file("core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(plan.title)}</dc:title><dc:creator>Gestão de Intervalo</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created></cp:coreProperties>`);
    const xl = zip.folder("xl");
    xl.file("workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Intervalo" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`);
    xl.folder("_rels").file("workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    xl.folder("worksheets").file("sheet1.xml", sheetXml);
    xl.file("styles.xml", stylesXml);
    const blob = await zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", compression: "DEFLATE" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${(plan.title || "plano-intervalo").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/gi, "-").replace(/(^-|-$)/g, "").toLowerCase()}.xlsx`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    return blob;
  }

  function fileSlug(value) {
    return String(value || "relatorio").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/gi, "-").replace(/(^-|-$)/g, "").toLowerCase();
  }

  function exportPageToPdf(button, fileName, idleLabel, printClass = "exporting-pdf") {
    const previousTitle = document.title;
    document.title = fileSlug(fileName);
    document.body.classList.add(printClass);
    button.disabled = true;
    button.textContent = "Preparando PDF…";
    const restore = () => {
      document.title = previousTitle;
      document.body.classList.remove(printClass);
      button.disabled = false;
      button.textContent = idleLabel;
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    setTimeout(() => window.print(), 80);
  }

  async function exportPlanFromButton(button, plan, idleLabel = "Exportar Excel") {
    button.disabled = true;
    button.textContent = "Gerando planilha…";
    try {
      await exportPlanToXlsx(plan);
      showToast("Planilha Excel exportada com sucesso.");
    } catch (error) {
      console.error(error);
      showToast("Não foi possível gerar a planilha Excel.");
      throw error;
    } finally {
      button.disabled = false;
      button.textContent = idleLabel;
    }
  }

  function planningPage() {
    const form = $("#plan-form");
    const stepsRoot = $("#planning-steps");
    const selector = $("#plan-selector");
    const dialog = $("#confirm-dialog");
    let coordinatorDirectory = [];

    async function configureCoordinatorField() {
      const currentField = form.elements.coordinator;
      if (!currentField || !currentProfile) return;
      if (isOperatorRole(currentProfile.role)) {
        currentField.readOnly = true;
        currentField.title = "O responsável é definido pela sua conta.";
        coordinatorDirectory = [{
          id: currentProfile.organization_member_id,
          full_name: currentProfile.full_name,
          manager_id: null,
          coordinator_type: currentProfile.coordinator_type
        }];
        renderForm();
        return;
      }
      if (currentProfile.role !== "editor") return;

      const select = document.createElement("select");
      select.name = "coordinator";
      select.dataset.coordinatorSelector = "";
      select.setAttribute("aria-label", "Coordenador ou Especialista responsável");
      select.required = true;
      currentField.replaceWith(select);
      select.innerHTML = '<option value="">Carregando responsáveis…</option>';
      select.disabled = true;

      const { data, error } = await cloudClient
        .from("organization_members")
        .select("id,full_name,role,manager_id,coordinator_type")
        .in("role", ["coordinator", "specialist"])
        .eq("enabled", true)
        .order("full_name");
      if (error) {
        select.innerHTML = '<option value="">Não foi possível carregar os responsáveis</option>';
        showToast("Não foi possível carregar Coordenadores e Especialistas.");
        return;
      }
      coordinatorDirectory = data || [];
      select.innerHTML = '<option value="">Selecione o responsável</option>' + coordinatorDirectory
        .map((member) => `<option value="${escapeHtml(member.id)}">${escapeHtml(member.full_name)} · ${escapeHtml(ROLE_LABELS[member.role])}</option>`)
        .join("");
      renderForm();
    }

    function renderSelector() {
      selector.innerHTML = store.plans
        .map((plan) => `<option value="${plan.id}" ${plan.id === store.activePlanId ? "selected" : ""}>${escapeHtml(plan.title || "Plano sem nome")}${plan.locked ? " · travado" : hasExecutionData(plan) ? " · em revisão" : ""}</option>`)
        .join("");
    }

    function renderForm() {
      const plan = activePlan();
      renderSelector();
      ["title", "serviceType", "coordinator", "date", "location", "windowStart", "windowEnd", "notes"].forEach((name) => {
        const input = form.elements[name];
        if (input) {
          input.value = name === "coordinator" && input.dataset.coordinatorSelector !== undefined
            ? (plan.coordinatorMemberId || "")
            : (plan[name] || "");
          input.disabled = plan.locked || (name === "coordinator" && isOperatorRole(currentProfile?.role));
        }
      });
      $("#lock-banner").hidden = !plan.locked;
      const hasExecution = hasExecutionData(plan);
      $("#planning-revision-banner").hidden = plan.locked || !hasExecution;
      $("#unlock-plan-button").disabled = false;
      $("#unlock-plan-button").textContent = hasExecution ? "Revisar planejamento em execução" : "Destravar para editar";
      $("#lock-plan-button").disabled = plan.locked;
      $("#lock-plan-button").textContent = plan.locked ? "Cronograma travado" : hasExecution ? "Confirmar planejamento atualizado" : "Revisar e travar cronograma";
      $("#add-step-button").disabled = plan.locked;
      $("#chain-times-button").disabled = plan.locked;
      renderSteps();
      renderValidation();
      renderGantt();
    }

    function renderSteps() {
      const plan = activePlan();
      $("#planning-empty").hidden = plan.steps.length > 0;
      $(".schedule-table-wrap").hidden = plan.steps.length === 0;
      stepsRoot.innerHTML = plan.steps.map((step, index) => {
        const timelineStep = buildTimeline(plan).steps[index];
        return `
          <tr data-step-id="${step.id}">
            <td><select class="sequence-select" data-field="executionOrder" aria-label="Ordem de início da etapa ${index + 1}" ${plan.locked ? "disabled" : ""}>${plan.steps.map((_, orderIndex) => `<option value="${orderIndex}" ${orderIndex === index ? "selected" : ""}>${String(orderIndex + 1).padStart(2, "0")}</option>`).join("")}</select></td>
            <td><input data-field="name" type="text" maxlength="140" aria-label="Nome da etapa ${index + 1}" value="${escapeHtml(step.name)}" placeholder="Descreva a atividade" ${plan.locked ? "disabled" : ""}></td>
            <td><input data-field="plannedStart" type="time" aria-label="Início programado da etapa ${index + 1}" value="${escapeHtml(step.plannedStart)}" ${plan.locked ? "disabled" : ""}></td>
            <td><input data-field="plannedEnd" type="time" aria-label="Fim programado da etapa ${index + 1}" value="${escapeHtml(step.plannedEnd)}" ${plan.locked ? "disabled" : ""}></td>
            <td>${formatMinutes(timelineStep.duration)}</td>
            <td>
              <div class="row-actions">
                <button class="row-action" type="button" data-action="up" aria-label="Mover etapa ${index + 1} para cima" title="Mover para cima" ${plan.locked || index === 0 ? "disabled" : ""}>↑</button>
                <button class="row-action" type="button" data-action="down" aria-label="Mover etapa ${index + 1} para baixo" title="Mover para baixo" ${plan.locked || index === plan.steps.length - 1 ? "disabled" : ""}>↓</button>
                <button class="row-action delete" type="button" data-action="delete" aria-label="Excluir etapa ${index + 1}" title="Excluir" ${plan.locked ? "disabled" : ""}>×</button>
              </div>
            </td>
          </tr>`;
      }).join("");
    }

    function renderValidation() {
      const result = validatePlan(activePlan());
      const root = $("#validation-summary");
      root.className = "validation-summary";
      if (result.errors.length) {
        root.classList.add("error");
        root.textContent = `Antes de travar: ${result.errors.join("; ")}.`;
      } else if (result.warnings.length) {
        root.classList.add("warning");
        root.textContent = `Cronograma válido, com atenção: ${result.warnings.join("; ")}.`;
      } else {
        root.classList.add("valid");
        root.textContent = "Cronograma consistente e pronto para confirmação.";
      }
      return result;
    }

    function renderGantt() {
      const plan = activePlan();
      const timeline = buildTimeline(plan);
      const root = $("#gantt");
      $("#window-total").textContent = timeline.duration == null
        ? "Defina a janela"
        : `${plan.windowStart}–${plan.windowEnd} · ${formatMinutes(timeline.duration)}`;
      const validSteps = timeline.steps.filter((step) => step.start != null && step.end != null);
      if (timeline.windowStart == null || timeline.windowEnd == null || !validSteps.length) {
        root.innerHTML = '<div class="gantt-empty">Preencha a janela e os horários das etapas para visualizar a linha do tempo.</div>';
        return;
      }
      root.innerHTML = validSteps.map((step) => {
        const left = Math.max(0, ((step.start - timeline.windowStart) / timeline.duration) * 100);
        const width = Math.max(0.7, Math.min(100 - left, (step.duration / timeline.duration) * 100));
        return `<div class="gantt-row">
          <span class="gantt-label" title="${escapeHtml(step.name || `Etapa ${step.index + 1}`)}">${escapeHtml(step.name || `Etapa ${step.index + 1}`)}</span>
          <div class="gantt-track"><span class="gantt-bar" style="left:${left}%;width:${width}%"></span></div>
          <span class="gantt-time">${step.plannedStart}–${step.plannedEnd}</span>
        </div>`;
      }).join("");
    }

    function addStep() {
      const plan = activePlan();
      if (plan.locked) return;
      const previous = plan.steps.at(-1);
      const step = blankStep();
      if (previous?.plannedEnd) step.plannedStart = previous.plannedEnd;
      plan.steps.push(step);
      persist();
      renderSteps();
      renderValidation();
      renderGantt();
      requestAnimationFrame(() => $(`[data-step-id="${step.id}"] input[data-field="name"]`)?.focus());
    }

    form.addEventListener("input", (event) => {
      const plan = activePlan();
      if (plan.locked) return;
      const field = event.target.name;
      if (field === "coordinator" && event.target.dataset.coordinatorSelector !== undefined) {
        const member = coordinatorDirectory.find((candidate) => candidate.id === event.target.value);
        plan.coordinator = member?.full_name || "";
        plan.coordinatorMemberId = member?.id || null;
        plan.managerMemberId = member?.manager_id || null;
        plan.coordinatorType = member?.coordinator_type || null;
        renderForm();
      } else if (field && Object.hasOwn(plan, field)) {
        plan[field] = event.target.value;
      }
      persist();
      renderSelector();
      renderValidation();
      renderGantt();
    });

    stepsRoot.addEventListener("input", (event) => {
      const plan = activePlan();
      if (plan.locked) return;
      const row = event.target.closest("tr");
      const step = plan.steps.find((item) => item.id === row?.dataset.stepId);
      if (!step) return;
      if (event.target.dataset.field === "executionOrder") {
        const fromIndex = plan.steps.findIndex((item) => item.id === step.id);
        const toIndex = Math.max(0, Math.min(plan.steps.length - 1, Number(event.target.value)));
        if (fromIndex !== toIndex) {
          plan.steps.splice(fromIndex, 1);
          plan.steps.splice(toIndex, 0, step);
          plan.structureDirty = true;
          persist();
          renderForm();
          showToast(`Etapa movida para a posição ${toIndex + 1} da sequência.`);
        }
        return;
      }
      step[event.target.dataset.field] = event.target.value;
      persist();
      const timelineStep = buildTimeline(plan).steps.find((item) => item.id === step.id);
      row.children[4].textContent = formatMinutes(timelineStep.duration);
      renderValidation();
      renderGantt();
    });

    stepsRoot.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const plan = activePlan();
      if (plan.locked) return;
      const row = button.closest("tr");
      const index = plan.steps.findIndex((item) => item.id === row.dataset.stepId);
      if (button.dataset.action === "delete") {
        const target = plan.steps[index];
        const targetHasExecution = target && (target.actualStart || target.actualEnd || target.executionStatus === "skipped" || target.actualNotes);
        if (targetHasExecution && !confirm(`A etapa “${target.name || `Etapa ${index + 1}`}” possui registros realizados. Excluir também removerá esses registros. Deseja continuar?`)) return;
        const [removed] = plan.steps.splice(index, 1);
        if (removed) plan.deletedStepIds.push(removed.id);
        plan.structureDirty = true;
      }
      if (button.dataset.action === "up" && index > 0) {
        [plan.steps[index - 1], plan.steps[index]] = [plan.steps[index], plan.steps[index - 1]];
        plan.structureDirty = true;
      }
      if (button.dataset.action === "down" && index < plan.steps.length - 1) {
        [plan.steps[index], plan.steps[index + 1]] = [plan.steps[index + 1], plan.steps[index]];
        plan.structureDirty = true;
      }
      persist();
      renderSteps();
      renderValidation();
      renderGantt();
    });

    $("#add-step-button").addEventListener("click", addStep);
    $$('[data-add-step]').forEach((button) => button.addEventListener("click", addStep));

    $("#chain-times-button").addEventListener("click", () => {
      const plan = activePlan();
      if (plan.locked || plan.steps.length < 2) return;
      let changed = 0;
      plan.steps.forEach((step, index) => {
        if (index === 0) return;
        const previous = plan.steps[index - 1];
        if (!previous.plannedEnd) return;
        const oldStart = timeToMinutes(step.plannedStart);
        const oldEnd = timeToMinutes(step.plannedEnd);
        const duration = oldStart != null && oldEnd != null ? (oldEnd <= oldStart ? oldEnd + 1440 : oldEnd) - oldStart : null;
        step.plannedStart = previous.plannedEnd;
        if (duration != null) step.plannedEnd = absoluteToTime(timeToMinutes(step.plannedStart) + duration);
        changed++;
      });
      persist();
      renderForm();
      showToast(changed ? "Horários encadeados com a duração preservada." : "Preencha o fim das etapas anteriores primeiro.");
    });

    selector.addEventListener("change", () => {
      selectPlan(selector.value);
      renderForm();
    });

    $("#new-plan-button").addEventListener("click", () => {
      const plan = blankPlan(`Plano ${store.plans.length + 1}`);
      store.plans.push(plan);
      store.activePlanId = plan.id;
      persist(true);
      renderForm();
      form.elements.title.focus();
    });

    $("#example-plan-button")?.addEventListener("click", () => {
      const existingExample = store.plans.find((plan) => plan.isExample);
      if (existingExample) {
        store.activePlanId = existingExample.id;
        persist(true);
        renderForm();
        showToast("Exemplo existente selecionado. Abra a execução para testar.");
        return;
      }
      const plan = examplePlan();
      store.plans.push(plan);
      store.activePlanId = plan.id;
      persist(true);
      renderForm();
      showToast("Exemplo criado com execução parcial. Clique em “Abrir execução”.");
    });

    $("#duplicate-plan-button").addEventListener("click", () => {
      const source = activePlan();
      const copy = structuredClone(source);
      copy.id = uid();
      delete copy.databaseId;
      copy.title = `${source.title || "Plano"} — cópia`;
      copy.locked = false;
      copy.lockedAt = null;
      copy.createdAt = new Date().toISOString();
      copy.steps.forEach((step) => {
        step.id = uid();
        delete step.databaseId;
        step.actualStart = "";
        step.actualEnd = "";
        step.actualNotes = "";
        step.executionStatus = "pending";
        step.skipReason = "";
      });
      copy.executionNotes = "";
      copy.deletedStepIds = [];
      copy.structureDirty = false;
      store.plans.push(copy);
      store.activePlanId = copy.id;
      persist(true);
      renderForm();
      showToast("Plano duplicado e liberado para edição.");
    });

    $("#delete-plan-button").addEventListener("click", () => {
      if (store.plans.length === 1) {
        showToast("Mantenha ao menos um plano salvo.");
        return;
      }
      const plan = activePlan();
      if (plan.status !== "planning" || plan.completedAt || hasExecutionData(plan)) {
        showToast("Somente rascunhos sem execução podem ser excluídos.");
        return;
      }
      if (!confirm(`Excluir “${plan.title || "Plano sem nome"}”? Esta ação não pode ser desfeita.`)) return;
      store.deletedPlanIds.push({ clientId: plan.id, databaseId: plan.databaseId || null, ownerId: plan.ownerId || currentUser?.id || null });
      store.plans = store.plans.filter((item) => item.id !== plan.id);
      store.activePlanId = store.plans[0].id;
      persist(true);
      renderForm();
    });

    $("#lock-plan-button").addEventListener("click", () => {
      const result = renderValidation();
      if (!result.valid) {
        showToast("Revise os itens indicados antes de travar.");
        $("#validation-summary").scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      const revisingExecution = hasExecutionData(activePlan());
      $("#confirm-dialog-title").textContent = revisingExecution ? "Confirmar planejamento atualizado?" : "Travar o cronograma?";
      $("#confirm-dialog-description").textContent = revisingExecution
        ? "Os novos horários e etapas passarão a ser a referência da execução. Os dados realizados serão preservados e os indicadores permanecerão recalculados com o planejamento atualizado."
        : "Depois da confirmação, as etapas e os horários programados ficarão protegidos contra alterações acidentais. Se o CCO mudar a janela durante a execução, o planejamento poderá ser revisado novamente sem apagar os dados realizados.";
      $("#confirm-dialog-submit").textContent = revisingExecution ? "Confirmar atualização" : "Sim, travar plano";
      dialog.showModal();
    });

    dialog.addEventListener("close", () => {
      if (dialog.returnValue !== "confirm") return;
      const plan = activePlan();
      const wasInExecution = hasExecutionData(plan);
      plan.locked = true;
      plan.lockedAt = new Date().toISOString();
      persist(true);
      renderForm();
      showToast(wasInExecution ? "Planejamento atualizado. A execução e os cálculos foram recalculados." : "Cronograma travado. Execução liberada.");
    });

    $("#unlock-plan-button").addEventListener("click", () => {
      const plan = activePlan();
      const hasExecution = hasExecutionData(plan);
      const message = hasExecution
        ? "O intervalo está em execução. As alterações serão salvas na nuvem e recalcularão automaticamente atrasos, previsão de término, dashboard e relatórios. Deseja revisar o planejamento?"
        : "Destravar o cronograma para edição?";
      if (!confirm(message)) return;
      plan.locked = false;
      persist(true);
      renderForm();
      showToast(hasExecution ? "Planejamento em revisão. A execução permanece disponível." : "Cronograma destravado para edição.");
    });

    $("#export-button").addEventListener("click", async () => {
      try { await exportPlanFromButton($("#export-button"), activePlan(), "Exportar Excel (.xlsx)"); } catch (_) { /* feedback exibido */ }
    });
    $("#export-plan-pdf").addEventListener("click", () => exportPageToPdf($("#export-plan-pdf"), `planejamento-${activePlan().title || "intervalo"}`, "Exportar PDF", "planning-printing"));

    renderForm();
    configureCoordinatorField();
    pageRefreshHandler = renderForm;
  }

  function executionPage() {
    let plan = activePlan();
    let comments = [];
    const root = $("#execution-steps");
    const blocked = $("#execution-blocked");
    const content = $("#execution-content");

    function nowTime() {
      return new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false });
    }

    function pendingCommentsForPlan() {
      return outbox.filter((item) => item.type === "comment_create" && item.planId === plan.id).map((item) => ({
        id: `pending-${item.payload.client_id}`,
        client_id: item.payload.client_id,
        author_user_id: currentUser.id,
        author_name: currentProfile.full_name || "Usuário",
        author_role: currentProfile.role,
        content: item.payload.content,
        created_at: item.createdAt,
        pending: true
      }));
    }

    async function loadExecutionComments() {
      if (!plan.databaseId || !cloudClient) { comments = pendingCommentsForPlan(); renderComments(); return; }
      const { data, error } = await cloudClient.from("interval_comments").select("*").eq("plan_id", plan.databaseId).order("created_at");
      if (error) { console.warn("Não foi possível atualizar os comentários.", error); renderComments(); return; }
      const pending = pendingCommentsForPlan().filter((local) => !(data || []).some((remote) => remote.client_id === local.client_id));
      comments = [...(data || []), ...pending];
      renderComments();
    }

    function renderComments() {
      const commentsRoot = $("#execution-comments");
      if (!commentsRoot) return;
      const visible = comments.filter((comment) => !comment.deleted_at);
      commentsRoot.innerHTML = visible.length ? visible.map((comment) => {
        const removable = comment.author_user_id === currentUser.id && !comment.pending && plan.status === "executing";
        return `<article class="interval-comment ${comment.pending ? "is-pending" : ""}" data-comment-id="${escapeHtml(comment.id)}"><header><span><strong>${escapeHtml(comment.author_name)}</strong><i>${escapeHtml(ROLE_LABELS[comment.author_role] || comment.author_role)}</i></span><time>${new Date(comment.created_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}${comment.pending ? " · Pendente de sincronização" : ""}</time></header><p>${escapeHtml(comment.content)}</p>${removable ? '<button type="button" data-comment-delete>Excluir meu comentário</button>' : ""}</article>`;
      }).join("") : `<div class="portal-empty"><strong>Nenhum comentário</strong><span>Atualizações registradas durante a execução aparecerão aqui.</span></div>`;
      const allowed = plan.status === "executing" || (hasExecutionData(plan) && !getStatus().finished);
      $("#execution-comment-form").hidden = !allowed;
      $("#execution-comments-locked").hidden = allowed;
    }

    function getStatus() {
      const timeline = buildTimeline(plan);
      return executionStatus(plan, timeline);
    }

    function variancePresentation(step, nowAbs) {
      const variance = stepScheduleDeviation(step, nowAbs);
      const rounded = wholeMinutes(variance);
      if (isStepSkipped(step)) return { className: "skipped", text: "Não executada", value: null };
      if (rounded == null) return { className: "", text: "Aguardando", value: null };
      if (rounded > 0) return { className: "delay", text: `+${rounded} min`, value: rounded };
      if (rounded < 0) return { className: "ahead", text: `${rounded} min`, value: rounded };
      return { className: "", text: "No prazo", value: 0 };
    }

    function stepStateText(step, nowAbs) {
      if (isStepSkipped(step)) return "Etapa não executada";
      if (isStepComplete(step)) return "Etapa concluída";
      if (step.actualStartMinutes != null) {
        const burn = stepDurationBurn(step, nowAbs);
        return burn ? `Em andamento há ${formatMinutes(burn.elapsed)}` : "Em andamento";
      }
      if (isStartOverdue(step, nowAbs)) {
        return `Não iniciada · deveria ter começado às ${step.plannedStart}`;
      }
      return "Aguardando início";
    }

    // Linha de duração: para etapa em andamento mostra o tempo corrido contra o
    // previsto, para que o coordenador veja a etapa estourar a duração antes
    // mesmo de o fim programado chegar.
    function durationText(step, nowAbs) {
      if (isStepSkipped(step)) return `Não executada${step.skipReason ? ` · ${step.skipReason}` : ""}`;
      if (step.actualDuration != null) {
        const variance = step.duration == null ? null : Math.round(step.actualDuration - step.duration);
        return `Duração realizada: ${formatMinutes(step.actualDuration)}${
          variance == null ? "" : variance === 0 ? " · igual ao previsto" : ` · ${variance > 0 ? "+" : "−"}${formatMinutes(variance)} vs. previsto`
        }`;
      }
      const burn = stepDurationBurn(step, nowAbs);
      if (!burn) return "Duração calculada ao informar início e fim";
      const head = burn.planned == null
        ? `Em execução há ${formatMinutes(burn.elapsed)}`
        : `Em execução há ${formatMinutes(burn.elapsed)} de ${formatMinutes(burn.planned)} previstos`;
      const remaining = step.end == null ? null : step.end - nowAbs;
      const over = burn.over == null ? null : wholeMinutes(burn.over);
      // Passar da duração prevista só é problema se a etapa também já tiver
      // passado do fim programado. Uma etapa que começou bem antes do previsto
      // pode consumir mais tempo e ainda assim entregar com folga.
      if (remaining != null && wholeMinutes(remaining) < 0) {
        return `${head} · ${over > 0 ? `${formatMinutes(burn.over)} a mais que o previsto e ` : ""}${formatMinutes(-remaining)} além do fim programado`;
      }
      if (over != null && over > 0) {
        return `${head} · ${formatMinutes(burn.over)} a mais que o previsto${
          remaining == null ? "" : `, ainda ${formatMinutes(remaining)} antes do fim programado`
        }`;
      }
      if (burn.planned == null) return head;
      return `${head} · restam ${formatMinutes(-burn.over)} de duração`;
    }

    // Vermelho apenas quando a etapa já passou do próprio fim programado.
    function durationOverClass(step, nowAbs) {
      if (nowAbs == null || step.end == null || isStepSkipped(step)) return "";
      if (step.actualStartMinutes == null || step.actualEndMinutes != null) return "";
      return wholeMinutes(step.end - nowAbs) < 0 ? " is-over" : "";
    }

    // Linha de previsão exibida dentro de cada etapa aberta.
    function stepForecastText(step, status) {
      if (isStepSkipped(step) || isStepComplete(step)) return "";
      const entry = status.projection.byStep.get(step.id);
      if (!entry || !Number.isFinite(entry.projectedEnd)) return "";
      // Só o horário: o desvio contra o prazo da etapa já é o selo do topo,
      // e dois números diferentes no mesmo cartão confundem.
      return entry.state === "running"
        ? `Previsão de término: ${absoluteToTime(entry.projectedEnd)} · prazo ${step.plannedEnd || "—"}`
        : `Previsão ${absoluteToTime(entry.projectedStart)} → ${absoluteToTime(entry.projectedEnd)} · prazo ${step.plannedEnd || "—"}`;
    }

    function renderSteps() {
      const status = getStatus();
      const activeIds = new Set(status.active.map((step) => step.id));
      const criticalId = status.critical?.step?.id || null;
      const firstPending = status.steps.find((step) => !isStepResolved(step) && !activeIds.has(step.id));
      root.innerHTML = status.steps.map((step, index) => {
        const variance = variancePresentation(step, status.nowAbs);
        const forecastText = stepForecastText(step, status);
        const realizedDurationText = durationText(step, status.nowAbs);
        const stepComplete = isStepComplete(step);
        const skipped = isStepSkipped(step);
        const isCritical = !skipped && !stepComplete && step.id === criticalId && variance.value > 0;
        const stateClass = [
          skipped ? "is-skipped" : stepComplete ? "is-complete" : activeIds.has(step.id) || (!status.active.length && firstPending?.id === step.id) ? "is-active" : "",
          isCritical ? "is-critical" : ""
        ].filter(Boolean).join(" ");
        const disabled = skipped ? "disabled" : "";
        return `<article class="execution-step ${stateClass}" data-step-id="${step.id}">
          <header class="execution-step-header">
            <span class="execution-index">${stepComplete ? "✓" : skipped ? "—" : String(index + 1).padStart(2, "0")}</span>
            <div class="execution-step-title">
              <h3>${escapeHtml(step.name || `Etapa ${index + 1}`)}${isCritical ? '<b class="critical-flag">Ofensor principal</b>' : ""}</h3>
              <span data-step-state>${escapeHtml(stepStateText(step, status.nowAbs))}</span>
            </div>
            <span class="step-variance ${variance.className}" data-step-variance>${variance.text}</span>
          </header>
          <div class="execution-step-grid">
            <div class="programmed-block">
              <span class="block-label">Programado</span>
              <div class="time-pair"><strong>${escapeHtml(step.plannedStart || "—")}</strong><span>→</span><strong>${escapeHtml(step.plannedEnd || "—")}</strong></div>
              <small>${formatMinutes(step.duration)}</small>
            </div>
            <div class="realized-block">
              <span class="block-label">Realizado</span>
              <div class="realized-times">
                <div class="time-entry">
                  <label>Início<input data-field="actualStart" type="time" value="${escapeHtml(step.actualStart)}" aria-label="Início realizado da etapa ${index + 1}" ${disabled}></label>
                  <button class="now-button" type="button" data-now="actualStart" ${disabled}>Agora</button>
                </div>
                <div class="time-entry">
                  <label>Fim<input data-field="actualEnd" type="time" value="${escapeHtml(step.actualEnd)}" aria-label="Fim realizado da etapa ${index + 1}" ${step.actualStart && !skipped ? "" : "disabled"}></label>
                  <button class="now-button" type="button" data-now="actualEnd" ${step.actualStart && !skipped ? "" : "disabled"}>Agora</button>
                </div>
              </div>
              <small class="realized-duration${durationOverClass(step, status.nowAbs)}" data-step-duration>${escapeHtml(realizedDurationText)}</small>
              <small class="step-forecast" data-step-forecast ${forecastText ? "" : "hidden"}>${escapeHtml(forecastText)}</small>
              <button class="step-status-button" type="button" data-step-action="${skipped ? "restore" : "skip"}" ${stepComplete ? "disabled" : ""}>${skipped ? "Reativar etapa" : "Marcar como não executada"}</button>
            </div>
            <label class="field notes-block">
              <span>${skipped ? "Observação / motivo" : "O que foi realizado"}</span>
              <textarea data-field="actualNotes" maxlength="600" rows="3" placeholder="${skipped ? "Registre detalhes da decisão" : "Descreva o serviço executado, ocorrências ou desvios"}">${escapeHtml(step.actualNotes)}</textarea>
            </label>
          </div>
        </article>`;
      }).join("");
    }

    function refreshStepIndicators() {
      const status = getStatus();
      const activeIds = new Set(status.active.map((step) => step.id));
      const criticalId = status.critical?.step?.id || null;
      const firstPending = status.steps.find((step) => !isStepResolved(step) && !activeIds.has(step.id));
      status.steps.forEach((step) => {
        const article = $(`[data-step-id="${step.id}"]`, root);
        if (!article) return;
        const variance = variancePresentation(step, status.nowAbs);
        const open = !isStepSkipped(step) && !isStepComplete(step);
        article.classList.toggle("is-active", open && (activeIds.has(step.id) || (!status.active.length && firstPending?.id === step.id)));
        article.classList.toggle("is-critical", open && step.id === criticalId && variance.value > 0);
        const badge = $("[data-step-variance]", article);
        badge.className = `step-variance ${variance.className}`;
        badge.textContent = variance.text;
        $("[data-step-state]", article).textContent = stepStateText(step, status.nowAbs);
        const duration = $("[data-step-duration]", article);
        if (duration) {
          duration.textContent = durationText(step, status.nowAbs);
          duration.className = `realized-duration${durationOverClass(step, status.nowAbs)}`;
        }
        const forecast = $("[data-step-forecast]", article);
        if (forecast) {
          const text = stepForecastText(step, status);
          forecast.textContent = text;
          forecast.hidden = !text;
        }
      });
    }

    function renderDashboard() {
      const status = getStatus();
      const {
        timeline, steps, active, pending, resolved,
        lateNow, lateFinished,
        baseline, projectedEnd, delay, started, finished, live
      } = status;

      const delayRounded = delay == null ? null : wholeMinutes(delay);
      const waiting = !started && (delayRounded == null || delayRounded <= 0);
      const hasLate = lateNow.length > 0 || lateFinished.length > 0;
      const baselineText = baseline == null ? "—" : absoluteToTime(baseline);
      const forecastText = projectedEnd == null ? "—" : absoluteToTime(Math.floor(projectedEnd));

      // ---------- indicador principal: atraso da EXECUÇÃO INTEIRA vs. planejado ----------
      let tone;
      if (!live || delayRounded == null || waiting) tone = "status-neutral";
      else if (delayRounded > 0) tone = "status-delay";
      else if (delayRounded < 0) tone = "status-ahead";
      else tone = hasLate && !finished ? "status-warn" : "status-on-time";
      $("#status-hero").className = "status-hero " + tone;

      const showNumber = live && delayRounded != null && !waiting;
      $("#status-sign").textContent = !showNumber ? "" : delayRounded > 0 ? "+" : delayRounded < 0 ? "−" : "";
      $("#status-minutes").textContent = !showNumber ? "—" : String(Math.abs(delayRounded)).padStart(2, "0");
      $("#status-readable").hidden = !showNumber;
      $("#status-readable").textContent = !showNumber
        ? ""
        : `${Math.abs(delayRounded)} min${Math.abs(delayRounded) >= 60 ? ` · ${formatHoursMinutes(delayRounded)}` : ""} · marco mais avançado da sequência`;

      if (!live) {
        $("#status-label").textContent = "Acompanhamento ao vivo indisponível";
      } else if (waiting) {
        $("#status-label").textContent = "Aguardando início da execução";
      } else if (finished) {
        $("#status-label").textContent = delayRounded > 0
          ? "Intervalo encerrado com atraso"
          : delayRounded < 0 ? "Intervalo encerrado adiantado" : "Intervalo encerrado no horário";
      } else if (delayRounded > 0) {
        $("#status-label").textContent = "Execução atrasada em relação ao planejado";
      } else if (delayRounded < 0) {
        $("#status-label").textContent = "Execução adiantada em relação ao planejado";
      } else if (hasLate) {
        $("#status-label").textContent = "Execução dentro do prazo da sequência";
      } else {
        $("#status-label").textContent = "Execução no horário planejado";
      }

      $("#status-announcement").textContent = !live
        ? "Acompanhamento ao vivo indisponível."
        : waiting ? "Aguardando início da execução."
        : delayRounded > 0 ? `Execução atrasada em ${delayRounded} minutos em relação ao planejado. ${lateNow.length} etapa ou etapas em atraso agora.`
        : delayRounded < 0 ? `Execução adiantada em ${Math.abs(delayRounded)} minutos em relação ao planejado.`
        : "Execução no horário planejado.";

      // ---------- relógios ----------
      $("#live-forecast").textContent = absoluteToClock(projectedEnd);
      $("#live-forecast-note").textContent = projectedEnd == null
        ? "Aguardando dados do intervalo"
        : `Pelo ritmo atual · planejado ${baselineText}`;

      // ---------- cartões de resumo ----------
      $("#metric-window").textContent = timeline.windowStart == null ? "—" : `${plan.windowStart}–${plan.windowEnd}`;
      $("#metric-duration").textContent = timeline.duration == null ? "Janela não definida" : `${formatMinutes(timeline.duration)} de janela`;
      $("#metric-progress").textContent = `${resolved.length} / ${steps.length}`;
      $("#progress-bar").style.width = steps.length ? `${(resolved.length / steps.length) * 100}%` : "0%";

      const nextPending = pending[0] || null;
      $("#metric-current").textContent = active.length > 1
        ? `${active.length} simultâneas`
        : active.length === 1 ? stepLabel(active[0])
        : finished ? "Concluído"
        : nextPending ? "Aguardando início" : "Aguardando";
      $("#metric-current-time").textContent = active.length
        ? active.map((step) => `${stepLabel(step)}: desde ${step.actualStart}`).join(" · ")
        : nextPending ? `Próxima: ${stepLabel(nextPending)} ${nextPending.plannedStart}–${nextPending.plannedEnd}` : "—";

      $("#metric-late").textContent = !live ? "—" : String(lateNow.length);
      $("#metric-late-note").textContent = !live
        ? "Acompanhamento indisponível"
        : lateNow.length ? `Pior: ${stepLabel(lateNow[0].step)} +${wholeMinutes(lateNow[0].deviation)} min`
        : lateFinished.length ? `${pluralize(lateFinished.length, "concluída com atraso", "concluídas com atraso")}`
        : "Nenhuma etapa em atraso";

      $("#metric-forecast").textContent = forecastText;
      $("#metric-forecast-note").textContent = projectedEnd == null
        ? "Aguardando dados"
        : `Pelo ritmo atual · planejado ${baselineText}`;

    }

    function renderClock() {
      const now = new Date();
      $("#live-clock").textContent = now.toLocaleTimeString("pt-BR", { hour12: false });
      $("#live-date").textContent = now.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" });
    }

    function updateActualTime(step, field, value) {
      const previous = step[field];
      if (isStepSkipped(step)) {
        showToast("Reative a etapa antes de registrar horários.");
        return false;
      }
      if (field === "actualStart" && !value && step.actualEnd) {
        showToast("Limpe primeiro o horário de fim para não deixar um término sem início.");
        return false;
      }
      if (field === "actualEnd" && value && !step.actualStart) {
        showToast("Informe o início antes de registrar o fim.");
        return false;
      }
      step[field] = value;
      const timelineStep = buildTimeline(plan).steps.find((item) => item.id === step.id);
      if (isStepComplete(timelineStep) && (timelineStep.actualDuration <= 0 || timelineStep.actualDuration > 720)) {
        step[field] = previous;
        showToast("A duração realizada deve ser maior que zero e não pode superar 12 horas.");
        return false;
      }
      persist(true);
      return true;
    }

    root.addEventListener("input", (event) => {
      if (!event.target.matches("textarea[data-field='actualNotes']")) return;
      const stepElement = event.target.closest("[data-step-id]");
      const step = plan.steps.find((item) => item.id === stepElement?.dataset.stepId);
      if (!step) return;
      step.actualNotes = event.target.value;
      persist();
    });

    root.addEventListener("change", (event) => {
      if (!event.target.matches('input[type="time"]')) return;
      const stepElement = event.target.closest("[data-step-id]");
      const step = plan.steps.find((item) => item.id === stepElement?.dataset.stepId);
      if (!step) return;
      const field = event.target.dataset.field;
      if (!updateActualTime(step, field, event.target.value)) event.target.value = step[field] || "";
      else if (event.target.value) showToast(`${field === "actualStart" ? "Início" : "Fim"} realizado registrado às ${event.target.value}.`);
      renderSteps();
      renderDashboard();
    });

    root.addEventListener("click", (event) => {
      const button = event.target.closest("[data-now], [data-step-action]");
      if (!button) return;
      const stepElement = button.closest("[data-step-id]");
      const step = plan.steps.find((item) => item.id === stepElement?.dataset.stepId);
      if (!step) return;
      if (button.dataset.now) {
        const value = nowTime();
        if (updateActualTime(step, button.dataset.now, value)) showToast(`Horário registrado: ${value}.`);
      } else if (button.dataset.stepAction === "skip") {
        const reason = prompt("Motivo para a etapa não ser executada (opcional):", "");
        if (reason === null) return;
        step.executionStatus = "skipped";
        step.skipReason = reason.trim();
        step.actualStart = "";
        step.actualEnd = "";
        persist(true);
        showToast("Etapa registrada como não executada.");
      } else if (button.dataset.stepAction === "restore") {
        step.executionStatus = "pending";
        step.skipReason = "";
        persist(true);
        showToast("Etapa reativada para execução.");
      }
      renderSteps();
      renderDashboard();
    });

    $("#execution-notes").addEventListener("input", (event) => {
      plan.executionNotes = event.target.value;
      persist();
    });
    $("#execution-comment-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const content = form.content.value.trim();
      const feedback = $("#execution-comment-feedback");
      if (!content) return;
      enqueueDirtyPlans();
      const clientId = uid();
      outbox.push({
        type: "comment_create", operationId: uid(), deviceId, planId: plan.id,
        payload: { client_id: clientId, dataset_id: plan.datasetId, plan_id: plan.databaseId, author_user_id: currentUser.id, author_name: currentProfile.full_name || "Usuário", author_role: currentProfile.role, content },
        attempts: 0, createdAt: new Date().toISOString(), state: "pending"
      });
      saveOutbox();
      store.pendingSync = true;
      writeStoreLocally();
      form.reset();
      feedback.textContent = navigator.onLine ? "Salvando…" : "Salvo localmente. Será enviado quando a conexão retornar.";
      comments.push(...pendingCommentsForPlan().filter((pending) => pending.client_id === clientId));
      renderComments();
      scheduleCloudSync(true);
      if (navigator.onLine) setTimeout(loadExecutionComments, 900);
    });
    $("#execution-comments")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-comment-delete]");
      if (!button) return;
      const row = button.closest("[data-comment-id]");
      const deletedAt = new Date().toISOString();
      const comment = comments.find((item) => item.id === row.dataset.commentId);
      if (comment) comment.deleted_at = deletedAt;
      outbox.push({ type: "comment_delete", operationId: uid(), deviceId, planId: plan.id, commentId: row.dataset.commentId, deletedAt, attempts: 0, createdAt: deletedAt, state: "pending" });
      saveOutbox();
      store.pendingSync = true;
      writeStoreLocally();
      renderComments();
      scheduleCloudSync(true);
    });
    $("#export-execution-xlsx").addEventListener("click", async () => {
      try { await exportPlanFromButton($("#export-execution-xlsx"), plan); } catch (_) { /* feedback exibido */ }
    });
    $("#print-button").addEventListener("click", () => exportPageToPdf($("#print-button"), `execucao-${plan.title || "intervalo"}`, "Exportar PDF", "execution-printing"));

    function renderPage() {
      plan = activePlan();
      const executionAvailable = plan.locked || hasExecutionData(plan);
      blocked.hidden = executionAvailable;
      content.hidden = !executionAvailable;
      $("#execution-revision-banner").hidden = plan.locked || !hasExecutionData(plan);
      $("#execution-title").textContent = plan.title || "Intervalo sem nome";
      const dateLabel = plan.date ? new Date(`${plan.date}T12:00:00`).toLocaleDateString("pt-BR") : "Data não informada";
      $("#execution-subtitle").textContent = [dateLabel, plan.serviceType, plan.location, plan.coordinator && `Responsável: ${plan.coordinator}`].filter(Boolean).join(" · ");
      if (document.activeElement !== $("#execution-notes")) $("#execution-notes").value = plan.executionNotes || "";
      $("#execution-notes").disabled = !executionAvailable;
      renderSteps();
      renderDashboard();
      renderClock();
      loadExecutionComments();
    }

    renderPage();
    pageRefreshHandler = renderPage;
    setInterval(() => {
      renderClock();
      if (plan.locked || hasExecutionData(plan)) {
        renderDashboard();
        refreshStepIndicators();
      }
    }, 1000);
  }

  function dashboardPage() {
    const selector = $("#dashboard-plan-selector");

    function statusFor(step, nowAbs) {
      const variance = stepScheduleDeviation(step, nowAbs);
      const rounded = wholeMinutes(variance);
      if (isStepSkipped(step)) return { label: "Não executada", className: "skipped", variance: null };
      if (isStepComplete(step)) {
        if (rounded > 0) return { label: "Atrasada", className: "delay", variance: rounded };
        if (rounded < 0) return { label: "Adiantada", className: "ahead", variance: rounded };
        return { label: "No prazo", className: "on-time", variance: 0 };
      }
      if (step.actualStartMinutes != null) {
        if (rounded > 0) return { label: "Em andamento · iniciou atrasada", className: "delay", variance: rounded };
        if (rounded < 0) return { label: "Em andamento · iniciou adiantada", className: "ahead", variance: rounded };
        return { label: "Em andamento · iniciou no horário", className: "running", variance: 0 };
      }
      if (rounded > 0) return { label: "Prazo vencido sem iniciar", className: "delay", variance: rounded };
      if (isStartOverdue(step, nowAbs)) return { label: "Início atrasado", className: "waiting", variance: null };
      return { label: "Aguardando", className: "waiting", variance: null };
    }

    function renderPlanOptions() {
      selector.innerHTML = store.plans.map((plan) => `<option value="${plan.id}" ${plan.id === store.activePlanId ? "selected" : ""}>${escapeHtml(plan.title || "Plano sem nome")}</option>`).join("");
    }

    function render() {
      const plan = activePlan();
      const timeline = buildTimeline(plan);
      const completed = timeline.steps.filter(isStepComplete);
      const resolved = timeline.steps.filter(isStepResolved);
      const skipped = timeline.steps.filter(isStepSkipped);
      const running = timeline.steps.filter((step) => step.actualStartMinutes != null && step.actualEndMinutes == null && !isStepSkipped(step));
      const progress = timeline.steps.length ? Math.round((resolved.length / timeline.steps.length) * 100) : 0;
      const plannedTotal = timeline.steps.reduce((sum, step) => sum + (step.duration || 0), 0);
      const status = executionStatus(plan, timeline);
      const scheduleDeviation = status.delay == null ? null : wholeMinutes(status.delay);
      const nowAbs = status.nowAbs;
      const elapsedInterval = intervalElapsedTime(timeline, nowAbs);
      const maxDuration = Math.max(1, ...timeline.steps.flatMap((step) => [step.duration || 0, step.actualDuration || 0]));
      const concurrentExecution = hasConcurrentExecution(timeline, nowAbs);

      $("#dashboard-title").textContent = plan.title || "Intervalo sem nome";
      $("#dashboard-subtitle").textContent = [plan.date && new Date(`${plan.date}T12:00:00`).toLocaleDateString("pt-BR"), plan.serviceType, plan.location, plan.coordinator].filter(Boolean).join(" · ") || "Plano ativo";
      $("#dashboard-progress").textContent = `${progress}%`;
      $("#dashboard-progress-note").textContent = `${resolved.length} de ${timeline.steps.length} etapas encerradas`;
      $("#dashboard-planned-total").textContent = plannedTotal ? formatMinutes(plannedTotal) : "—";
      $("#dashboard-actual-total").textContent = elapsedInterval.minutes == null ? "—" : formatMinutes(elapsedInterval.minutes);
      $("#dashboard-actual-note").textContent = elapsedInterval.start == null
        ? "Aguardando o primeiro início realizado"
        : elapsedInterval.finished
          ? `${absoluteToTime(elapsedInterval.start)}–${absoluteToTime(elapsedInterval.end)} · intervalo encerrado`
          : elapsedInterval.end == null
            ? "Horário atual indisponível para a data deste plano"
            : `Desde ${absoluteToTime(elapsedInterval.start)} até agora · períodos concomitantes contam uma vez`;
      $("#dashboard-variance").textContent = scheduleDeviation == null
        ? "—"
        : scheduleDeviation > 0 ? `Atrasado ${scheduleDeviation} min`
          : scheduleDeviation < 0 ? `Adiantado ${Math.abs(scheduleDeviation)} min` : "Dentro do prazo";
      $("#dashboard-variance-label").textContent = "Situação do cronograma em execução";
      $("#dashboard-variance-note").textContent = !status.live
        ? "Acompanhamento ao vivo indisponível para esta data"
        : scheduleDeviation == null
          ? "Aguardando o primeiro prazo ou marco a comparar"
          : `Marco mais avançado da sequência · previsão de término ${absoluteToTime(Math.floor(status.projectedEnd))}${
              status.lateNow.length ? ` · ${pluralize(status.lateNow.length, "etapa em atraso agora", "etapas em atraso agora")}` : ""
            }${concurrentExecution ? " · períodos simultâneos contados uma vez só" : ""}`;
      $("#dashboard-variance-card").className = `dashboard-kpi featured ${scheduleDeviation == null ? "variance-neutral" : scheduleDeviation > 0 ? "variance-positive" : scheduleDeviation < 0 ? "variance-negative" : "variance-zero"}`;

      const activeTimelineEnd = (step) => step.actualEndMinutes ?? (step.actualStartMinutes != null ? nowAbs ?? step.actualStartMinutes : null);
      const timelineValues = [timeline.windowStart, timeline.windowEnd];
      timeline.steps.forEach((step) => {
        timelineValues.push(step.start, step.end, step.actualStartMinutes, activeTimelineEnd(step));
      });
      const validTimelineValues = timelineValues.filter(Number.isFinite);
      const comparisonStart = validTimelineValues.length ? Math.min(...validTimelineValues) : null;
      const comparisonEnd = validTimelineValues.length ? Math.max(...validTimelineValues) : null;
      const comparisonDuration = comparisonStart != null && comparisonEnd != null ? Math.max(1, comparisonEnd - comparisonStart) : null;
      const comparisonPosition = (value) => comparisonDuration == null || value == null ? 0 : Math.max(0, Math.min(100, ((value - comparisonStart) / comparisonDuration) * 100));
      const comparisonWidth = (start, end) => start == null || end == null ? 0 : Math.max(0.8, comparisonPosition(end) - comparisonPosition(start));
      const timelineHost = $("#dashboard-timeline");
      const timelineScaleInfo = comparisonDuration == null ? null : timelineScale(comparisonStart, comparisonEnd, timelineAvailablePx(timelineHost));
      const timelineGrid = timelineScaleInfo ? timelineGridStyle(timelineScaleInfo.ticks, comparisonStart, comparisonDuration) : "";
      $("#dashboard-timeline-range").textContent = comparisonDuration == null
        ? "Defina os horários do intervalo"
        : `Escala comparativa: ${absoluteToTime(comparisonStart)}–${absoluteToTime(comparisonEnd)} · ${formatMinutes(comparisonDuration)} · marcas a cada ${formatMinutes(timelineScaleInfo.step)}`;
      hideChartTooltip();
      timelineHost.innerHTML = comparisonDuration == null || !timeline.steps.length
        ? `<div class="chart-empty">Adicione etapas e horários para gerar a linha do tempo comparativa.</div>`
        : `${timeline.steps.map((step, index) => {
          const actualEnd = activeTimelineEnd(step);
          const runningStep = step.actualStartMinutes != null && step.actualEndMinutes == null && !isStepSkipped(step);
          const actualText = isStepSkipped(step)
            ? "Não executada"
            : step.actualStartMinutes == null
              ? "Aguardando execução"
              : `${absoluteToTime(step.actualStartMinutes)}–${runningStep ? "agora" : absoluteToTime(step.actualEndMinutes)}`;
          const stepStatus = statusFor(step, nowAbs);
          const elapsed = runningStep && actualEnd != null ? actualEnd - step.actualStartMinutes : null;
          const projection = status.projection.byStep.get(step.id);
          const projectedEnd = projection && Number.isFinite(projection.projectedEnd) ? projection.projectedEnd : null;
          const tipInfo = {
            actualText,
            actualDurationText: step.actualDuration != null
              ? formatMinutes(step.actualDuration)
              : elapsed != null ? `${formatMinutes(elapsed)} até agora${step.duration != null && wholeMinutes(elapsed - step.duration) > 0 ? ` · ${formatMinutes(elapsed - step.duration)} a mais que o previsto` : ""}` : "",
            statusLabel: stepStatus.label,
            deviationText: stepStatus.variance == null ? "" : `${stepStatus.variance > 0 ? "+" : ""}${stepStatus.variance} min`,
            deviationTone: stepStatus.variance == null ? "" : stepStatus.variance > 0 ? "delay" : stepStatus.variance < 0 ? "ahead" : "on-time",
            forecastText: isStepSkipped(step) || isStepComplete(step) || projectedEnd == null
              ? ""
              : `${absoluteToTime(Math.floor(projectedEnd))}${step.end == null ? "" : ` (${wholeMinutes(projectedEnd - step.end) > 0 ? "+" : ""}${wholeMinutes(projectedEnd - step.end)} min vs. programado)`}`
          };
          const rowTip = timelineTipData(step, index, tipInfo);
          const plannedTip = timelineTipData(step, index, { ...tipInfo, kind: "Barra planejada" });
          const actualTip = timelineTipData(step, index, { ...tipInfo, kind: runningStep ? "Barra em andamento" : "Barra realizada" });
          return `<div class="timeline-compare-row">
            <div class="timeline-compare-label"><span>${String(index + 1).padStart(2, "0")}</span><strong title="${escapeHtml(step.name)}">${escapeHtml(step.name || `Etapa ${index + 1}`)}</strong></div>
            <div class="timeline-compare-track" data-track-start="${comparisonStart}" data-track-span="${comparisonDuration}" ${rowTip} style="${timelineGrid}" aria-label="${escapeHtml(step.name || `Etapa ${index + 1}`)}: planejado ${escapeHtml(step.plannedStart || "—")} a ${escapeHtml(step.plannedEnd || "—")}; realizado ${escapeHtml(actualText)}">
              <div class="timeline-lane timeline-planned-lane"><i tabindex="0" ${plannedTip} style="left:${comparisonPosition(step.start)}%;width:${comparisonWidth(step.start, step.end)}%"></i></div>
              <div class="timeline-lane timeline-actual-lane">${step.actualStartMinutes != null && !isStepSkipped(step) ? `<i tabindex="0" ${actualTip} class="${runningStep ? "running" : "complete"}" style="left:${comparisonPosition(step.actualStartMinutes)}%;width:${comparisonWidth(step.actualStartMinutes, actualEnd)}%"></i>` : ""}</div>
            </div>
            <div class="timeline-compare-times"><span><b>P</b>${escapeHtml(step.plannedStart || "—")}–${escapeHtml(step.plannedEnd || "—")}</span><span class="${runningStep ? "running" : isStepComplete(step) ? "complete" : "waiting"}"><b>R</b>${escapeHtml(actualText)}</span></div>
          </div>`;
        }).join("")}${timelineAxisHtml(timelineScaleInfo.ticks, comparisonStart, comparisonDuration)}`;
      bindTimelineTooltip(timelineHost);
      restorePinnedChartTooltip(timelineHost);

      $("#duration-chart").innerHTML = timeline.steps.length ? timeline.steps.map((step, index) => `
        <div class="duration-row">
          <div class="duration-label"><span>${String(index + 1).padStart(2, "0")}</span><strong title="${escapeHtml(step.name)}">${escapeHtml(step.name || `Etapa ${index + 1}`)}</strong></div>
          <div class="duration-bars">
            <div class="chart-bar-line"><i class="planned" style="width:${Math.max(2, ((step.duration || 0) / maxDuration) * 100)}%"></i><b>${formatMinutes(step.duration)}</b></div>
            <div class="chart-bar-line"><i class="actual" style="width:${step.actualDuration == null ? 0 : Math.max(2, (step.actualDuration / maxDuration) * 100)}%"></i><b>${step.actualDuration == null ? "—" : formatMinutes(step.actualDuration)}</b></div>
          </div>
        </div>`).join("") : `<div class="chart-empty">Adicione etapas ao planejamento para gerar o gráfico.</div>`;

      $("#completion-ring").style.setProperty("--progress", `${progress * 3.6}deg`);
      $("#completion-value").textContent = `${progress}%`;
      $("#completion-breakdown").innerHTML = `
        <span><i class="complete"></i><strong>${completed.length}</strong> concluídas</span>
        <span><i class="running"></i><strong>${running.length}</strong> em andamento</span>
        <span><i class="waiting"></i><strong>${Math.max(0, timeline.steps.length - resolved.length - running.length)}</strong> aguardando</span>
        ${skipped.length ? `<span><i class="skipped"></i><strong>${skipped.length}</strong> não executada${skipped.length > 1 ? "s" : ""}</span>` : ""}`;

      const varianceSteps = timeline.steps.filter((step) => isStepComplete(step) && step.end != null);
      const maxVariance = Math.max(1, ...varianceSteps.map((step) => Math.abs(step.actualEndMinutes - step.end)));
      $("#variance-chart").innerHTML = varianceSteps.length ? varianceSteps.map((step) => {
        const value = Math.round(step.actualEndMinutes - step.end);
        const width = Math.max(value === 0 ? 2 : 8, (Math.abs(value) / maxVariance) * 48);
        return `<div class="variance-row"><span>${String(step.index + 1).padStart(2, "0")}</span><div class="variance-axis"><i class="${value > 0 ? "delay" : value < 0 ? "ahead" : "on-time"}" style="width:${width}%;${value < 0 ? "right:50%" : "left:50%"}"></i></div><strong>${value > 0 ? "+" : ""}${value} min</strong></div>`;
      }).join("") : `<div class="chart-empty">Conclua uma etapa para visualizar os desvios.</div>`;

      $("#dashboard-table-body").innerHTML = timeline.steps.length ? timeline.steps.map((step) => {
        const status = statusFor(step, nowAbs);
        const scheduleDiff = status.variance;
        return `<tr><td><strong>${escapeHtml(step.name || "Etapa sem nome")}</strong><small>${escapeHtml(step.plannedStart || "—")}–${escapeHtml(step.plannedEnd || "—")}</small></td><td>${formatMinutes(step.duration)}</td><td>${step.actualDuration == null ? "—" : formatMinutes(step.actualDuration)}</td><td>${scheduleDiff == null ? "—" : `${scheduleDiff > 0 ? "+" : ""}${scheduleDiff} min`}</td><td><span class="table-status ${status.className}">${status.label}</span></td></tr>`;
      }).join("") : `<tr><td colspan="5">Nenhuma etapa cadastrada.</td></tr>`;
    }

    selector.addEventListener("change", () => {
      selectPlan(selector.value);
      render();
    });

    $("#export-dashboard-xlsx").addEventListener("click", async () => {
      try { await exportPlanFromButton($("#export-dashboard-xlsx"), activePlan()); } catch (_) { /* feedback exibido */ }
    });
    $("#export-dashboard-pdf").addEventListener("click", () => exportPageToPdf($("#export-dashboard-pdf"), `dashboard-${activePlan()?.title || "intervalo"}`, "Exportar PDF", "dashboard-printing"));

    const requestedPlan = new URLSearchParams(location.search).get("plan");
    if (requestedPlan) selectPlan(requestedPlan);
    renderPlanOptions();
    render();
    pageRefreshHandler = () => { renderPlanOptions(); render(); };
    setInterval(render, 1000);
  }

  function renderAuthControls() {
    const tools = $(".header-tools");
    if (!tools || $("[data-auth-button]", tools)) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "auth-button";
    button.dataset.authButton = "";
    button.textContent = currentUser ? "Minha conta" : "Entrar";
    button.addEventListener("click", () => currentUser ? location.assign("conta.html") : openAuthDialog());
    tools.prepend(button);
  }

  function renderRoleNavigation() {
    const nav = $(".primary-nav");
    if (!nav || !currentProfile) return;
    let links;
    if (isOperatorRole(currentProfile.role)) {
      links = [["index.html", "Planejar", "planning"], ["executar.html", "Executar", "execution"], ["dashboard.html", "Dashboard", "dashboard"], ["gestao.html?view=history", "Histórico", "management"], ["conta.html", "Minha conta", "account"]];
    } else if (currentProfile.role === "editor") {
      links = [["gestao.html", "Gestão", "management"], ["index.html", "Planejar", "planning"], ["executar.html", "Executar", "execution"], ["dashboard.html", "Dashboard", "dashboard"], ["admin.html", "Administração", "admin"], ["conta.html", "Minha conta", "account"]];
    } else if (READ_ONLY_MANAGEMENT_ROLES.includes(currentProfile.role)) {
      links = [["gestao.html", "Gestão", "management"], ["conta.html", "Minha conta", "account"]];
    } else {
      links = [["conta.html", "Minha conta", "account"]];
    }
    nav.style.setProperty("--nav-count", links.length);
    nav.innerHTML = links.map(([href, label, target], index) => `<a href="${href}" class="${page === target ? "active" : ""}" ${page === target ? 'aria-current="page"' : ""}><span>${index + 1}</span>${escapeHtml(label)}</a>`).join("");
  }

  function routeAllowedForRole() {
    if (!["planning", "execution", "dashboard"].includes(page)) return true;
    return ["coordinator", "specialist", "editor"].includes(currentProfile?.role);
  }

  function createDialog(className, content) {
    const existing = $(`.${className}`);
    if (existing) existing.remove();
    const dialog = document.createElement("dialog");
    dialog.className = `cloud-dialog ${className}`;
    dialog.innerHTML = content;
    document.body.append(dialog);
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", () => dialog.remove());
    dialog.showModal();
    return dialog;
  }

  function openAuthDialog() {
    const dialog = createDialog("auth-dialog", `<form method="dialog" class="cloud-dialog-content" id="auth-form">
      <button class="dialog-close" type="button" aria-label="Fechar">×</button>
      <p class="section-kicker">Dados protegidos no Supabase</p>
      <h2>Entrar na Gestão de Intervalo</h2>
      <p>Use seu e-mail para acessar os mesmos planos em qualquer dispositivo.</p>
      <label class="field"><span>E-mail</span><input name="email" type="email" autocomplete="email" required></label>
      <label class="field"><span>Senha</span><input name="password" type="password" minlength="6" autocomplete="current-password" required></label>
      <div class="cloud-dialog-actions">
        <button class="button button-ghost" type="button" data-sign-up>Criar conta</button>
        <button class="button button-secondary" type="submit">Entrar</button>
      </div>
      <span class="auth-feedback" role="status" aria-live="polite"></span>
    </form>`);
    const form = $("#auth-form", dialog);
    const feedback = $(".auth-feedback", dialog);
    $(".dialog-close", dialog).addEventListener("click", () => dialog.close());

    async function authenticate(mode) {
      if (!form.reportValidity()) return;
      const email = form.email.value.trim();
      const password = form.password.value;
      if (mode === "signup" && email.toLowerCase() !== "erwin.klein@ext.rumolog.com") {
        feedback.textContent = "Novas contas devem ser criadas por um editor.";
        return;
      }
      feedback.textContent = mode === "signup" ? "Criando conta…" : "Entrando…";
      const result = mode === "signup"
        ? await cloudClient.auth.signUp({ email, password })
        : await cloudClient.auth.signInWithPassword({ email, password });
      if (result.error) {
        feedback.textContent = result.error.message === "Invalid login credentials" ? "E-mail ou senha inválidos." : result.error.message;
        return;
      }
      if (mode === "signup" && !result.data.session) {
        feedback.textContent = "Conta criada. Confirme o e-mail recebido e depois entre no site.";
        return;
      }
      dialog.close();
      location.reload();
    }

    form.addEventListener("submit", (event) => { event.preventDefault(); authenticate("signin"); });
    $("[data-sign-up]", dialog).addEventListener("click", () => authenticate("signup"));
  }

  function openAccountDialog() {
    const dialog = createDialog("account-dialog", `<div class="cloud-dialog-content">
      <button class="dialog-close" type="button" aria-label="Fechar">×</button>
      <p class="section-kicker">Conta conectada</p>
      <h2>Dados salvos na nuvem</h2>
      <p class="account-email">${escapeHtml(currentUser.email || "Usuário Supabase")}</p>
      <p>Seus planos e registros de execução estão associados a esta conta.</p>
      <div class="cloud-dialog-actions"><button class="button button-ghost" type="button" data-sign-out>Sair da conta</button></div>
    </div>`);
    $(".dialog-close", dialog).addEventListener("click", () => dialog.close());
    $("[data-sign-out]", dialog).addEventListener("click", async () => {
      await cloudClient.auth.signOut();
      localStorage.removeItem(activeStorageKey);
      location.replace("login.html");
    });
  }

  async function loadCloudStore() {
    const { data, error } = await cloudClient
      .from("interval_plans")
      .select("*,interval_steps(*)")
      .order("updated_at", { ascending: false });
    if (error) throw error;
    if (!data.length) {
      const first = store.plans.find((plan) => !plan.isExample) || blankPlan();
      store = { version: 4, activePlanId: first.id, plans: [first], deletedPlanIds: [], pendingSync: false };
      writeStoreLocally();
      return;
    }
    const plans = data.map(databaseToPlan);
    const activeId = plans.some((plan) => plan.id === store.activePlanId) ? store.activePlanId : plans[0].id;
    store = { version: 4, activePlanId: activeId, plans, deletedPlanIds: [] };
    store.pendingSync = false;
    writeStoreLocally();
  }

  async function refreshCloudStore() {
    if (!cloudClient || !currentUser || cloudRefreshRunning || cloudSyncing || store.pendingSync || document.hidden) return;
    cloudRefreshRunning = true;
    try {
      const { data, error } = await cloudClient
        .from("interval_plans")
        .select("*,interval_steps(*)")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      if (!data.length) return;
      const plans = data.map(databaseToPlan);
      const activeId = plans.some((item) => item.id === store.activePlanId) ? store.activePlanId : plans[0].id;
      const incomingSignature = JSON.stringify(plans.map((item) => [item.id, item.updatedAt, item.steps.map((step) => [step.id, step.actualStart, step.actualEnd, step.executionStatus, step.actualNotes])]));
      const currentSignature = JSON.stringify(store.plans.map((item) => [item.id, item.updatedAt, item.steps.map((step) => [step.id, step.actualStart, step.actualEnd, step.executionStatus, step.actualNotes])]));
      if (incomingSignature === currentSignature) return;
      store = { version: 4, activePlanId: activeId, plans, deletedPlanIds: [], pendingSync: false };
      writeStoreLocally();
      pageRefreshHandler?.();
      setSyncState("Sincronizado", "saved");
    } catch (error) {
      console.warn("Não foi possível atualizar os dados da nuvem.", error);
    } finally {
      cloudRefreshRunning = false;
    }
  }

  function startCloudRefresh() {
    clearInterval(cloudRefreshTimer);
    if (!cloudClient || !currentUser || !["execution", "dashboard"].includes(page)) return;
    cloudRefreshTimer = setInterval(refreshCloudStore, 10000);
  }

  function initializeCurrentPage() {
    if (pageInitialized) return;
    pageInitialized = true;
    if (page === "planning") planningPage();
    if (page === "execution") executionPage();
    if (page === "dashboard") dashboardPage();
    if (page === "account") accountPage();
    if (page === "shared") sharedPage();
  }

  async function initializeCloud() {
    if (!window.supabase?.createClient) {
      console.warn("Biblioteca do Supabase indisponível.");
      return;
    }
    cloudClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    const { data: { session } } = await cloudClient.auth.getSession();
    currentUser = session?.user || null;
    if (page === "login") {
      if (currentUser) {
        const { data: profile } = await cloudClient.from("user_profiles").select("role,enabled").eq("id", currentUser.id).single();
        if (profile?.enabled) location.replace(["coordinator", "specialist", "editor"].includes(profile.role) ? "index.html" : "gestao.html");
        else loginPage();
      } else loginPage();
      return;
    }
    renderAuthControls();
    const state = $("#save-state");
    if (!currentUser) {
      location.replace("login.html");
      return;
    }
    const { data: profile } = await cloudClient.from("user_profiles").select("*").eq("id", currentUser.id).single();
    currentProfile = profile || null;
    if (!currentProfile?.enabled) {
      await cloudClient.auth.signOut();
      localStorage.removeItem(activeStorageKey);
      location.replace("login.html?status=disabled");
      return;
    }

    sessionStorage.removeItem("gestaoIntervaloRumo.dataset");
    sessionStorage.removeItem("gestaoIntervaloRumo.demoPersona");
    renderRoleNavigation();
    if (!routeAllowedForRole()) {
      location.replace("gestao.html");
      return;
    }

    activeStorageKey = `${STORAGE_KEY}.${currentUser.id}`;
    loadOutbox();
    const hasUserStore = Boolean(localStorage.getItem(activeStorageKey));
    if (hasUserStore) {
      store = loadStore();
    } else if (currentProfile.role === "editor" && localStorage.getItem(STORAGE_KEY)) {
      // Migra com segurança os dados da versão anterior, que ainda usava uma chave local única.
      store.pendingSync = true;
      normalizeStore(store);
      store.plans.filter((plan) => !plan.isExample).forEach((plan) => { plan.ownerId ||= currentUser.id; dirtyPlanIds.add(plan.id); });
      writeStoreLocally();
    } else {
      const first = blankPlan();
      store = { version: 4, activePlanId: first.id, plans: [first], deletedPlanIds: [], pendingSync: false };
      writeStoreLocally();
    }

    $("#example-plan-button")?.remove();
    const hadExamples = store.plans.some((plan) => plan.isExample);
    store.plans = store.plans.filter((plan) => !plan.isExample);
    if (!store.plans.length) store.plans = [blankPlan()];
    if (!store.plans.some((plan) => plan.id === store.activePlanId)) store.activePlanId = store.plans[0].id;
    if (hadExamples) writeStoreLocally();
    if (store.pendingSync && !outbox.length && !dirtyPlanIds.size) {
      store.plans.filter((plan) => !plan.ownerId || plan.ownerId === currentUser.id).forEach((plan) => dirtyPlanIds.add(plan.id));
    }
    setSyncState("Sincronizando", "syncing");
    try {
      if (store.pendingSync || outbox.length || dirtyPlanIds.size) {
        cloudSyncPending = true;
        await syncStoreToCloud();
      }
      if (!store.pendingSync) await loadCloudStore();
      setSyncState(store.pendingSync ? "Pendente de sincronização" : "Sincronizado", store.pendingSync ? "pending" : "saved");
    } catch (error) {
      console.error("Falha ao carregar dados do Supabase.", error);
      setSyncState("Erro de sincronização", "error");
    } finally {
      document.documentElement.classList.remove("auth-checking");
      initializeCurrentPage();
      startCloudRefresh();
    }
  }

  function loginPage() {
    const form = $("#login-form");
    const feedback = $("#login-feedback");
    if (new URLSearchParams(location.search).get("status") === "disabled") feedback.textContent = "Esta conta está desabilitada. Procure um editor.";
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = $("button[type='submit']", form);
      button.disabled = true;
      button.textContent = "Verificando acesso…";
      feedback.textContent = "";
      const { data, error } = await cloudClient.auth.signInWithPassword({ email: form.email.value.trim(), password: form.password.value });
      if (error || !data.user) {
        feedback.textContent = "E-mail ou senha inválidos.";
        button.disabled = false;
        button.textContent = "Entrar no sistema";
        return;
      }
      const { data: profile } = await cloudClient.from("user_profiles").select("enabled,role").eq("id", data.user.id).single();
      if (!profile?.enabled) {
        await cloudClient.auth.signOut();
        feedback.textContent = "Esta conta está desabilitada. Procure um editor.";
        button.disabled = false;
        button.textContent = "Entrar no sistema";
        return;
      }
      location.replace(["coordinator", "specialist", "editor"].includes(profile.role) ? "index.html" : "gestao.html");
    });
  }

  function sharedPage() {
    const params = new URLSearchParams(location.search);
    const token = params.get("token") || "";
    const requestedPlanId = params.get("plan") || "";
    const requestedView = params.get("view") || "plan";
    const demoPersonaId = params.get("persona") || "";
    const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const internalMode = Boolean(requestedPlanId);
    const demoMode = internalMode && params.get("dataset") === "demo";
    const loading = $("#shared-loading");
    const errorPanel = $("#shared-error");
    const content = $("#shared-content");
    let sharedPlan = null;
    let internalClient = null;
    let internalUserVerified = false;
    let refreshTimer = null;
    let clockTimer = null;

    $("#export-shared-xlsx").addEventListener("click", async () => {
      if (!sharedPlan) return;
      try { await exportPlanFromButton($("#export-shared-xlsx"), sharedPlan); } catch (_) { /* estado do botão restaurado */ }
    });
    $("#export-shared-pdf").addEventListener("click", () => {
      if (!sharedPlan) return;
      exportPageToPdf($("#export-shared-pdf"), `acompanhamento-${sharedPlan.title || "intervalo"}`, "Exportar PDF", "shared-printing");
    });

    function renderSharedClock() {
      const now = new Date();
      $("#shared-live-clock").textContent = now.toLocaleTimeString("pt-BR", { hour12: false });
      $("#shared-live-date").textContent = now.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" });
    }

    function showError(message) {
      loading.hidden = true;
      content.hidden = true;
      errorPanel.hidden = false;
      $("#shared-error-message").textContent = message;
    }

    function sharedStepStatus(step, nowAbs) {
      const variance = wholeMinutes(stepScheduleDeviation(step, nowAbs));
      if (isStepSkipped(step)) return { label: "Não executada", className: "skipped", variance: null };
      if (isStepComplete(step)) return variance > 0
        ? { label: "Concluída com atraso", className: "delay", variance }
        : variance < 0 ? { label: "Concluída adiantada", className: "ahead", variance } : { label: "Concluída no prazo", className: "on-time", variance: 0 };
      if (step.actualStartMinutes != null) return variance > 0
        ? { label: "Em andamento · iniciou atrasada", className: "delay", variance }
        : variance < 0 ? { label: "Em andamento · iniciou adiantada", className: "ahead", variance } : { label: "Em andamento · iniciou no horário", className: "running", variance: 0 };
      if (variance > 0) return { label: "Prazo vencido sem iniciar", className: "delay", variance };
      if (isStartOverdue(step, nowAbs)) return { label: "Início atrasado", className: "waiting", variance: null };
      return { label: "Aguardando", className: "waiting", variance: null };
    }

    function renderSharedPlan(plan, metadata) {
      sharedPlan = plan;
      const timeline = buildTimeline(plan);
      const resolved = timeline.steps.filter(isStepResolved);
      const running = timeline.steps.filter((step) => step.actualStartMinutes != null && step.actualEndMinutes == null && !isStepSkipped(step));
      const execution = executionStatus(plan, timeline);
      const nowAbs = execution.nowAbs;
      const deviation = execution.delay == null ? null : wholeMinutes(execution.delay);
      const forecast = execution.projectedEnd;
      const baselineText = execution.baseline == null ? "—" : absoluteToTime(execution.baseline);
      const forecastText = forecast == null ? "—" : absoluteToTime(Math.floor(forecast));
      const waitingStart = !execution.started && (deviation == null || deviation <= 0);
      const showDeviation = execution.live && deviation != null && !waitingStart;
      const progress = timeline.steps.length ? Math.round((resolved.length / timeline.steps.length) * 100) : 0;
      const plannedTotal = timeline.steps.reduce((sum, step) => sum + (step.duration || 0), 0);
      const elapsedInterval = intervalElapsedTime(timeline, nowAbs);

      $("#shared-title").textContent = plan.title || "Intervalo sem nome";
      $("#shared-subtitle").textContent = [plan.date && new Date(`${plan.date}T12:00:00`).toLocaleDateString("pt-BR"), plan.serviceType, plan.location, plan.coordinator && `Responsável: ${plan.coordinator}`].filter(Boolean).join(" · ") || "Acompanhamento operacional";
      $("#shared-updated").textContent = `Atualizado às ${new Date(metadata.fetched_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
      if (metadata.access_mode === "profile") {
        $("#shared-access-title").textContent = "Acesso conforme o seu perfil";
        $("#shared-access-description").textContent = "Página completa somente para consulta, com os mesmos limites de acesso da visão gerencial.";
        $("#shared-expiry").textContent = demoMode ? "Ambiente de demonstração" : "Sessão autenticada";
      } else {
        $("#shared-access-title").textContent = "Acesso somente para consulta";
        $("#shared-access-description").textContent = "Este link não permite alterar planejamento, horários ou registros. Solicite ao coordenador um novo link caso este expire.";
        $("#shared-expiry").textContent = `Link válido até ${new Date(metadata.share.expires_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}`;
      }
      $("#shared-plan-summary").innerHTML = [
        ["Título", plan.title || "—"], ["Tipo", plan.serviceType || "—"], ["Data", plan.date ? new Date(`${plan.date}T12:00:00`).toLocaleDateString("pt-BR") : "—"],
        ["Local", plan.location || "—"], ["Responsável", plan.coordinator || "—"], ["Janela", plan.windowStart && plan.windowEnd ? `${plan.windowStart}–${plan.windowEnd}` : "—"]
      ].map(([label, value]) => `<div><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
      $("#shared-planning-notes").textContent = plan.notes || "Nenhuma observação registrada.";
      $("#shared-planned-steps").innerHTML = timeline.steps.map((step, index) => `<article><span>${String(index + 1).padStart(2, "0")}</span><div><strong>${escapeHtml(step.name || `Etapa ${index + 1}`)}</strong><small>Planejado · ${escapeHtml(step.plannedStart || "—")}–${escapeHtml(step.plannedEnd || "—")}</small></div></article>`).join("") || `<div class="chart-empty">Nenhuma etapa cadastrada.</div>`;
      const sharedComments = metadata.comments || [];
      $("#shared-comment-count").textContent = sharedComments.length;
      $("#shared-comments").innerHTML = sharedComments.length ? sharedComments.map((comment) => `<article class="interval-comment"><header><span><strong>${escapeHtml(comment.author_name)}</strong><i>${escapeHtml(ROLE_LABELS[comment.author_role] || comment.author_role)}</i></span><time>${new Date(comment.created_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</time></header><p>${escapeHtml(comment.content)}</p></article>`).join("") : `<div class="chart-empty">Nenhum comentário registrado.</div>`;

      const hasLate = execution.lateNow.length > 0 || execution.lateFinished.length > 0;
      const status = $("#shared-status");
      status.className = `shared-status ${
        !showDeviation ? "status-neutral"
          : deviation > 0 ? "status-delay"
          : deviation < 0 ? "status-ahead"
          : hasLate ? "status-warn" : "status-on-time"
      }`;
      $("#shared-status-sign").textContent = !showDeviation ? "" : deviation > 0 ? "+" : deviation < 0 ? "−" : "";
      $("#shared-status-minutes").textContent = !showDeviation ? "—" : Math.abs(deviation);
      $("#shared-status-label").textContent = !execution.live
        ? "Acompanhamento ao vivo indisponível"
        : waitingStart ? "Aguardando início da execução"
        : execution.finished
          ? (deviation > 0 ? "Intervalo encerrado com atraso" : deviation < 0 ? "Intervalo encerrado adiantado" : "Intervalo encerrado no horário")
          : deviation > 0 ? "Execução atrasada"
          : deviation < 0 ? "Execução adiantada"
          : hasLate ? "Dentro do prazo, com desvios individuais" : "Execução dentro do prazo";
      $("#shared-status-readable").hidden = !showDeviation;
      $("#shared-status-readable").textContent = showDeviation
        ? `${Math.abs(deviation)} min${Math.abs(deviation) >= 60 ? ` · ${formatHoursMinutes(deviation)}` : ""} · marco mais avançado da sequência`
        : "";
      renderSharedClock();
      $("#shared-forecast").textContent = absoluteToClock(forecast);
      $("#shared-forecast-note").textContent = forecast == null
        ? "Aguardando primeiro marco"
        : `Planejado ${baselineText}${plan.windowEnd && plan.windowEnd !== baselineText ? ` · prazo final ${plan.windowEnd}` : ""}`;

      $("#shared-window").textContent = plan.windowStart && plan.windowEnd ? `${plan.windowStart}–${plan.windowEnd}` : "—";
      $("#shared-window-note").textContent = timeline.duration == null ? "Janela não definida" : formatMinutes(timeline.duration);
      $("#shared-progress").textContent = `${resolved.length} / ${timeline.steps.length}`;
      $("#shared-progress-note").textContent = `${progress}% das etapas encerradas`;
      $("#shared-current").textContent = running.length > 1 ? `${running.length} simultâneas` : running[0]?.name || (resolved.length === timeline.steps.length && timeline.steps.length ? "Concluído" : "Aguardando");
      $("#shared-current-note").textContent = running.length ? running.map((step) => `Desde ${step.actualStart}`).join(" · ") : "Nenhuma etapa em andamento";

      $("#shared-steps").innerHTML = timeline.steps.map((step, index) => {
        const stepStatus = sharedStepStatus(step, nowAbs);
        const realized = isStepSkipped(step) ? "Não executada" : step.actualStart ? `${step.actualStart}–${step.actualEnd || "em andamento"}` : "Ainda não iniciada";
        return `<article class="shared-step ${stepStatus.className}">
          <header><span>${String(index + 1).padStart(2, "0")}</span><div><h3>${escapeHtml(step.name || `Etapa ${index + 1}`)}</h3><small>${stepStatus.label}</small></div>${stepStatus.variance == null ? "" : `<b>${stepStatus.variance > 0 ? "+" : ""}${stepStatus.variance} min</b>`}</header>
          <div class="shared-step-times"><p><span>Planejado</span><strong>${escapeHtml(step.plannedStart || "—")}–${escapeHtml(step.plannedEnd || "—")}</strong><small>${formatMinutes(step.duration)}</small></p><p><span>Realizado</span><strong>${escapeHtml(realized)}</strong><small>${(() => {
            if (step.actualDuration != null) return formatMinutes(step.actualDuration);
            const burn = stepDurationBurn(step, nowAbs);
            if (!burn) return "Duração em aberto";
            if (burn.planned == null) return `${formatMinutes(burn.elapsed)} em curso`;
            return `${formatMinutes(burn.elapsed)} de ${formatMinutes(burn.planned)}${wholeMinutes(burn.over) > 0 ? ` · ${formatMinutes(burn.over)} a mais` : ""}`;
          })()}</small></p></div>
          ${step.actualNotes ? `<p class="shared-step-note"><span>Registro operacional</span>${escapeHtml(step.actualNotes)}</p>` : ""}
        </article>`;
      }).join("") || `<div class="chart-empty">Nenhuma etapa cadastrada.</div>`;

      $("#shared-dashboard-progress").textContent = `${progress}%`;
      $("#shared-dashboard-progress-note").textContent = `${resolved.length} de ${timeline.steps.length} etapas encerradas`;
      $("#shared-dashboard-planned").textContent = plannedTotal ? formatMinutes(plannedTotal) : "—";
      $("#shared-dashboard-actual").textContent = elapsedInterval.minutes == null ? "—" : formatMinutes(elapsedInterval.minutes);
      $("#shared-dashboard-actual-note").textContent = elapsedInterval.start == null
        ? "Aguardando o primeiro início realizado"
        : elapsedInterval.finished
          ? `${absoluteToTime(elapsedInterval.start)}–${absoluteToTime(elapsedInterval.end)} · intervalo encerrado`
          : elapsedInterval.end == null
            ? "Horário atual indisponível para a data deste plano"
            : `Desde ${absoluteToTime(elapsedInterval.start)} até agora · períodos concomitantes contam uma vez`;
      $("#shared-dashboard-variance").textContent = deviation == null
        ? "—"
        : deviation > 0 ? `Atrasado ${deviation} min`
          : deviation < 0 ? `Adiantado ${Math.abs(deviation)} min` : "Dentro do prazo";
      $("#shared-dashboard-variance-label").textContent = "Situação do cronograma em execução";
      $("#shared-dashboard-variance-note").textContent = deviation == null
        ? "Aguardando o primeiro marco a comparar"
        : `Marco mais avançado da sequência · previsão ${forecastText}`;
      $("#shared-dashboard-variance-card").className = `dashboard-kpi featured ${deviation == null ? "variance-neutral" : deviation > 0 ? "variance-positive" : deviation < 0 ? "variance-negative" : "variance-zero"}`;

      const activeTimelineEnd = (step) => step.actualEndMinutes ?? (step.actualStartMinutes != null ? nowAbs ?? step.actualStartMinutes : null);
      const values = [timeline.windowStart, timeline.windowEnd];
      timeline.steps.forEach((step) => values.push(step.start, step.end, step.actualStartMinutes, activeTimelineEnd(step)));
      const valid = values.filter(Number.isFinite);
      const comparisonStart = valid.length ? Math.min(...valid) : null;
      const comparisonEnd = valid.length ? Math.max(...valid) : null;
      const comparisonDuration = comparisonStart != null && comparisonEnd != null ? Math.max(1, comparisonEnd - comparisonStart) : null;
      const position = (value) => comparisonDuration == null || value == null ? 0 : Math.max(0, Math.min(100, ((value - comparisonStart) / comparisonDuration) * 100));
      const width = (start, end) => start == null || end == null ? 0 : Math.max(.8, position(end) - position(start));
      const sharedTimelineHost = $("#shared-timeline");
      const sharedScale = comparisonDuration == null ? null : timelineScale(comparisonStart, comparisonEnd, timelineAvailablePx(sharedTimelineHost));
      const sharedGrid = sharedScale ? timelineGridStyle(sharedScale.ticks, comparisonStart, comparisonDuration) : "";
      $("#shared-timeline-range").textContent = comparisonDuration == null
        ? "Horários não definidos"
        : `${absoluteToTime(comparisonStart)}–${absoluteToTime(comparisonEnd)} · ${formatMinutes(comparisonDuration)} · marcas a cada ${formatMinutes(sharedScale.step)}`;
      hideChartTooltip();
      sharedTimelineHost.innerHTML = comparisonDuration == null ? `<div class="chart-empty">Linha do tempo indisponível.</div>` : `${timeline.steps.map((step, index) => {
        const actualEnd = activeTimelineEnd(step);
        const isRunning = step.actualStartMinutes != null && step.actualEndMinutes == null && !isStepSkipped(step);
        const actualText = isStepSkipped(step) ? "Não executada" : step.actualStartMinutes == null ? "Aguardando" : `${absoluteToTime(step.actualStartMinutes)}–${isRunning ? "agora" : absoluteToTime(step.actualEndMinutes)}`;
        const stepStatus = sharedStepStatus(step, nowAbs);
        const elapsed = isRunning && actualEnd != null ? actualEnd - step.actualStartMinutes : null;
        const projection = execution.projection.byStep.get(step.id);
        const projectedEnd = projection && Number.isFinite(projection.projectedEnd) ? projection.projectedEnd : null;
        const tipInfo = {
          actualText,
          actualDurationText: step.actualDuration != null
            ? formatMinutes(step.actualDuration)
            : elapsed != null ? `${formatMinutes(elapsed)} até agora${step.duration != null && wholeMinutes(elapsed - step.duration) > 0 ? ` · ${formatMinutes(elapsed - step.duration)} a mais que o previsto` : ""}` : "",
          statusLabel: stepStatus.label,
          deviationText: stepStatus.variance == null ? "" : `${stepStatus.variance > 0 ? "+" : ""}${stepStatus.variance} min`,
          deviationTone: stepStatus.variance == null ? "" : stepStatus.variance > 0 ? "delay" : stepStatus.variance < 0 ? "ahead" : "on-time",
          forecastText: isStepSkipped(step) || isStepComplete(step) || projectedEnd == null
            ? ""
            : `${absoluteToTime(Math.floor(projectedEnd))}${step.end == null ? "" : ` (${wholeMinutes(projectedEnd - step.end) > 0 ? "+" : ""}${wholeMinutes(projectedEnd - step.end)} min vs. programado)`}`
        };
        const rowTip = timelineTipData(step, index, tipInfo);
        const plannedTip = timelineTipData(step, index, { ...tipInfo, kind: "Barra planejada" });
        const actualTip = timelineTipData(step, index, { ...tipInfo, kind: isRunning ? "Barra em andamento" : "Barra realizada" });
        return `<div class="timeline-compare-row"><div class="timeline-compare-label"><span>${String(index + 1).padStart(2, "0")}</span><strong title="${escapeHtml(step.name)}">${escapeHtml(step.name || `Etapa ${index + 1}`)}</strong></div><div class="timeline-compare-track" data-track-start="${comparisonStart}" data-track-span="${comparisonDuration}" ${rowTip} style="${sharedGrid}"><div class="timeline-lane timeline-planned-lane"><i tabindex="0" ${plannedTip} style="left:${position(step.start)}%;width:${width(step.start, step.end)}%"></i></div><div class="timeline-lane timeline-actual-lane">${step.actualStartMinutes != null && !isStepSkipped(step) ? `<i tabindex="0" ${actualTip} class="${isRunning ? "running" : "complete"}" style="left:${position(step.actualStartMinutes)}%;width:${width(step.actualStartMinutes, actualEnd)}%"></i>` : ""}</div></div><div class="timeline-compare-times"><span><b>P</b>${escapeHtml(step.plannedStart || "—")}–${escapeHtml(step.plannedEnd || "—")}</span><span class="${isRunning ? "running" : isStepComplete(step) ? "complete" : "waiting"}"><b>R</b>${escapeHtml(actualText)}</span></div></div>`;
      }).join("")}${timelineAxisHtml(sharedScale.ticks, comparisonStart, comparisonDuration)}`;
      bindTimelineTooltip(sharedTimelineHost);
      restorePinnedChartTooltip(sharedTimelineHost);

      const maxDuration = Math.max(1, ...timeline.steps.flatMap((step) => [step.duration || 0, step.actualDuration || 0]));
      $("#shared-duration-chart").innerHTML = timeline.steps.map((step, index) => `<div class="duration-row"><div class="duration-label"><span>${String(index + 1).padStart(2, "0")}</span><strong title="${escapeHtml(step.name)}">${escapeHtml(step.name || `Etapa ${index + 1}`)}</strong></div><div class="duration-bars"><div class="chart-bar-line"><i class="planned" style="width:${Math.max(2, ((step.duration || 0) / maxDuration) * 100)}%"></i><b>${formatMinutes(step.duration)}</b></div><div class="chart-bar-line"><i class="actual" style="width:${step.actualDuration == null ? 0 : Math.max(2, (step.actualDuration / maxDuration) * 100)}%"></i><b>${step.actualDuration == null ? "—" : formatMinutes(step.actualDuration)}</b></div></div></div>`).join("") || `<div class="chart-empty">Nenhuma etapa cadastrada.</div>`;

      loading.hidden = true;
      errorPanel.hidden = true;
      content.hidden = false;
    }

    async function loadInternalPlan() {
      if (!window.supabase?.createClient) throw new Error("Biblioteca de autenticação indisponível.");
      if (!UUID_PATTERN.test(requestedPlanId)) throw new Error("O endereço não contém um intervalo válido.");
      if (demoMode && !UUID_PATTERN.test(demoPersonaId)) throw new Error("A persona de demonstração não é válida.");
      if (!internalClient) {
        const headers = demoMode ? { "x-dataset-context": "demo", "x-demo-persona-id": demoPersonaId } : {};
        internalClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
          global: { headers }
        });
      }
      if (!internalUserVerified) {
        const { data: { user }, error: userError } = await internalClient.auth.getUser();
        if (userError || !user) throw new Error("Sua sessão expirou. Entre novamente no sistema e abra o acompanhamento pela visão gerencial.");
        internalUserVerified = true;
      }
      const { data: plan, error } = await internalClient
        .from("interval_plans")
        .select("*,interval_steps(*),interval_comments(*)")
        .eq("id", requestedPlanId)
        .maybeSingle();
      if (error) throw error;
      if (!plan) throw new Error("Este intervalo não está disponível para o seu perfil.");
      renderSharedPlan(databaseToPlan(plan), {
        access_mode: "profile",
        fetched_at: new Date().toISOString(),
        comments: (plan.interval_comments || []).filter((comment) => !comment.deleted_at)
      });
    }

    async function loadSharedPlan(showLoading = false) {
      if (showLoading) { loading.hidden = false; errorPanel.hidden = true; content.hidden = true; }
      try {
        if (internalMode) {
          await loadInternalPlan();
          return;
        }
        if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) { showError("O endereço está incompleto ou não contém um código de acesso válido."); return; }
        const response = await fetch(`${SUPABASE_URL}/functions/v1/interval-share`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }), cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) { showError(payload.error || "O link expirou, foi revogado ou não existe."); clearInterval(refreshTimer); return; }
        renderSharedPlan(databaseToPlan(payload.plan), payload);
      } catch (error) {
        console.warn("Falha ao atualizar acompanhamento.", error);
        if (!sharedPlan) showError(error.message || "Não foi possível conectar ao acompanhamento. Verifique sua internet e tente novamente.");
        else $("#shared-updated").textContent = "Sem conexão · tentando novamente";
      }
    }

    function activateSharedView(tab) {
      $$('[data-shared-tab]').forEach((item) => {
        const active = item.dataset.sharedTab === tab;
        item.classList.toggle("active", active);
        item.setAttribute("aria-selected", String(active));
      });
      $$('[data-shared-view]').forEach((view) => { view.hidden = view.dataset.sharedView !== tab; });
    }
    $$('[data-shared-tab]').forEach((button) => button.addEventListener("click", () => activateSharedView(button.dataset.sharedTab)));
    activateSharedView(["plan", "execution", "dashboard"].includes(requestedView) ? requestedView : "plan");
    $("#shared-retry").addEventListener("click", () => loadSharedPlan(true));
    loadSharedPlan(true);
    refreshTimer = setInterval(() => loadSharedPlan(false), 10000);
    renderSharedClock();
    clockTimer = setInterval(renderSharedClock, 1000);
  }

  async function renderAccountHistory() {
    const gate = $("#account-gate");
    const content = $("#account-content");
    if (!currentUser || !currentProfile?.enabled) {
      gate.hidden = false;
      content.hidden = true;
      $("#account-login")?.addEventListener("click", openAuthDialog, { once: true });
      return;
    }
    gate.hidden = true;
    content.hidden = false;
    $("#account-name").textContent = currentProfile.full_name || "Usuário";
    $("#account-email").textContent = currentProfile.email;
    $("#account-role").textContent = ROLE_LABELS[currentProfile.role] || currentProfile.role;
    const personalPlans = store.plans.filter((plan) => plan.ownerId === currentUser.id);
    const databasePlanIds = personalPlans.map((plan) => plan.databaseId).filter(Boolean);
    const { data: shareRows, error: shareRowsError } = databasePlanIds.length
      ? await cloudClient.from("interval_share_links").select("id,plan_id,expires_at,revoked_at,token_hint").in("plan_id", databasePlanIds)
      : { data: [], error: null };
    if (shareRowsError) console.warn("Não foi possível consultar os links de acompanhamento.", shareRowsError);
    const shareByPlan = new Map((shareRows || []).map((share) => [share.plan_id, share]));
    const now = Date.now();
    $("#account-history").innerHTML = personalPlans.length ? [...personalPlans].sort((a,b)=>(b.date||"").localeCompare(a.date||"")).map((plan) => {
      const timeline = buildTimeline(plan);
      const resolved = timeline.steps.filter(isStepResolved).length;
      const share = shareByPlan.get(plan.databaseId);
      const activeShare = share && !share.revoked_at && new Date(share.expires_at).getTime() > now;
      const savedToken = activeShare ? sessionStorage.getItem(`intervalShareToken.${share.id}`) : "";
      const shareState = activeShare
        ? `<span class="share-state active"><i></i>Link ativo até ${new Date(share.expires_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</span>`
        : `<span class="share-state">Nenhum link ativo</span>`;
      return `<article class="history-item" data-plan-id="${escapeHtml(plan.id)}" data-database-id="${escapeHtml(plan.databaseId || "")}">
        <div class="history-main"><strong>${escapeHtml(plan.title || "Plano sem nome")}</strong><span>${plan.date ? new Date(`${plan.date}T12:00:00`).toLocaleDateString("pt-BR") : "Sem data"} · ${escapeHtml(plan.serviceType || "Serviço não informado")}</span>${shareState}</div>
        <div class="history-progress"><b>${resolved}/${plan.steps.length}</b><small>etapas encerradas</small></div>
        <div class="history-actions"><a class="button button-ghost" href="dashboard.html?plan=${encodeURIComponent(plan.id)}">Ver dashboard</a><button class="button ${activeShare ? "button-share-active" : "button-secondary"}" type="button" data-share-action="${activeShare && savedToken ? "copy" : "manage"}" data-share-id="${share?.id || ""}" data-token="${escapeHtml(savedToken)}">${activeShare && savedToken ? "Copiar link" : activeShare ? "Gerenciar link" : "Compartilhar"}</button></div>
      </article>`;
    }).join("") : `<div class="chart-empty">Nenhum intervalo registrado nesta conta.</div>`;

    $("#account-history").addEventListener("click", async (event) => {
      const button = event.target.closest("[data-share-action]");
      if (!button) return;
      const item = button.closest(".history-item");
        const plan = personalPlans.find((candidate) => candidate.id === item.dataset.planId);
      if (!plan?.databaseId) {
        showToast("Aguarde o intervalo terminar de salvar na nuvem.");
        return;
      }
      if (button.dataset.shareAction === "copy" && button.dataset.token) {
        await navigator.clipboard.writeText(sharedUrl(button.dataset.token));
        showToast("Link de acompanhamento copiado.");
        return;
      }
      openShareDialog(plan, shareByPlan.get(plan.databaseId) || null);
    });

    function openShareDialog(plan, existingShare) {
      const activeShare = existingShare && !existingShare.revoked_at && new Date(existingShare.expires_at).getTime() > Date.now();
      const savedToken = activeShare ? sessionStorage.getItem(`intervalShareToken.${existingShare.id}`) : "";
      const dialog = createDialog("share-dialog", `<div class="cloud-dialog-content share-dialog-content">
        <button class="dialog-close" type="button" aria-label="Fechar">×</button>
        <p class="section-kicker">Acompanhamento externo</p>
        <h2>${activeShare ? "Gerenciar link" : "Compartilhar intervalo"}</h2>
        <p>Quem receber o link poderá consultar a execução e o dashboard, mas não poderá alterar nenhuma informação.</p>
        ${activeShare ? `<div class="share-active-card"><strong>Link ativo</strong><span>Válido até ${new Date(existingShare.expires_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</span></div>` : `<label class="field"><span>Validade do link</span><select id="share-validity"><option value="24">24 horas</option><option value="72" selected>3 dias</option><option value="168">7 dias</option><option value="720">30 dias</option></select></label>`}
        <p class="auth-feedback" id="share-feedback"></p>
        <div class="cloud-dialog-actions share-dialog-actions">
          ${activeShare ? `<button class="button button-ghost" type="button" data-revoke-share>Revogar link</button><button class="button button-secondary" type="button" data-copy-share ${savedToken ? "" : "disabled"}>${savedToken ? "Copiar link" : "Link criado em outro dispositivo"}</button><button class="button button-share-active" type="button" data-regenerate-share>Gerar novo link</button>` : `<button class="button button-secondary" type="button" data-create-share>Gerar e copiar link</button>`}
        </div>
      </div>`);
      $(".dialog-close", dialog).addEventListener("click", () => dialog.close());
      const feedback = $("#share-feedback", dialog);

      async function createShare() {
        const actionButton = $("[data-create-share], [data-regenerate-share]", dialog);
        actionButton.disabled = true;
        feedback.textContent = "Gerando link seguro…";
        const token = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
        const tokenHash = await sha256Hex(token);
        const validity = Number($("#share-validity", dialog)?.value || 72);
        const expiresAt = new Date(Date.now() + validity * 60 * 60 * 1000).toISOString();
        const { data, error } = await cloudClient.from("interval_share_links").upsert({
          plan_id: plan.databaseId,
          owner_id: currentUser.id,
          token_hash: tokenHash,
          token_hint: token.slice(-6),
          expires_at: expiresAt,
          revoked_at: null,
          last_accessed_at: null,
        }, { onConflict: "plan_id" }).select("id").single();
        if (error) {
          feedback.textContent = "Não foi possível gerar o link. Tente novamente.";
          actionButton.disabled = false;
          console.error("Falha ao gerar link.", error);
          return;
        }
        sessionStorage.setItem(`intervalShareToken.${data.id}`, token);
        await navigator.clipboard.writeText(sharedUrl(token));
        showToast("Link seguro gerado e copiado.");
        dialog.close();
        location.reload();
      }

      $("[data-create-share]", dialog)?.addEventListener("click", createShare);
      $("[data-regenerate-share]", dialog)?.addEventListener("click", createShare);
      $("[data-copy-share]", dialog)?.addEventListener("click", async () => {
        await navigator.clipboard.writeText(sharedUrl(savedToken));
        showToast("Link de acompanhamento copiado.");
      });
      $("[data-revoke-share]", dialog)?.addEventListener("click", async () => {
        const revokeButton = $("[data-revoke-share]", dialog);
        revokeButton.disabled = true;
        feedback.textContent = "Revogando acesso…";
        const { error } = await cloudClient.from("interval_share_links").update({ revoked_at: new Date().toISOString() }).eq("id", existingShare.id);
        if (error) { feedback.textContent = "Não foi possível revogar o link."; revokeButton.disabled = false; return; }
        sessionStorage.removeItem(`intervalShareToken.${existingShare.id}`);
        showToast("Acesso ao intervalo revogado.");
        dialog.close();
        location.reload();
      });
    }

  }

  async function accountPage() {
    const gate = $("#account-gate");
    const content = $("#account-content");
    if (!currentUser || !currentProfile?.enabled) {
      gate.hidden = false;
      content.hidden = true;
      $("#account-login")?.addEventListener("click", openAuthDialog, { once: true });
      return;
    }
    gate.hidden = true;
    content.hidden = false;
    const roleLabel = ROLE_LABELS[currentProfile.role] || currentProfile.role;
    $("#account-name").textContent = currentProfile.full_name || "Usuário";
    $("#account-email").textContent = currentProfile.email;
    $("#account-role").textContent = roleLabel;
    $("#account-detail-name").textContent = currentProfile.full_name || "Não informado";
    $("#account-detail-email").textContent = currentProfile.email;
    $("#account-detail-role").textContent = roleLabel;
    $("#account-detail-enabled").textContent = currentProfile.enabled ? "Conta habilitada" : "Conta desabilitada";

    const [{ data: directory }, { data: managerLinks }] = await Promise.all([
      cloudClient.from("organization_members")
        .select("id,full_name,role,manager_id,coordinator_type,coordinator_types")
        .eq("enabled", true),
      cloudClient.from("manager_operator_assignments")
        .select("manager_member_id,operator_member_id")
        .eq("operator_member_id", currentProfile.organization_member_id)
    ]);
    const ownMember = (directory || []).find((member) => member.id === currentProfile.organization_member_id);
    const manager = (directory || []).find((member) => member.id === ownMember?.manager_id);
    const managerNames = (managerLinks || []).map((link) => (directory || []).find((member) => member.id === link.manager_member_id)?.full_name).filter(Boolean);
    const operator = isOperatorRole(currentProfile.role);
    const hasDirectManager = ["manager", "coordinator", "specialist"].includes(currentProfile.role);
    $("#account-manager-row").hidden = !hasDirectManager;
    $("#account-type-row").hidden = false;
    $("#account-detail-manager").textContent = isOperatorRole(currentProfile.role)
      ? managerNames.join(", ") || manager?.full_name || "Sem gestor direto definido"
      : manager?.full_name || "Sem gestor direto definido";
    const classificationLabels = { infrastructure: "Infraestrutura", superstructure: "Superestrutura", modernization: "Modernização" };
    const ownClassifications = (Array.isArray(ownMember?.coordinator_types) && ownMember.coordinator_types.length
      ? ownMember.coordinator_types
      : [ownMember?.coordinator_type]).map((entry) => classificationLabels[entry]).filter(Boolean);
    $("#account-detail-type").textContent = ownClassifications.join(" · ") || "Cadastro pendente de revisão";

    await renderAccountHistory();

    if (operator) {
      const primary = $("#account-primary-link");
      primary.href = "index.html";
      $("strong", primary).textContent = "Planejamento";
      $("small", primary).textContent = "Criar e revisar seus intervalos";
    }
    if (currentProfile.role === "editor") {
      $("#account-admin-link").hidden = false;
      $("#account-examples").hidden = false;
      $("#account-examples").addEventListener("click", () => {
        sessionStorage.setItem("gestaoIntervaloRumo.dataset", "demo");
        sessionStorage.removeItem("gestaoIntervaloRumo.demoPersona");
        location.assign("gestao.html");
      });
    }
    $("#account-sign-out").addEventListener("click", async () => {
      await cloudClient.auth.signOut();
      location.replace("login.html");
    });
  }

  if (window.__GESTAO_TEST_MODE__) {
    window.__GESTAO_TEST_API__ = { buildTimeline, executionStatus, intervalElapsedTime, operationalDeviation, stepScheduleDeviation, wholeMinutes, snapshotSignature, exportPlanToXlsx };
    return;
  }

  initializeTheme();
  window.addEventListener("online", () => {
    if (store.pendingSync) scheduleCloudSync(true);
    else refreshCloudStore();
  });
  window.addEventListener("focus", refreshCloudStore);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshCloudStore();
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== activeStorageKey || !event.newValue || (store.pendingSync && (cloudSyncPending || cloudSyncing || saveTimer))) return;
    try {
      const incoming = JSON.parse(event.newValue);
      if (!incoming || !Array.isArray(incoming.plans) || !incoming.plans.length) return;
      const currentActiveId = store.activePlanId;
      store = normalizeStore(incoming);
      store.activePlanId = store.plans.some((plan) => plan.id === currentActiveId) ? currentActiveId : store.plans[0].id;
      pageRefreshHandler?.();
    } catch (error) {
      console.warn("Não foi possível atualizar os dados de outra aba.", error);
    }
  });
  window.addEventListener("pagehide", () => {
    clearTimeout(saveTimer);
    if (store.pendingSync) scheduleCloudSync(true);
  });
  if (page === "shared") initializeCurrentPage();
  else initializeCloud();
})();
