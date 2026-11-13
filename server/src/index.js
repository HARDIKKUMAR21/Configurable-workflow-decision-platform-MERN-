import { MongoClient } from 'mongodb';
import { createApp } from './http/app.js';
import { loadWorkflows } from './domain/workflows.js';
import { MongoRequestRepository } from './repositories/mongoRequestRepository.js';
import { MemoryRequestRepository } from './repositories/memoryRequestRepository.js';
import { DecisionService } from './services/decisionService.js';

const port = Number(process.env.PORT || 3001);
const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017';
const dbName = process.env.MONGO_DB || 'decision_platform';
const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });

try {
  const memoryMode = process.env.DATA_STORE === 'memory';
  if (!memoryMode) await client.connect();
  const repository = memoryMode ? new MemoryRequestRepository() : new MongoRequestRepository(client.db(dbName));
  await repository.initialize();
  const workflows = loadWorkflows();
  const service = new DecisionService({ repository, workflows });
  const app = createApp({ service, workflows });
  const server = app.listen(port, () => console.log(`Decision API listening on http://localhost:${port}${memoryMode ? ' (nonpersistent demo mode)' : ''}`));
  const worker = setInterval(() => service.processDue(), 1000);
  worker.unref();
  const shutdown = async () => {
    clearInterval(worker);
    server.close();
    if (!memoryMode) await client.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (error) {
  console.error('Startup failed:', error.message);
  await client.close();
  process.exitCode = 1;
}
