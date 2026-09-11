const state = {
  plants: [],
  allMissions: [],
  missions: [],
  allAlerts: [],
  summary: {},
  trend: [],
  meta: {},
  filters: { plant: "", robot: "", status: "", from: "", to: "", search: "" },
  sort: { field: "startTime", direction: "desc" },
};

const main = document.querySelector("#main-content");
const sidebar = document.querySelector("#sidebar");
const mobileScrim = document.querySelector("#mobile-scrim");
const alertDialog = document.querySelector("#alert-dialog");
const previewDialog = document.querySelector("#preview-dialog");

function icon(name, className = "") {
  return `<svg class="${className}" aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function slug(value) {
  return String(value || "unavailable").toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.details?.join("; ") || payload.error || `Request failed (${response.status})`);
  return payload;
}

function showToast(message, type = "success") {
  const region = document.querySelector("#toast-region");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `${icon(type === "error" ? "alert" : "check")}<span>${escapeHtml(message)}</span>`;
  region.append(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

function plantById(id) {
  return state.plants.find((plant) => plant.id === id);
}

function formatDate(iso, plantId, compact = false) {
  if (!iso) return null;
  const plant = plantById(plantId);
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "2-digit",
      day: "2-digit",
      year: compact ? "2-digit" : "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
      timeZone: plant?.timezone || "UTC",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function formatShortDate(iso) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(`${iso}T12:00:00Z`));
}

function formatRelative(iso) {
  if (!iso) return "Unavailable";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return formatShortDate(iso.slice(0, 10));
}

function formatDuration(start, end) {
  if (!start || !end) return null;
  const seconds = Math.max(0, Math.round((new Date(end) - new Date(start)) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

function badge(label, className = slug(label)) {
  return `<span class="badge ${escapeHtml(className)}">${escapeHtml(label)}</span>`;
}

function unavailable(label = "Unavailable") {
  return `<span class="unavailable-copy">${escapeHtml(label)}</span>`;
}

function setPageChrome(route) {
  const detail = route.startsWith("mission/");
  const section = detail ? "tickets" : route.split("/")[0];
  const titles = {
    overview: ["SPOT Robotics", "Mission overview"],
    tickets: ["SPOT Robotics", "Tickets"],
  };
  const [eyebrow, title] = detail ? ["Mission record", "Mission details"] : (titles[section] || titles.overview);
  document.querySelector("#page-eyebrow").textContent = eyebrow;
  document.querySelector("#page-title").textContent = title;
  document.title = `${title} · ARCH SPOT`;
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.route === section));
}

function currentRoute() {
  const raw = window.location.hash.replace(/^#\/?/, "");
  return raw || "overview";
}

function navigate(route) {
  closeMobileNav();
  if (currentRoute() === route) {
    renderRoute();
  } else {
    window.location.hash = `/${route}`;
  }
}

function openMobileNav() {
  sidebar.classList.add("open");
  mobileScrim.classList.add("open");
}

function closeMobileNav() {
  sidebar.classList.remove("open");
  mobileScrim.classList.remove("open");
}

function updateNavCounts() {
  document.querySelector("#ticket-nav-count").textContent = state.allMissions.length;
}

function defaultDateRange(missions) {
  const dates = missions.map((mission) => mission.startTime.slice(0, 10)).sort();
  if (!dates.length) return { from: "", to: "" };
  const to = dates.at(-1);
  const fromDate = new Date(`${to}T12:00:00Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - 6);
  return { from: fromDate.toISOString().slice(0, 10), to };
}

async function loadBootstrap() {
  const [plantResponse, missionResponse, alertResponse] = await Promise.all([
    api("/api/plants"),
    api("/api/missions"),
    api("/api/alerts"),
  ]);
  state.plants = plantResponse.data;
  state.allMissions = missionResponse.data;
  state.allAlerts = alertResponse.data;
  const range = defaultDateRange(state.allMissions);
  state.filters.from = range.from;
  state.filters.to = range.to;
  await loadMissions();
  updateNavCounts();
}

function missionQuery() {
  const params = new URLSearchParams();
  Object.entries(state.filters).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  return params.toString();
}

