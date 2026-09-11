const crypto = require("node:crypto");

class OrbitWebhookError extends Error {
  constructor(message, { code = "orbit_webhook_error", statusCode = 400, details } = {}) {
    super(message);
    this.name = "OrbitWebhookError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function signatureParts(header) {
  if (!header || typeof header !== "string") {
    throw new OrbitWebhookError("Orbit-Signature header is required", {
      code: "missing_signature",
      statusCode: 401,
    });
  }

  const parts = {};
  for (const entry of header.split(",")) {
    const separator = entry.indexOf("=");
    if (separator > 0) parts[entry.slice(0, separator).trim()] = entry.slice(separator + 1).trim();
  }

  if (!/^\d+$/.test(parts.t || "") || !/^[a-f0-9]{64}$/i.test(parts.v1 || "")) {
    throw new OrbitWebhookError("Orbit-Signature header is malformed", {
      code: "malformed_signature",
      statusCode: 401,
    });
  }
  return { timestamp: parts.t, signature: parts.v1.toLowerCase() };
}

function canonicalPayload(payload) {
  // Match Python json.dumps(..., separators=(",", ":")), which is used by
  // Boston Dynamics' validate_webhook_payload helper, including ensure_ascii.
  return JSON.stringify(payload).replace(/[\u007f-\uffff]/g, (character) => (
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  ));
}

function createOrbitSignature(payload, timestamp, secret) {
  if (!/^[a-f0-9]{64}$/i.test(String(secret || ""))) {
    throw new OrbitWebhookError("Orbit webhook secret must be a 64-character hexadecimal value", {
      code: "invalid_webhook_configuration",
      statusCode: 503,
    });
  }
  return crypto
    .createHmac("sha256", Buffer.from(secret, "hex"))
    .update(`${timestamp}.${canonicalPayload(payload)}`, "utf8")
    .digest("hex");
}

function verifyOrbitSignature({ payload, signatureHeader, secret, toleranceMs, now = Date.now() }) {
  const { timestamp, signature } = signatureParts(signatureHeader);
  const sentAt = Number(timestamp);
  const ageMs = now - sentAt;
  if (Math.abs(ageMs) > toleranceMs) {
    throw new OrbitWebhookError("Orbit webhook timestamp is outside the accepted window", {
      code: "stale_signature",
      statusCode: 401,
      details: { toleranceMs },
    });
  }

  const expected = createOrbitSignature(payload, timestamp, secret);
  const receivedBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (receivedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)) {
    throw new OrbitWebhookError("Orbit webhook signature did not match", {
      code: "invalid_signature",
      statusCode: 401,
    });
  }
  return { verified: true, sentAt: new Date(sentAt).toISOString(), ageMs };
}

module.exports = {
  OrbitWebhookError,
  canonicalPayload,
  createOrbitSignature,
  signatureParts,
  verifyOrbitSignature,
};
