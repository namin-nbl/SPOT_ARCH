const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { plants, missions, alerts, integrationLogs } = require("./server-data");
const { loadOrbitConfig } = require("./orbit/config");
const { normalizeOrbitEvent, validateOrbitEnvelope } = require("./orbit/normalize");
const { verifyOrbitSignature } = require("./orbit/signature");
const { deliverToEventSink, orbitEventStore } = require("./orbit/store");

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, "public");
const VALID_TICKET_STATUSES = new Set(["Open", "In Review", "Resolved"]);

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

function projectOrbitMission(incoming) {
  let mission = missions.find((item) => item.runId === incoming.runId || item.id === incoming.id);
  if (!mission) {
    mission = incoming;
    missions.unshift(mission);
  } else {
    const inspection = incoming.inspections[0];
    const existingInspection = mission.inspections.find((item) => item.id === inspection.id);
    if (!existingInspection) {
      mission.inspections.push(inspection);
    } else if (inspection.result === "Fail") {
      Object.assign(existingInspection, inspection);
    }
    mission.orbitEventIds = [...new Set([...(mission.orbitEventIds || []), ...incoming.orbitEventIds])];
    mission.status = incoming.status === "Complete" ? "Complete" : mission.status;
    mission.endTime = incoming.endTime || mission.endTime;
    mission.eventId = mission.eventId || incoming.eventId;
  }
  return { mission, tickets: createTicketsForMission(mission) };
}

