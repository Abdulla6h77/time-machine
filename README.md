# Time Machine

Time Machine archives versions of public pages. TinyFish Page Monitor performs the live checks and supplies the page text and run evidence. The worker records that evidence, filters common noise, and asks TinyFish Browser for a fresh screenshot when it saves a version. The timeline and JSON API read the same SQLite archive.

## Evidence status

This repository publishes the implementation, not completed bounty evidence. The last local audit recorded 20 configured targets, 40 checks and 20 stored screenshots, with no genuine changes captured. Those checks covered approximately five minutes; the original registration date does not prove 72 hours of continuous collection. Current provider-side activity has not been reverified. Credentials, monitor records, SQLite files, screenshots and operational logs are excluded from this release and remain in the original local project. Nine offline tests passed before publication; they do not establish live acceptance.

## Run locally

Requires Node.js 24+, a TinyFish API key with Monitor and Browser access, and persistent disk space. Supply the key through the process environment or a private Node env file. Keep the same data directory across restarts.

```powershell
npm ci
npm test
npm run start
```

Open http://127.0.0.1:3036. Start the worker in a second terminal.

```powershell
npm run worker
npm run status
```

Register the 20 supplied sources once, or register another public page by URL and label. Registration runs a billable baseline and schedules future checks every six hours. Registration reconciles matching project monitor names and URLs from the account list before creating a new monitor. Review account capacity and schedule before running it.

```powershell
npm run register
npm run register -- https://example.com/ "Example"
```

## Collection modes

**Scheduled webhook** is the deployment mode. Set `TIME_MACHINE_WEBHOOK_SECRET` to a long, random URL-safe secret on the API process. Set `TIME_MACHINE_WEBHOOK_URL` for registration to the public HTTPS URL ending in `/hooks/monitor/<secret>`. Existing monitors can be updated through the provider API or dashboard. The API commits the raw run to SQLite before acknowledging it. The worker resumes queued processing on restart. Disable reverse proxy request path logging for the secret-bearing route.

**Local run-now** uses the authenticated Monitor API when there is no public webhook. Set `TIME_MACHINE_RUN_NOW_HOURS` (for example, `3`) and `TIME_MACHINE_POLL_UNTIL` to an explicit ISO timestamp on the worker. It issues scheduled batches of Monitor run-now calls, persists the results, and ceases issuing calls at the cutoff. The separate TinyFish account schedules continue until paused. Do not run both modes for the same targets unless you intend the extra checks. Monitor's public REST API has no scheduled run-history replay. Webhook delivery gaps may leave missing versions.

## API

| Route | Result |
| --- | --- |
| `GET /api/status` | Monitor and capture counts from persisted evidence |
| `GET /api/pages` | Registered pages and observed coverage |
| `GET /api/pages/:id/versions` | Timeline metadata, source URLs and available screenshot URLs |
| `GET /api/pages/:id/as-of?at=2026-11-11` | Latest version observed by the given date |
| `GET /api/pages/:id/diff?from=2026-11-11&to=2026-11-12` | Added, removed, and changed line ranges |
| `GET /api/screenshots/:versionId` | Stored JPEG |

Date-only requests use the end of the UTC day. Exact timestamps accept ISO 8601 with a timezone and return the last observed version at or before that time. Earlier dates with no observed history return HTTP 404. Run timestamp provenance distinguishes provider timestamps from local receipt times. Screenshot time is stored separately because rendering happens after Monitor's observation. A failed or expired capture stays visible as unavailable. Capture attempts must start within five minutes of a change observation or fifteen minutes of a baseline. The browser view can differ from the Monitor text if the source changes again, so both timestamps remain visible. A baseline is never counted as a change.

## Deployment plan

1. Run one API process and one worker on the same persistent local SSD volume. Set `TIME_MACHINE_DATA_DIR` to an absolute path outside the release directory. Keep the SQLite database and WAL on that volume. Run both processes under a supervisor with restart policies.
2. Put HTTPS in front of the API. Limit webhook request bodies, keep its secret path out of logs, and restrict access to operational logs and stored artifacts. Give the worker egress to TinyFish and DNS. Keep browser execution isolated from private resources.
3. Set the webhook on each project monitor, then verify an actual scheduled delivery, database persistence, image retrieval, and restart recovery. Leave run-now disabled in webhook mode.
4. Back up SQLite using its online backup mechanism. Observe disk use, capture errors, and last successful deliveries. Review TinyFish account schedules and pause them when collection ends if ongoing billing is unwanted.
5. Before submitting, verify at least 72 hours of live monitoring and retain evidence for real captured changes. Keep test databases separate from the evidence volume.

Provider references: [TinyFish Monitor REST API](https://docs.tinyfish.ai/monitor/api-reference) and [TinyFish Browser API](https://docs.tinyfish.ai/browser-api/reference).

See [SPEC.md](SPEC.md) and [TASKS.md](TASKS.md) for bounty requirements and validation status.

## Windows collector supervision

The current-user **TinyFish Time Machine Worker** task runs the supervisor during sign-in and relaunches it after an exit. The supervisor restarts its child with bounded backoff and checks the SQLite heartbeat. A logged-out or sleeping machine can miss local checks. The provider schedules run independently.

The task reads the ignored local `state/collector-config.json` with `hours`, `until` (an ISO cutoff), and optionally `credentialFile` (path to a private env file). An inherited `TINYFISH_API_KEY` can supply the credential instead. Keep keys out of the task command line and collector config. To reinstall on a new machine, create that private configuration and run `install-supervisor.ps1` from PowerShell, then start the registered task. Preserve the original cutoff and SQLite volume when migrating an active evidence window.

The collector keeps one SQLite lease and one reservation per page and scheduled slot. After an outage it logs skipped local slots and collects the current one. It retries transient read-only status requests once. A possibly dispatched billable run is logged as interrupted and left for the next slot. SQLite deduplicates provider run IDs across restarts and webhook retries.

The home dashboard shows heartbeat, last successful observation, next local check, and per-page check, change, and failure counts. `GET /api/collector` exposes the same information. Run `node audit.mjs` to validate stored image-to-run bindings and JPEG fingerprints. See [TARGETS.md](TARGETS.md) for the review of all 20 sources.
