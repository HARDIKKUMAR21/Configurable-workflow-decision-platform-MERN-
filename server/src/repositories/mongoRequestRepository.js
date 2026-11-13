import { randomUUID } from 'node:crypto';

export class MongoRequestRepository {
  constructor(db) { this.collection = db.collection('decision_requests'); }

  async initialize() {
    await this.collection.createIndex({ workflowId: 1, idempotencyKey: 1 }, { unique: true });
    await this.collection.createIndex({ status: 1, nextRetryAt: 1 });
    await this.collection.createIndex({ status: 1, leaseUntil: 1 });
  }

  async create(request) {
    try {
      await this.collection.insertOne(request);
      return { request, created: true };
    } catch (error) {
      if (error.code !== 11000) throw error;
      const existing = await this.collection.findOne({ workflowId: request.workflowId, idempotencyKey: request.idempotencyKey });
      if (!existing) throw error;
      return { request: existing, created: false };
    }
  }

  async get(id) { return this.collection.findOne({ _id: id }); }

  async list() { return this.collection.find({}, { projection: { audit: 0 } }).sort({ createdAt: -1 }).limit(100).toArray(); }

  async claim(id, { force = false, leaseMs = 30000 } = {}) {
    const now = new Date();
    const eligibility = [
      { status: 'RECEIVED' },
      { status: 'RETRY_PENDING', ...(force ? {} : { nextRetryAt: { $lte: now } }) },
      { status: 'PROCESSING', leaseUntil: { $lte: now } }
    ];
    return this.collection.findOneAndUpdate(
      { _id: id, $or: eligibility },
      {
        $set: { status: 'PROCESSING', leaseOwner: randomUUID(), leaseUntil: new Date(now.getTime() + leaseMs), updatedAt: now },
        $inc: { attempts: 1, version: 1 },
        $push: { audit: { at: now, type: 'PROCESSING_STARTED' } }
      },
      { returnDocument: 'after' }
    );
  }

  async saveStep(previous, change) {
    return this.collection.findOneAndUpdate(
      { _id: previous.id, version: previous.version, leaseOwner: previous.leaseOwner, stageIndex: previous.stageIndex, status: 'PROCESSING' },
      {
        $set: { ...change.set, updatedAt: new Date() },
        $inc: { version: 1 },
        $push: { audit: { $each: change.events } }
      },
      { returnDocument: 'after' }
    );
  }

  async findDue(limit = 20) {
    const now = new Date();
    const rows = await this.collection.find({ $or: [
      { status: 'RECEIVED' },
      { status: 'RETRY_PENDING', nextRetryAt: { $lte: now } },
      { status: 'PROCESSING', leaseUntil: { $lte: now } }
    ] }, { projection: { _id: 1 } }).limit(limit).toArray();
    return rows.map((row) => row._id);
  }

  async resolveReview(id, decision, operator, note, explanation) {
    const at = new Date();
    return this.collection.findOneAndUpdate(
      { _id: id, status: 'MANUAL_REVIEW' },
      { $set: { status: decision, explanation, updatedAt: at }, $inc: { version: 1 },
        $push: { audit: { at, type: 'MANUAL_REVIEW_RESOLVED', outcome: decision, operator, note, summary: explanation, reason: explanation } } },
      { returnDocument: 'after' }
    );
  }
}