async function loadMissions() {
  const payload = await api(`/api/missions?${missionQuery()}`);
  state.missions = payload.data;
  state.summary = payload.summary;
  state.trend = payload.trend;
  state.meta = payload.meta;
}

async function refreshAll({ toast = true } = {}) {
  const [allResponse, alertResponse] = await Promise.all([api("/api/missions"), api("/api/alerts")]);
  state.allMissions = allResponse.data;
  state.allAlerts = alertResponse.data;
  await loadMissions();
  updateNavCounts();
  if (toast) showToast("Mission data refreshed from the ARCH service.");
}

function filterOptions() {
  const plantOptions = state.plants.map((plant) => `<option value="${escapeHtml(plant.id)}" ${state.filters.plant === plant.id ? "selected" : ""}>${escapeHtml(plant.id)} · ${escapeHtml(plant.name)}</option>`).join("");
  const robots = [...new Set(state.allMissions
    .filter((mission) => !state.filters.plant || mission.plantId === state.filters.plant)
    .map((mission) => mission.robotId))].sort();
  const robotOptions = robots.map((robot) => `<option value="${escapeHtml(robot)}" ${state.filters.robot === robot ? "selected" : ""}>${escapeHtml(robot)}</option>`).join("");
  return { plantOptions, robotOptions };
}

