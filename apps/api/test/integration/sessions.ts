import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { ensureAdmin } from '../../src/modules/auth/ensure-admin';
import { WEB_ORIGIN, type createTestDeps } from './helpers';

type Deps = ReturnType<typeof createTestDeps>;
export type Agent = ReturnType<typeof request.agent>;

const PASSWORD = 'test-password-123';

/** A cookie-keeping client signed in as a fresh admin. */
export async function signInAsAdmin(app: Express, deps: Deps): Promise<Agent> {
  const email = `admin-${randomUUID()}@example.com`;
  await ensureAdmin(deps.auth, deps.pool, { email, password: PASSWORD, name: 'Admin' });

  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/sign-in/email')
    .set('origin', WEB_ORIGIN)
    .send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`admin sign-in failed: ${res.status}`);
  return agent;
}

/** A cookie-keeping client signed in as a fresh normal user. */
export async function signInAsUser(app: Express): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/sign-up/email')
    .set('origin', WEB_ORIGIN)
    .send({ name: 'User', email: `user-${randomUUID()}@example.com`, password: PASSWORD });
  if (res.status !== 200) throw new Error(`user sign-up failed: ${res.status}`);
  return agent;
}
