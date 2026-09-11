# ARCH SPOT Mission Monitor

A self-contained, interactive implementation of the SPOT monitoring experience described in `SPOT ARCH BRD.docx`. It models the approved Orbit → Litmus → ARCH boundary while keeping environment-specific credentials and endpoint choices outside the prototype.

## Run locally

Requirements: Node.js 18 or newer. No dependency installation is required.

```powershell
npm.cmd start
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173).

## Deploy to Vercel

Import the GitHub repository into Vercel and use the **Other** framework preset. No build or output-directory override is required. Static files are served from `public/`, while `vercel.json` routes `/api/*` requests to the Node.js function in `api/index.js`.

The included data store is in memory. It is appropriate for this interactive prototype, but webhook-created records and ticket-status changes are not guaranteed to persist between serverless invocations. Connect an approved persistent data store before production use.

To run syntax checks:

```powershell
npm.cmd run check
```

## Included capabilities

- SPOT overview and Tickets experience with responsive ARCH-inspired navigation
- Plant, mission status, date-range, and Mission ID filtering on Tickets; Overview also supports robot filtering
- Mission, inspection, failure, and open-ticket KPI cards scoped to the active filters
- Equal-width weekly mission and inspection trend cards
- Sortable mission grid and CSV export
- Mission details with required summary fields, plant-local timestamps, Orbit trace IDs, inspection points, possible causes, recommendations, attachments, and related alerts
- Mission-linked anomaly ticket drawer with status workflow updates
- Attachment preview and download behavior
- Local Orbit webhook endpoint with validation, normalization, safe retry/deduplication, correlation logging, and anomaly-ticket creation
- Explicit unavailable/pending states so missing data is not represented as a valid zero

## Local API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/missions` | Filtered mission list, KPIs, and trends |
| `GET` | `/api/missions/:id` | Mission summary, inspections, artifacts, and related alerts |
| `GET` | `/api/alerts` | Filtered SPOT ticket list |
| `PATCH` | `/api/alerts/:id` | Update a local ticket workflow status |
| `POST` | `/api/webhooks/orbit` | Validate and process an Orbit-style event |
| `GET` | `/api/integration/logs` | Correlated processing trace |
| `GET` | `/api/health` | Integration service health summary |

All data is intentionally in-memory. Restarting the server restores the curated BRD-aligned sample state.

## Production integration boundary

The BRD leaves the Orbit version/endpoints, subscribed event types, final field mapping, anomaly thresholds and severity rules, secret management, retry/dead-letter behavior, retention, ticket fields, and media access policy open. The local webhook and generated artifacts demonstrate those contracts but do not guess production credentials or Niagara infrastructure details.

Before deployment, connect the API handlers to the approved Litmus-to-ARCH transport and persistence layer, enforce ARCH RBAC and plant scoping server-side, replace the sample anomaly rules with approved thresholds, and use the enterprise secret and media-retention controls.