function renderFilters({ includeRobot = true } = {}) {
  const { plantOptions, robotOptions } = filterOptions();
  return `
    <section class="filter-panel" aria-label="Mission filters">
      <form class="filter-form ${includeRobot ? "" : "tickets-filter-form"}" id="mission-filter-form">
        <div class="field">
          <label for="filter-plant">Plant</label>
          <select id="filter-plant" name="plant"><option value="">All authorized plants</option>${plantOptions}</select>
        </div>
        ${includeRobot ? `<div class="field">
          <label for="filter-robot">Robot</label>
          <select id="filter-robot" name="robot"><option value="">All robots</option>${robotOptions}</select>
        </div>` : ""}
        <div class="field">
          <label for="filter-status">Mission status</label>
          <select id="filter-status" name="status">
            <option value="">All statuses</option>
            ${["Not Started", "In Progress", "Complete"].map((value) => `<option value="${value}" ${state.filters.status === value ? "selected" : ""}>${value}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label for="filter-search">Mission ID</label>
          <div class="input-wrap">${icon("search")}<input id="filter-search" name="search" value="${escapeHtml(state.filters.search)}" placeholder="Search mission ID" autocomplete="off" /></div>
        </div>
        <div class="field">
          <label for="filter-from">Mission date range</label>
          <div class="date-range-fields">
            <input id="filter-from" name="from" type="date" value="${escapeHtml(state.filters.from)}" aria-label="From date" />
            <span>to</span>
            <input id="filter-to" name="to" type="date" value="${escapeHtml(state.filters.to)}" aria-label="To date" />
          </div>
        </div>
        <div class="filter-actions">
          <button class="button primary" type="submit">${icon("filter")}Apply</button>
          <button class="button" type="button" data-action="reset-filters">${icon("reset")}Reset</button>
        </div>
      </form>
    </section>`;
}

function renderPageHeading(title, description, action = "") {
  return `
    <header class="page-heading">
      <div><span class="eyebrow">Operational intelligence</span><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div>
      ${action || `<span class="updated-copy">Updated <strong>${escapeHtml(formatRelative(state.meta.refreshedAt))}</strong></span>`}
    </header>`;
}

function renderKpis() {
  const summary = state.summary;
  return `
    <section class="kpi-grid" aria-label="Mission KPI summary">
      <article class="metric-card teal">
        <div><span class="metric-label">Missions completed</span><strong class="metric-value">${summary.missionsCompleted ?? "—"}</strong><span class="metric-note"><span class="up">↑ 8%</span> vs prior 7 days</span></div>
        <span class="metric-icon">${icon("mission")}</span>
      </article>
      <article class="metric-card blue">
        <div><span class="metric-label">Inspections completed</span><strong class="metric-value">${summary.inspectionsCompleted ?? "—"}</strong><span class="metric-note">Across ${state.missions.length} mission records</span></div>
        <span class="metric-icon">${icon("check")}</span>
      </article>
      <article class="metric-card red">
        <div><span class="metric-label">Failed inspections</span><strong class="metric-value">${summary.failedInspections ?? "—"}</strong><span class="metric-note"><span class="attention">Requires reliability review</span></span></div>
        <span class="metric-icon">${icon("alert")}</span>
      </article>
      <article class="metric-card orange">
        <div><span class="metric-label">Open anomaly tickets</span><strong class="metric-value">${summary.openAlerts ?? "—"}</strong><span class="metric-note">Created through ARCH Alerts</span></div>
        <span class="metric-icon">${icon("pulse")}</span>
      </article>
    </section>`;
}

function chartPath(points) {
  return points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
}

function renderTrendChart(type, title, subtitle) {
  if (!state.trend.length) {
    return `<section class="section-card"><div class="card-header"><div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(subtitle)}</p></div></div><div class="empty-state">No mission data is available for this filter scope.</div></section>`;
  }
  const width = 660;
  const height = 215;
  const margin = { top: 15, right: 15, bottom: 34, left: 42 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const values = state.trend.flatMap((item) => [item[type].total, item[type].passed, item[type].failed]);
  const maxValue = Math.max(4, ...values);
  const ceiling = Math.ceil(maxValue / 4) * 4;
  const x = (index) => margin.left + (state.trend.length === 1 ? innerWidth / 2 : index * innerWidth / (state.trend.length - 1));
  const y = (value) => margin.top + innerHeight - (value / ceiling) * innerHeight;
  const series = [
    { key: "total", label: "Total", color: "var(--blue)", className: "total" },
    { key: "passed", label: "Passed", color: "var(--teal)", className: "pass" },
    { key: "failed", label: "Failed", color: "var(--red)", className: "fail" },
  ];
  const totalPoints = state.trend.map((item, index) => ({ x: x(index), y: y(item[type].total) }));
  const areaPath = `${chartPath(totalPoints)} L${x(state.trend.length - 1)},${margin.top + innerHeight} L${x(0)},${margin.top + innerHeight} Z`;
  const gradientId = `chart-area-${type}`;
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = ceiling - index * ceiling / 4;
    const lineY = margin.top + index * innerHeight / 4;
    return `<line class="chart-grid-line" x1="${margin.left}" x2="${width - margin.right}" y1="${lineY}" y2="${lineY}"/><text class="chart-label" x="${margin.left - 9}" y="${lineY + 3}" text-anchor="end">${Math.round(value)}</text>`;
  }).join("");
  const lines = series.map((item) => {
    const points = state.trend.map((entry, index) => ({ x: x(index), y: y(entry[type][item.key]), value: entry[type][item.key] }));
    return `<path class="chart-line chart-line-${item.className}" d="${chartPath(points)}"/>${points.map((point) => `<circle class="chart-dot" cx="${point.x}" cy="${point.y}" r="3.5" fill="${item.color}"><title>${item.label}: ${point.value}</title></circle>`).join("")}`;
  }).join("");
  const xLabels = state.trend.map((item, index) => `<text class="chart-label" x="${x(index)}" y="${height - 8}" text-anchor="middle">${escapeHtml(formatShortDate(item.date))}</text>`).join("");

  return `
    <section class="section-card trend-card">
      <div class="card-header"><div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(subtitle)}</p></div>${badge("Live scope", "healthy")}</div>
      <div class="chart-wrap">
        <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)} line chart">
          <defs><linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#68a7ff" stop-opacity=".18"/><stop offset="1" stop-color="#68a7ff" stop-opacity="0"/></linearGradient></defs>
          ${grid}<path d="${areaPath}" fill="url(#${gradientId})"/>${lines}${xLabels}
        </svg>
        <div class="chart-legend">
          <span style="color:var(--blue)"><i class="legend-line"></i>Total</span>
          <span style="color:var(--teal)"><i class="legend-line"></i>Passed</span>
          <span style="color:var(--red)"><i class="legend-line"></i>Failed</span>
        </div>
      </div>
    </section>`;
}

function sortMissions(missions) {
  const getValue = (mission) => ({
    id: mission.id,
    robotId: mission.robotId,
    startTime: mission.startTime,
    endTime: mission.endTime || "",
    duration: mission.endTime ? new Date(mission.endTime) - new Date(mission.startTime) : -1,
    status: mission.status,
    result: mission.missionResult || "",
    inspections: mission.inspectionCount,
    failed: mission.failedInspectionCount,
    anomalies: mission.anomalyCount,
  })[state.sort.field];
  return [...missions].sort((a, b) => {
    const first = getValue(a);
    const second = getValue(b);
    const comparison = typeof first === "number" ? first - second : String(first).localeCompare(String(second));
    return state.sort.direction === "asc" ? comparison : -comparison;
  });
}

function sortButton(label, field) {
  const active = state.sort.field === field;
  const direction = state.sort.direction === "asc" ? "↑" : "↓";
  return `<button class="sortable ${active ? "active" : ""}" data-sort="${field}" data-direction="${direction}">${escapeHtml(label)}</button>`;
}

function renderMissionTable({ limit = null, compact = false } = {}) {
  const missions = sortMissions(state.missions);
  const displayed = limit ? missions.slice(0, limit) : missions;
  if (!displayed.length) {
    return `<div class="empty-state"><div><strong>No missions match these filters.</strong><br><span>Adjust the plant, robot, status, mission ID, or date range.</span></div></div>`;
  }
  return `
    <div class="table-wrap">
      <table aria-label="SPOT missions">
        <thead><tr>
          <th>${sortButton("Mission ID", "id")}</th>
          <th>${sortButton("Robot ID", "robotId")}</th>
          <th>${sortButton("Start time", "startTime")}</th>
          <th>${sortButton("End time", "endTime")}</th>
          <th>${sortButton("Duration", "duration")}</th>
          <th>${sortButton("Status", "status")}</th>
          <th>${sortButton("Result", "result")}</th>
          <th>${sortButton("Inspections", "inspections")}</th>
          <th>${sortButton("Failed", "failed")}</th>
          ${compact ? "" : `<th>${sortButton("Anomalies", "anomalies")}</th>`}
        </tr></thead>
        <tbody>${displayed.map((mission) => `
          <tr>
            <td><button class="mission-link" data-mission-id="${escapeHtml(mission.id)}">${escapeHtml(mission.id)}</button></td>
            <td><span class="robot-cell">${icon("robot")}${escapeHtml(mission.robotId)}</span></td>
            <td>${escapeHtml(formatDate(mission.startTime, mission.plantId, true))}</td>
            <td>${mission.endTime ? escapeHtml(formatDate(mission.endTime, mission.plantId, true)) : unavailable("Pending")}</td>
            <td class="numeric-cell">${mission.endTime ? escapeHtml(formatDuration(mission.startTime, mission.endTime)) : unavailable("In progress")}</td>
            <td>${badge(mission.status)}</td>
            <td>${mission.missionResult ? badge(mission.missionResult) : badge("Unavailable")}</td>
            <td class="numeric-cell">${mission.inspectionCount}</td>
            <td class="numeric-cell ${mission.failedInspectionCount ? "failed-count" : ""}">${mission.failedInspectionCount}</td>
            ${compact ? "" : `<td class="numeric-cell ${mission.anomalyCount ? "failed-count" : ""}">${mission.anomalyCount}</td>`}
          </tr>`).join("")}</tbody>
      </table>
    </div>
    ${limit ? "" : `<div class="pagination"><span>Rows per page: <strong>${displayed.length}</strong></span><span>1–${displayed.length} of ${displayed.length}</span><button class="icon-button prev" disabled aria-label="Previous page">${icon("chevron")}</button><button class="icon-button" disabled aria-label="Next page">${icon("chevron")}</button></div>`}`;
}

function renderOverview() {
  main.innerHTML = `
    <div class="page">
      ${renderPageHeading("Good afternoon, Mariah", "A live view of SPOT missions, inspection outcomes, and anomaly follow-up across authorized plants.")}
      ${renderFilters()}
      ${renderKpis()}
      <div class="trend-pair">
        ${renderTrendChart("missions", "Weekly missions", "Total, passed, and failed missions")}
        ${renderTrendChart("inspections", "Weekly inspections", "Completed inspection point outcomes")}
      </div>
      <section class="section-card">
        <div class="table-toolbar"><div><h3>Recent mission tickets</h3><p>Mission ID opens the complete inspection record</p></div><div class="inline-actions"><button class="button" data-action="refresh">${icon("refresh")}Refresh</button><button class="button secondary" data-route="tickets">All tickets ${icon("chevron")}</button></div></div>
        ${renderMissionTable({ limit: 6, compact: true })}
      </section>
    </div>`;
}

function renderTickets() {
  main.innerHTML = `
    <div class="page">
      ${renderPageHeading("Tickets", "One traceable ticket per Orbit mission, normalized by Litmus and delivered to ARCH.")}
      ${renderFilters({ includeRobot: false })}
      <section class="section-card">
        <div class="table-toolbar">
          <div><h3>Ticket records</h3><p>${state.missions.length} ticket${state.missions.length === 1 ? "" : "s"} in the selected scope</p></div>
          <div class="inline-actions"><button class="button" data-action="refresh">${icon("refresh")}Refresh</button><button class="button secondary" data-action="export-missions">${icon("download")}Export CSV</button></div>
        </div>
        ${renderMissionTable()}
      </section>
    </div>`;
}

function summaryItem(label, value) {
  return `<div class="summary-item"><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
}

