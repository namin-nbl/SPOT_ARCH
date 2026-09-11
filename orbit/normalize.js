const { OrbitWebhookError } = require("./signature");

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "");
}

function objectAt(value) {
  return value && !Array.isArray(value) && typeof value === "object" ? value : {};
}

function validateOrbitEnvelope(payload, supportedEventTypes) {
  const errors = [];
  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    throw new OrbitWebhookError("Webhook body must be a JSON object", {
      code: "invalid_payload",
      details: ["body must be a JSON object"],
    });
  }
  if (!payload.uuid || typeof payload.uuid !== "string") errors.push("uuid is required");
  if (!payload.type || typeof payload.type !== "string") {
    errors.push("type is required");
  } else if (!supportedEventTypes.has(payload.type)) {
    errors.push(`type must be one of: ${[...supportedEventTypes].join(", ")}`);
  }
  if (!payload.time || Number.isNaN(Date.parse(payload.time))) errors.push("time must be a valid ISO timestamp");
  if (!payload.data || Array.isArray(payload.data) || typeof payload.data !== "object") {
    errors.push("data must contain the Orbit run_event object");
  } else if (!payload.data.uuid || typeof payload.data.uuid !== "string") {
    errors.push("data.uuid is required for the Orbit run_event");
  }
  if (errors.length) {
    throw new OrbitWebhookError("Orbit webhook validation failed", {
      code: "invalid_payload",
      details: errors,
    });
  }
}

function runEventRobot(runEvent) {
  const robot = objectAt(runEvent.robot);
  return firstValue(
    runEvent.robotNickname,
    runEvent.robotName,
    runEvent.robotHostname,
    runEvent.robotId,
    robot.nickname,
    robot.name,
    robot.hostname,
    robot.id,
  );
}

function runEventPlant(runEvent, robotId, config) {
  const metadata = objectAt(runEvent.metadata);
  const customMetadata = objectAt(runEvent.customMetadata);
  const candidate = firstValue(runEvent.plantId, metadata.plantId, customMetadata.plantId);
  if (candidate && config.allowedPlantIds.has(String(candidate).toUpperCase())) {
    return String(candidate).toUpperCase();
  }
  return config.robotPlantMap[String(robotId || "").toLowerCase()] || config.defaultPlantId || "";
}

function captureList(runEvent) {
  const captures = firstValue(runEvent.dataCaptures, runEvent.runCaptures, runEvent.captures);
  return Array.isArray(captures) ? captures : [];
}

function deriveInspectionType(actionName, captures) {
  const channels = captures.map((capture) => capture.channelName || capture.name || "").join(" ");
  const value = `${actionName || ""} ${channels}`.toLowerCase();
  if (value.includes("thermal") || value.includes("temperature")) return "Thermal";
  if (value.includes("acoustic") || value.includes("sound") || value.includes("audio")) return "Acoustic";
  if (value.includes("leak") || value.includes("ultrasonic")) return "Leak detection";
  if (value.includes("visual") || value.includes("image")) return "Visual";
  return "Other";
}

function keyResultSummary(captures) {
  const results = [];
  for (const capture of captures) {
    const keyResults = Array.isArray(capture.keyResults) ? capture.keyResults : [];
    for (const result of keyResults) {
      if (!result || typeof result !== "object") continue;
      const name = firstValue(result.name, result.key, capture.channelName, "Result");
      const value = firstValue(result.value, result.text, result.status);
      if (value === undefined) continue;
      results.push(`${name}: ${value}${result.units ? ` ${result.units}` : ""}`);
    }
  }
  return results.join("; ") || null;
}

function mapMissionStatus(runEvent) {
  const raw = String(firstValue(runEvent.missionStatus, runEvent.runStatus, runEvent.status, "") || "").toUpperCase();
  if (["SUCCESS", "FAILURE", "ERROR", "STOPPED", "COMPLETE", "COMPLETED"].includes(raw)) return "Complete";
  if (["PENDING", "QUEUED", "NOT_STARTED"].includes(raw)) return "Not Started";
  return "In Progress";
}

function normalizeOrbitEvent(payload, config, context = {}) {
  const runEvent = payload.data;
  const captures = captureList(runEvent);
  const robotId = runEventRobot(runEvent);
  const plantId = runEventPlant(runEvent, robotId, config);
  const runId = firstValue(runEvent.runUuid, runEvent.runUUID, runEvent.runId);
  const actionName = firstValue(runEvent.actionName, runEvent.name, "Unnamed Orbit action");
  const missionName = firstValue(runEvent.missionName, runEvent.siteWalkName, "Orbit mission");
  const occurredAt = new Date(payload.time).toISOString();
  const isAlert = payload.type === "ACTION_COMPLETED_WITH_ALERT";
  const missingProjectionFields = [];
  if (!runId) missingProjectionFields.push("data.runUuid");
  if (!robotId) missingProjectionFields.push("robot identity");
  if (!plantId) missingProjectionFields.push("plant mapping");

  const record = {
    schemaVersion: "orbit-action-event.v1",
    eventId: payload.uuid,
    eventType: payload.type,
    occurredAt,
    receivedAt: context.receivedAt || new Date().toISOString(),
    signature: {
      verified: Boolean(context.signatureVerified),
      sentAt: context.signatureSentAt || null,
    },
    runEvent: {
      uuid: runEvent.uuid,
      runUuid: runId || null,
      actionName,
      missionName,
      robotId: robotId || null,
      plantId: plantId || null,
      captureCount: captures.length,
      hasAlert: isAlert,
    },
    payload,
    projection: {
      status: missingProjectionFields.length ? "pending_mapping" : "ready",
      missingFields: missingProjectionFields,
    },
  };

  const mission = missingProjectionFields.length ? null : {
    id: runId,
    eventId: payload.uuid,
    runId,
    actionId: runEvent.uuid,
    robotId,
    plantId,
    startTime: firstValue(runEvent.runStartTime, runEvent.startTime, runEvent.time, payload.time),
    endTime: firstValue(runEvent.runEndTime, runEvent.endTime, null),
    status: mapMissionStatus(runEvent),
    route: missionName,
    inspections: [{
      id: runEvent.uuid,
      name: actionName,
      type: deriveInspectionType(actionName, captures),
      result: isAlert ? "Fail" : "Pass",
      possibleCauses: [],
      recommendations: [],
      reading: keyResultSummary(captures),
    }],
    attachments: [],
    source: "Boston Dynamics Orbit webhook",
    correlationId: `orbit-${payload.uuid}`,
    orbitEventIds: [payload.uuid],
  };

  return { record, mission };
}

module.exports = {
  captureList,
  normalizeOrbitEvent,
  validateOrbitEnvelope,
};
