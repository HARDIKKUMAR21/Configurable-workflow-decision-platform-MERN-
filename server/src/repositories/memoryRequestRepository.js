import { randomUUID } from 'node:crypto';

const copy = (value) => value === undefined ? undefined : structuredClone(value);

export class MemoryRequestRepository {
  constructor() {
    this.requests = new Map();
    this.failNextSave = false;
  }

  async initialize() {}

  async create(request) {
    const existing = [...this.requests.values()].find((item) =>
      item.workflowId === request.workflowId && item.idempotencyKey === request.idempotencyKey
    );
    if (existing) return { request: copy(existing), created: false };
    this.requests.set(request.id, copy(request));
    return { request: copy(request), created: true };
  }

  async get(id) { return copy(this.requests.get(id) || null); }

  async list() {
    return [...this.requests.values()].sort((a, b) => b.createdAt - a.createdAt).map(copy);
  }

  async claim(id, { force = false, leaseMs = 30000 } = {}) {
    const request = this.requests.get(id);
    if (!request) return null;
    const now = Date.now();
    const eligible = request.status === 'RECEIVED' ||
      (request.status === 'RETRY_PENDING' && (force || new Date(request.nextRetryAt).getTime() <= now)) ||
      (request.status === 'PROCESSING' && new Date(request.leaseUntil).getTime() <= now);
    if (!eligible) return null;
    request.status = 'PROCESSING';
    request.leaseOwner = randomUUID();
    request.leaseUntil = new Date(now + leaseMs);
    request.attempts += 1;
    request.version += 1;
    request.updatedAt = new Date(now);
    request.audit.push({ at: request.updatedAt, type: 'PROCESSING_STARTED', attempt: request.attempts, stageIndex: request.stageIndex });
    return copy(request);
  }

  async saveStep(previous, change) {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error('Simulated persistence failure');
    }
    const request = this.requests.get(previous.id);
    if (!request || request.version !== previous.version || request.leaseOwner !== previous.leaseOwner ||
      request.stageIndex !== previous.stageIndex || request.status !== 'PROCESSING') return null;
    Object.assign(request, copy(change.set));
    request.version += 1;
    request.updatedAt = new Date().toISOString();
    request.audit.push(...copy(change.events));
    return copy(request);
  }

  async findDue(limit = 20) {
    const now = Date.now();
    return [...this.requests.values()].filter((request) => request.status === 'RECEIVED' ||
      (request.status === 'RETRY_PENDING' && new Date(request.nextRetryAt).getTime() <= now) ||
      (request.status === 'PROCESSING' && new Date(request.leaseUntil).getTime() <= now)
    ).slice(0, limit).map((request) => request.id);
  }

  async resolveReview(id, decision, operator, note, explanation) {
    const request = this.requests.get(id);
    if (!request || request.status !== 'MANUAL_REVIEW') return null;
    const at = new Date();
    request.status = decision;
    request.explanation = explanation;
    request.version += 1;
    request.updatedAt = at;
    request.audit.push({ at, type: 'MANUAL_REVIEW_RESOLVED', outcome: decision, operator, note, summary: explanation, reason: explanation });
    return copy(request);
  }
}
