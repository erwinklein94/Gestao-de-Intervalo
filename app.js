(function () {
  "use strict";

  const STORAGE_KEY = "gestaoIntervaloRumo.v1";
  const page = document.body.dataset.page;
  let store = loadStore();
  let saveTimer;
  let toastTimer;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

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
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
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
    const save = () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
      const state = $("#save-state");
      if (state) state.textContent = "Salvo neste dispositivo";
    };
    const state = $("#save-state");
    if (state) state.textContent = "Salvando…";
    clearTimeout(saveTimer);
    if (immediate) save();
    else saveTimer = setTimeout(save, 260);
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
      let actualStart = nearestDay(timeToMinutes(step.actualStart), start);
      let actualEnd = nearestDay(timeToMinutes(step.actualEnd), end);
      if (actualStart != null && actualEnd != null) while (actualEnd < actualStart) actualEnd += 1440;
      return {
        ...step,
        index,
        start,
        end,
        duration: start != null && end != null ? end - start : null,
        actualStart,
        actualEnd,
        actualDuration: actualStart != null && actualEnd != null ? actualEnd - actualStart : null
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

    $("#example-plan-button").addEventListener("click", () => {
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

    $("#export-button").addEventListener("click", () => {
      const plan = activePlan();
      const blob = new Blob([JSON.stringify({ app: "Gestão de Intervalo", version: 1, plan }, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${(plan.title || "plano-intervalo").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/gi, "-").replace(/(^-|-$)/g, "").toLowerCase()}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
      showToast("Cópia de segurança exportada.");
    });

    $("#import-input").addEventListener("change", async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const imported = data.plan || data;
        if (!imported || !Array.isArray(imported.steps)) throw new Error("Formato inválido");
        normalizePlan(imported);
        imported.id = uid();
        imported.title = `${imported.title || "Plano importado"} — importado`;
        imported.steps.forEach((step) => { step.id = uid(); });
        store.plans.push(imported);
        store.activePlanId = imported.id;
        persist(true);
        renderForm();
        showToast("Plano importado com sucesso.");
      } catch (error) {
        showToast("Não foi possível importar este arquivo.");
      } finally {
        event.target.value = "";
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
      const completed = timeline.steps.filter((step) => step.actualEnd != null);
      const candidates = [];
      timeline.steps.forEach((step) => {
        if (step.actualStart != null) candidates.push({ actual: step.actualStart, planned: step.start, type: "início", step });
        if (step.actualEnd != null) candidates.push({ actual: step.actualEnd, planned: step.end, type: "fim", step });
      });
      candidates.sort((a, b) => a.actual - b.actual);
      let milestone = candidates.at(-1) || null;
      let diff = milestone ? milestone.actual - milestone.planned : null;
      const active = timeline.steps.find((step) => step.actualStart != null && step.actualEnd == null);
      const nowAbs = currentAbsolute(timeline);
      if (active && nowAbs != null && active.end != null && nowAbs > active.end) {
        const liveDelay = nowAbs - active.end;
        if (diff == null || liveDelay > diff) diff = liveDelay;
      }
      if (completed.length === timeline.steps.length && timeline.steps.length && timeline.windowEnd != null) {
        const lastActual = Math.max(...completed.map((step) => step.actualEnd));
        diff = lastActual - timeline.windowEnd;
        milestone = { actual: lastActual, planned: timeline.windowEnd, type: "encerramento", step: completed.at(-1) };
      }
      return { timeline, completed, milestone, diff, active };
    }

    function varianceLabel(step) {
      if (step.actualEnd != null && step.end != null) return step.actualEnd - step.end;
      if (step.actualStart != null && step.start != null) return step.actualStart - step.start;
      return null;
    }

    function renderSteps() {
      const status = getStatus();
      const firstPending = status.timeline.steps.find((step) => step.actualEnd == null);
      root.innerHTML = status.timeline.steps.map((step, index) => {
        const variance = varianceLabel(step);
        const durationVariance = step.actualDuration != null && step.duration != null ? step.actualDuration - step.duration : null;
        const realizedDurationText = step.actualDuration == null
          ? "Duração calculada ao informar início e fim"
          : `Duração realizada: ${formatMinutes(step.actualDuration)}${durationVariance === 0 ? " · igual ao previsto" : ` · ${durationVariance > 0 ? "+" : "−"}${formatMinutes(durationVariance)} vs. previsto`}`;
        const stateClass = step.actualEnd != null ? "is-complete" : firstPending?.id === step.id ? "is-active" : "";
        const varianceClass = variance == null ? "" : variance > 0 ? "delay" : variance < 0 ? "ahead" : "";
        const varianceText = variance == null ? "Aguardando" : variance > 0 ? `+${Math.round(variance)} min` : variance < 0 ? `${Math.round(variance)} min` : "No horário";
        return `<article class="execution-step ${stateClass}" data-step-id="${step.id}">
          <header class="execution-step-header">
            <span class="execution-index">${step.actualEnd != null ? "✓" : String(index + 1).padStart(2, "0")}</span>
            <div class="execution-step-title">
              <h3>${escapeHtml(step.name || `Etapa ${index + 1}`)}</h3>
              <span>${step.actualEnd != null ? "Etapa concluída" : step.actualStart != null ? "Em andamento" : "Aguardando início"}</span>
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
        $("#status-label").textContent = `Intervalo atrasado em ${Math.abs(rounded)} minutos`;
        $("#status-description").textContent = milestone ? `Comparação pelo ${milestone.type} de “${milestone.step.name}”.` : "Atraso em relação ao cronograma.";
      } else if (rounded < -1) {
        $("#status-label").textContent = `Intervalo adiantado em ${Math.abs(rounded)} minutos`;
        $("#status-description").textContent = milestone ? `Comparação pelo ${milestone.type} de “${milestone.step.name}”.` : "Adiantamento em relação ao cronograma.";
      } else {
        $("#status-label").textContent = "Intervalo dentro do prazo";
        $("#status-description").textContent = "O último marco realizado está aderente ao cronograma programado.";
      }

      $("#metric-window").textContent = timeline.windowStart == null ? "—" : `${plan.windowStart}–${plan.windowEnd}`;
      $("#metric-duration").textContent = timeline.duration == null ? "Janela não definida" : `${formatMinutes(timeline.duration)} de janela`;
      $("#metric-progress").textContent = `${completed.length} / ${timeline.steps.length}`;
      $("#progress-bar").style.width = timeline.steps.length ? `${(completed.length / timeline.steps.length) * 100}%` : "0%";
      const current = active || timeline.steps.find((step) => step.actualEnd == null);
      $("#metric-current").textContent = current?.name || (timeline.steps.length && completed.length === timeline.steps.length ? "Concluído" : "Aguardando");
      $("#metric-current-time").textContent = active ? `Iniciada às ${active.actualStart}` : current ? `Programada ${current.plannedStart}–${current.plannedEnd}` : "—";
      const forecast = timeline.windowEnd == null || diff == null ? null : timeline.windowEnd + diff;
      $("#metric-forecast").textContent = forecast == null ? "—" : absoluteToTime(forecast);
      $("#metric-forecast-note").textContent = diff == null ? "Aguardando primeiro marco" : `Meta de encerramento: ${plan.windowEnd}`;

      const remaining = timeline.steps.filter((step) => step.actualEnd == null);
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
      persist();
      renderDashboard();
    });

    root.addEventListener("change", (event) => {
      if (!event.target.matches('input[type="time"]')) return;
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

  if (page === "planning") planningPage();
  if (page === "execution") executionPage();
})();