async function renderMissionDetails(id) {
  main.innerHTML = `<div class="loading-state"><span class="spinner"></span><span>Loading mission details…</span></div>`;
  try {
    const payload = await api(`/api/missions/${encodeURIComponent(id)}`);
    const mission = payload.data;
    const plant = plantById(mission.plantId);
    const inspectionRows = mission.inspections.map((point) => `
      <tr>
        <td><span class="inspection-cell"><strong>${escapeHtml(point.name)}</strong><small>${escapeHtml(point.id)}</small></span></td>
        <td>${escapeHtml(point.type)}</td>
        <td>${point.result ? badge(point.result) : badge("Awaiting result", "unavailable")}</td>
        <td><span class="reading">${point.reading ? escapeHtml(point.reading) : unavailable()}</span></td>
        <td class="wrap-cell">${point.possibleCauses.length ? escapeHtml(point.possibleCauses.join(" · ")) : (point.result ? "No anomaly detected" : unavailable())}</td>
        <td class="wrap-cell">${point.recommendations.length ? escapeHtml(point.recommendations.join(" · ")) : unavailable()}</td>
      </tr>`).join("");
    const attachments = mission.attachments.length ? mission.attachments.map((item) => {
      const isReport = item.kind === "Mission report";
      const url = `/api/attachments/${encodeURIComponent(item.id)}/download`;
      return `
        <article class="attachment-card">
          <div class="attachment-preview ${isReport ? "report" : ""}">${isReport ? icon("file") : ""}</div>
          <div class="attachment-info">
            <strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong>
            <small>${escapeHtml(item.kind)} · ${escapeHtml(item.size)}${item.inspectionPoint ? ` · ${escapeHtml(item.inspectionPoint)}` : ""}</small>
            <div class="attachment-actions">
              ${isReport ? "" : `<button class="button" data-preview-url="${url}" data-preview-title="${escapeHtml(item.name)}">${icon("image")}View</button>`}
              <a class="button" href="${url}" download>${icon("download")}Download</a>
            </div>
          </div>
        </article>`;
    }).join("") : `<div class="empty-state compact">No artifacts were supplied by Orbit for this mission.</div>`;
    const relatedAlerts = payload.relatedAlerts.length ? payload.relatedAlerts.map((alert) => `
      <button class="related-alert-card" data-alert-id="${escapeHtml(alert.id)}">
        <i class="severity-mark ${slug(alert.severity)}"></i>
        <span><strong>${escapeHtml(alert.title)}</strong><small>${escapeHtml(alert.id)} · ${escapeHtml(alert.status)}</small></span>
        ${icon("chevron")}
      </button>`).join("") : `<div class="empty-state compact">No anomaly tickets are associated with this mission.</div>`;

    main.innerHTML = `
      <div class="page">
        <nav class="breadcrumb" aria-label="Breadcrumb"><button data-route="tickets">Tickets</button>${icon("chevron")}<span>${escapeHtml(mission.id)}</span></nav>
        <section class="detail-hero">
          <div class="detail-hero-copy">
            <span class="eyebrow">${escapeHtml(mission.route)}</span>
            <h2>${escapeHtml(mission.id)}</h2>
            <div class="detail-hero-meta">
              <span>${icon("robot")}${escapeHtml(mission.robotId)}</span>
              <span>${icon("mission")}${escapeHtml(plant ? `${plant.name}, ${plant.state} (${plant.id})` : mission.plantId)}</span>
              <span>${icon("clock")}${escapeHtml(formatDate(mission.startTime, mission.plantId))}</span>
            </div>
          </div>
          <div class="detail-hero-actions">${badge(mission.status, `${slug(mission.status)} detail-status`)}<button class="button" data-action="export-detail" data-mission-id="${escapeHtml(mission.id)}">${icon("download")}Export record</button></div>
        </section>

        <dl class="summary-grid">
          ${summaryItem("Mission result", mission.missionResult ? badge(mission.missionResult) : badge("Unavailable"))}
          ${summaryItem("Duration", mission.endTime ? escapeHtml(formatDuration(mission.startTime, mission.endTime)) : unavailable("In progress"))}
          ${summaryItem("Total inspections", String(mission.inspectionCount))}
          ${summaryItem("Passed inspections", String(mission.passedInspectionCount))}
          ${summaryItem("Failed inspections", `<span class="${mission.failedInspectionCount ? "failed-count" : ""}">${mission.failedInspectionCount}</span>`)}
          ${summaryItem("Anomalies detected", `<span class="${mission.anomalyCount ? "failed-count" : ""}">${mission.anomalyCount}</span>`)}
          ${summaryItem("Mission start", escapeHtml(formatDate(mission.startTime, mission.plantId)))}
          ${summaryItem("Mission end", mission.endTime ? escapeHtml(formatDate(mission.endTime, mission.plantId)) : unavailable("Pending"))}
          ${summaryItem("Orbit run ID", mission.runId ? `<span class="trace-id">${escapeHtml(mission.runId)}</span>` : unavailable())}
          ${summaryItem("Orbit event ID", mission.eventId ? `<span class="trace-id">${escapeHtml(mission.eventId)}</span>` : unavailable())}
          ${summaryItem("Correlation ID", mission.correlationId ? `<span class="trace-id">${escapeHtml(mission.correlationId)}</span>` : unavailable())}
          ${summaryItem("Source", escapeHtml(mission.source))}
        </dl>

        <div class="detail-grid">
          <section class="section-card">
            <div class="card-header"><div><h3>Mission inspection points</h3><p>Only inspection points associated with this mission are shown</p></div><span class="updated-copy"><strong>${mission.completedInspectionCount}</strong> completed</span></div>
            <div class="table-wrap"><table aria-label="Mission inspection points"><thead><tr><th>Inspection point</th><th>Type</th><th>Result</th><th>Reading</th><th>Possible causes</th><th>Recommendations</th></tr></thead><tbody>${inspectionRows}</tbody></table></div>
          </section>
          <aside class="section-card">
            <div class="card-header"><div><h3>Related alerts</h3><p>ARCH anomaly tickets for this mission</p></div>${payload.relatedAlerts.length ? badge(String(payload.relatedAlerts.length), "open") : ""}</div>
            <div class="card-body related-alerts">${relatedAlerts}</div>
          </aside>
        </div>

        <section class="section-card attachment-section">
          <div class="card-header"><div><h3>Attachments</h3><p>Orbit captures and mission artifacts, subject to ARCH permissions</p></div>${mission.attachments.length ? badge(`${mission.attachments.length} files`, "healthy") : ""}</div>
          <div class="card-body attachment-grid">${attachments}</div>
        </section>
      </div>`;
  } catch (error) {
    main.innerHTML = `<div class="error-state"><div><strong>Mission details could not be loaded.</strong><br>${escapeHtml(error.message)}<br><br><button class="button" data-route="tickets">Return to tickets</button></div></div>`;
  }
}

