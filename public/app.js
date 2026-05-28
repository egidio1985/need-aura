const state = {
  needs: [],
  candidates: [],
  applications: [],
  dashboard: null,
  selectedTab: "needs",
  selectedPipelineStage: "Tutte",
  selectedNeedId: "",
  selectedNeedPriority: "Tutte",
  selectedNeedStatus: "Attivi",
  selectedCandidateStatus: "Attivi",
  search: "",
  editing: null
};

const PIPELINE_STAGES = [
  "Primo contatto",
  "Colloquio HR",
  "Primo Colloquio",
  "Inviato Dossier",
  "Organizzata QM",
  "KO BM",
  "KO Candidato",
  "KO Cliente",
  "Senza fase",
  "QM OK",
  "Interno"
];

const PIPELINE_STAGE_CLASSES = {
  "Primo contatto": "stage-contact",
  "Colloquio HR": "stage-hr",
  "Primo Colloquio": "stage-first",
  "Inviato Dossier": "stage-dossier",
  "Organizzata QM": "stage-qm",
  "KO BM": "stage-ko-bm",
  "KO Candidato": "stage-ko-candidate",
  "KO Cliente": "stage-ko-client",
  "Senza fase": "stage-empty",
  "QM OK": "stage-ok",
  "Interno": "stage-internal"
};

const SENIORITY_OPTIONS = ["Neo", "Junior", "Middle", "Senior"];

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#039;"
}[char]));

async function api(path, options = {}) {
  let response;
  try {
    const isFormData = options.body instanceof FormData;
    const headers = isFormData ? {} : { "Content-Type": "application/json" };
    response = await fetch(path, {
      headers: { ...headers, ...(options.headers || {}) },
      cache: "no-store",
      ...options
    });
  } catch {
    throw new Error("Backend non raggiungibile. Avvia start-local.cmd e apri http://localhost:5173.");
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Risposta non valida dal backend. Riavvia il servizio locale.");
  }

  if (!response.ok) throw new Error(data.error || "Errore API");
  return data;
}

function showStatus(message, isError = false) {
  const el = $("#statusMessage");
  el.hidden = false;
  el.textContent = message;
  el.style.background = isError ? "#fee4e2" : "#edf7ee";
  el.style.color = isError ? "#b42318" : "#1d7a46";
  window.clearTimeout(showStatus.timer);
  showStatus.timer = window.setTimeout(() => {
    el.hidden = true;
  }, 4200);
}

function textMatches(item) {
  const q = state.search.trim().toLowerCase();
  if (!q) return true;
  return JSON.stringify(item).toLowerCase().includes(q);
}

function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function canonicalPipelineStage(value) {
  const normalized = normalizeText(value);
  return PIPELINE_STAGES.find((stage) => normalizeText(stage) === normalized) || String(value || "").trim();
}

function pipelineStagesFromData() {
  const fromData = state.candidates
    .map((candidate) => canonicalPipelineStage(candidate.phase))
    .filter(Boolean);
  return [...new Set([...PIPELINE_STAGES, ...fromData])];
}

function needPriorityMatches(need) {
  if (state.selectedNeedPriority === "Tutte") return true;
  return normalizeText(need.urgency) === normalizeText(state.selectedNeedPriority);
}

function needStatusMatches(need) {
  if (state.selectedNeedStatus === "Tutti") return true;
  if (state.selectedNeedStatus === "Attivi") return !isNeedClosed(need.status);
  return normalizeText(need.status) === normalizeText(state.selectedNeedStatus);
}

function candidateStatusMatches(candidate) {
  if (state.selectedCandidateStatus === "Tutti") return true;
  return !isCandidateKo(candidate.phase);
}

function isCandidateKo(phase) {
  return normalizeText(phase).includes("ko");
}

function isNeedClosed(status) {
  const normalized = normalizeText(status);
  return normalized.includes("closed") || normalized.includes("chiuso") || normalized.includes("ko");
}

function badge(text, kind = "") {
  if (!text) return "";
  return `<span class="badge ${kind}">${escapeHtml(text)}</span>`;
}

function skills(items) {
  if (!items?.length) return `<span class="muted">Skill non compilate</span>`;
  return `<div class="skills">${items.map((item) => badge(item)).join("")}</div>`;
}

function renderDashboard() {
  $("#dashboard").innerHTML = dashboardStatsForTab(state.selectedTab).map(([label, value]) => `
    <article class="kpi">
      <span class="muted">${label}</span>
      <strong>${value}</strong>
    </article>
  `).join("");
}

function dashboardStatsForTab(tab) {
  if (tab === "candidates" || tab === "pipeline" || tab === "matching") return candidateDashboardStats();
  if (tab === "needs") return needDashboardStats();
  return overviewDashboardStats();
}

function candidateDashboardStats() {
  const candidates = state.candidates || [];
  const applications = state.applications || [];
  const active = candidates.filter((candidate) => !isCandidateKo(candidate.phase)).length;
  const internal = candidates.filter((candidate) => normalizeText(candidate.phase) === "interno").length;
  const ko = candidates.filter((candidate) => isCandidateKo(candidate.phase)).length;
  const associated = new Set(applications.map((application) => normalizeText(application.candidateName)).filter(Boolean)).size;
  return [
    ["Candidati attivi", active],
    ["In organico", internal],
    ["In fase KO", ko],
    ["Associati a need", associated],
    ["Candidati totali", candidates.length]
  ];
}

