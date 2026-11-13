import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorkflows } from '../src/domain/workflows.js';
import { MemoryRequestRepository } from '../src/repositories/memoryRequestRepository.js';
import { DecisionService } from '../src/services/decisionService.js';

const workflows = loadWorkflows();
const baseInput = { applicantId: 'A-100', amount: 4000, creditScore: 720, documentsComplete: true, dependencyMode: 'ok' };

function setup() {
  const repository = new MemoryRequestRepository();
  const service = new DecisionService({ repository, workflows });
  return { repository, service };
}

function submit(service, input = baseInput, version = 1, idempotencyKey = crypto.randomUUID()) {
  return service.submit({ workflowId: 'application-approval', version, input, idempotencyKey });
}

test('happy path approves and records every stage and rule', async () => {
  const { service } = setup();
  const { request } = await submit(service);
  assert.equal(request.status, 'APPROVED');
  assert.equal(request.stageIndex, 3);
  assert.equal(request.context.riskScore, 7);
  assert.deepEqual(request.audit.filter((event) => event.type === 'STAGE_COMPLETED').map((event) => event.stageId),
    ['eligibility', 'risk-check', 'risk-and-routing']);
  assert.equal(request.audit.at(-1).outcome, 'APPROVED');
  assert.equal(request.explanation, 'Approved: documents complete, creditScore 720 >= 600, riskScore 7 <= 70, amount 4000 not above the 10000 review threshold');
  assert.equal(request.audit.at(-1).summary, request.explanation);
  assert.ok(request.audit.some((event) => event.type === 'RULE_EVALUATED' && event.dataRef === 'input.creditScore' && event.actual === 720));
  assert.deepEqual(request.audit.filter((event) => event.type === 'RULE_EVALUATED').map((event) => event.result),
    ['PASS', 'PASS', 'PASS', 'NOT MATCHED']);
  assert.equal(request.audit.find((event) => event.ruleId === 'high-value-review').reason, null);
});

test('invalid input is rejected before persistence', async () => {
  const { repository, service } = setup();
  await assert.rejects(submit(service, { ...baseInput, creditScore: '720' }), (error) =>
    error.code === 'INVALID_INPUT' && error.details.some((detail) => detail.includes('creditScore')));
  assert.equal((await repository.list()).length, 0);
});

test('duplicate key returns the same result without another execution', async () => {
  const { service } = setup();
  const key = 'same-key';
  const first = await submit(service, baseInput, 1, key);
  const second = await submit(service, { ...baseInput }, 1, key);
  assert.equal(second.duplicate, true);
  assert.equal(second.request.id, first.request.id);
  assert.equal(second.request.attempts, 1);
  assert.equal(second.request.audit.length, first.request.audit.length);
});