function requestHeader(request, name) {
  if (typeof request.headers?.get === "function") return request.headers.get(name);
  const value = request.headers?.[name.toLowerCase()] ?? request.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function orbitConfig() {
  return loadOrbitConfig(process.env, plants.map((plant) => plant.id));
}

function hasAdminAccess(request, config) {
  if (!config.adminToken) return false;
  const supplied = Buffer.from(String(requestHeader(request, "authorization") || ""));
  const expected = Buffer.from(`Bearer ${config.adminToken}`);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function publicEventRecord(entry) {
  return {
    schemaVersion: entry.schemaVersion,
    eventId: entry.eventId,
    eventType: entry.eventType,
    occurredAt: entry.occurredAt,
    receivedAt: entry.receivedAt,
    signature: entry.signature,
    runEvent: entry.runEvent,
    projection: entry.projection,
    archive: entry.archive,
    projectedAt: entry.projectedAt,
  };
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
    const config = orbitConfig();
    return sendJson(response, 200, {
      status: config.errors.length ? "degraded" : "ok",
      services: [
        {
          name: "Orbit webhook",
          status: config.errors.length ? "Configuration required" : "Listening",
          detail: config.secret ? "HMAC verification enabled" : "unsigned development mode",
        },
        {
          name: "Event archive",
          status: config.sinkUrl ? "Durable sink configured" : "Prototype only",
          detail: config.sinkUrl ? "retry-safe HTTP delivery" : "in-memory records are ephemeral",
        },
        { name: "ARCH projection", status: "Ready", detail: "Orbit action event v1" },
      ],
      lastDeliveryAt: integrationLogs.find((log) => log.stage === "ARCH projection")?.time || null,
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

  if (request.method === "GET" && pathname === "/api/webhooks/orbit/status") {
    const config = orbitConfig();
    return sendJson(response, config.errors.length ? 503 : 200, {
      status: config.errors.length ? "configuration_required" : "ready",
      signatureVerification: config.secret ? "required" : "disabled_for_development",
      storage: config.sinkUrl ? "external_http_sink" : "ephemeral_memory",
      supportedEventTypes: [...config.supportedEventTypes],
      metrics: orbitEventStore.summary(),
      configurationErrors: config.errors,
    });
  }

  if (request.method === "GET" && pathname === "/api/webhooks/orbit/events") {
    const config = orbitConfig();
    if (!config.adminToken) {
      return sendJson(response, 503, { error: "ORBIT_ADMIN_TOKEN is not configured" });
    }
    if (!hasAdminAccess(request, config)) return sendJson(response, 401, { error: "Unauthorized" });
    const requestedLimit = Number(url.searchParams.get("limit") || 25);
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : 25;
    return sendJson(response, 200, { data: orbitEventStore.list(limit).map(publicEventRecord) });
  }

  if (request.method === "POST" && pathname === "/api/webhooks/orbit") {
    const config = orbitConfig();
    if (config.errors.length) {
      return sendJson(response, 503, {
        error: "Orbit webhook is not configured",
        code: "invalid_webhook_configuration",
        details: config.errors,
      });
    }

    if (!String(requestHeader(request, "content-type") || "").toLowerCase().includes("application/json")) {
      return sendJson(response, 415, { error: "Content-Type must be application/json", code: "unsupported_media_type" });
    }

    const payload = await readJson(request);
    let signature = { verified: false, sentAt: null };
    if (config.secret) {
      signature = verifyOrbitSignature({
        payload,
        signatureHeader: requestHeader(request, "orbit-signature"),
        secret: config.secret,
        toleranceMs: config.signatureToleranceMs,
      });
    }
    validateOrbitEnvelope(payload, config.supportedEventTypes);

    const normalized = normalizeOrbitEvent(payload, config, {
      receivedAt: new Date().toISOString(),
      signatureVerified: signature.verified,
      signatureSentAt: signature.sentAt,
    });
    const reservation = orbitEventStore.reserve(normalized.record);
    const entry = reservation.entry;
    const correlationId = `orbit-${payload.uuid}`;

    if (config.sinkUrl && entry.archive.status !== "delivered") {
      try {
        const delivery = await deliverToEventSink(entry, config);
        orbitEventStore.markArchive(payload.uuid, {
          status: "delivered",
          attempts: entry.archive.attempts + 1,
          deliveredAt: new Date().toISOString(),
          statusCode: delivery.statusCode,
          lastError: null,
        });
      } catch (error) {
        orbitEventStore.markArchive(payload.uuid, {
          status: "failed",
          attempts: entry.archive.attempts + 1,
          lastError: error.message,
        });
        addLog({ eventId: payload.uuid, correlationId, stage: "Orbit archive", outcome: "Retry requested", detail: error.message });
        return sendJson(response, 503, {
          error: "Orbit event could not be archived; retry is safe",
          code: "event_sink_unavailable",
          eventId: payload.uuid,
          correlationId,
        });
      }
    }

    let projection = null;
    if (normalized.mission && !entry.projectedAt) {
      projection = projectOrbitMission(normalized.mission);
      orbitEventStore.markProjected(payload.uuid);
      addLog({
        eventId: payload.uuid,
        correlationId,
        stage: "ARCH projection",
        outcome: "Projected",
        detail: `${normalized.record.runEvent.actionName}${projection.tickets.length ? `; ${projection.tickets.length} ticket created` : ""}`,
      });
    } else if (!normalized.mission) {
      addLog({
        eventId: payload.uuid,
        correlationId,
        stage: "ARCH projection",
        outcome: "Pending mapping",
        detail: normalized.record.projection.missingFields.join(", "),
      });
    }

    if (reservation.duplicate) {
      addLog({ eventId: payload.uuid, correlationId, stage: "Orbit webhook", outcome: "Duplicate acknowledged", detail: "No duplicate action or ticket created" });
      return sendJson(response, 200, {
        accepted: true,
        duplicate: true,
        eventId: payload.uuid,
        correlationId,
        projection: entry.projection.status,
      });
    }

    addLog({ eventId: payload.uuid, correlationId, stage: "Orbit webhook", outcome: "Captured", detail: payload.type });
    return sendJson(response, 202, {
      accepted: true,
      duplicate: false,
      eventId: payload.uuid,
      correlationId,
      archive: config.sinkUrl ? "delivered" : "ephemeral",
      projection: normalized.record.projection.status,
      missionId: projection?.mission.id || normalized.mission?.id || null,
      tickets: projection?.tickets || [],
    });
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
    if (!response.writableEnded) {
      sendJson(response, error.statusCode || 500, {
        error: error.message || "Unexpected server error",
        ...(error.code ? { code: error.code } : {}),
        ...(error.details ? { details: error.details } : {}),
      });
    }
  }
});

if (require.main === module) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`ARCH SPOT Mission Monitor running at http://127.0.0.1:${PORT}`);
  });
}

module.exports = { server, handleApi, sendJson, missionResult, missionView, projectOrbitMission };
