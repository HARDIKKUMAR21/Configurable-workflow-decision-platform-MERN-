import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AppError } from '../domain/errors.js';
import { getWorkflow, listWorkflows } from '../domain/workflows.js';

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

export function createApp({ service, workflows }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/workflows', (_req, res) => res.json(listWorkflows(workflows)));
  app.get('/api/workflows/:id/:version', (req, res, next) => {
    try { res.json(getWorkflow(workflows, req.params.id, Number(req.params.version))); }
    catch (error) { next(error); }
  });
  app.get('/api/requests', asyncRoute(async (_req, res) => res.json(await service.list())));
  app.post('/api/requests', asyncRoute(async (req, res) => {
    const result = await service.submit({ ...req.body, idempotencyKey: req.header('Idempotency-Key') });
    res.status(result.duplicate ? 200 : 201).json(result);
  }));
  app.get('/api/requests/:id', asyncRoute(async (req, res) => res.json(await service.get(req.params.id))));
  app.post('/api/requests/:id/retry', asyncRoute(async (req, res) => res.json(await service.retry(req.params.id))));
  app.post('/api/requests/:id/review', asyncRoute(async (req, res) => res.json(await service.resolveReview(req.params.id, req.body || {}))));
  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'API route not found' } }));

  const builtClient = fileURLToPath(new URL('../../../client/dist/', import.meta.url));
  if (existsSync(builtClient)) {
    app.use(express.static(builtClient));
    app.get('*', (_req, res) => res.sendFile(fileURLToPath(new URL('../../../client/dist/index.html', import.meta.url))));
  }

  app.use((error, _req, res, _next) => {
    if (error instanceof SyntaxError && 'body' in error) {
      return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Malformed JSON body' } });
    }
    if (!(error instanceof AppError)) console.error(error);
    const status = error instanceof AppError ? error.status : 500;
    res.status(status).json({ error: {
      code: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
      message: error instanceof AppError ? error.message : 'Unexpected server error',
      ...(error instanceof AppError && error.details ? { details: error.details } : {})
    } });
  });
  return app;
}
