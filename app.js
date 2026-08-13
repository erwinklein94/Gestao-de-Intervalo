(function () {
  "use strict";

  const STORAGE_KEY = "gestaoIntervaloRumo.v1";
  const THEME_KEY = "gestaoIntervaloRumo.theme";
  const SUPABASE_URL = "https://rzsybguxlueorjpsstmu.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_sHHGnU3rob-unvk-_CCdcA_Ut4omY23";
  const page = document.body.dataset.page;
  let activeStorageKey = window.__GESTAO_USER_ID__ ? `${STORAGE_KEY}.${window.__GESTAO_USER_ID__}` : STORAGE_KEY;
  let store = loadStore();
  let saveTimer;
  let toastTimer;
  let cloudClient = null;
  let currentUser = null;
  let currentProfile = null;
  let cloudTimer;
  let cloudSyncing = false;
  let cloudSyncPending = false;
  let localRevision = 0;
  let pageInitialized = false;

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
    return { id: uid(), name: "", plannedStart: "", plannedEnd: "", actualStart: "", actualEnd: "", actualNotes: "" };
  }

  function blankPlan(title = "Novo plano") {
    return {
      id: uid(),
      title,
      serviceType: "",
      coordinator: "",
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
        parsed.plans.forEach(normalizePlan);
        if (!parsed.plans.some((plan) => plan.id === parsed.activePlanId)) parsed.activePlanId = parsed.plans[0].id;
        return parsed;
      }
    } catch (error) {
      console.warn("Não foi possível ler os dados locais.", error);
    }
    const first = blankPlan();
    return { version: 1, activePlanId: first.id, plans: [first] };
  }

  function normalizePlan(plan) {
    plan.steps = Array.isArray(plan.steps) ? plan.steps : [];
    plan.executionNotes = plan.executionNotes || "";
    plan.steps.forEach((step) => {
      step.id = step.id || uid();
      step.name = step.name || "";
      step.plannedStart = step.plannedStart || step.start || "";
      step.plannedEnd = step.plannedEnd || step.end || "";
      step.actualStart = step.actualStart || "";
      step.actualEnd = step.actualEnd || "";
      step.actualNotes = step.actualNotes || "";
    });
  }

  function activePlan() {
    return store.plans.find((plan) => plan.id === store.activePlanId) || store.plans[0];
  }

  function persist(immediate = false) {
    const plan = activePlan();
    if (plan) plan.updatedAt = new Date().toISOString();
    store.pendingSync = Boolean(currentUser);
    localRevision += 1;
    localStorage.setItem(activeStorageKey, JSON.stringify(store));
    const state = $("#save-state");
    if (state) state.textContent = "Salvando…";
    clearTimeout(saveTimer);
    if (immediate) scheduleCloudSync(true);
    else saveTimer = setTimeout(() => scheduleCloudSync(false), 260);
  }

  function planToDatabase(plan) {
    return {
      user_id: currentUser.id,
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
      is_example: Boolean(plan.isExample),
      created_at: plan.createdAt || new Date().toISOString(),
      updated_at: plan.updatedAt || new Date().toISOString()
    };
  }

  function databaseToPlan(row) {
    return {
      id: row.client_id,
      databaseId: row.id,
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
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      steps: (row.interval_steps || []).sort((a, b) => a.position - b.position).map((step) => ({
        id: step.client_id,
        databaseId: step.id,
        name: step.activity_name,
        plannedStart: (step.planned_start || "").slice(0, 5),
        plannedEnd: (step.planned_end || "").slice(0, 5),
        actualStart: (step.actual_start || "").slice(0, 5),
        actualEnd: (step.actual_end || "").slice(0, 5),
        actualNotes: step.actual_notes
      }))
    };
  }

  function scheduleCloudSync(immediate = false) {
    if (!cloudClient || !currentUser) return;
    cloudSyncPending = true;
    if (cloudSyncing) return;
    clearTimeout(cloudTimer);
    cloudTimer = setTimeout(syncStoreToCloud, immediate ? 0 : 700);
  }

  async function syncStoreToCloud() {
    if (!cloudClient || !currentUser || cloudSyncing) return;
    cloudSyncing = true;
    cloudSyncPending = false;
    const syncingRevision = localRevision;
    const state = $("#save-state");
    if (state) state.textContent = "Salvando na nuvem…";
    try {
      const plansPayload = store.plans.map(planToDatabase);
      const { data: savedPlans, error: planError } = await cloudClient
        .from("interval_plans")
        .upsert(plansPayload, { onConflict: "user_id,client_id" })
        .select("id,client_id");
      if (planError) throw planError;

      const localPlanIds = store.plans.map((plan) => plan.id);
      const deletePlans = cloudClient.from("interval_plans").delete().eq("user_id", currentUser.id);
      if (localPlanIds.length) deletePlans.not("client_id", "in", `(${localPlanIds.map((id) => `\"${id}\"`).join(",")})`);
      const { error: deletePlanError } = await deletePlans;
      if (deletePlanError) throw deletePlanError;

      for (const plan of store.plans) {
        const savedPlan = savedPlans.find((item) => item.client_id === plan.id);
        if (!savedPlan) continue;
        plan.databaseId = savedPlan.id;
        const { error: clearStepsError } = await cloudClient.from("interval_steps").delete().eq("plan_id", savedPlan.id);
        if (clearStepsError) throw clearStepsError;
        if (plan.steps.length) {
          const stepsPayload = plan.steps.map((step, position) => ({
            plan_id: savedPlan.id,
            client_id: step.id,
            position,
            activity_name: step.name || "",
            planned_start: step.plannedStart || null,
            planned_end: step.plannedEnd || null,
            actual_start: step.actualStart || null,
            actual_end: step.actualEnd || null,
            actual_notes: step.actualNotes || ""
          }));
          const { error: stepError } = await cloudClient.from("interval_steps").insert(stepsPayload);
          if (stepError) throw stepError;
        }
      }
      if (syncingRevision === localRevision && !cloudSyncPending) {
        store.pendingSync = false;
        localStorage.setItem(activeStorageKey, JSON.stringify(store));
        if (state) state.textContent = "Salvo na nuvem";
      }
    } catch (error) {
      console.error("Falha ao salvar no Supabase.", error);
      if (state) state.textContent = "Falha ao salvar na nuvem";
      showToast("Não foi possível salvar na nuvem. Os dados continuam neste dispositivo.");
    } finally {
      cloudSyncing = false;
      if (cloudSyncPending || syncingRevision !== localRevision) {
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

  function absoluteToTime(total) {
    if (!Number.isFinite(total)) return "—";
    const normalized = ((Math.round(total) % 1440) + 1440) % 1440;
    return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
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
        actualDuration: actualStartMinutes != null && actualEndMinutes != null ? actualEndMinutes - actualStartMinutes : null
      };
    });
    return { windowStart, windowEnd, duration: windowStart != null && windowEnd != null ? windowEnd - windowStart : null, steps };
  }

  function validatePlan(plan) {
    const timeline = buildTimeline(plan);
    const errors = [];
    const warnings = [];
    if (!plan.title.trim()) errors.push("informe o nome do plano");
    if (!plan.date) errors.push("informe a data");
    if (timeline.windowStart == null || timeline.windowEnd == null) errors.push("preencha a janela completa");
    if (!plan.steps.length) errors.push("adicione ao menos uma etapa");
    timeline.steps.forEach((step, index) => {
      if (!step.name.trim() || step.start == null || step.end == null) errors.push(`complete a etapa ${index + 1}`);
      if (step.duration != null && step.duration > 720) warnings.push(`revise a duração da etapa ${index + 1}`);
      if (timeline.windowStart != null && step.start != null && step.start < timeline.windowStart) warnings.push(`a etapa ${index + 1} começa antes da janela`);
      if (timeline.windowEnd != null && step.end != null && step.end > timeline.windowEnd) errors.push(`a etapa ${index + 1} termina após a janela`);
      if (index > 0) {
        const previous = timeline.steps[index - 1];
        if (previous.end != null && step.start != null) {
          if (step.start < previous.end) errors.push(`há sobreposição entre as etapas ${index} e ${index + 1}`);
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
    const headers = ["#", "Atividade", "Início programado", "Fim programado", "Duração programada (min)", "Início realizado", "Fim realizado", "Duração realizada (min)", "Diferença no fim (min)", "Situação", "O que foi realizado"];
    const dataRows = timeline.steps.map((step, index) => {
      const difference = step.actualEndMinutes != null && step.end != null ? Math.round(step.actualEndMinutes - step.end) : null;
      const status = difference == null ? (step.actualStart ? "Em andamento" : "Aguardando") : difference > 0 ? "Atrasado" : difference < 0 ? "Adiantado" : "No horário";
      return [index + 1, step.name, step.plannedStart, step.plannedEnd, step.duration, step.actualStart, step.actualEnd, step.actualDuration, difference, status, step.actualNotes];
    });
    const rows = [];
    rows.push(`<row r="1" ht="30" customHeight="1">${excelCell(1, 1, "GESTÃO DE INTERVALO — PROGRAMADO X REALIZADO", 1)}</row>`);
    rows.push(`<row r="2" ht="8" customHeight="1"></row>`);
    rows.push(`<row r="3">${excelCell(1, 3, "Nome do plano", 3)}${excelCell(4, 3, plan.title, 5)}${excelCell(7, 3, "Data", 3)}${excelCell(9, 3, plan.date, 5)}</row>`);
    rows.push(`<row r="4">${excelCell(1, 4, "Tipo de serviço", 3)}${excelCell(4, 4, plan.serviceType, 5)}${excelCell(7, 4, "Janela", 3)}${excelCell(9, 4, `${plan.windowStart || "—"}–${plan.windowEnd || "—"}`, 5)}</row>`);
    rows.push(`<row r="5">${excelCell(1, 5, "Coordenador(a)", 3)}${excelCell(4, 5, plan.coordinator, 5)}${excelCell(7, 5, "Local / trecho", 3)}${excelCell(9, 5, plan.location, 5)}</row>`);
    rows.push(`<row r="6" ht="34" customHeight="1">${excelCell(1, 6, "Observações do planejamento", 3)}${excelCell(4, 6, plan.notes, 9)}</row>`);
    rows.push(`<row r="7" ht="34" customHeight="1">${excelCell(1, 7, "Registro geral da execução", 3)}${excelCell(4, 7, plan.executionNotes, 9)}</row>`);
    rows.push(`<row r="8" ht="8" customHeight="1"></row>`);
    rows.push(`<row r="9" ht="28" customHeight="1">${headers.map((header, index) => excelCell(index + 1, 9, header, 4)).join("")}</row>`);
    dataRows.forEach((values, index) => {
      const rowNumber = index + 10;
      const statusStyle = values[9] === "Atrasado" ? 7 : values[9] === "Adiantado" || values[9] === "No horário" ? 6 : 8;
      rows.push(`<row r="${rowNumber}" ht="32" customHeight="1">${values.map((value, columnIndex) => excelCell(columnIndex + 1, rowNumber, value, columnIndex === 9 ? statusStyle : columnIndex === 1 || columnIndex === 10 ? 9 : 5)).join("")}</row>`);
    });
    const lastRow = Math.max(9, dataRows.length + 9);
    const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="9" topLeftCell="A10" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols><col min="1" max="1" width="6" customWidth="1"/><col min="2" max="2" width="38" customWidth="1"/><col min="3" max="4" width="18" customWidth="1"/><col min="5" max="5" width="24" customWidth="1"/><col min="6" max="7" width="17" customWidth="1"/><col min="8" max="9" width="22" customWidth="1"/><col min="10" max="10" width="16" customWidth="1"/><col min="11" max="11" width="52" customWidth="1"/></cols><sheetData>${rows.join("")}</sheetData><autoFilter ref="A9:K${lastRow}"/><mergeCells count="17"><mergeCell ref="A1:K1"/><mergeCell ref="A3:C3"/><mergeCell ref="D3:F3"/><mergeCell ref="G3:H3"/><mergeCell ref="I3:K3"/><mergeCell ref="A4:C4"/><mergeCell ref="D4:F4"/><mergeCell ref="G4:H4"/><mergeCell ref="I4:K4"/><mergeCell ref="A5:C5"/><mergeCell ref="D5:F5"/><mergeCell ref="G5:H5"/><mergeCell ref="I5:K5"/><mergeCell ref="A6:C6"/><mergeCell ref="D6:K6"/><mergeCell ref="A7:C7"/><mergeCell ref="D7:K7"/></mergeCells></worksheet>`;
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
  }

  function planningPage() {
    const form = $("#plan-form");
    const stepsRoot = $("#planning-steps");
    const selector = $("#plan-selector");
    const dialog = $("#confirm-dialog");

    function renderSelector() {
      selector.innerHTML = store.plans
        .map((plan) => `<option value="${plan.id}" ${plan.id === store.activePlanId ? "selected" : ""}>${escapeHtml(plan.title || "Plano sem nome")}${plan.locked ? " · travado" : ""}</option>`)
        .join("");
    }

    function renderForm() {
      const plan = activePlan();
      renderSelector();
      ["title", "serviceType", "coordinator", "date", "location", "windowStart", "windowEnd", "notes"].forEach((name) => {
        const input = form.elements[name];
        if (input) {
          input.value = plan[name] || "";
          input.disabled = plan.locked;
        }
      });
      $("#lock-banner").hidden = !plan.locked;
      $("#lock-plan-button").disabled = plan.locked;
      $("#lock-plan-button").textContent = plan.locked ? "Cronograma travado" : "Revisar e travar cronograma";
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
            <td>${String(index + 1).padStart(2, "0")}</td>
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
      if (field && Object.hasOwn(plan, field)) plan[field] = event.target.value;
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
      if (button.dataset.action === "delete") plan.steps.splice(index, 1);
      if (button.dataset.action === "up" && index > 0) [plan.steps[index - 1], plan.steps[index]] = [plan.steps[index], plan.steps[index - 1]];
      if (button.dataset.action === "down" && index < plan.steps.length - 1) [plan.steps[index], plan.steps[index + 1]] = [plan.steps[index + 1], plan.steps[index]];
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
      store.activePlanId = selector.value;
      persist(true);
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
      copy.title = `${source.title || "Plano"} — cópia`;
      copy.locked = false;
      copy.lockedAt = null;
      copy.createdAt = new Date().toISOString();
      copy.steps.forEach((step) => {
        step.id = uid();
        step.actualStart = "";
        step.actualEnd = "";
        step.actualNotes = "";
      });
      copy.executionNotes = "";
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
      if (!confirm(`Excluir “${plan.title || "Plano sem nome"}”? Esta ação não pode ser desfeita.`)) return;
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
      dialog.showModal();
    });

    dialog.addEventListener("close", () => {
      if (dialog.returnValue !== "confirm") return;
      const plan = activePlan();
      plan.locked = true;
      plan.lockedAt = new Date().toISOString();
      persist(true);
      renderForm();
      showToast("Cronograma travado. Execução liberada.");
    });

    $("#unlock-plan-button").addEventListener("click", () => {
      const plan = activePlan();
      const hasExecution = plan.steps.some((step) => step.actualStart || step.actualEnd || step.actualNotes) || plan.executionNotes;
      const message = hasExecution
        ? "Este plano já possui dados realizados. Destravar pode alterar a referência da execução. Deseja continuar?"
        : "Destravar o cronograma para edição?";
      if (!confirm(message)) return;
      plan.locked = false;
      plan.lockedAt = null;
      persist(true);
      renderForm();
      showToast("Cronograma destravado para edição.");
    });

    $("#export-button").addEventListener("click", async () => {
      const plan = activePlan();
      const button = $("#export-button");
      button.disabled = true;
      button.textContent = "Gerando planilha…";
      try {
        await exportPlanToXlsx(plan);
        showToast("Planilha Excel exportada com sucesso.");
      } catch (error) {
        console.error(error);
        showToast("Não foi possível gerar a planilha Excel.");
      } finally {
        button.disabled = false;
        button.textContent = "Exportar Excel (.xlsx)";
      }
    });

    renderForm();
  }

  function executionPage() {
    const plan = activePlan();
    const root = $("#execution-steps");
    const blocked = $("#execution-blocked");
    const content = $("#execution-content");
    blocked.hidden = plan.locked;
    content.hidden = !plan.locked;
    $("#execution-title").textContent = plan.title || "Intervalo sem nome";
    $("#execution-subtitle").textContent = [plan.serviceType, plan.location, plan.coordinator && `Coordenação: ${plan.coordinator}`].filter(Boolean).join(" · ") || "Plano ativo";
    $("#execution-notes").value = plan.executionNotes || "";
    $("#execution-notes").disabled = !plan.locked;

    function nowTime() {
      return new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false });
    }

    function currentAbsolute(timeline) {
      if (!plan.date || timeline.windowStart == null) return null;
      if (plan.date !== todayISO()) return null;
      const startDate = new Date(`${plan.date}T00:00:00`);
      if (Number.isNaN(startDate.getTime())) return null;
      const now = new Date();
      return (now.getTime() - startDate.getTime()) / 60000;
    }

    function getStatus() {
      const timeline = buildTimeline(plan);
      const completed = timeline.steps.filter((step) => step.actualEndMinutes != null);
      const candidates = [];
      timeline.steps.forEach((step) => {
        if (step.actualStartMinutes != null) candidates.push({ actual: step.actualStartMinutes, planned: step.start, type: "início", step });
        if (step.actualEndMinutes != null) candidates.push({ actual: step.actualEndMinutes, planned: step.end, type: "fim", step });
      });
      candidates.sort((a, b) => a.actual - b.actual);
      let milestone = candidates.at(-1) || null;
      let diff = milestone ? milestone.actual - milestone.planned : null;
      const active = timeline.steps
        .filter((step) => step.actualStartMinutes != null && step.actualEndMinutes == null)
        .sort((a, b) => a.actualStartMinutes - b.actualStartMinutes)
        .at(-1) || null;
      const nowAbs = currentAbsolute(timeline);
      if (active && nowAbs != null && active.end != null && nowAbs > active.end) {
        const liveDelay = nowAbs - active.end;
        diff = liveDelay;
        milestone = { actual: nowAbs, planned: active.end, type: "andamento", step: active };
      }
      if (completed.length === timeline.steps.length && timeline.steps.length && timeline.windowEnd != null) {
        const lastActual = Math.max(...completed.map((step) => step.actualEndMinutes));
        diff = lastActual - timeline.windowEnd;
        milestone = { actual: lastActual, planned: timeline.windowEnd, type: "encerramento", step: completed.at(-1) };
      }
      return { timeline, completed, milestone, diff, active };
    }

    function varianceLabel(step) {
      if (step.actualEndMinutes != null && step.end != null) return step.actualEndMinutes - step.end;
      if (step.actualStartMinutes != null && step.start != null) return step.actualStartMinutes - step.start;
      return null;
    }

    function renderSteps() {
      const status = getStatus();
      const firstPending = status.timeline.steps.find((step) => step.actualEndMinutes == null);
      root.innerHTML = status.timeline.steps.map((step, index) => {
        const variance = varianceLabel(step);
        const durationVariance = step.actualDuration != null && step.duration != null ? step.actualDuration - step.duration : null;
        const realizedDurationText = step.actualDuration == null
          ? "Duração calculada ao informar início e fim"
          : `Duração realizada: ${formatMinutes(step.actualDuration)}${durationVariance === 0 ? " · igual ao previsto" : ` · ${durationVariance > 0 ? "+" : "−"}${formatMinutes(durationVariance)} vs. previsto`}`;
        const stateClass = step.actualEndMinutes != null ? "is-complete" : firstPending?.id === step.id ? "is-active" : "";
        const varianceClass = variance == null ? "" : variance > 0 ? "delay" : variance < 0 ? "ahead" : "";
        const varianceText = variance == null ? "Aguardando" : variance > 0 ? `+${Math.round(variance)} min` : variance < 0 ? `${Math.round(variance)} min` : "No horário";
        return `<article class="execution-step ${stateClass}" data-step-id="${step.id}">
          <header class="execution-step-header">
            <span class="execution-index">${step.actualEndMinutes != null ? "✓" : String(index + 1).padStart(2, "0")}</span>
            <div class="execution-step-title">
              <h3>${escapeHtml(step.name || `Etapa ${index + 1}`)}</h3>
              <span>${step.actualEndMinutes != null ? "Etapa concluída" : step.actualStartMinutes != null ? "Em andamento" : "Aguardando início"}</span>
            </div>
            <span class="step-variance ${varianceClass}">${varianceText}</span>
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
                  <label>Início<input data-field="actualStart" type="time" value="${escapeHtml(step.actualStart)}" aria-label="Início realizado da etapa ${index + 1}"></label>
                  <button class="now-button" type="button" data-now="actualStart">Agora</button>
                </div>
                <div class="time-entry">
                  <label>Fim<input data-field="actualEnd" type="time" value="${escapeHtml(step.actualEnd)}" aria-label="Fim realizado da etapa ${index + 1}"></label>
                  <button class="now-button" type="button" data-now="actualEnd">Agora</button>
                </div>
              </div>
              <small class="realized-duration">${realizedDurationText}</small>
            </div>
            <label class="field notes-block">
              <span>O que foi realizado</span>
              <textarea data-field="actualNotes" maxlength="600" rows="3" placeholder="Descreva o serviço executado, ocorrências ou desvios">${escapeHtml(step.actualNotes)}</textarea>
            </label>
          </div>
        </article>`;
      }).join("");
    }

    function renderDashboard() {
      const status = getStatus();
      const { timeline, completed, diff, milestone, active } = status;
      const rounded = diff == null ? 0 : Math.round(diff);
      const hero = $("#status-hero");
      hero.className = "status-hero " + (diff == null ? "status-neutral" : rounded > 1 ? "status-delay" : rounded < -1 ? "status-ahead" : "status-on-time");
      $("#status-minutes").textContent = String(Math.abs(rounded)).padStart(2, "0");
      $("#status-sign").textContent = diff == null || Math.abs(rounded) <= 1 ? "" : rounded > 0 ? "+" : "−";
      if (diff == null) {
        $("#status-label").textContent = "Aguardando início";
        $("#status-description").textContent = "Preencha o primeiro horário realizado para iniciar o acompanhamento.";
      } else if (rounded > 1) {
        $("#status-label").textContent = `Atraso atual do cronograma: ${Math.abs(rounded)} minutos`;
        $("#status-description").textContent = milestone?.type === "andamento"
          ? `A etapa “${milestone.step.name}” ainda está em andamento após o fim programado.`
          : milestone ? `Comparação pelo ${milestone.type} de “${milestone.step.name}”.` : "Atraso em relação ao cronograma.";
      } else if (rounded < -1) {
        $("#status-label").textContent = `Adiantamento atual do cronograma: ${Math.abs(rounded)} minutos`;
        $("#status-description").textContent = milestone ? `Comparação pelo ${milestone.type} de “${milestone.step.name}”.` : "Adiantamento em relação ao cronograma.";
      } else {
        $("#status-label").textContent = "Intervalo dentro do prazo";
        $("#status-description").textContent = "O último marco realizado está aderente ao cronograma programado.";
      }

      $("#metric-window").textContent = timeline.windowStart == null ? "—" : `${plan.windowStart}–${plan.windowEnd}`;
      $("#metric-duration").textContent = timeline.duration == null ? "Janela não definida" : `${formatMinutes(timeline.duration)} de janela`;
      $("#metric-progress").textContent = `${completed.length} / ${timeline.steps.length}`;
      $("#progress-bar").style.width = timeline.steps.length ? `${(completed.length / timeline.steps.length) * 100}%` : "0%";
      const current = active || timeline.steps.find((step) => step.actualEndMinutes == null);
      $("#metric-current").textContent = current?.name || (timeline.steps.length && completed.length === timeline.steps.length ? "Concluído" : "Aguardando");
      $("#metric-current-time").textContent = active ? `Iniciada às ${active.actualStart}` : current ? `Programada ${current.plannedStart}–${current.plannedEnd}` : "—";
      const forecast = timeline.windowEnd == null || diff == null ? null : timeline.windowEnd + diff;
      $("#metric-forecast").textContent = forecast == null ? "—" : absoluteToTime(forecast);
      $("#metric-forecast-note").textContent = diff == null ? "Aguardando primeiro marco" : `Projeção pelo desvio atual · meta: ${plan.windowEnd}`;

      const remaining = timeline.steps.filter((step) => step.actualEndMinutes == null);
      const card = $("#compensation-card");
      card.className = "compensation-card ";
      if (diff != null && rounded > 1 && remaining.length) {
        const each = Math.ceil(rounded / remaining.length);
        card.classList.add("compensation-alert");
        $("#compensation-title").textContent = `Recuperar ${rounded} min em ${remaining.length} etapa${remaining.length > 1 ? "s" : ""}`;
        $("#compensation-description").textContent = `Para preservar o fim às ${plan.windowEnd}, distribua a recuperação entre as próximas atividades e reavalie após cada marco.`;
        $("#compensation-number").textContent = `≈ ${each} min/etapa`;
      } else if (diff != null && rounded < -1) {
        card.classList.add("compensation-good");
        $("#compensation-title").textContent = `Margem de ${Math.abs(rounded)} min no cronograma`;
        $("#compensation-description").textContent = "O intervalo está adiantado; preserve a execução segura antes de converter essa margem em ganho.";
        $("#compensation-number").textContent = `${Math.abs(rounded)} min`;
      } else if (!remaining.length && timeline.steps.length) {
        card.classList.add("compensation-good");
        $("#compensation-title").textContent = "Intervalo concluído";
        $("#compensation-description").textContent = rounded > 1 ? "Encerrado após o limite programado." : "Todas as etapas possuem horário de término realizado.";
        $("#compensation-number").textContent = rounded > 1 ? `+${rounded} min` : rounded < -1 ? `${rounded} min` : "No prazo";
      } else {
        card.classList.add("compensation-neutral");
        $("#compensation-title").textContent = "Sem necessidade de compensação";
        $("#compensation-description").textContent = diff == null ? "O acompanhamento começará após o primeiro horário realizado." : "O ritmo atual não exige recuperação de tempo.";
        $("#compensation-number").textContent = diff == null ? "—" : "No prazo";
      }
    }

    function renderClock() {
      const now = new Date();
      $("#live-clock").textContent = now.toLocaleTimeString("pt-BR", { hour12: false });
      $("#live-date").textContent = now.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" });
    }

    root.addEventListener("input", (event) => {
      const stepElement = event.target.closest("[data-step-id]");
      const step = plan.steps.find((item) => item.id === stepElement?.dataset.stepId);
      if (!step) return;
      step[event.target.dataset.field] = event.target.value;
      persist(event.target.matches('input[type="time"]'));
      renderDashboard();
    });

    root.addEventListener("change", (event) => {
      if (!event.target.matches('input[type="time"]')) return;
      const label = event.target.dataset.field === "actualStart" ? "Início" : "Fim";
      if (event.target.value) showToast(`${label} realizado registrado às ${event.target.value}.`);
      renderSteps();
      renderDashboard();
    });

    root.addEventListener("click", (event) => {
      const button = event.target.closest("[data-now]");
      if (!button) return;
      const stepElement = button.closest("[data-step-id]");
      const step = plan.steps.find((item) => item.id === stepElement.dataset.stepId);
      step[button.dataset.now] = nowTime();
      persist(true);
      renderSteps();
      renderDashboard();
      showToast(`Horário registrado: ${step[button.dataset.now]}.`);
    });

    $("#execution-notes").addEventListener("input", (event) => {
      plan.executionNotes = event.target.value;
      persist();
    });
    $("#print-button").addEventListener("click", () => window.print());

    renderSteps();
    renderDashboard();
    renderClock();
    setInterval(() => {
      renderClock();
      if (plan.locked) renderDashboard();
    }, 1000);
  }

  function dashboardPage() {
    const selector = $("#dashboard-plan-selector");

    function statusFor(step) {
      if (step.actualEndMinutes != null) {
        const variance = step.end == null ? null : Math.round(step.actualEndMinutes - step.end);
        if (variance > 1) return { label: "Atrasada", className: "delay", variance };
        if (variance < -1) return { label: "Adiantada", className: "ahead", variance };
        return { label: "No prazo", className: "on-time", variance: variance || 0 };
      }
      if (step.actualStartMinutes != null) return { label: "Em andamento", className: "running", variance: null };
      return { label: "Aguardando", className: "waiting", variance: null };
    }

    function renderPlanOptions() {
      selector.innerHTML = store.plans.map((plan) => `<option value="${plan.id}" ${plan.id === store.activePlanId ? "selected" : ""}>${escapeHtml(plan.title || "Plano sem nome")}</option>`).join("");
    }

    function render() {
      const plan = activePlan();
      const timeline = buildTimeline(plan);
      const completed = timeline.steps.filter((step) => step.actualEndMinutes != null);
      const running = timeline.steps.filter((step) => step.actualStartMinutes != null && step.actualEndMinutes == null);
      const progress = timeline.steps.length ? Math.round((completed.length / timeline.steps.length) * 100) : 0;
      const plannedTotal = timeline.steps.reduce((sum, step) => sum + (step.duration || 0), 0);
      const actualTotal = completed.reduce((sum, step) => sum + (step.actualDuration || 0), 0);
      const comparableSteps = completed.filter((step) => step.duration != null && step.actualDuration != null);
      const comparablePlannedTotal = comparableSteps.reduce((sum, step) => sum + step.duration, 0);
      const comparableActualTotal = comparableSteps.reduce((sum, step) => sum + step.actualDuration, 0);
      const durationDifference = comparableSteps.length ? Math.round(comparableActualTotal - comparablePlannedTotal) : null;
      const maxDuration = Math.max(1, ...timeline.steps.flatMap((step) => [step.duration || 0, step.actualDuration || 0]));

      $("#dashboard-title").textContent = plan.title || "Intervalo sem nome";
      $("#dashboard-subtitle").textContent = [plan.date && new Date(`${plan.date}T12:00:00`).toLocaleDateString("pt-BR"), plan.serviceType, plan.location, plan.coordinator].filter(Boolean).join(" · ") || "Plano ativo";
      $("#dashboard-progress").textContent = `${progress}%`;
      $("#dashboard-progress-note").textContent = `${completed.length} de ${timeline.steps.length} etapas concluídas`;
      $("#dashboard-planned-total").textContent = plannedTotal ? formatMinutes(plannedTotal) : "—";
      $("#dashboard-actual-total").textContent = completed.length ? formatMinutes(actualTotal) : "—";
      $("#dashboard-actual-note").textContent = completed.length ? `${completed.length} etapa${completed.length > 1 ? "s" : ""} com duração calculada` : "aguardando registros completos";
      $("#dashboard-variance").textContent = durationDifference == null ? "—" : `${durationDifference > 0 ? "+" : ""}${durationDifference} min`;
      $("#dashboard-variance-note").textContent = durationDifference == null
        ? "Somente etapas concluídas e comparáveis"
        : durationDifference > 0
          ? `${comparableSteps.length} etapa${comparableSteps.length > 1 ? "s" : ""} concluída${comparableSteps.length > 1 ? "s" : ""}: ${durationDifference} min a mais de duração`
          : durationDifference < 0
            ? `${comparableSteps.length} etapa${comparableSteps.length > 1 ? "s" : ""} concluída${comparableSteps.length > 1 ? "s" : ""}: ${Math.abs(durationDifference)} min a menos de duração`
            : "Etapas concluídas: duração realizada igual à planejada";
      $("#dashboard-variance-card").className = `dashboard-kpi featured ${durationDifference == null ? "variance-neutral" : durationDifference > 0 ? "variance-positive" : durationDifference < 0 ? "variance-negative" : "variance-zero"}`;

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
        <span><i class="waiting"></i><strong>${Math.max(0, timeline.steps.length - completed.length - running.length)}</strong> aguardando</span>`;

      const varianceSteps = timeline.steps.filter((step) => step.actualEndMinutes != null && step.end != null);
      const maxVariance = Math.max(1, ...varianceSteps.map((step) => Math.abs(step.actualEndMinutes - step.end)));
      $("#variance-chart").innerHTML = varianceSteps.length ? varianceSteps.map((step) => {
        const value = Math.round(step.actualEndMinutes - step.end);
        const width = Math.max(value === 0 ? 2 : 8, (Math.abs(value) / maxVariance) * 48);
        return `<div class="variance-row"><span>${String(step.index + 1).padStart(2, "0")}</span><div class="variance-axis"><i class="${value > 1 ? "delay" : value < -1 ? "ahead" : "on-time"}" style="width:${width}%;${value < -1 ? "right:50%" : "left:50%"}"></i></div><strong>${value > 0 ? "+" : ""}${value} min</strong></div>`;
      }).join("") : `<div class="chart-empty">Conclua uma etapa para visualizar os desvios.</div>`;

      $("#dashboard-table-body").innerHTML = timeline.steps.length ? timeline.steps.map((step) => {
        const status = statusFor(step);
        const durationDiff = step.actualDuration != null && step.duration != null ? Math.round(step.actualDuration - step.duration) : null;
        return `<tr><td><strong>${escapeHtml(step.name || "Etapa sem nome")}</strong><small>${escapeHtml(step.plannedStart || "—")}–${escapeHtml(step.plannedEnd || "—")}</small></td><td>${formatMinutes(step.duration)}</td><td>${step.actualDuration == null ? "—" : formatMinutes(step.actualDuration)}</td><td>${durationDiff == null ? "—" : `${durationDiff > 0 ? "+" : ""}${durationDiff} min`}</td><td><span class="table-status ${status.className}">${status.label}</span></td></tr>`;
      }).join("") : `<tr><td colspan="5">Nenhuma etapa cadastrada.</td></tr>`;
    }

    selector.addEventListener("change", () => {
      store.activePlanId = selector.value;
      persist(true);
      render();
    });

    $("#export-dashboard-pdf").addEventListener("click", () => {
      const button = $("#export-dashboard-pdf");
      const previousTitle = document.title;
      const planName = (activePlan()?.title || "intervalo").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/gi, "-").replace(/(^-|-$)/g, "").toLowerCase();
      document.title = `dashboard-${planName}`;
      button.disabled = true;
      button.textContent = "Preparando PDF…";
      const restore = () => {
        document.title = previousTitle;
        button.disabled = false;
        button.textContent = "Exportar PDF";
        window.removeEventListener("afterprint", restore);
      };
      window.addEventListener("afterprint", restore);
      setTimeout(() => window.print(), 80);
    });

    renderPlanOptions();
    render();
  }

  function renderAuthControls() {
    const tools = $(".header-tools");
    if (!tools || $("[data-auth-button]", tools)) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "auth-button";
    button.dataset.authButton = "";
    button.textContent = currentUser ? "Minha conta" : "Entrar";
    button.addEventListener("click", () => currentUser ? openAccountDialog() : openAuthDialog());
    tools.prepend(button);
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
    const allowedData = currentProfile?.role === "editor" ? data : data.filter((plan) => !plan.is_example);
    if (!allowedData.length) {
      if (currentProfile?.role !== "editor") {
        const first = blankPlan();
        store = { version: 2, activePlanId: first.id, plans: [first] };
        localStorage.setItem(activeStorageKey, JSON.stringify(store));
      }
      await syncStoreToCloud();
      return;
    }
    const plans = allowedData.map(databaseToPlan);
    const activeId = plans.some((plan) => plan.id === store.activePlanId) ? store.activePlanId : plans[0].id;
    store = { version: 2, activePlanId: activeId, plans };
    store.pendingSync = false;
    localStorage.setItem(activeStorageKey, JSON.stringify(store));
  }

  function initializeCurrentPage() {
    if (pageInitialized) return;
    pageInitialized = true;
    if (page === "planning") planningPage();
    if (page === "execution") executionPage();
    if (page === "dashboard") dashboardPage();
    if (page === "account") accountPage();
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
      if (currentUser) location.replace("index.html");
      else loginPage();
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

    activeStorageKey = `${STORAGE_KEY}.${currentUser.id}`;
    const hasUserStore = Boolean(localStorage.getItem(activeStorageKey));
    if (hasUserStore) {
      store = loadStore();
    } else if (currentProfile.role === "editor" && localStorage.getItem(STORAGE_KEY)) {
      // Migra com segurança os dados da versão anterior, que ainda usava uma chave local única.
      store.pendingSync = true;
      localStorage.setItem(activeStorageKey, JSON.stringify(store));
    } else {
      const first = blankPlan();
      store = { version: 2, activePlanId: first.id, plans: [first], pendingSync: false };
      localStorage.setItem(activeStorageKey, JSON.stringify(store));
    }

    if (currentProfile.role !== "editor") {
      $("#example-plan-button")?.remove();
      const hadExamples = store.plans.some((plan) => plan.isExample);
      store.plans = store.plans.filter((plan) => !plan.isExample);
      if (!store.plans.length) store.plans = [blankPlan()];
      if (!store.plans.some((plan) => plan.id === store.activePlanId)) store.activePlanId = store.plans[0].id;
      if (hadExamples) store.pendingSync = true;
      localStorage.setItem(activeStorageKey, JSON.stringify(store));
    }
    if (state) state.textContent = "Sincronizando…";
    try {
      if (store.pendingSync) {
        cloudSyncPending = true;
        await syncStoreToCloud();
      }
      if (!store.pendingSync) await loadCloudStore();
      if (state) state.textContent = store.pendingSync ? "Pendente de sincronização" : "Salvo na nuvem";
    } catch (error) {
      console.error("Falha ao carregar dados do Supabase.", error);
      if (state) state.textContent = "Falha na sincronização";
    } finally {
      document.documentElement.classList.remove("auth-checking");
      initializeCurrentPage();
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
      const { data: profile } = await cloudClient.from("user_profiles").select("enabled").eq("id", data.user.id).single();
      if (!profile?.enabled) {
        await cloudClient.auth.signOut();
        feedback.textContent = "Esta conta está desabilitada. Procure um editor.";
        button.disabled = false;
        button.textContent = "Entrar no sistema";
        return;
      }
      location.replace("index.html");
    });
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
    $("#account-name").textContent = currentProfile.full_name || "Usuário";
    $("#account-email").textContent = currentProfile.email;
    $("#account-role").textContent = currentProfile.role === "editor" ? "Editor" : "Coordenador";
    $("#account-history").innerHTML = store.plans.length ? [...store.plans].sort((a,b)=>(b.date||"").localeCompare(a.date||"")).map((plan) => {
      const completed = plan.steps.filter((step) => step.actualEnd).length;
      return `<article class="history-item"><div><strong>${escapeHtml(plan.title || "Plano sem nome")}</strong><span>${plan.date ? new Date(`${plan.date}T12:00:00`).toLocaleDateString("pt-BR") : "Sem data"} · ${escapeHtml(plan.serviceType || "Serviço não informado")}</span></div><div><b>${completed}/${plan.steps.length}</b><small>etapas concluídas</small></div><a class="button button-ghost" href="dashboard.html">Ver dashboard</a></article>`;
    }).join("") : `<div class="chart-empty">Nenhum intervalo registrado nesta conta.</div>`;

    if (currentProfile.role !== "editor") return;
    $("#editor-panel").hidden = false;
    const form = $("#user-create-form");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const feedback = $("#user-create-feedback");
      feedback.textContent = "Criando conta…";
      const { data, error } = await cloudClient.functions.invoke("create-site-user", { body: { fullName: form.fullName.value, email: form.email.value, password: form.password.value } });
      if (error || data?.error) { feedback.textContent = data?.error || error.message; return; }
      feedback.textContent = "Conta criada e habilitada.";
      form.reset();
      await renderUsers();
    });

    async function renderUsers() {
      const { data } = await cloudClient.from("user_profiles").select("*").order("created_at", { ascending: false });
      $("#users-list").innerHTML = (data || []).map((profile) => `<article class="user-row" data-user-id="${profile.id}"><div><strong>${escapeHtml(profile.full_name || "Sem nome")}</strong><span>${escapeHtml(profile.email)}</span></div><span>${profile.role === "editor" ? "Editor" : "Coordenador"}</span><label class="account-switch"><input type="checkbox" ${profile.enabled ? "checked" : ""} ${profile.id === currentUser.id ? "disabled" : ""}><i></i><b>${profile.enabled ? "Habilitada" : "Desabilitada"}</b></label></article>`).join("");
      $$(".user-row input", $("#users-list")).forEach((input) => input.addEventListener("change", async () => {
        const row = input.closest(".user-row");
        await cloudClient.from("user_profiles").update({ enabled: input.checked }).eq("id", row.dataset.userId);
        await renderUsers();
      }));
    }
    await renderUsers();
  }

  initializeTheme();
  window.addEventListener("online", () => {
    if (store.pendingSync) scheduleCloudSync(true);
  });
  window.addEventListener("pagehide", () => {
    clearTimeout(saveTimer);
    if (store.pendingSync) scheduleCloudSync(true);
  });
  initializeCloud();
})();
