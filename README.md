# Resilient Decision System

A MERN workflow decision platform with versioned rules, a simulated risk dependency, idempotent requests, automatic retries, manual review, and an auditable explanation for each outcome.

## Ten-minute reviewer route

1. Start MongoDB and the app using the commands below.
2. Open the UI and submit the **Happy path** and **High-value manual review** scenarios from the table.
3. Repeat the happy-path submission with the same idempotency key, then try the `fail-once` scenario.
4. Inspect the explanation at the top of Decision detail and the newest-first audit timeline. See the linked architecture and examples for the design rationale.

## Prerequisites

- **Node.js 22 or newer** and npm.
- **MongoDB 7**, either via the included `compose.yaml` and Docker Compose, or a local MongoDB Community installation. The commands below assume MongoDB is available on `127.0.0.1:27017`.
- macOS or Linux. Run commands from the repository root.

If using a local installation instead of Docker Compose, start MongoDB with `brew services start mongodb-community@7.0` on macOS (for the Homebrew 7.0 formula) or `sudo systemctl start mongod` on a systemd-based Linux installation. See MongoDB's [macOS](https://www.mongodb.com/docs/v7.0/tutorial/install-mongodb-on-os-x/) and [Linux systemd](https://www.mongodb.com/docs/manual/administration/run-mongodb-systemd/) instructions if MongoDB is not installed yet.

## Run on macOS

In a terminal at the repository root:

```bash
docker compose up -d mongo
export MONGO_URI='mongodb://127.0.0.1:27017'
export MONGO_DB='decision_platform'
export PORT=3001
npm ci
npm test
npm run dev
```

For a local Homebrew MongoDB installation, replace `docker compose up -d mongo` with `brew services start mongodb-community@7.0`. Keep this terminal open while reviewing the app.

## Run on Linux

In a terminal at the repository root:

```bash
docker compose up -d mongo
export MONGO_URI='mongodb://127.0.0.1:27017'
export MONGO_DB='decision_platform'
export PORT=3001
npm ci
npm test
npm run dev
```

For a local systemd MongoDB installation, replace `docker compose up -d mongo` with `sudo systemctl start mongod`.

