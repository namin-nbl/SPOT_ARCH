class MemoryOrbitEventStore {
  constructor(limit = 500) {
    this.limit = limit;
    this.records = new Map();
    this.order = [];
  }

  reserve(record) {
    const existing = this.records.get(record.eventId);
    if (existing) return { duplicate: true, entry: existing };

    const entry = {
      ...record,
      archive: { status: "not_configured", attempts: 0, lastError: null },
      projectedAt: null,
    };
    this.records.set(record.eventId, entry);
    this.order.unshift(record.eventId);
    while (this.order.length > this.limit) this.records.delete(this.order.pop());
    return { duplicate: false, entry };
  }

  markArchive(eventId, archive) {
    const entry = this.records.get(eventId);
    if (entry) entry.archive = { ...entry.archive, ...archive };
  }

  markProjected(eventId) {
    const entry = this.records.get(eventId);
    if (entry) entry.projectedAt = new Date().toISOString();
  }

  list(limit = 25) {
    return this.order.slice(0, Math.min(Math.max(limit, 1), 100)).map((id) => this.records.get(id));
  }

  summary() {
    const entries = this.list(this.limit);
    return {
      captured: entries.length,
      archived: entries.filter((entry) => entry.archive.status === "delivered").length,
      pendingMapping: entries.filter((entry) => entry.projection.status === "pending_mapping").length,
      lastEventAt: entries[0]?.receivedAt || null,
    };
  }
}

async function deliverToEventSink(entry, config, fetchImpl = globalThis.fetch) {
  if (!config.sinkUrl) return { configured: false, delivered: false };
  if (typeof fetchImpl !== "function") throw new Error("This Node.js runtime does not provide fetch");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.sinkTimeoutMs);
  try {
    const headers = {
      "Content-Type": "application/json",
      "Idempotency-Key": entry.eventId,
      "X-Orbit-Event-Type": entry.eventType,
    };
    if (config.sinkToken) headers.Authorization = `Bearer ${config.sinkToken}`;
    const response = await fetchImpl(config.sinkUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(entry),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Event sink returned HTTP ${response.status}`);
    return { configured: true, delivered: true, statusCode: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

const orbitEventStore = new MemoryOrbitEventStore();

module.exports = { MemoryOrbitEventStore, deliverToEventSink, orbitEventStore };
