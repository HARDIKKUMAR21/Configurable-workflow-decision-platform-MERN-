import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/http/app.js';
import { loadWorkflows } from '../src/domain/workflows.js';
import { MemoryRequestRepository } from '../src/repositories/memoryRequestRepository.js';
import { DecisionService } from '../src/services/decisionService.js';

test('REST interface exposes configuration, validation, idempotency, and decision trace', async () => {
  const workflows = loadWorkflows();
  const service = new DecisionService({ repository: new MemoryRequestRepository(), workflows });
  const server = createApp({ service, workflows }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const definitions = await (await fetch(`${base}/api/workflows`)).json();
    assert.equal(definitions.length, 3);
    const payload = { workflowId: 'application-approval', version: 1,
      input: { applicantId: 'A-1', amount: 4000, creditScore: 720, documentsComplete: true } };
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-test' }, body: JSON.stringify(payload) };
    const created = await fetch(`${base}/api/requests`, options);
    assert.equal(created.status, 201);
    const first = await created.json();
    assert.equal(first.request.status, 'APPROVED');
    assert.match(first.request.explanation, /creditScore 720 >= 600/);
    assert.ok(first.request.audit.some((event) => event.type === 'RULE_EVALUATED'));
    const duplicate = await fetch(`${base}/api/requests`, options);
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).duplicate, true);
    const invalid = await fetch(`${base}/api/requests`, { ...options, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'invalid' }, body: JSON.stringify({ ...payload, input: { ...payload.input, amount: -1 } }) });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'INVALID_INPUT');
    const detail = await (await fetch(`${base}/api/requests/${first.request.id}`)).json();
    assert.equal(detail.id, first.request.id);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