function needDashboardStats() {
  const needs = state.needs || [];
  const active = needs.filter((need) => !isNeedClosed(need.status)).length;
  const urgentActive = needs.filter((need) => !isNeedClosed(need.status) && normalizeText(need.urgency) === "alta").length;
  const closedWin = needs.filter((need) => normalizeText(need.status).includes("win")).length;
  const inactive = needs.filter((need) => isNeedClosed(need.status)).length;
  return [
    ["Need attivi", active],
    ["Need urgenti attivi", urgentActive],
    ["Need chiusi positivi", closedWin],
    ["Need non attivi", inactive],
    ["Need totali", needs.length]
  ];
}

function overviewDashboardStats() {
  const candidates = candidateDashboardStats();
  const needs = needDashboardStats();
  const applications = state.applications || [];
  return [
    needs[0],
    candidates[0],
    candidates[1],
    ["Associazioni candidate-need", applications.length],
    ["Need totali", (state.needs || []).length],
    ["Candidati totali", (state.candidates || []).length]
  ];
}

function objectEntriesSorted(object = {}) {
  return Object.entries(object).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function renderDashboardPage() {
  const d = state.dashboard || {};
  renderSourceStatusChart(d.candidateStatusBySource || {});
  renderNeedStatusChart(d.candidateStatusByNeed || {});
  const sourceEntries = objectEntriesSorted(d.candidatesBySource);
  const maxSource = Math.max(1, ...sourceEntries.map(([, count]) => count));
  $("#sourceChart").innerHTML = sourceEntries.map(([source, count]) => `
    <div class="bar-row">
      <span class="bar-label">${escapeHtml(source)}</span>
      <div class="bar-track"><span style="width:${Math.round((count / maxSource) * 100)}%"></span></div>
      <strong>${count}</strong>
    </div>
  `).join("") || `<p class="muted">Nessun fornitore compilato.</p>`;

  const byNeed = d.proposalsByNeedAndSource || {};
  const needs = Object.keys(byNeed).sort((a, b) => a.localeCompare(b));
  const sources = [...new Set(Object.values(byNeed).flatMap((row) => Object.keys(row)))].sort((a, b) => a.localeCompare(b));

  if (!needs.length || !sources.length) {
    $("#needSourceChart").innerHTML = `<p class="muted">Nessuna associazione candidato-need ancora registrata.</p>`;
    return;
  }

  $("#needSourceChart").innerHTML = `
    <table class="analytics-table">
      <thead>
        <tr>
          <th>Need</th>
          ${sources.map((source) => `<th>${escapeHtml(source)}</th>`).join("")}
          <th>Totale</th>
        </tr>
      </thead>
      <tbody>
        ${needs.map((need) => {
          const row = byNeed[need] || {};
          const total = sources.reduce((sum, source) => sum + (row[source] || 0), 0);
          return `
            <tr>
              <th>${escapeHtml(need)}</th>
              ${sources.map((source) => `<td>${row[source] || ""}</td>`).join("")}
              <td><strong>${total}</strong></td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;

}

function renderSourceStatusChart(bySource = {}) {
  const sources = Object.keys(bySource).sort((a, b) => a.localeCompare(b));
  const preferredStatuses = [
    "Primo Colloquio",
    "Inviato Dossier",
    "Organizzata QM",
    "KO BM",
    "KO Candidato",
    "KO Cliente",
    "Senza fase",
    "QM OK",
    "Interno"
  ];
  const extraStatuses = [...new Set(Object.values(bySource).flatMap((row) => Object.keys(row)))]
    .filter((status) => !preferredStatuses.includes(status))
    .sort((a, b) => a.localeCompare(b));
  const statuses = [...preferredStatuses, ...extraStatuses].filter((status) =>
    sources.some((source) => bySource[source]?.[status])
  );

  if (!sources.length || !statuses.length) {
    $("#sourceStatusChart").innerHTML = `<p class="muted">Nessuno stato candidato disponibile per fornitore.</p>`;
    return;
  }

  $("#sourceStatusChart").innerHTML = `
    <table class="analytics-table quality-table">
      <thead>
        <tr>
          <th>Fornitore</th>
          ${statuses.map((status) => `<th class="${statusClass(status)}">${escapeHtml(status)}</th>`).join("")}
          <th>Totale</th>
          <th>% KO</th>
        </tr>
      </thead>
      <tbody>
        ${sources.map((source) => {
          const row = bySource[source] || {};
          const total = statuses.reduce((sum, status) => sum + (row[status] || 0), 0);
          const koTotal = statuses
            .filter((status) => normalizeText(status).startsWith("ko"))
            .reduce((sum, status) => sum + (row[status] || 0), 0);
          const koRate = total ? Math.round((koTotal / total) * 100) : 0;
          return `
            <tr>
              <th>${escapeHtml(source)}</th>
              ${statuses.map((status) => `<td class="${statusClass(status)}">${row[status] || ""}</td>`).join("")}
              <td><strong>${total}</strong></td>
              <td class="${koRate >= 50 ? "ko-heavy" : ""}"><strong>${koRate}%</strong></td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}

function renderNeedStatusChart(byNeed = {}) {
  const needs = Object.keys(byNeed).sort((a, b) => a.localeCompare(b));
  const preferredStatuses = [
    "Primo Colloquio",
    "Inviato Dossier",
    "Organizzata QM",
    "KO BM",
    "KO Candidato",
    "KO Cliente",
    "Senza fase",
    "QM OK",
    "Interno"
  ];
  const extraStatuses = [...new Set(Object.values(byNeed).flatMap((row) => Object.keys(row)))]
    .filter((status) => !preferredStatuses.includes(status))
    .sort((a, b) => a.localeCompare(b));
  const statuses = [...preferredStatuses, ...extraStatuses].filter((status) =>
    needs.some((need) => byNeed[need]?.[status])
  );

  if (!needs.length || !statuses.length) {
    $("#needStatusChart").innerHTML = `<p class="muted">Nessuna associazione candidato-need ancora registrata.</p>`;
    return;
  }

  $("#needStatusChart").innerHTML = `
    <table class="analytics-table quality-table">
      <thead>
        <tr>
          <th>Need</th>
          ${statuses.map((status) => `<th class="${statusClass(status)}">${escapeHtml(status)}</th>`).join("")}
          <th>Totale</th>
          <th>% KO</th>
        </tr>
      </thead>
      <tbody>
        ${needs.map((need) => {
          const row = byNeed[need] || {};
          const total = statuses.reduce((sum, status) => sum + (row[status] || 0), 0);
          const koTotal = statuses
            .filter((status) => normalizeText(status).startsWith("ko"))
            .reduce((sum, status) => sum + (row[status] || 0), 0);
          const koRate = total ? Math.round((koTotal / total) * 100) : 0;
          return `
            <tr>
              <th>${escapeHtml(need)}</th>
              ${statuses.map((status) => `<td class="${statusClass(status)}">${row[status] || ""}</td>`).join("")}
              <td><strong>${total}</strong></td>
              <td class="${koRate >= 50 ? "ko-heavy" : ""}"><strong>${koRate}%</strong></td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}

function statusClass(status) {
  const normalized = normalizeText(status);
  if (normalized.includes("ko")) return "status-ko";
  if (normalized.includes("dossier") || normalized.includes("qm")) return "status-good";
  if (normalized.includes("colloquio")) return "status-mid";
  return "";
}

function renderNeeds() {
  renderNeedPriorityFilter();
  renderNeedStatusFilter();
  const needs = state.needs
    .filter(textMatches)
    .filter(needPriorityMatches)
    .filter(needStatusMatches);
  $("#needsList").innerHTML = needs.map((need) => `
    <article class="card">
      <div class="card-header">
        <div>
          <h3>${escapeHtml(need.title)}</h3>
          <p class="muted">${escapeHtml(need.client)} · ${escapeHtml(need.location)} · ${escapeHtml(need.seniority)}</p>
        </div>
        <div class="actions">
          ${badge(need.status, need.status === "Open" ? "good" : "")}
          ${badge(need.urgency, need.urgency === "Alta" ? "warn" : "")}
          <button data-action="matchNeed" data-id="${need.id}">Matching</button>
          <button data-action="editNeed" data-id="${need.id}">Modifica</button>
        </div>
      </div>
      <div class="meta">
        <span>FTE: ${escapeHtml(need.fte || "-")}</span>
        <span>Budget: ${escapeHtml(need.budget || "-")}</span>
        <span>Owner: ${escapeHtml(need.owner || "-")}</span>
        <span>Modalità: ${escapeHtml(need.workMode || "-")}</span>
      </div>
      ${skills(need.skills)}
      <p class="muted">${escapeHtml(need.description || "")}</p>
    </article>
  `).join("") || `<p class="muted">Nessun need trovato.</p>`;
}

function renderNeedStatusFilter() {
  const select = $("#needStatusFilter");
  if (!select) return;

  const statuses = [...new Set(state.needs.map((need) => need.status).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  const validStatuses = ["Attivi", "Tutti", ...statuses];

  if (!validStatuses.includes(state.selectedNeedStatus)) {
    state.selectedNeedStatus = "Attivi";
  }

  select.innerHTML = validStatuses.map((status) => `
    <option value="${escapeHtml(status)}" ${status === state.selectedNeedStatus ? "selected" : ""}>
      ${status === "Attivi" ? "Solo attivi" : status === "Tutti" ? "Tutti gli stati" : escapeHtml(status)}
    </option>
  `).join("");
}

function renderNeedPriorityFilter() {
  const select = $("#needPriorityFilter");
  if (!select) return;

  const priorities = [...new Set(state.needs.map((need) => need.urgency).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  const validPriorities = ["Tutte", ...priorities];

  if (!validPriorities.includes(state.selectedNeedPriority)) {
    state.selectedNeedPriority = "Tutte";
  }

  select.innerHTML = validPriorities.map((priority) => `
    <option value="${escapeHtml(priority)}" ${priority === state.selectedNeedPriority ? "selected" : ""}>
      ${priority === "Tutte" ? "Tutte le priorita" : escapeHtml(priority)}
    </option>
  `).join("");
}

function renderCandidates() {
  renderCandidateStatusFilter();
  const candidates = state.candidates
    .filter(textMatches)
    .filter(candidateStatusMatches);
  $("#candidatesList").innerHTML = candidates.map((candidate) => `
    <article class="card">
      <div class="card-header">
        <div>
          <h3>${escapeHtml(candidate.name)}</h3>
          <p class="muted">${escapeHtml(candidate.role || "-")} · ${escapeHtml(candidate.city || "-")}</p>
        </div>
          <div class="actions">
            ${badge(candidate.phase, candidate.phase?.toLowerCase().includes("ko") ? "bad" : "")}
            ${badge(candidate.evaluation)}
            <button data-action="editCandidate" data-id="${candidate.id}">Modifica</button>
            <button class="danger" data-action="deleteCandidate" data-id="${candidate.id}">Cancella</button>
          </div>
      </div>
      <div class="meta">
        <span>Esperienza: ${escapeHtml(candidate.experienceRaw || "-")}</span>
        <span>Disponibilità: ${escapeHtml(candidate.availability || "-")}</span>
        <span>RAL desiderata: ${escapeHtml(candidate.desiredRal || "-")}</span>
      </div>
      ${candidateNeedPanel(candidate)}
      ${candidateFilesPanel(candidate)}
      ${skills(candidate.skills)}
      <p class="muted">${escapeHtml(candidate.notes || candidate.description || "")}</p>
    </article>
  `).join("") || `<p class="muted">Nessun candidato trovato.</p>`;
}

function renderCandidateStatusFilter() {
  const select = $("#candidateStatusFilter");
  if (!select) return;

  const validStatuses = ["Attivi", "Tutti"];
  if (!validStatuses.includes(state.selectedCandidateStatus)) {
    state.selectedCandidateStatus = "Attivi";
  }

  select.innerHTML = validStatuses.map((status) => `
    <option value="${escapeHtml(status)}" ${status === state.selectedCandidateStatus ? "selected" : ""}>
      ${status === "Attivi" ? "Solo attivi" : "Tutti i candidati"}
    </option>
  `).join("");
}

function renderPipeline() {
  const candidates = state.candidates.filter(textMatches);
  const pipelineStages = pipelineStagesFromData();
  const byStage = new Map(pipelineStages.map((stage) => [stage, []]));

  for (const candidate of candidates) {
    const stage = canonicalPipelineStage(candidate.phase) || "Senza fase";
    if (!byStage.has(stage)) byStage.set(stage, []);
    byStage.get(stage).push(candidate);
  }

  const visibleStages = state.selectedPipelineStage === "Tutte"
    ? pipelineStages
    : [state.selectedPipelineStage];

  renderPipelineFilter(pipelineStages);
  $("#pipelineBoard").classList.toggle("single-column", visibleStages.length === 1);
  $("#pipelineBoard").innerHTML = visibleStages.map((stage) => {
    const items = byStage.get(stage) || [];
    return `
    <section class="pipeline-column ${PIPELINE_STAGE_CLASSES[stage] || "stage-empty"}">
      <header>
        <h3>${escapeHtml(stage)}</h3>
        ${badge(String(items.length), stage.toLowerCase().includes("ko") ? "bad" : "")}
      </header>
      ${items.map((candidate) => `
        <article class="pipeline-card">
          <div>
            <h3>${escapeHtml(candidate.name)}</h3>
            <p class="muted">${escapeHtml(candidate.role || "-")}</p>
          </div>
          <div class="meta">
            <span>${escapeHtml(candidate.evaluation || "No rating")}</span>
            <span>${escapeHtml(candidateNeedLabels(candidate) || "Nessun need")}</span>
          </div>
          <select data-action="changeStage" data-id="${candidate.id}" aria-label="Fase processo">
            ${pipelineStageOptions(candidate.phase).map((option) => `
              <option value="${escapeHtml(option)}" ${normalizeText(option) === normalizeText(candidate.phase) ? "selected" : ""}>${escapeHtml(option)}</option>
            `).join("")}
          </select>
          <div class="actions">
            <button data-action="editCandidate" data-id="${candidate.id}">Modifica</button>
            <button class="danger" data-action="deleteCandidate" data-id="${candidate.id}">Cancella</button>
            ${state.selectedNeedId ? `<button data-action="associate" data-id="${candidate.id}">Associa al need selezionato</button>` : ""}
          </div>
        </article>
      `).join("") || `<p class="muted">Nessun candidato in questo step.</p>`}
    </section>
    `;
  }).join("");
}

function renderPipelineFilter(pipelineStages) {
  const options = ["Tutte", ...pipelineStages];
  if (!options.includes(state.selectedPipelineStage)) state.selectedPipelineStage = "Tutte";
  $("#pipelineFilter").innerHTML = options.map((stage) => `
    <option value="${escapeHtml(stage)}" ${stage === state.selectedPipelineStage ? "selected" : ""}>${escapeHtml(stage)}</option>
  `).join("");
}

function pipelineStageOptions(currentPhase = "") {
  const current = canonicalPipelineStage(currentPhase);
  return [...new Set([...PIPELINE_STAGES.filter((stage) => stage !== "Senza fase"), current].filter(Boolean))];
}

function renderNeedSelect() {
  const activeNeeds = state.needs.filter((need) => !isNeedClosed(need.status));
  if (!activeNeeds.some((need) => need.id === state.selectedNeedId)) {
    state.selectedNeedId = activeNeeds[0]?.id || "";
  }
  $("#needSelect").innerHTML = activeNeeds.map((need) => `
    <option value="${need.id}" ${need.id === state.selectedNeedId ? "selected" : ""}>
      ${escapeHtml(need.title)}
    </option>
  `).join("") || `<option value="">Nessun need attivo</option>`;
}

function candidateNeedLabels(candidate) {
  const fromApplications = state.applications
    .filter((application) => normalizeText(application.candidateName) === normalizeText(candidate.name))
    .map((application) => application.needTitle)
    .filter(Boolean);
  const all = [...new Set([...fromApplications, candidate.associatedNeed].filter(Boolean))];
  return all.join(", ");
}

function candidateNeedPanel(candidate) {
  const labels = candidateNeedLabels(candidate);
  if (!labels) {
    return `<div class="association-panel empty"><strong>Need associato</strong><span>Nessun need associato</span></div>`;
  }
  return `
    <div class="association-panel">
      <strong>Need associato</strong>
      <span>${escapeHtml(labels)}</span>
    </div>
  `;
}

function candidateFilesPanel(candidate) {
  const files = candidate.files || [];
  if (!files.length) return "";
  return `
    <div class="candidate-files">
      <strong>CV</strong>
      ${files.map((file) => `
        <a href="${escapeHtml(file.downloadUrl)}" title="Scarica ${escapeHtml(file.name)}">${escapeHtml(file.name)}</a>
      `).join("")}
    </div>
  `;
}

function matchQuality(score) {
  if (score >= 75) return { label: "Match forte", kind: "good" };
  if (score >= 50) return { label: "Da valutare", kind: "warn" };
  return { label: "Debole", kind: "bad" };
}

function needSummary(need) {
  if (!need) return "";
  return `
    <article class="match-summary">
      <div>
        <span class="muted">Need selezionato</span>
        <h3>${escapeHtml(need.title)}</h3>
        <p class="muted">${escapeHtml(need.client || "-")} - ${escapeHtml(need.location || "-")} - ${escapeHtml(need.seniority || "-")}</p>
      </div>
      <div class="actions">
        ${badge(need.status, need.status === "Open" ? "good" : "")}
        ${badge(need.urgency, need.urgency === "Alta" ? "warn" : "")}
        ${badge(`${need.fte || "-"} FTE`)}
      </div>
    </article>
  `;
}

async function renderMatches() {
  renderNeedSelect();
  const target = $("#matchesList");
  if (!state.selectedNeedId) {
    target.innerHTML = `<p class="muted">Seleziona un need.</p>`;
    return;
  }
  target.innerHTML = `<p class="muted">Calcolo matching...</p>`;
  try {
    const data = await api(`/api/needs/${encodeURIComponent(state.selectedNeedId)}/matches`);
    target.innerHTML = `
      ${needSummary(data.need)}
      ${data.matches.map(({ candidate, score, positives, warnings, missing, matchedSkills }) => {
        const quality = matchQuality(score);
        return `
      <article class="card">
        <div class="card-header">
          <div>
            <h3>${escapeHtml(candidate.name)}</h3>
            <p class="muted">${escapeHtml(candidate.role || "-")} · ${escapeHtml(candidate.city || "-")}</p>
          </div>
          <div class="actions">
            ${badge(quality.label, quality.kind)}
            ${badge(candidate.phase, candidate.phase?.toLowerCase().includes("ko") ? "bad" : "")}
            <button data-action="associate" data-id="${candidate.id}">Associa al need</button>
          </div>
        </div>
        <div class="score-row">
          <div class="score">${score}%</div>
          <div class="bar" aria-label="Score ${score}%"><span style="width:${score}%"></span></div>
        </div>
        ${candidateNeedPanel(candidate)}
        ${candidateFilesPanel(candidate)}
        <div>${skills(matchedSkills)}</div>
        <div class="reason-list">
          ${positives.map((item) => `<span>+ ${escapeHtml(item)}</span>`).join("")}
          ${warnings.map((item) => `<span>! ${escapeHtml(item)}</span>`).join("")}
          ${missing.length ? `<span>Campi mancanti: ${escapeHtml(missing.join(", "))}</span>` : ""}
        </div>
      </article>
    `;
      }).join("") || `<p class="muted">Nessun candidato disponibile per il matching.</p>`}
    `;
  } catch (error) {
    target.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
  }
}

function setTab(tab) {
  state.selectedTab = tab;
  document.querySelectorAll(".tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
  $(`#${tab}View`).classList.add("active");
  renderDashboard();
  if (tab === "matching") renderMatches();
  if (tab === "pipeline") renderPipeline();
  if (tab === "dashboardPage") renderDashboardPage();
}

function field(name, label, value = "", full = false, multiline = false) {
  return `
    <div class="field ${full ? "full" : ""}">
      <label for="${name}">${label}</label>
      ${multiline
        ? `<textarea id="${name}" name="${name}">${escapeHtml(value)}</textarea>`
        : `<input id="${name}" name="${name}" value="${escapeHtml(value)}" />`}
    </div>
  `;
}

function toDateInput(value = "") {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return text;
  const [, day, month, year] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function fromDateInput(value = "") {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return text;
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}

function dateField(name, label, value = "") {
  return `
    <div class="field">
      <label for="${name}">${label}</label>
      <input id="${name}" name="${name}" type="date" value="${escapeHtml(toDateInput(value))}" />
    </div>
  `;
}

function fileField(name, label) {
  return `
    <div class="field full">
      <label for="${name}">${label}</label>
      <input id="${name}" name="${name}" type="file" multiple accept=".pdf,.doc,.docx,.rtf,.txt,.odt,.png,.jpg,.jpeg" />
      <span class="field-help">Puoi selezionare piu file. Durante il salvataggio resta su questa finestra.</span>
    </div>
  `;
}

function candidateFilesEditor(candidate = {}) {
  const files = candidate.files || [];
  if (!files.length) return "";
  return `
    <div class="field full">
      <span class="field-label">File gia caricati</span>
      <div class="candidate-file-list">
        ${files.map((file) => `
          <div class="candidate-file-row">
            <a href="${escapeHtml(file.downloadUrl)}">${escapeHtml(file.name)}</a>
            <button type="button" class="danger" data-action="deleteCandidateFile" data-id="${escapeHtml(file.id)}" data-candidate-id="${escapeHtml(candidate.id)}">Elimina</button>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function selectField(name, label, value = "", options = [], full = false) {
  return `
    <div class="field ${full ? "full" : ""}">
      <label for="${name}">${label}</label>
      <select id="${name}" name="${name}">
        ${options.map((option) => {
          const optionValue = typeof option === "string" ? option : option.value;
          const optionLabel = typeof option === "string" ? option : option.label;
          const selected = normalizeText(optionValue) === normalizeText(value);
          return `<option value="${escapeHtml(optionValue)}" ${selected ? "selected" : ""}>${escapeHtml(optionLabel)}</option>`;
        }).join("")}
      </select>
    </div>
  `;
}

function selectedSeniorityValues(value = "") {
  const tokens = String(value || "")
    .split(/[,\-/]+/)
    .map((item) => normalizeText(item))
    .filter(Boolean);

  return SENIORITY_OPTIONS.filter((option) => tokens.includes(normalizeText(option)));
}

function seniorityField(value = "") {
  const selected = selectedSeniorityValues(value);
  return `
    <div class="field">
      <span class="field-label">Seniority</span>
      <div class="checkbox-group">
        ${SENIORITY_OPTIONS.map((option) => `
          <label class="checkbox-option">
            <input type="checkbox" name="seniority" value="${escapeHtml(option)}" ${selected.includes(option) ? "checked" : ""} />
            <span>${escapeHtml(option)}</span>
          </label>
        `).join("")}
      </div>
    </div>
  `;
}

function openNeedForm(need = {}) {
  state.editing = { type: "need", id: need.id };
  $("#dialogTitle").textContent = need.id ? "Modifica need" : "Nuovo need";
  const urgencyOptions = ["", "Bassa", "Medio", "Alta"];
  const statusOptions = ["Open", "Stand-by", "Closed-KO", "Closed-WIN"];
  $("#formFields").innerHTML = [
    field("title", "Titolo", need.title),
    field("fte", "FTE ricercate", need.fte),
    field("client", "Cliente", need.client),
    field("location", "Sede", need.location),
    seniorityField(need.seniority),
    field("skills", "Skills", need.skills?.join(", "), true),
    selectField("urgency", "Urgenza", need.urgency, urgencyOptions),
    selectField("status", "Stato", need.status || "Open", statusOptions),
    field("budget", "Budget", need.budget),
    field("owner", "Owner", need.owner),
    field("workMode", "Modalità lavoro", need.workMode),
    dateField("openedAt", "Data apertura need", need.openedAt),
    dateField("closedAt", "Data chiusura need", need.closedAt),
    field("description", "Descrizione", need.description, true, true)
  ].join("");
  if (!$("#editDialog").open) $("#editDialog").showModal();
}

function openCandidateForm(candidate = {}) {
  state.editing = { type: "candidate", id: candidate.id };
  $("#dialogTitle").textContent = candidate.id ? "Modifica candidato" : "Nuovo candidato";
  const evaluationOptions = ["", "A+", "A", "B+", "B", "C"];
  const phaseOptions = PIPELINE_STAGES.filter((stage) => stage !== "Senza fase");
  const availabilityOptions = ["", "Disponibile da subito", "Preavviso 30", "Preavviso 45", "Preavviso 60", "Preavviso 90"];
  const geographicAvailabilityOptions = ["", "Si", "No"];
  const sourceOptions = buildCandidateSourceOptions(candidate.source);
  const needOptions = [
    { value: "", label: "Nessun need associato" },
    ...state.needs.map((need) => ({ value: need.title, label: `${need.title} - ${need.client || "Cliente non indicato"}` }))
  ];
  $("#formFields").innerHTML = [
    field("name", "Nome", candidate.name),
    field("role", "Ruolo", candidate.role),
    field("skills", "Skills", candidate.skills?.join(", "), true),
    selectField("evaluation", "Valutazione", candidate.evaluation, evaluationOptions),
    selectField("phase", "Fase processo", candidate.phase || "Primo contatto", phaseOptions),
    field("experienceRaw", "Anni esperienza", candidate.experienceRaw),
    selectField("availability", "Disponibilità", candidate.availability, availabilityOptions),
    field("currentRal", "RAL attuale", candidate.currentRal),
    field("desiredRal", "RAL desiderata", candidate.desiredRal),
    field("contract", "Inquadramento", candidate.contract),
    selectField("source", "Fornitore CV", candidate.source, sourceOptions),
    field("city", "Città", candidate.city),
    selectField("geographicAvailability", "Disponibilità geografica", candidate.geographicAvailability, geographicAvailabilityOptions),
    field("relocationCity", "Città dove vuole trasferirsi", candidate.relocationCity, true),
    dateField("firstInterviewAt", "Data primo colloquio", candidate.firstInterviewAt),
    dateField("qmAt", "Data QM", candidate.qmAt),
    field("email", "Email", candidate.email),
    fileField("candidateFiles", "CV / allegati candidato"),
    candidateFilesEditor(candidate),
    selectField("associatedNeed", "Need associato", candidate.associatedNeed, needOptions, true),
    field("notes", "Note BM", candidate.notes, true, true),
    field("description", "Descrizione candidato", candidate.description, true, true)
  ].join("");
  if (!$("#editDialog").open) $("#editDialog").showModal();
}

function buildCandidateSourceOptions(currentSource = "") {
  const defaults = ["", "Allibo", "Almalaurea", "BSG", "OpenJob", "Segnalazione", "Linkedin Candidatura", "Linkedin Ricerca attiva", "Sito Web"];
  const fromData = state.candidates.map((candidate) => candidate.source).filter(Boolean);
  return [...new Set([...defaults, ...fromData, currentSource].filter((value, index, array) => value || index === 0))]
    .sort((a, b) => {
      if (!a) return -1;
      if (!b) return 1;
      return a.localeCompare(b);
    });
}

function formPayload() {
  const form = new FormData($("#editForm"));
  const payload = Object.fromEntries(form.entries());
  delete payload.candidateFiles;
  if (state.editing?.type === "need") {
    payload.seniority = form.getAll("seniority").join(", ");
  }
  if (payload.skills) payload.skills = payload.skills.split(",").map((item) => item.trim()).filter(Boolean);
  for (const key of ["openedAt", "closedAt", "firstInterviewAt", "qmAt"]) {
    if (key in payload) payload[key] = fromDateInput(payload[key]);
  }
  return payload;
}

function selectedCandidateFiles() {
  const input = $("#candidateFiles");
  return input ? [...input.files] : [];
}

async function uploadCandidateFiles(candidateId, files) {
  if (!candidateId || !files.length) return null;
  const formData = new FormData();
  for (const file of files) formData.append("files", file);
  return api(`/api/candidates/${encodeURIComponent(candidateId)}/files`, {
    method: "POST",
    body: formData
  });
}

function setFormSaving(isSaving, message = "Salvataggio in corso...") {
  const button = $("#saveButton");
  const fields = $("#formFields");
  if (button) {
    button.disabled = isSaving;
    button.textContent = isSaving ? "Salvataggio..." : "Salva";
  }
  if (fields) fields.classList.toggle("is-saving", isSaving);
  let indicator = $("#formSavingMessage");
  if (!indicator && isSaving) {
    indicator = document.createElement("p");
    indicator.id = "formSavingMessage";
    indicator.className = "form-saving-message";
    $("#editForm footer").prepend(indicator);
  }
  if (indicator) {
    indicator.hidden = !isSaving;
    indicator.textContent = message;
  }
}

async function saveForm() {
  const payload = formPayload();
  const current = state.editing;
  const filesToUpload = current.type === "candidate" ? selectedCandidateFiles() : [];
  let emailNotification = null;
  try {
    setFormSaving(true, filesToUpload.length ? `Caricamento di ${filesToUpload.length} file in corso...` : "Salvataggio in corso...");
    if (current.type === "need") {
      const path = current.id ? `/api/needs/${encodeURIComponent(current.id)}` : "/api/needs";
      const saved = await api(path, { method: current.id ? "PUT" : "POST", body: JSON.stringify(payload) });
      emailNotification = saved.emailNotification;
    } else {
      const path = current.id ? `/api/candidates/${encodeURIComponent(current.id)}` : "/api/candidates";
      const saved = await api(path, { method: current.id ? "PUT" : "POST", body: JSON.stringify(payload) });
      emailNotification = saved.emailNotification;
      if (filesToUpload.length && saved.item?.id) {
        setFormSaving(true, `Caricamento di ${filesToUpload.length} file in corso...`);
        await uploadCandidateFiles(saved.item.id, filesToUpload);
      }
      if (shouldCreateCandidateAssociation(current, payload.associatedNeed)) {
        const need = state.needs.find((item) => item.title === payload.associatedNeed);
        if (need && saved.item) {
          try {
            await api("/api/applications", {
              method: "POST",
              body: JSON.stringify({ candidateId: saved.item.id, needId: need.id })
            });
          } catch (error) {
            if (!String(error.message).includes("già presente")) throw error;
          }
        }
      }
    }
    $("#editDialog").close();
    showStatus(saveStatusMessage(current, emailNotification));
    await loadData();
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    setFormSaving(false);
  }
}

function shouldCreateCandidateAssociation(current, associatedNeed) {
  if (!associatedNeed) return false;
  if (!current?.id) return true;
  const candidate = state.candidates.find((item) => item.id === current.id);
  return normalizeText(candidate?.associatedNeed) !== normalizeText(associatedNeed);
}

function isDuplicateAssociationError(error) {
  const message = normalizeText(error?.message);
  return message.includes("associazione") && message.includes("presente");
}

function saveStatusMessage(current, emailNotification) {
  if (current?.id || !emailNotification?.enabled) {
    return "Salvato. Backup CSV creato automaticamente.";
  }
  const recordLabel = current?.type === "need" ? "Need" : "Candidato";
  if (emailNotification.sent) {
    return `${recordLabel} salvato. Mail inviata a ${emailNotification.recipients.length} contatti.`;
  }
  return `${recordLabel} salvato. Mail non inviata: ${emailNotification.error || "configurazione SMTP da verificare"}.`;
}

async function associateCandidate(candidateId) {
  const candidate = state.candidates.find((item) => item.id === candidateId);
  const need = state.needs.find((item) => item.id === state.selectedNeedId);
  if (!candidate || !need) return;
  try {
    await api("/api/applications", {
      method: "POST",
      body: JSON.stringify({ candidateId: candidate.id, needId: need.id })
    });
    showStatus(`${candidate.name} associato a ${need.title}.`);
    await loadData();
    setTab("matching");
  } catch (error) {
    showStatus(error.message, true);
  }
}

async function changeCandidateStage(candidateId, phase) {
  const candidate = state.candidates.find((item) => item.id === candidateId);
  if (!candidate) return;
  try {
    await api(`/api/candidates/${encodeURIComponent(candidate.id)}`, {
      method: "PUT",
      body: JSON.stringify({ phase })
    });
    showStatus(`${candidate.name}: fase aggiornata a ${phase}.`);
    await loadData();
    setTab("pipeline");
  } catch (error) {
    showStatus(error.message, true);
  }
}

async function deleteCandidate(candidateId) {
  const candidate = state.candidates.find((item) => item.id === candidateId);
  if (!candidate) return;
  const ok = window.confirm(`Cancellare ${candidate.name}? Verrà creato prima un backup del CSV.`);
  if (!ok) return;
  try {
    await api(`/api/candidates/${encodeURIComponent(candidate.id)}`, {
      method: "DELETE"
    });
    showStatus(`${candidate.name} cancellato. Backup CSV creato automaticamente.`);
    await loadData();
  } catch (error) {
    showStatus(error.message, true);
  }
}

async function deleteCandidateFile(fileId, candidateId) {
  if (!fileId) return;
  const ok = window.confirm("Eliminare questo file candidato?");
  if (!ok) return;
  try {
    await api(`/api/candidate-files/${encodeURIComponent(fileId)}`, {
      method: "DELETE"
    });
    showStatus("File eliminato.");
    await loadData();
    const updated = state.candidates.find((candidate) => candidate.id === candidateId);
    if ($("#editDialog").open && updated) openCandidateForm(updated);
  } catch (error) {
    showStatus(error.message, true);
  }
}

async function importRecords(kind, file) {
  const formData = new FormData();
  formData.append("file", file);
  const label = kind === "candidates" ? "candidati" : "need";
  try {
    showStatus(`Import ${label} in corso...`);
    const result = await api(`/api/import/${kind}`, {
      method: "POST",
      body: formData
    });
    showStatus(`Import ${label}: ${result.imported} nuovi, ${result.skipped} duplicati o non validi.`);
    await loadData();
  } catch (error) {
    showStatus(error.message, true);
  }
}

function renderAll() {
  renderDashboard();
  renderDashboardPage();
  renderNeeds();
  renderCandidates();
  renderPipeline();
  renderNeedSelect();
}

async function loadData({ silent = false } = {}) {
  const dialog = $("#editDialog");
  if (silent && dialog?.open) return;

  try {
    const [needs, candidates, applications] = await Promise.all([
      api("/api/needs"),
      api("/api/candidates"),
      api("/api/applications")
    ]);
    const dashboard = await api("/api/dashboard");
    state.dashboard = dashboard;
    state.needs = needs;
    state.candidates = candidates;
    state.applications = applications;
    if (!state.selectedNeedId && needs[0]) state.selectedNeedId = needs[0].id;
    renderAll();
    if (state.selectedTab === "matching") renderMatches();
    if (state.selectedTab === "dashboardPage") renderDashboardPage();
  } catch (error) {
    if (!silent) showStatus(error.message, true);
  }
}

document.addEventListener("click", async (event) => {
  const action = event.target?.dataset?.action;
  const id = event.target?.dataset?.id;
  if (!action) return;
  if (action === "editNeed") openNeedForm(state.needs.find((item) => item.id === id));
  if (action === "editCandidate") openCandidateForm(state.candidates.find((item) => item.id === id));
  if (action === "deleteCandidate") await deleteCandidate(id);
  if (action === "deleteCandidateFile") await deleteCandidateFile(id, event.target?.dataset?.candidateId);
  if (action === "matchNeed") {
    state.selectedNeedId = id;
    setTab("matching");
  }
  if (action === "associate") await associateCandidate(id);
});

document.addEventListener("change", async (event) => {
  const action = event.target?.dataset?.action;
  const id = event.target?.dataset?.id;
  if (action === "changeStage") {
    await changeCandidateStage(id, event.target.value);
  }
});

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => setTab(button.dataset.tab));
});

$("#searchInput").addEventListener("input", (event) => {
  state.search = event.target.value;
  renderNeeds();
  renderCandidates();
  renderPipeline();
});

$("#needSelect").addEventListener("change", (event) => {
  state.selectedNeedId = event.target.value;
  renderMatches();
});

$("#needPriorityFilter").addEventListener("change", (event) => {
  state.selectedNeedPriority = event.target.value;
  renderNeeds();
});

$("#needStatusFilter").addEventListener("change", (event) => {
  state.selectedNeedStatus = event.target.value;
  renderNeeds();
});

$("#candidateStatusFilter").addEventListener("change", (event) => {
  state.selectedCandidateStatus = event.target.value;
  renderCandidates();
});

$("#pipelineFilter").addEventListener("change", (event) => {
  state.selectedPipelineStage = event.target.value;
  renderPipeline();
});

function toggleToolsMenu(open = $("#toolsMenu").hidden) {
  $("#toolsMenu").hidden = !open;
  $("#toolsMenuButton").setAttribute("aria-expanded", String(open));
}

$("#toolsMenuButton").addEventListener("click", (event) => {
  event.stopPropagation();
  toggleToolsMenu();
});

document.addEventListener("click", (event) => {
  if (!$("#toolsMenu").hidden && !event.target.closest(".topbar-actions")) {
    toggleToolsMenu(false);
  }
});

$("#exportCandidatesButton").addEventListener("click", () => {
  toggleToolsMenu(false);
  window.location.href = "/api/export/candidates.xlsx";
});
$("#exportNeedsButton").addEventListener("click", () => {
  toggleToolsMenu(false);
  window.location.href = "/api/export/needs.xlsx";
});
$("#importCandidatesButton").addEventListener("click", () => {
  toggleToolsMenu(false);
  $("#importCandidatesInput").click();
});
$("#importNeedsButton").addEventListener("click", () => {
  toggleToolsMenu(false);
  $("#importNeedsInput").click();
});
$("#importCandidatesInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (file) await importRecords("candidates", file);
  event.target.value = "";
});
$("#importNeedsInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (file) await importRecords("needs", file);
  event.target.value = "";
});
$("#newNeedButton").addEventListener("click", () => openNeedForm());
$("#newCandidateButton").addEventListener("click", () => openCandidateForm());
$("#saveButton").addEventListener("click", saveForm);

window.addEventListener("focus", () => loadData({ silent: true }));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") loadData({ silent: true });
});

window.setInterval(() => {
  loadData({ silent: true });
}, 30000);

loadData();