Open the **[React UI](http://localhost:5173)**. The **[REST API](http://localhost:3001/api/health)** listens on port 3001; `GET /api/workflows` lists available configurations. If you change `PORT`, also update the Vite proxy target in `client/vite.config.js`. For a nonpersistent preview without MongoDB, use `DATA_STORE=memory npm run dev` after `npm ci`.

## Submit and inspect a request

The UI accepts the inner `input` object after you choose a workflow and version. The table below gives complete JSON bodies for `POST /api/requests`. Each submission requires an `Idempotency-Key` header. For example:

```bash
curl -i -X POST 'http://localhost:3001/api/requests' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-happy' \
  -d '{"workflowId":"application-approval","version":1,"input":{"applicantId":"A-100","amount":4000,"creditScore":720,"documentsComplete":true,"dependencyMode":"ok"}}'
```

Copy the returned `request.id` and inspect `GET http://localhost:3001/api/requests/<id>` for the current `explanation` and complete `audit` array. The UI shows the same detail. To retry immediately, call `POST /api/requests/<id>/retry` while the status is `RETRY_PENDING`. To resolve manual review, call `POST /api/requests/<id>/review` with JSON such as `{"decision":"APPROVED","operator":"reviewer","note":"Checked supporting documents"}`.

## Demo scenarios

Submit the rows in order. Use the stated key in the `Idempotency-Key` header. The **Duplicate request** and **Same key, different data** rows deliberately reuse the happy-path key. All other keys are unique so previous submissions do not affect the expected result. `fail-once` and `fail-always` depend on the automatic retry worker running with `npm run dev`.

| Scenario | Idempotency key | Exact JSON body for `POST /api/requests` | Expected result |
| --- | --- | --- | --- |
| Happy path | `demo-happy` | `{"workflowId":"application-approval","version":1,"input":{"applicantId":"A-100","amount":4000,"creditScore":720,"documentsComplete":true,"dependencyMode":"ok"}}` | `201`, `APPROVED`; explanation includes `creditScore 720 >= 600`, `riskScore 7 <= 70`, and amount below the review threshold. |
| Reject | `demo-reject` | `{"workflowId":"application-approval","version":1,"input":{"applicantId":"A-101","amount":4000,"creditScore":550,"documentsComplete":true,"dependencyMode":"ok"}}` | `201`, `REJECTED` by the minimum-credit rule; later stages do not run. |
| Rule change, v1 | `demo-v1-625` | `{"workflowId":"application-approval","version":1,"input":{"applicantId":"A-102","amount":4000,"creditScore":625,"documentsComplete":true,"dependencyMode":"ok"}}` | `201`, `APPROVED`; v1 requires `creditScore >= 600`. |
| Rule change, v2 | `demo-v2-625` | `{"workflowId":"application-approval","version":2,"input":{"applicantId":"A-102","amount":4000,"creditScore":625,"documentsComplete":true,"dependencyMode":"ok"}}` | `201`, `REJECTED`; v2 requires `creditScore >= 650`. |
| High-value manual review | `demo-review` | `{"workflowId":"application-approval","version":2,"input":{"applicantId":"A-103","amount":8000,"creditScore":720,"documentsComplete":true,"dependencyMode":"ok"}}` | `201`, `MANUAL_REVIEW`; v2 routes amounts above `7500` to review. Resolve it in the UI or review endpoint. |
| Duplicate request | `demo-happy` again | `{"workflowId":"application-approval","version":1,"input":{"applicantId":"A-100","amount":4000,"creditScore":720,"documentsComplete":true,"dependencyMode":"ok"}}` | `200`, `duplicate: true`; same request ID and no second execution. |
| Same key, different data | `demo-happy` again | `{"workflowId":"application-approval","version":1,"input":{"applicantId":"A-100","amount":5000,"creditScore":720,"documentsComplete":true,"dependencyMode":"ok"}}` | `409`, `IDEMPOTENCY_CONFLICT`. |
| Invalid input | `demo-invalid` | `{"workflowId":"application-approval","version":1,"input":{"applicantId":"A-104","amount":4000,"creditScore":"720","documentsComplete":true,"dependencyMode":"ok"}}` | `400`, `INVALID_INPUT`; `creditScore` must be a number. |
| Dependency fails once | `demo-fail-once` | `{"workflowId":"application-approval","version":1,"input":{"applicantId":"A-105","amount":4000,"creditScore":720,"documentsComplete":true,"dependencyMode":"fail-once"}}` | Initial `201`, `RETRY_PENDING`; automatic retry after about 1 second reaches `APPROVED` on attempt 2. |
| Dependency always fails | `demo-fail-always` | `{"workflowId":"application-approval","version":1,"input":{"applicantId":"A-106","amount":4000,"creditScore":720,"documentsComplete":true,"dependencyMode":"fail-always"}}` | Initial `201`, `RETRY_PENDING`; after 5 attempts it escalates to `MANUAL_REVIEW` (about 15 seconds with the sample backoff). |

## How to change a rule or add a workflow

Definitions are JSON files in [`server/config/workflows`](server/config/workflows). Copy `application-v2.json`, change a threshold or stage, increment `version`, and restart the server. Keep old versions so in-flight requests can still use their pinned configuration. To add a use case, create a new file with a unique `id` and version, an `input` schema, ordered `rules` or `dependency` stages, and a `defaultOutcome`; [`vendor-v1.json`](server/config/workflows/vendor-v1.json) is a second example. The server validates configurations at startup. `kind: "branch"` gives routing rules `MATCHED` / `NOT MATCHED` results, while checks use `PASS` / `FAIL`.

## Assumptions and trade-offs

The risk service is simulated and deterministic, and workflow configurations are source-controlled and versioned rather than edited live. The initial request runs synchronously for a quick decision; failed dependencies enter an automatic retry flow. Audit events live in the same MongoDB document as state, making each stage and its trace one atomic write. The demo review endpoint has no authentication, so production use needs operator identity and authorization.

## Scaling considerations

MongoDB's unique idempotency index and retry/status indexes support the current workload. For higher volume, use dedicated queue-backed workers, paginate request lists, move large audit histories to an append-only store with transactional or outbox coordination, and monitor retry lag and manual-review backlog. External adapters must honor the stable operation key so a replay cannot create duplicate side effects.

## Further reading

- [Architecture and trade-offs](ARCHITECTURE.md)
- [Implementation plan and deliverables](IMPLEMENTATION_PLAN.md)
- [Decision explanation examples](DECISION_EXAMPLES.md)
