import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { createTestDeps } from './helpers';

describe('health endpoints against real Postgres and Redis', () => {
  let deps: ReturnType<typeof createTestDeps>;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    deps = createTestDeps();
    app = createApp(deps);
  });

  afterAll(async () => {
    await deps.close();
  });

  it('GET /healthz is ok', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /readyz is ready', async () => {
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready', checks: { postgres: 'ok', redis: 'ok' } });
  });
});
