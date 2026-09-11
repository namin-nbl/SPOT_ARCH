const fs = require("node:fs");
const path = require("node:path");
const { createOrbitSignature } = require("../orbit/signature");

async function main() {
  const args = process.argv.slice(2);
  const preserveId = args.includes("--preserve-id");
  const positional = args.filter((arg) => arg !== "--preserve-id");
  const [endpoint, payloadPath = "fixtures/orbit/action-completed-with-alert.json"] = positional;
  if (!endpoint) {
    throw new Error("Usage: node scripts/send-orbit-webhook.js <endpoint-url> [payload-json] [--preserve-id]");
  }
  const secret = process.env.ORBIT_WEBHOOK_SECRET;
  if (!secret) throw new Error("Set ORBIT_WEBHOOK_SECRET before sending the fixture");

  const absolutePath = path.resolve(process.cwd(), payloadPath);
  const payload = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  if (!preserveId) payload.uuid = `local-${Date.now()}`;
  payload.time = new Date().toISOString();
  const timestamp = String(Date.now());
  const signature = createOrbitSignature(payload, timestamp, secret);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Orbit-Signature": `t=${timestamp},v1=${signature}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  console.log(`HTTP ${response.status}`);
  console.log(text);
  if (!response.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
