const DEFAULT_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;
const DEFAULT_SINK_TIMEOUT_MS = 5000;
const SUPPORTED_EVENT_TYPES = ["ACTION_COMPLETED", "ACTION_COMPLETED_WITH_ALERT"];

function parseBoolean(value) {
  return /^(1|true|yes)$/i.test(String(value || ""));
}

function parsePositiveInteger(value, fallback, name, errors) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    errors.push(`${name} must be a positive integer`);
    return fallback;
  }
  return parsed;
}

function parseRobotPlantMap(value, allowedPlantIds, errors) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      errors.push("ORBIT_ROBOT_PLANT_MAP must be a JSON object");
      return {};
    }

    const normalized = {};
    for (const [robot, plant] of Object.entries(parsed)) {
      const plantId = String(plant || "").toUpperCase();
      if (!robot.trim() || !allowedPlantIds.has(plantId)) {
        errors.push(`ORBIT_ROBOT_PLANT_MAP contains an invalid mapping for ${robot || "<empty>"}`);
        continue;
      }
      normalized[robot.trim().toLowerCase()] = plantId;
    }
    return normalized;
  } catch {
    errors.push("ORBIT_ROBOT_PLANT_MAP must contain valid JSON");
    return {};
  }
}

function loadOrbitConfig(env = process.env, plantIds = []) {
  const errors = [];
  const allowedPlantIds = new Set(plantIds.map((plantId) => String(plantId).toUpperCase()));
  const secret = String(env.ORBIT_WEBHOOK_SECRET || "").trim();
  const allowUnsigned = parseBoolean(env.ORBIT_ALLOW_UNSIGNED_WEBHOOKS);

  if (secret && !/^[a-f0-9]{64}$/i.test(secret)) {
    errors.push("ORBIT_WEBHOOK_SECRET must be a 64-character hexadecimal value");
  }
  if (!secret && !allowUnsigned) {
    errors.push("ORBIT_WEBHOOK_SECRET is required unless ORBIT_ALLOW_UNSIGNED_WEBHOOKS=true");
  }

  const defaultPlantId = String(env.ORBIT_DEFAULT_PLANT_ID || "").toUpperCase();
  if (defaultPlantId && !allowedPlantIds.has(defaultPlantId)) {
    errors.push("ORBIT_DEFAULT_PLANT_ID must identify an approved plant");
  }

  let sinkUrl = "";
  if (env.ORBIT_EVENT_SINK_URL) {
    try {
      const parsed = new URL(env.ORBIT_EVENT_SINK_URL);
      if (parsed.protocol !== "https:" && !parseBoolean(env.ORBIT_ALLOW_HTTP_SINK)) {
        errors.push("ORBIT_EVENT_SINK_URL must use HTTPS");
      } else {
        sinkUrl = parsed.toString();
      }
    } catch {
      errors.push("ORBIT_EVENT_SINK_URL must be a valid URL");
    }
  }

  return {
    errors,
    secret,
    allowUnsigned,
    signatureToleranceMs: parsePositiveInteger(
      env.ORBIT_SIGNATURE_TOLERANCE_MS,
      DEFAULT_SIGNATURE_TOLERANCE_MS,
      "ORBIT_SIGNATURE_TOLERANCE_MS",
      errors,
    ),
    robotPlantMap: parseRobotPlantMap(env.ORBIT_ROBOT_PLANT_MAP, allowedPlantIds, errors),
    defaultPlantId,
    allowedPlantIds,
    sinkUrl,
    sinkToken: String(env.ORBIT_EVENT_SINK_TOKEN || ""),
    sinkTimeoutMs: parsePositiveInteger(
      env.ORBIT_EVENT_SINK_TIMEOUT_MS,
      DEFAULT_SINK_TIMEOUT_MS,
      "ORBIT_EVENT_SINK_TIMEOUT_MS",
      errors,
    ),
    adminToken: String(env.ORBIT_ADMIN_TOKEN || ""),
    supportedEventTypes: new Set(SUPPORTED_EVENT_TYPES),
  };
}

module.exports = {
  DEFAULT_SIGNATURE_TOLERANCE_MS,
  SUPPORTED_EVENT_TYPES,
  loadOrbitConfig,
};
