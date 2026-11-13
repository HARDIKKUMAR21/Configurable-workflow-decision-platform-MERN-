# Implementation plan

## 1. Scope and acceptance

Build a MERN decision platform with REST endpoints and a small React console. A request is validated against a selected, immutable workflow version. The engine executes configured rule and dependency stages, records each transition and rule result, and ends in `APPROVED`, `REJECTED`, `MANUAL_REVIEW`, or `RETRY_PENDING`.

Acceptance is the assignment's required scenarios: happy path, invalid input, duplicate idempotency key, dependency failure, retry, and changed rule version. Also demonstrate a second use case, document the architecture, and provide sample explanations.

## 2. Build sequence

1. **Configuration and pure engine**: define versioned workflow JSON, schema validation, rule operators, conditional rules, stage results, and a deterministic external dependency simulator.
2. **Durable execution**: add MongoDB repository with a unique idempotency index, atomic state and audit writes, optimistic stage updates, and expiring worker leases. Add an in-memory repository for isolated tests.
3. **REST API**: create, list, inspect, retry, and inspect workflow configurations. Map validation, conflict, and dependency outcomes to clear HTTP responses.
4. **React console**: select workflow/version, edit JSON input, submit with idempotency key, and inspect state, rule trace, and audit events.
5. **Verification and docs**: run the automated tests and UI build, then explain assumptions, failure behavior, scaling, and the exact commands to run the app.

All five steps are implemented. Final verification: 14 automated tests passed, the React production build passed, and the built UI processed a sample request in the browser.

## 3. Key design decisions

- Workflow versions are immutable snapshots in source-controlled JSON. A request pins its version, so a later rule change cannot silently change an in-flight decision.
- The repository owns persistence and concurrency; the engine has no database or HTTP knowledge.
- Each stage outcome and its audit events are written in one MongoDB document update. A save failure leaves that stage uncommitted, so an expired lease can replay it.
- The dependency receives a stable operation key derived from request and stage IDs. The supplied simulator is deterministic and side-effect free; a production adapter must honor that key for safe replay.
- Automatic retries use exponential backoff; the API also supports an immediate manual retry for demonstration and operations.

## 4. Deliverable map

| Assignment deliverable | Location |
| --- | --- |
| Runnable implementation and setup | `README.md`, `server/`, `client/` |
| Architecture and tradeoffs | `ARCHITECTURE.md` |
| Configurable workflows and rules | `server/config/workflows/*.json` |
| API interface | `server/src/http/`, `client/src/` |
| Required scenario tests | `server/test/` |
| Input, triggered rules, outputs, reasoning | `DECISION_EXAMPLES.md` |
