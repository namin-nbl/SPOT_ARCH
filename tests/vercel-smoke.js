const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
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

async function invoke(path, { method = "GET", query = {}, body } = {}) {
  const request = Readable.from([]);
  const search = new URLSearchParams({ path, ...query });
  request.method = method;
  request.url = `/api?${search}`;
  request.headers = { host: "spot-arch.vercel.app", "content-type": "application/json" };
  request.query = { path, ...query };
  if (body !== undefined) request.body = body;

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
    eventId: "evt-vercel-smoke-001",
    eventType: "action.completed_with_alert",
    eventTime: "2026-09-11T16:00:00Z",
    data: {
      missionId: "SPOT-VERCEL-SMOKE-001",
      robotId: "SPOT-BD-52240",
      plantId: "BLM",
      status: "Complete",
      inspections: [{ id: "IP-VS-1", name: "Smoke test point", type: "Thermal", result: "Fail" }],
    },
  };
  const created = await invoke("webhooks/orbit", { method: "POST", body: event });
  assert.equal(created.statusCode, 201);
  assert.equal(json(created).tickets.length, 1);

  const replay = await invoke("webhooks/orbit", { method: "POST", body: event });
  assert.equal(replay.statusCode, 200);
  assert.equal(json(replay).duplicate, true);

  const missing = await invoke("does-not-exist");
  assert.equal(missing.statusCode, 404);

  console.log("Vercel function smoke test passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