test('reusing a key with different data or version is a conflict', async () => {
  const { service } = setup();
  await submit(service, baseInput, 1, 'fixed-key');
  await assert.rejects(submit(service, { ...baseInput, amount: 9000 }, 1, 'fixed-key'), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(submit(service, baseInput, 2, 'fixed-key'), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('dependency failure schedules retry without losing the earlier stage', async () => {
  const { service } = setup();
  const { request } = await submit(service, { ...baseInput, dependencyMode: 'fail-always' });
  assert.equal(request.status, 'RETRY_PENDING');
  assert.equal(request.stageIndex, 1);
  assert.equal(request.attempts, 1);
  assert.ok(request.nextRetryAt > new Date());
  assert.ok(request.audit.some((event) => event.type === 'DEPENDENCY_FAILED' && event.stageId === 'risk-check'));
  assert.equal(request.explanation, 'Retry pending: documents complete, creditScore 720 >= 600, risk-check failed: Risk scoring service is temporarily unavailable (attempt 1 of 5)');
  assert.equal(request.audit.at(-1).summary, request.explanation);
});

test('invalid dependency response is treated as retryable failure', async () => {
  const repository = new MemoryRequestRepository();
  const service = new DecisionService({ repository, workflows, adapters: { 'risk-score': async () => ({ riskScore: 'unknown' }) } });
  const { request } = await submit(service);
  assert.equal(request.status, 'RETRY_PENDING');
  assert.match(request.audit.find((event) => event.type === 'DEPENDENCY_FAILED').message, /invalid response/);
});

test('manual retry resumes the failed stage and reaches a decision', async () => {
  const { service } = setup();
  const first = await submit(service, { ...baseInput, dependencyMode: 'fail-once' });
  assert.equal(first.request.status, 'RETRY_PENDING');
  const retried = await service.retry(first.request.id);
  assert.equal(retried.status, 'APPROVED');
  assert.equal(retried.attempts, 2);
  assert.equal(retried.audit.filter((event) => event.type === 'STAGE_COMPLETED' && event.stageId === 'eligibility').length, 1);
  assert.equal(retried.audit.filter((event) => event.type === 'DEPENDENCY_RESULT').length, 1);
  assert.equal(retried.explanation, 'Approved: documents complete, creditScore 720 >= 600, riskScore 7 <= 70, amount 4000 not above the 10000 review threshold');
});

test('scheduled retry worker resumes due requests', async () => {
  const { repository, service } = setup();
  const first = await submit(service, { ...baseInput, dependencyMode: 'fail-once' });
  repository.requests.get(first.request.id).nextRetryAt = new Date(Date.now() - 1);
  await service.processDue();
  assert.equal((await service.get(first.request.id)).status, 'APPROVED');
});

test('rule version change changes outcomes without rewriting the engine', async () => {
  const { service } = setup();
  const input = { ...baseInput, creditScore: 625 };
  const oldVersion = await submit(service, input, 1);
  const newVersion = await submit(service, input, 2);
  assert.equal(oldVersion.request.status, 'APPROVED');
  assert.equal(newVersion.request.status, 'REJECTED');
  assert.equal(newVersion.request.audit.find((event) => event.ruleId === 'minimum-credit').expected, 650);
  assert.equal(newVersion.request.explanation, 'Rejected: documents complete, creditScore 625 < 650');
  assert.match(oldVersion.request.explanation, /creditScore 625 >= 600/);
  assert.equal(oldVersion.request.workflowVersion, 1);
});

test('conditional vendor rule is skipped or routes to manual review', async () => {
  const { service } = setup();
  const base = { vendorId: 'V-1', contractValue: 20000, taxVerified: true, insuranceVerified: false };
  const small = await service.submit({ workflowId: 'vendor-approval', version: 1, input: base, idempotencyKey: 'vendor-small' });
  assert.equal(small.request.status, 'APPROVED');
  assert.equal(small.request.audit.find((event) => event.ruleId === 'insurance-for-large-contract').result, 'SKIPPED');
  const large = await service.submit({ workflowId: 'vendor-approval', version: 1, input: { ...base, contractValue: 60000 }, idempotencyKey: 'vendor-large' });
  assert.equal(large.request.status, 'MANUAL_REVIEW');
  assert.match(large.request.explanation, /insurance not verified/);
});

test('failed stage save can be recovered after its lease expires', async () => {
  const { repository, service } = setup();
  repository.failNextSave = true;
  await assert.rejects(submit(service), /Simulated persistence failure/);
  const [stuck] = await repository.list();
  assert.equal(stuck.status, 'PROCESSING');
  assert.equal(stuck.stageIndex, 0);
  assert.equal(stuck.audit.some((event) => event.type === 'STAGE_COMPLETED'), false);
  repository.requests.get(stuck.id).leaseUntil = new Date(Date.now() - 1);
  await service.processDue();
  const recovered = await service.get(stuck.id);
  assert.equal(recovered.status, 'APPROVED');
  assert.equal(recovered.attempts, 2);
  assert.equal(recovered.audit.filter((event) => event.type === 'DECISION_RECORDED').length, 1);
});

test('persistent dependency failure escalates after configured attempts', async () => {
  const { service } = setup();
  let request = (await submit(service, { ...baseInput, dependencyMode: 'fail-always' })).request;
  for (let attempt = 2; attempt <= 5; attempt++) request = await service.retry(request.id);
  assert.equal(request.status, 'MANUAL_REVIEW');
  assert.equal(request.attempts, 5);
  assert.equal(request.nextRetryAt, null);
  assert.match(request.explanation, /risk-check failed: .*attempt 5 of 5/);
  assert.equal(request.audit.at(-1).summary, request.explanation);
});

test('manual review resolution is an audited, one-time transition', async () => {
  const { service } = setup();
  const pending = await submit(service, { ...baseInput, amount: 11000 });
  assert.equal(pending.request.status, 'MANUAL_REVIEW');
  assert.match(pending.request.explanation, /amount 11000 above the 10000 review threshold/);
  assert.equal(pending.request.audit.find((event) => event.ruleId === 'high-value-review').result, 'MATCHED');
  const resolved = await service.resolveReview(pending.request.id, { decision: 'APPROVED', operator: 'case-worker', note: 'Documents checked' });
  assert.equal(resolved.status, 'APPROVED');
  assert.match(resolved.explanation, /^Approved after manual review: .*reviewed by case-worker: Documents checked$/);
  assert.equal(resolved.audit.at(-1).summary, resolved.explanation);
  assert.deepEqual({ operator: resolved.audit.at(-1).operator, note: resolved.audit.at(-1).note },
    { operator: 'case-worker', note: 'Documents checked' });
  await assert.rejects(service.resolveReview(pending.request.id, { decision: 'REJECTED', operator: 'case-worker', note: 'Second decision' }),
    { code: 'NOT_IN_REVIEW' });
});
