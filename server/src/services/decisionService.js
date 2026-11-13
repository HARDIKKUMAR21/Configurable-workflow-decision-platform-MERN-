import { createHash, randomUUID } from 'node:crypto';
import { AppError, DependencyError } from '../domain/errors.js';
import { executeStage } from '../domain/engine.js';
import { buildDecisionExplanation } from '../domain/explanation.js';
import { getWorkflow } from '../domain/workflows.js';
import { validateInput } from '../domain/validation.js';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function inputHash(workflowId, version, input) {
  return createHash('sha256').update(JSON.stringify(canonical({ workflowId, version, input }))).digest('hex');
}

function publicRequest(request) {
  if (!request) return null;
  const { _id, payloadHash, leaseOwner, leaseUntil, ...rest } = request;
  return rest;
}

export class DecisionService {
  constructor({ repository, workflows, adapters }) {
    this.repository = repository;
    this.workflows = workflows;
    this.adapters = adapters;
  }

  async submit({ workflowId, version, input, idempotencyKey }) {
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 200) {
      throw new AppError('Idempotency-Key header is required (1–200 characters)', 400, 'INVALID_IDEMPOTENCY_KEY');
    }
    if (typeof workflowId !== 'string' || !Number.isInteger(version)) {
      throw new AppError('workflowId and integer version are required', 400, 'INVALID_REQUEST');
    }
    const workflow = getWorkflow(this.workflows, workflowId, version);
    validateInput(workflow.input, input);
    const now = new Date();
    const request = {
      _id: randomUUID(), id: null, workflowId, workflowVersion: version, idempotencyKey,
      payloadHash: inputHash(workflowId, version, input), input, context: {},
      status: 'RECEIVED', stageIndex: 0, attempts: 0, version: 0,
      explanation: null,
      nextRetryAt: null, leaseOwner: null, leaseUntil: null,
      createdAt: now, updatedAt: now,
      audit: [{ at: now, type: 'REQUEST_ACCEPTED', workflow: `${workflowId}@${version}`, inputSnapshot: input }]
    };
    request.id = request._id;
    const result = await this.repository.create(request);
    if (!result.created) {
      if (result.request.payloadHash !== request.payloadHash) {
        throw new AppError('Idempotency key was already used with different input or version', 409, 'IDEMPOTENCY_CONFLICT');
      }
      return { request: publicRequest(result.request), duplicate: true };
    }
    const processed = await this.process(request.id);
    return { request: processed, duplicate: false };
  }

  async get(id) {
    const request = await this.repository.get(id);
    if (!request) throw new AppError('Request not found', 404, 'REQUEST_NOT_FOUND');
    return publicRequest(request);
  }

  async list() { return (await this.repository.list()).map(publicRequest); }

  async retry(id) {
    const request = await this.repository.get(id);
    if (!request) throw new AppError('Request not found', 404, 'REQUEST_NOT_FOUND');
    if (request.status !== 'RETRY_PENDING') throw new AppError('Only pending requests can be retried', 409, 'NOT_RETRYABLE');
    return this.process(id, { force: true });
  }

  async resolveReview(id, { decision, operator, note }) {
    if (!['APPROVED', 'REJECTED'].includes(decision) || typeof operator !== 'string' || !operator.trim() ||
      typeof note !== 'string' || !note.trim()) {
      throw new AppError('decision (APPROVED or REJECTED), operator, and note are required', 400, 'INVALID_REVIEW');
    }
    const current = await this.repository.get(id);
    if (!current) throw new AppError('Request not found', 404, 'REQUEST_NOT_FOUND');
    const cleanOperator = operator.trim();
    const cleanNote = note.trim();
    const explanation = buildDecisionExplanation({ outcome: decision, audit: current.audit,
      review: { operator: cleanOperator, note: cleanNote }, previousExplanation: current.explanation });
    const saved = await this.repository.resolveReview(id, decision, cleanOperator, cleanNote, explanation);
    if (!saved) throw new AppError('Request is no longer awaiting review', 409, 'NOT_IN_REVIEW');
    return publicRequest(saved);
  }

  async process(id, { force = false } = {}) {
    let current = await this.repository.claim(id, { force });
    if (!current) return this.get(id);
    const workflow = getWorkflow(this.workflows, current.workflowId, current.workflowVersion);
    while (current.stageIndex < workflow.stages.length) {
      const stage = workflow.stages[current.stageIndex];
      const at = new Date();
      let result;
      try {
        result = await executeStage(stage, current, this.adapters);
      } catch (error) {
        if (!(error instanceof DependencyError)) throw error;
        const maxAttempts = workflow.retryPolicy?.maxAttempts || 5;
        const exhausted = current.attempts >= maxAttempts;
        const outcome = exhausted ? 'MANUAL_REVIEW' : 'RETRY_PENDING';
        const backoffMs = Math.min(60000, (workflow.retryPolicy?.initialDelayMs || 1000) * 2 ** Math.min(current.attempts - 1, 6));
        const events = [{ at, type: 'DEPENDENCY_FAILED', stageId: stage.id, message: error.message, operationKey: `${current.id}:${stage.id}` }];
        const explanation = buildDecisionExplanation({ outcome, audit: current.audit, events,
          failure: { stageId: stage.id, message: error.message }, attempt: current.attempts, maxAttempts });
        if (!exhausted) events.push({ at, type: 'RETRY_SCHEDULED', delayMs: backoffMs, attempt: current.attempts });
        events.push({ at, type: 'DECISION_RECORDED', outcome, reason: explanation, summary: explanation });
        const saved = await this.repository.saveStep(current, {
          set: { status: outcome, explanation, nextRetryAt: exhausted ? null : new Date(Date.now() + backoffMs), leaseOwner: null, leaseUntil: null },
          events
        });
        if (!saved) throw new AppError('Concurrent state change; retry the request', 409, 'CONCURRENT_UPDATE');
        return publicRequest(saved);
      }
      const events = result.trace.map((entry) => ({ at, type: entry.adapter ? 'DEPENDENCY_RESULT' : 'RULE_EVALUATED', stageId: stage.id, ...entry }));
      events.push({ at, type: 'STAGE_COMPLETED', stageId: stage.id, outcome: result.outcome || 'CONTINUE' });
      const nextIndex = current.stageIndex + 1;
      const outcome = result.outcome || (nextIndex === workflow.stages.length ? workflow.defaultOutcome : null);
      const explanation = outcome ? buildDecisionExplanation({ outcome, audit: current.audit, events }) : null;
      if (outcome) events.push({ at, type: 'DECISION_RECORDED', outcome, reason: explanation, summary: explanation });
      const saved = await this.repository.saveStep(current, {
        set: {
          stageIndex: nextIndex,
          context: { ...current.context, ...result.contextPatch },
          status: outcome || 'PROCESSING',
          explanation: outcome ? explanation : current.explanation,
          leaseOwner: outcome ? null : current.leaseOwner,
          leaseUntil: outcome ? null : new Date(Date.now() + 30000),
          nextRetryAt: null
        },
        events
      });
      if (!saved) throw new AppError('Concurrent state change; retry the request', 409, 'CONCURRENT_UPDATE');
      current = saved;
      if (outcome) return publicRequest(current);
    }
    throw new Error('Workflow exhausted without a decision');
  }

  async processDue() {
    for (const id of await this.repository.findDue()) {
      try { await this.process(id); }
      catch (error) { console.error('Background processing failed', id, error); }
    }
  }
}
