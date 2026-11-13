# Decision explanation examples

The following examples use the bundled workflow definitions. Each request's `audit` array records the full sequence, including timestamps, field references, actual values, rule results, stage transitions, and final outcome.

## 1. Approved application

**Input:** `application-approval@1` with `{"applicantId":"A-100","amount":4000,"creditScore":720,"documentsComplete":true,"dependencyMode":"ok"}`.

| Stage | Triggered check | Observed data | Result |
| --- | --- | --- | --- |
| Eligibility | `documents-present`: `eq true` | `input.documentsComplete = true` | Pass |
| Eligibility | `minimum-credit`: `gte 600` | `input.creditScore = 720` | Pass |
| Risk check | `risk-score` adapter | `riskScore = 7` | Success |
| Risk and routing | `risk-limit`: `lte 70` | `context.riskScore = 7` | Pass |
| Risk and routing | `high-value-review`: `gt 10000` | `input.amount = 4000` | Not matched, no review branch |

**Output:** `APPROVED`. The request's `explanation` and the final `DECISION_RECORDED.summary` contain:

> Approved: documents complete, creditScore 720 >= 600, riskScore 7 <= 70, amount 4000 not above the 10000 review threshold

## 2. Rejected after a rule change

**Input:** `application-approval@2` with `{"applicantId":"A-101","amount":4000,"creditScore":625,"documentsComplete":true,"dependencyMode":"ok"}`.

`documents-present` passes. `minimum-credit` observes `input.creditScore = 625` against the v2 threshold `gte 650` and fails with reason `Credit score is below the minimum`. The configured `onFail` action is `REJECTED`, so later stages are not run. The same input under v1 passes the `gte 600` check and can be approved. Each request retains its selected version and trace.

**Output:** `REJECTED` with explanation `Rejected: documents complete, creditScore 625 < 650`.

## 3. Transient dependency failure and retry

**Input:** `application-approval@1` with the approved example's fields, but `dependencyMode = "fail-once"`.

Eligibility passes. On attempt 1, `risk-check` records `DEPENDENCY_FAILED` with stage ID and operation key, then `RETRY_SCHEDULED`; output is `RETRY_PENDING` with a next retry time. On attempt 2, the same stage calls the adapter with the same operation key, receives risk score 7, and processing continues to `APPROVED`. The earlier eligibility stage is not repeated. Both attempts and the final decision remain in the audit trail.

**Retry output:** `Retry pending: documents complete, creditScore 720 >= 600, risk-check failed: Risk scoring service is temporarily unavailable (attempt 1 of 5)`. A successful retry replaces the request's current explanation with the approved summary while preserving both summaries in the audit history.

## 4. Conditional vendor review

**Input:** `vendor-approval@1` with `{"vendorId":"V-100","contractValue":60000,"taxVerified":true,"insuranceVerified":false}`.

`tax-verified` passes. The condition `input.contractValue > 50000` is true, so `insurance-for-large-contract` runs and fails because `insuranceVerified` is false. Its configured outcome is `MANUAL_REVIEW`. An operator can then use `POST /api/requests/:id/review` with `{"decision":"APPROVED","operator":"case-worker","note":"Insurance document manually verified"}`. The final audit event records the operator, note, and decision.

**Review output:** `Manual review required: tax verified, insurance not verified`. After resolution, the explanation becomes `Approved after manual review: tax verified, insurance not verified, reviewed by case-worker: Insurance document manually verified`.
