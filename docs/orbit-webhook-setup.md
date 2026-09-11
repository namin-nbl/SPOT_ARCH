# Boston Dynamics Orbit webhook setup

This receiver implements the Orbit action webhook contract and keeps three concerns separate:

1. Authenticate and validate the Orbit event.
2. Capture the complete event in an audit record and optionally deliver it to durable storage.
3. Project action results into the existing ARCH Tickets data model when robot and plant identity are known.

## Endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/webhooks/orbit` | Signed Orbit event receiver |
| `GET` | `/api/webhooks/orbit/status` | Configuration and in-process capture health |
| `GET` | `/api/webhooks/orbit/events` | Recent event metadata; requires the admin bearer token |

The receiver supports `ACTION_COMPLETED` and `ACTION_COMPLETED_WITH_ALERT`. Each request must use `Content-Type: application/json` and the Orbit envelope fields `uuid`, `type`, `time`, and `data`. The `data` value is the Orbit `run_event` resource.

Orbit 5.2 still exposes webhooks and run-event resources through the v0 API tier. Boston Dynamics describes v0 as beta/experimental, so keep the full original payload in the archive and regression-test this adapter when Orbit is upgraded.

## Vercel configuration

Add the following in **Vercel > Project > Settings > Environment Variables**, then redeploy:

- `ORBIT_WEBHOOK_SECRET`: the same 64-character hexadecimal secret configured for the Orbit webhook.
- `ORBIT_ROBOT_PLANT_MAP`: a JSON object mapping the hostname or nickname in each Orbit `run_event` to an approved plant. Example: `{"spot-blm-01":"BLM"}`.
- `ORBIT_ADMIN_TOKEN`: a long random bearer token for the event-inspection endpoint.
- `ORBIT_EVENT_SINK_URL` and `ORBIT_EVENT_SINK_TOKEN`: optional but strongly recommended durable archive target.

`ORBIT_DEFAULT_PLANT_ID` can replace the robot map only when the deployment receives events for a single plant. The receiver will still capture a valid event when its plant is unknown, but marks the ARCH projection `pending_mapping` instead of assigning the wrong plant.

Vercel function memory is not durable. Without `ORBIT_EVENT_SINK_URL`, accepted events are visible only while that function instance remains warm. A production deployment should configure a Niagara-approved database or integration service behind the sink contract below.

## Durable event sink contract

When `ORBIT_EVENT_SINK_URL` is set, the receiver sends a JSON `POST` containing the complete versioned audit record. It includes these headers:

```text
Authorization: Bearer <ORBIT_EVENT_SINK_TOKEN>
Idempotency-Key: <Orbit envelope uuid>
X-Orbit-Event-Type: ACTION_COMPLETED_WITH_ALERT
```

The sink must return any `2xx` status after durable storage and must enforce uniqueness on `Idempotency-Key`. A non-`2xx` response causes this receiver to return `503`, allowing Orbit to retry safely.

## Register in Orbit

In the Orbit administrator settings, create a webhook with:

- URL: `https://<your-vercel-domain>/api/webhooks/orbit`
- Events: `ACTION_COMPLETED` and/or `ACTION_COMPLETED_WITH_ALERT`
- Secret: the value stored in `ORBIT_WEBHOOK_SECRET`
- TLS certificate validation: enabled

Confirm the Orbit host/network can reach the public HTTPS endpoint. Use Orbit's test-payload function before enabling production actions.

## Local signed test

Start the application, then send the included fixture from another terminal:

```powershell
$env:ORBIT_WEBHOOK_SECRET="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
$env:ORBIT_ROBOT_PLANT_MAP='{"spot-blm-01":"BLM"}'
npm.cmd start
```

```powershell
$env:ORBIT_WEBHOOK_SECRET="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
npm.cmd run webhook:send -- http://127.0.0.1:4173/api/webhooks/orbit
```

The sender gives the fixture a fresh event ID by default. Add `--preserve-id` to repeat the fixture's ID and verify the duplicate-delivery path.

Check health at `GET /api/webhooks/orbit/status`. To inspect recent metadata, send `Authorization: Bearer <ORBIT_ADMIN_TOKEN>` to `GET /api/webhooks/orbit/events`. Raw event payloads are intentionally excluded from that response; the configured durable sink is the audit system of record.

## Official references

- [About Orbit and webhook contract](https://dev.bostondynamics.com/docs/concepts/orbit/about_orbit)
- [Orbit API concepts and resource model](https://dev.bostondynamics.com/docs/concepts/orbit/orbit_api)
- [Boston Dynamics webhook integration example](https://dev.bostondynamics.com/python/examples/orbit/webhook_integration/readme)
