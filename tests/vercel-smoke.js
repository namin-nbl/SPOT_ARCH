const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { createOrbitSignature } = require("../orbit/signature");

const orbitSecret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.ORBIT_WEBHOOK_SECRET = orbitSecret;
process.env.ORBIT_ROBOT_PLANT_MAP = JSON.stringify({ "spot-blm-01": "BLM" });
process.env.ORBIT_ADMIN_TOKEN = "vercel-smoke-admin-token";
const handler = require("../api/index");

class MockResponse {
  constructor() {
    this.statusCode = 0;
    this.headers = {};
    this.body = Buffer.alloc(0);
    this.writableEnded = false;
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  end(body = "") {
    this.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    this.writableEnded = true;
  }
}

async function invoke(path, { method = "GET", query = {}, body, headers = {} } = {}) {
  const bodyText = body === undefined ? "" : JSON.stringify(body);
  const request = Readable.from(bodyText ? [Buffer.from(bodyText)] : []);
  const search = new URLSearchParams({ path, ...query });
  request.method = method;
  request.url = `/api?${search}`;
  request.headers = { host: "spot-arch.vercel.app", "content-type": "application/json", ...headers };
  request.query = { path, ...query };

  const response = new MockResponse();
  await handler(request, response);
  return response;
}

function json(response) {
  return JSON.parse(response.body.toString("utf8"));
}

async function run() {
  const plants = await invoke("plants");
  assert.equal(plants.statusCode, 200);
  assert.equal(json(plants).data.length, 4);

  const missions = await invoke("missions", { query: { plant: "BLM", status: "Complete" } });
  assert.equal(missions.statusCode, 200);
  assert.ok(json(missions).data.every((mission) => mission.plantId === "BLM" && mission.status === "Complete"));

  const details = await invoke("missions/SPOT-BLM-0910-042");
  assert.equal(details.statusCode, 200);
  assert.equal(json(details).data.inspectionCount, 5);

  const attachment = await invoke("attachments/ATT-042-A/download");
  assert.equal(attachment.statusCode, 200);
  assert.match(attachment.headers["Content-Type"], /image\/svg\+xml/);

  const event = {
    uuid: "evt-vercel-smoke-001",
    type: "ACTION_COMPLETED_WITH_ALERT",
    time: "2026-09-11T16:00:00Z",
    data: {
      uuid: "run-event-vercel-smoke-001",
      runUuid: "run-vercel-smoke-001",
      robotHostname: "spot-blm-01",
      missionName: "Vercel smoke route",
      actionName: "Thermal smoke test point",
      missionStatus: "SUCCESS",
      dataCaptures: [{
        uuid: "capture-vercel-smoke-001",
        channelName: "thermal",
        keyResults: [{ name: "Temperature", value: 90.2, units: "C" }],
      }],
    },
  };
  const timestamp = String(Date.now());
  const orbitHeaders = { "orbit-signature": `t=${timestamp},v1=${createOrbitSignature(event, timestamp, orbitSecret)}` };
  const created = await invoke("webhooks/orbit", { method: "POST", body: event, headers: orbitHeaders });
  assert.equal(created.statusCode, 202);
  assert.equal(json(created).tickets.length, 1);

  const invalidSignature = await invoke("webhooks/orbit", {
    method: "POST",
    body: { ...event, uuid: "evt-vercel-invalid-signature" },
    headers: { "orbit-signature": `t=${timestamp},v1=${"0".repeat(64)}` },
  });
  assert.equal(invalidSignature.statusCode, 401);
  assert.equal(json(invalidSignature).code, "invalid_signature");

  const replay = await invoke("webhooks/orbit", { method: "POST", body: event, headers: orbitHeaders });
  assert.equal(replay.statusCode, 200);
  assert.equal(json(replay).duplicate, true);

  const status = await invoke("webhooks/orbit/status");
  assert.equal(status.statusCode, 200);
  assert.equal(json(status).metrics.captured, 1);

  const unauthorizedEvents = await invoke("webhooks/orbit/events");
  assert.equal(unauthorizedEvents.statusCode, 401);
  const events = await invoke("webhooks/orbit/events", {
    headers: { authorization: "Bearer vercel-smoke-admin-token" },
  });
  assert.equal(events.statusCode, 200);
  assert.equal(json(events).data.length, 1);
  assert.equal(json(events).data[0].payload, undefined);

  const missing = await invoke("does-not-exist");
  assert.equal(missing.statusCode, 404);

  console.log("Vercel function smoke test passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