function findAlert(id) {
  return state.allAlerts.find((alert) => alert.id === id);
}

async function openAlert(id) {
  let alert = findAlert(id);
  if (!alert) {
    const response = await api("/api/alerts");
    state.allAlerts = response.data;
    alert = response.data.find((item) => item.id === id);
  }
  if (!alert) return showToast("This alert is no longer available.", "error");
  const mission = state.allMissions.find((item) => item.id === alert.missionId);
  document.querySelector("#alert-dialog-content").innerHTML = `
    <div class="drawer-header">
      <div><span class="eyebrow">${escapeHtml(alert.id)} · ${escapeHtml(alert.severity)} severity</span><h2>${escapeHtml(alert.title)}</h2></div>
      <button class="icon-button" data-action="close-alert" aria-label="Close ticket">${icon("close")}</button>
    </div>
    <div class="drawer-body">
      <div class="inline-actions">${badge(alert.status)}${badge(alert.severity)}</div>
      <section class="drawer-section"><h3>Anomaly details</h3><p class="drawer-description">${escapeHtml(alert.description)}</p></section>
      <section class="drawer-section">
        <h3>Traceability</h3>
        <div class="drawer-properties">
          <div class="drawer-property"><small>Mission ID</small><strong>${escapeHtml(alert.missionId)}</strong></div>
          <div class="drawer-property"><small>Inspection point</small><strong>${escapeHtml(alert.inspectionId)}</strong></div>
          <div class="drawer-property"><small>Plant</small><strong>${escapeHtml(mission?.plantId || "Unavailable")}</strong></div>
          <div class="drawer-property"><small>Robot</small><strong>${escapeHtml(mission?.robotId || "Unavailable")}</strong></div>
          <div class="drawer-property"><small>Created</small><strong>${escapeHtml(formatDate(alert.createdAt, mission?.plantId))}</strong></div>
          <div class="drawer-property"><small>Deduplication key</small><strong title="${escapeHtml(alert.ticketKey)}">${escapeHtml(alert.ticketKey)}</strong></div>
        </div>
      </section>
      <section class="drawer-section"><h3>Assigned team</h3><p class="drawer-description">${escapeHtml(alert.owner)}</p></section>
      <section class="drawer-section">
        <h3>Ticket status</h3>
        <div class="field"><label for="drawer-status">Update workflow state</label><select id="drawer-status">${["Open", "In Review", "Resolved"].map((value) => `<option value="${value}" ${alert.status === value ? "selected" : ""}>${value}</option>`).join("")}</select></div>
      </section>
    </div>
    <div class="drawer-footer"><button class="button" data-mission-id="${escapeHtml(alert.missionId)}">${icon("external")}Open mission</button><button class="button primary" data-action="save-alert" data-alert-id="${escapeHtml(alert.id)}">Save status</button></div>`;
  alertDialog.showModal();
}

