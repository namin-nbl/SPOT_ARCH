const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { plants, missions, alerts, integrationLogs } = require("./server-data");

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, "public");
const VALID_MISSION_STATUSES = new Set(["Not Started", "In Progress", "Complete"]);
const VALID_TICKET_STATUSES = new Set(["Open", "In Review", "Resolved"]);
const processedEventIds = new Set(missions.map((mission) => mission.eventId));

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
};

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function readJson(request) {
  try {
    if (request.body !== undefined) {
      if (Buffer.isBuffer(request.body)) {
        return Promise.resolve(JSON.parse(request.body.toString("utf8").replace(/^\uFEFF/, "")));
      }
      if (typeof request.body === "string") {
        return Promise.resolve(JSON.parse(request.body.replace(/^\uFEFF/, "")));
      }
      return Promise.resolve(request.body || {});
    }
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.statusCode = 400;
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        const error = new Error("Payload exceeds 1 MB");
        error.statusCode = 413;
        reject(error);
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body.replace(/^\uFEFF/, "")) : {});
      } catch {
        const error = new Error("Request body must be valid JSON");
        error.statusCode = 400;
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function missionResult(mission) {
  if (mission.status !== "Complete") return null;
  return mission.inspections.some((item) => item.result === "Fail") ? "Fail" : "Pass";
}

function missionView(mission) {
  const completed = mission.inspections.filter((item) => item.result === "Pass" || item.result === "Fail");
  return {
    ...mission,
    missionResult: missionResult(mission),
    inspectionCount: mission.inspections.length,
    completedInspectionCount: completed.length,
    passedInspectionCount: completed.filter((item) => item.result === "Pass").length,
    failedInspectionCount: completed.filter((item) => item.result === "Fail").length,
    anomalyCount: alerts.filter((alert) => alert.missionId === mission.id).length,
    alertIds: alerts.filter((alert) => alert.missionId === mission.id).map((alert) => alert.id),
  };
}

function filterMissions(searchParams) {
  const plant = searchParams.get("plant") || "";
  const robot = searchParams.get("robot") || "";
  const status = searchParams.get("status") || "";
  const search = (searchParams.get("search") || "").trim().toLowerCase();
  const from = searchParams.get("from") ? new Date(`${searchParams.get("from")}T00:00:00Z`) : null;
  const to = searchParams.get("to") ? new Date(`${searchParams.get("to")}T23:59:59.999Z`) : null;

  return missions.filter((mission) => {
    const started = new Date(mission.startTime);
    return (!plant || mission.plantId === plant)
      && (!robot || mission.robotId === robot)
      && (!status || mission.status === status)
      && (!search || mission.id.toLowerCase().includes(search))
      && (!from || started >= from)
      && (!to || started <= to);
  });
}

function dayKey(iso) {
  return iso.slice(0, 10);
}

function buildTrend(filtered) {
  const dates = [...new Set(filtered.map((mission) => dayKey(mission.startTime)))].sort();
  return dates.map((date) => {
    const dayMissions = filtered.filter((mission) => dayKey(mission.startTime) === date);
    const dayInspections = dayMissions.flatMap((mission) => mission.inspections).filter((item) => item.result);
    return {
      date,
      missions: {
        total: dayMissions.length,
        passed: dayMissions.filter((mission) => missionResult(mission) === "Pass").length,
        failed: dayMissions.filter((mission) => missionResult(mission) === "Fail").length,
      },
      inspections: {
        total: dayInspections.length,
        passed: dayInspections.filter((item) => item.result === "Pass").length,
        failed: dayInspections.filter((item) => item.result === "Fail").length,
      },
    };
  });
}

function missionListPayload(searchParams) {
  const filtered = filterMissions(searchParams);
  const completedInspections = filtered.flatMap((mission) => mission.inspections).filter((item) => item.result);
  return {
    data: filtered.map(missionView),
    summary: {
      missionsCompleted: filtered.filter((mission) => mission.status === "Complete").length,
      inspectionsCompleted: completedInspections.length,
      failedInspections: completedInspections.filter((item) => item.result === "Fail").length,
      openAlerts: alerts.filter((alert) => alert.status !== "Resolved" && filtered.some((mission) => mission.id === alert.missionId)).length,
    },
    trend: buildTrend(filtered),
    meta: { total: filtered.length, refreshedAt: new Date().toISOString() },
  };
}

function addLog({ eventId, correlationId, stage, outcome, detail }) {
  integrationLogs.unshift({
    id: `LOG-${8800 + integrationLogs.length + 20}`,
    time: new Date().toISOString(),
    eventId,
    correlationId,
    stage,
    outcome,
    detail,
  });
}

function validateWebhook(payload) {
  const errors = [];
  if (!payload.eventId) errors.push("eventId is required");
  if (!payload.eventType) errors.push("eventType is required");
  if (!payload.eventTime || Number.isNaN(Date.parse(payload.eventTime))) errors.push("eventTime must be a valid timestamp");
  if (!payload.data?.missionId) errors.push("data.missionId is required");
  if (!payload.data?.robotId) errors.push("data.robotId is required");
  if (!plants.some((plant) => plant.id === payload.data?.plantId)) errors.push("data.plantId must identify an approved plant");
  if (!VALID_MISSION_STATUSES.has(payload.data?.status)) errors.push("data.status is invalid");
  if (!Array.isArray(payload.data?.inspections)) errors.push("data.inspections must be an array");
  return errors;
}

function normalizeWebhook(payload) {
  const data = payload.data;
  return {
    id: data.missionId,
    eventId: payload.eventId,
    runId: data.runId || null,
    actionId: data.actionId || null,
    robotId: data.robotId,
    plantId: data.plantId,
    startTime: data.startTime || payload.eventTime,
    endTime: data.endTime || null,
    status: data.status,
    route: data.route || "Unspecified route",
    inspections: data.inspections.map((item, index) => ({
      id: item.id || `IP-AUTO-${index + 1}`,
      name: item.name || "Unnamed inspection point",
      type: item.type || "Other",
      result: item.result === "Pass" || item.result === "Fail" ? item.result : null,
      possibleCauses: Array.isArray(item.possibleCauses) ? item.possibleCauses : [],
      recommendations: Array.isArray(item.recommendations) ? item.recommendations : [],
      reading: item.reading ?? null,
    })),
    attachments: [],
    source: "Orbit via Litmus",
    correlationId: data.correlationId || `corr-${Date.now().toString(36)}-arch`,
  };
}

function createTicketsForMission(mission) {
  const created = [];
  for (const point of mission.inspections.filter((item) => item.result === "Fail")) {
    const ticketKey = `${mission.id}:${point.id}:${point.type.toLowerCase()}`;
    if (alerts.some((alert) => alert.ticketKey === ticketKey)) continue;
    const alert = {
      id: `ALT-${2050 + alerts.length}`,
      ticketKey,
      missionId: mission.id,
      inspectionId: point.id,
      title: `${point.type} anomaly at ${point.name}`,
      description: point.possibleCauses[0] || "Inspection failed the approved anomaly rule.",
      severity: point.type === "Thermal" ? "High" : "Medium",
      status: "Open",
      owner: `Reliability – ${mission.plantId}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    alerts.unshift(alert);
    created.push(alert.id);
  }
  return created;
}

function svgAttachment(attachmentId, missionId) {
  const safeAttachment = attachmentId.replace(/[^a-zA-Z0-9-]/g, "");
  const safeMission = missionId.replace(/[^a-zA-Z0-9-]/g, "");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760" viewBox="0 0 1200 760">
  <defs>
    <radialGradient id="heat" cx="48%" cy="48%" r="58%"><stop offset="0" stop-color="#fff36b"/><stop offset=".22" stop-color="#ff9d39"/><stop offset=".46" stop-color="#f0445d"/><stop offset=".72" stop-color="#7535a8"/><stop offset="1" stop-color="#14223f"/></radialGradient>
    <linearGradient id="bg" x1="0" x2="1"><stop stop-color="#101d35"/><stop offset="1" stop-color="#1e3157"/></linearGradient>
  </defs>
  <rect width="1200" height="760" fill="url(#bg)"/>
  <rect x="74" y="72" width="1052" height="570" rx="28" fill="#0a1326" stroke="#5f718d"/>
  <ellipse cx="585" cy="350" rx="310" ry="220" fill="url(#heat)"/>
  <circle cx="585" cy="350" r="74" fill="none" stroke="#fff" stroke-width="5" opacity=".9"/>
  <path d="M585 246v208M481 350h208" stroke="#fff" stroke-width="3" opacity=".7"/>
  <text x="88" y="698" fill="#d8e6f8" font-family="Arial" font-size="24">${safeMission} · ${safeAttachment} · Orbit capture preview</text>
</svg>`;
}

async function handleApi(request, response, url) {
  const pathname = url.pathname;

  if (request.method === "GET" && pathname === "/api/health") {
    return sendJson(response, 200, {
      status: "ok",
      services: [
        { name: "Orbit webhook", status: "Listening", detail: "action completion events" },
        { name: "Litmus mapping", status: "Healthy", detail: "SPOT payload v1.0" },
        { name: "ARCH delivery", status: "Healthy", detail: "99.8% successful · 24h" },
      ],
      lastDeliveryAt: integrationLogs.find((log) => log.stage === "ARCH delivery")?.time || null,
    });
  }

  if (request.method === "GET" && pathname === "/api/plants") {
    return sendJson(response, 200, { data: plants });
  }

  if (request.method === "GET" && pathname === "/api/missions") {
    return sendJson(response, 200, missionListPayload(url.searchParams));
  }

  const missionMatch = pathname.match(/^\/api\/missions\/([^/]+)$/);
  if (request.method === "GET" && missionMatch) {
    const mission = missions.find((item) => item.id === decodeURIComponent(missionMatch[1]));
    if (!mission) return sendJson(response, 404, { error: "Mission not found" });
    return sendJson(response, 200, {
      data: missionView(mission),
      relatedAlerts: alerts.filter((alert) => alert.missionId === mission.id),
    });
  }

  if (request.method === "GET" && pathname === "/api/alerts") {
    const status = url.searchParams.get("status") || "";
    const plant = url.searchParams.get("plant") || "";
    const filtered = alerts.filter((alert) => {
      const mission = missions.find((item) => item.id === alert.missionId);
      return (!status || alert.status === status) && (!plant || mission?.plantId === plant);
    });
    return sendJson(response, 200, { data: filtered, meta: { total: filtered.length } });
  }

  const alertMatch = pathname.match(/^\/api\/alerts\/([^/]+)$/);
  if (request.method === "PATCH" && alertMatch) {
    const alert = alerts.find((item) => item.id === decodeURIComponent(alertMatch[1]));
    if (!alert) return sendJson(response, 404, { error: "Alert not found" });
    const payload = await readJson(request);
    if (!VALID_TICKET_STATUSES.has(payload.status)) return sendJson(response, 400, { error: "Invalid ticket status" });
    alert.status = payload.status;
    alert.updatedAt = new Date().toISOString();
    return sendJson(response, 200, { data: alert });
  }

  if (request.method === "GET" && pathname === "/api/integration/logs") {
    return sendJson(response, 200, { data: integrationLogs.slice(0, 25) });
  }

  if (request.method === "POST" && pathname === "/api/webhooks/orbit") {
    const payload = await readJson(request);
    const errors = validateWebhook(payload);
    if (errors.length) {
      const correlationId = payload.data?.correlationId || `corr-rejected-${Date.now().toString(36)}`;
      addLog({ eventId: payload.eventId || "unavailable", correlationId, stage: "Orbit webhook", outcome: "Rejected", detail: errors.join("; ") });
      return sendJson(response, 400, { error: "Webhook validation failed", details: errors, correlationId });
    }

    if (processedEventIds.has(payload.eventId)) {
      const existing = missions.find((mission) => mission.eventId === payload.eventId);
      const correlationId = existing?.correlationId || payload.data.correlationId || "unavailable";
      addLog({ eventId: payload.eventId, correlationId, stage: "Orbit webhook", outcome: "Duplicate ignored", detail: "No duplicate mission or ticket created" });
      return sendJson(response, 200, { duplicate: true, missionId: existing?.id || payload.data.missionId, correlationId });
    }

    if (missions.some((mission) => mission.id === payload.data.missionId)) {
      return sendJson(response, 409, { error: "Mission ID already exists with a different event ID" });
    }

    const normalized = normalizeWebhook(payload);
    missions.unshift(normalized);
    processedEventIds.add(payload.eventId);
    const tickets = createTicketsForMission(normalized);
    addLog({ eventId: payload.eventId, correlationId: normalized.correlationId, stage: "ARCH delivery", outcome: "Delivered", detail: `Mission accepted${tickets.length ? `; ${tickets.length} ticket created` : ""}` });
    addLog({ eventId: payload.eventId, correlationId: normalized.correlationId, stage: "Litmus mapping", outcome: "Mapped", detail: `${normalized.inspections.length} inspections normalized` });
    addLog({ eventId: payload.eventId, correlationId: normalized.correlationId, stage: "Orbit webhook", outcome: "Validated", detail: payload.eventType });
    return sendJson(response, 201, { duplicate: false, mission: missionView(normalized), tickets, correlationId: normalized.correlationId });
  }

  const attachmentMatch = pathname.match(/^\/api\/attachments\/([^/]+)\/download$/);
  if (request.method === "GET" && attachmentMatch) {
    const attachmentId = decodeURIComponent(attachmentMatch[1]);
    const mission = missions.find((item) => item.attachments.some((attachment) => attachment.id === attachmentId));
    const item = mission?.attachments.find((attachment) => attachment.id === attachmentId);
    if (!mission || !item) return sendJson(response, 404, { error: "Attachment not found" });

    if (item.kind === "Mission report") {
      const report = `ARCH SPOT MISSION REPORT\n\nMission: ${mission.id}\nRobot: ${mission.robotId}\nPlant: ${mission.plantId}\nRoute: ${mission.route}\nStatus: ${mission.status}\nResult: ${missionResult(mission)}\nInspections: ${mission.inspections.length}\nFailed inspections: ${mission.inspections.filter((point) => point.result === "Fail").length}\nCorrelation ID: ${mission.correlationId}\n`;
      response.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${item.name.replace(/[^a-zA-Z0-9._-]/g, "-")}"`,
      });
      return response.end(report);
    }

    const preview = svgAttachment(item.id, mission.id);
    response.writeHead(200, {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Content-Disposition": `inline; filename="${item.name.replace(/[^a-zA-Z0-9._-]/g, "-")}"`,
    });
    return response.end(preview);
  }

  return false;
}

function serveStatic(response, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return sendJson(response, 400, { error: "Invalid URL encoding" });
  }
  const requested = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, requested);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== path.join(PUBLIC_DIR, "index.html")) {
    return sendJson(response, 403, { error: "Forbidden" });
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      if (error.code === "ENOENT") return sendJson(response, 404, { error: "Not found" });
      return sendJson(response, 500, { error: "Unable to read requested file" });
    }
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(data);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || `localhost:${PORT}`}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(request, response, url);
      if (handled === false && !response.writableEnded) sendJson(response, 404, { error: "API route not found" });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") return sendJson(response, 405, { error: "Method not allowed" });
    serveStatic(response, url.pathname);
  } catch (error) {
    if (!response.writableEnded) sendJson(response, error.statusCode || 500, { error: error.message || "Unexpected server error" });
  }
});

if (require.main === module) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`ARCH SPOT Mission Monitor running at http://127.0.0.1:${PORT}`);
  });
}

module.exports = { server, handleApi, sendJson, missionResult, missionView, validateWebhook };
