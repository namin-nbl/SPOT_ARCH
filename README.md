# ARCH SPOT Mission Monitor

A self-contained, interactive implementation of the SPOT monitoring experience described in `SPOT ARCH BRD.docx`. It models the Orbit-to-ARCH boundary while keeping environment-specific credentials and endpoint choices outside the codebase.

## Run locally

Requirements: Node.js 18 or newer. No dependency installation is required.

```powershell
npm.cmd start
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173).

## Deploy to Vercel

Import the GitHub repository into Vercel and use the **Other** framework preset. No build or output-directory override is required. Static files are served from `public/`, while `vercel.json` routes `/api/*` requests to the Node.js function in `api/index.js`.

The included UI data store is in memory. It is appropriate for this interactive prototype, but webhook-created records and ticket-status changes are not guaranteed to persist between serverless invocations. The webhook framework can forward each complete event to a durable HTTP sink; configure that sink before production use.

To run syntax checks:

```powershell
npm.cmd run check
```

## Included capabilities

- SPOT overview and Tickets experience with responsive ARCH-inspired navigation
- Niagara presentation-derived design system with Aptos typography, branded blue/orange/green accents, system-aware light and dark modes, and a persistent theme toggle
- Plant, mission status, date-range, and Mission ID filtering on Tickets; Overview also supports robot filtering
- Mission, inspection, failure, and open-ticket KPI cards scoped to the active filters
- Equal-width weekly mission and inspection trend cards
- Sortable mission grid and CSV export
- Mission details with required summary fields, plant-local timestamps, Orbit trace IDs, inspection points, possible causes, recommendations, attachments, and related alerts
- Mission-linked anomaly ticket drawer with status workflow updates
- Attachment preview and download behavior
- Boston Dynamics Orbit webhook ingestion with HMAC-SHA256 verification, replay-window enforcement, envelope validation, retry-safe deduplication, raw-event audit records, action normalization, and anomaly-ticket creation
- Robot-to-plant mapping with a pending-mapping path that captures valid events without assigning them to the wrong plant
- Optional durable HTTP event sink with idempotency keys for serverless deployments
- Explicit unavailable/pending states so missing data is not represented as a valid zero

## Local API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/missions` | Filtered mission list, KPIs, and trends |
| `GET` | `/api/missions/:id` | Mission summary, inspections, artifacts, and related alerts |
| `GET` | `/api/alerts` | Filtered SPOT ticket list |
| `PATCH` | `/api/alerts/:id` | Update a local ticket workflow status |
| `POST` | `/api/webhooks/orbit` | Authenticate, capture, and process an Orbit action event |
| `GET` | `/api/webhooks/orbit/status` | Webhook configuration, storage mode, and capture counters |
| `GET` | `/api/webhooks/orbit/events` | Recent event metadata (admin bearer token required) |
| `GET` | `/api/integration/logs` | Correlated processing trace |
| `GET` | `/api/health` | Integration service health summary |

The curated UI data is intentionally in-memory. Restarting the local server restores the sample state. See [the Orbit webhook setup guide](docs/orbit-webhook-setup.md) for environment variables, Orbit registration, signed local testing, and the durable sink contract.

## Production integration boundary

The receiver implements Orbit's documented `uuid` / `type` / `time` / `data` envelope and the `ACTION_COMPLETED` and `ACTION_COMPLETED_WITH_ALERT` events. The `data` value is retained as the complete `run_event`; the projection layer only derives fields needed by this prototype and does not invent anomaly causes or maintenance recommendations.

Before production use, connect `ORBIT_EVENT_SINK_URL` to an approved durable store, enforce ARCH RBAC and plant scoping server-side, define retention and media retrieval policies, and replace the prototype ticket-severity rule with the approved business mapping.