function csvCell(value) {
  const text = String(value ?? "Unavailable");
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadCsv(filename, rows) {
  const blob = new Blob([rows.map((row) => row.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function exportMissions(missions = state.missions, filename = "arch-spot-missions.csv") {
  const rows = [["Mission ID", "Robot ID", "Plant", "Mission Start Time", "Mission End Time", "Mission Duration", "Mission Status", "Mission Result", "Number of Inspections", "Failed Inspections", "Anomalies", "Orbit Event ID", "Correlation ID"]];
  missions.forEach((mission) => rows.push([
    mission.id,
    mission.robotId,
    mission.plantId,
    formatDate(mission.startTime, mission.plantId),
    mission.endTime ? formatDate(mission.endTime, mission.plantId) : null,
    formatDuration(mission.startTime, mission.endTime),
    mission.status,
    mission.missionResult,
    mission.inspectionCount,
    mission.failedInspectionCount,
    mission.anomalyCount,
    mission.eventId,
    mission.correlationId,
  ]));
  downloadCsv(filename, rows);
  showToast(`Exported ${missions.length} mission record${missions.length === 1 ? "" : "s"}.`);
}

async function renderRoute() {
  const route = currentRoute();
  if (route === "missions") return navigate("tickets");
  setPageChrome(route);
  if (route === "overview") return renderOverview();
  if (route === "tickets") {
    if (state.filters.robot) {
      state.filters.robot = "";
      await loadMissions();
    }
    return renderTickets();
  }
  if (route.startsWith("mission/")) return renderMissionDetails(decodeURIComponent(route.slice("mission/".length)));
  navigate("overview");
}

document.addEventListener("click", async (event) => {
  const routeButton = event.target.closest("[data-route]");
  if (routeButton) {
    event.preventDefault();
    navigate(routeButton.dataset.route);
    return;
  }

  const missionButton = event.target.closest("[data-mission-id]:not([data-action='export-detail'])");
  if (missionButton) {
    event.preventDefault();
    if (alertDialog.open) alertDialog.close();
    navigate(`mission/${encodeURIComponent(missionButton.dataset.missionId)}`);
    return;
  }

  const alertButton = event.target.closest("[data-alert-id]:not([data-action='save-alert'])");
  if (alertButton) {
    event.preventDefault();
    await openAlert(alertButton.dataset.alertId);
    return;
  }

  const sort = event.target.closest("[data-sort]");
  if (sort) {
    const field = sort.dataset.sort;
    state.sort.direction = state.sort.field === field && state.sort.direction === "asc" ? "desc" : "asc";
    state.sort.field = field;
    const route = currentRoute();
    if (route === "overview") renderOverview();
    else if (route === "tickets") renderTickets();
    return;
  }

  const preview = event.target.closest("[data-preview-url]");
  if (preview) {
    document.querySelector("#preview-title").textContent = preview.dataset.previewTitle;
    document.querySelector("#preview-frame").src = preview.dataset.previewUrl;
    previewDialog.showModal();
    return;
  }

  const actionButton = event.target.closest("[data-action]");
  if (!actionButton) return;
  const action = actionButton.dataset.action;
  try {
    actionButton.disabled = true;
    if (action === "reset-filters") {
      const range = defaultDateRange(state.allMissions);
      state.filters = { plant: "", robot: "", status: "", search: "", ...range };
      await loadMissions();
      await renderRoute();
      showToast("Mission filters reset to the default 7-day range.");
    } else if (action === "refresh") {
      await refreshAll();
      await renderRoute();
    } else if (action === "export-missions") {
      exportMissions();
    } else if (action === "export-detail") {
      const response = await api(`/api/missions/${encodeURIComponent(actionButton.dataset.missionId)}`);
      exportMissions([response.data], `${response.data.id}.csv`);
    } else if (action === "close-alert") {
      alertDialog.close();
    } else if (action === "save-alert") {
      const status = document.querySelector("#drawer-status").value;
      await api(`/api/alerts/${encodeURIComponent(actionButton.dataset.alertId)}`, { method: "PATCH", body: JSON.stringify({ status }) });
      alertDialog.close();
      await refreshAll({ toast: false });
      await renderRoute();
      showToast(`Ticket ${actionButton.dataset.alertId} moved to ${status}.`);
    }
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    if (actionButton.isConnected) actionButton.disabled = false;
  }
});

document.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    if (event.target.id === "mission-filter-form") {
      const form = new FormData(event.target);
      state.filters = Object.fromEntries(["plant", "robot", "status", "search", "from", "to"].map((key) => [key, String(form.get(key) || "")]));
      if (state.filters.from && state.filters.to && state.filters.from > state.filters.to) throw new Error("The start date must be on or before the end date.");
      await loadMissions();
      await renderRoute();
      showToast(`${state.missions.length} mission${state.missions.length === 1 ? "" : "s"} match the selected scope.`);
    }
  } catch (error) {
    showToast(error.message, "error");
  }
});

document.querySelector("#menu-button").addEventListener("click", openMobileNav);
mobileScrim.addEventListener("click", closeMobileNav);
document.querySelector("#preview-close").addEventListener("click", () => previewDialog.close());
previewDialog.addEventListener("close", () => { document.querySelector("#preview-frame").src = "about:blank"; });
previewDialog.addEventListener("click", (event) => { if (event.target === previewDialog) previewDialog.close(); });
alertDialog.addEventListener("click", (event) => { if (event.target === alertDialog) alertDialog.close(); });
window.addEventListener("hashchange", renderRoute);

loadBootstrap()
  .then(renderRoute)
  .catch((error) => {
    main.innerHTML = `<div class="error-state"><div><strong>The SPOT application could not start.</strong><br>${escapeHtml(error.message)}<br><br><span>Confirm the local service is running and reload the page.</span></div></div>`;
  });
