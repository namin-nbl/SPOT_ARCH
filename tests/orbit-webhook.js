const assert = require("node:assert/strict");
const { loadOrbitConfig } = require("../orbit/config");
const { normalizeOrbitEvent, validateOrbitEnvelope } = require("../orbit/normalize");
const { createOrbitSignature, verifyOrbitSignature } = require("../orbit/signature");
const { deliverToEventSink, MemoryOrbitEventStore } = require("../orbit/store");

const secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const now = Date.now();
const payload = {
  uuid: "event-001",
  type: "ACTION_COMPLETED_WITH_ALERT",
  time: new Date(now).toISOString(),
  data: {
    uuid: "run-event-001",
    runUuid: "run-001",
    actionName: "Compressor thermal inspection",
    missionName: "Utilities route",
    robotHostname: "spot-blm-01",
    dataCaptures: [{ channelName: "thermal", keyResults: [{ name: "Temperature", value: 88.4, units: "C" }] }],
  },
};

const config = loadOrbitConfig({
  ORBIT_WEBHOOK_SECRET: secret,
  ORBIT_ROBOT_PLANT_MAP: JSON.stringify({ "spot-blm-01": "BLM" }),
}, ["BLM", "JAX"]);
assert.deepEqual(config.errors, []);
assert.match(loadOrbitConfig({}, ["BLM"]).errors.join("; "), /ORBIT_WEBHOOK_SECRET/);

validateOrbitEnvelope(payload, config.supportedEventTypes);
const timestamp = String(now);
const signature = createOrbitSignature(payload, timestamp, secret);
const verified = verifyOrbitSignature({
  payload,
  signatureHeader: `t=${timestamp},v1=${signature}`,
  secret,
  toleranceMs: 300000,
  now,
});
assert.equal(verified.verified, true);

assert.throws(() => verifyOrbitSignature({
  payload,
  signatureHeader: `t=${timestamp},v1=${"0".repeat(64)}`,
  secret,
  toleranceMs: 300000,
  now,
}), (error) => error.code === "invalid_signature");

assert.throws(() => verifyOrbitSignature({
  payload,
  signatureHeader: `t=${now - 300001},v1=${signature}`,
  secret,
  toleranceMs: 300000,
  now,
}), (error) => error.code === "stale_signature");

const normalized = normalizeOrbitEvent(payload, config, { signatureVerified: true });
assert.equal(normalized.record.projection.status, "ready");
assert.equal(normalized.mission.plantId, "BLM");
assert.equal(normalized.mission.inspections[0].type, "Thermal");
assert.equal(normalized.mission.inspections[0].result, "Fail");
assert.match(normalized.mission.inspections[0].reading, /88\.4 C/);

const unmappedConfig = loadOrbitConfig({ ORBIT_WEBHOOK_SECRET: secret }, ["BLM"]);
const unmapped = normalizeOrbitEvent({
  ...payload,
  uuid: "event-unmapped",
  data: { ...payload.data, robotHostname: "unknown-robot" },
}, unmappedConfig);
assert.equal(unmapped.mission, null);
assert.equal(unmapped.record.projection.status, "pending_mapping");
assert.deepEqual(unmapped.record.projection.missingFields, ["plant mapping"]);

const store = new MemoryOrbitEventStore();
assert.equal(store.reserve(normalized.record).duplicate, false);
assert.equal(store.reserve(normalized.record).duplicate, true);
assert.equal(store.summary().captured, 1);

async function testSinkDelivery() {
  let sent;
  const response = await deliverToEventSink(normalized.record, {
    sinkUrl: "https://sink.example.test/orbit/events",
    sinkToken: "test-token",
    sinkTimeoutMs: 1000,
  }, async (url, options) => {
    sent = { url, options };
    return { ok: true, status: 201 };
  });
  assert.equal(response.delivered, true);
  assert.equal(sent.options.headers["Idempotency-Key"], payload.uuid);
  assert.equal(sent.options.headers.Authorization, "Bearer test-token");
  assert.equal(JSON.parse(sent.options.body).payload.data.uuid, payload.data.uuid);

  await assert.rejects(() => deliverToEventSink(normalized.record, {
    sinkUrl: "https://sink.example.test/orbit/events",
    sinkToken: "",
    sinkTimeoutMs: 1000,
  }, async () => ({ ok: false, status: 503 })), /HTTP 503/);
}

testSinkDelivery()
  .then(() => console.log("Orbit webhook unit tests passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
