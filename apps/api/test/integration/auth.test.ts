import { randomUUID } from 'node:crypto';
import { toNodeHandler } from 'better-auth/node';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { errorHandler } from '../../src/middleware/error-handler';
import { requestLogger } from '../../src/middleware/request-logger';
import { ensureAdmin } from '../../src/modules/auth/ensure-admin';
import { requireAuth, requireRole } from '../../src/modules/auth/middleware';
import { WEB_ORIGIN, createTestDeps } from './helpers';

const PASSWORD = 'correct-horse-battery-staple';

function newUser() {
  return { name: 'Test User', email: `user-${randomUUID()}@example.com`, password: PASSWORD };
}

/** Turns Set-Cookie response headers into a Cookie request header. */
function cookieHeader(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (raw ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

describe('auth', () => {
  let deps: ReturnType<typeof createTestDeps>;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    deps = createTestDeps();
    app = createApp(deps);
  });
  afterAll(async () => {
    await deps.close();
  });

  describe('sign-up and the current user', () => {
    it('signs up, signs in automatically, and /me returns the user', async () => {
      const agent = request.agent(app);
      const user = newUser();

      const signUp = await agent
        .post('/api/auth/sign-up/email')
        .set('origin', WEB_ORIGIN)
        .send(user);
      expect(signUp.status).toBe(200);

      const me = await agent.get('/api/v1/me');
      expect(me.status).toBe(200);
      expect(me.body.user).toMatchObject({ email: user.email, name: user.name, role: 'user' });
    });

    it('rejects /me without a session using the standard error body', async () => {
      const res = await request(app).get('/api/v1/me');
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({ code: 'UNAUTHENTICATED' });
    });

    it('allows one account per email regardless of case', async () => {
      const user = newUser();
      await request(app).post('/api/auth/sign-up/email').set('origin', WEB_ORIGIN).send(user);

      const again = await request(app)
        .post('/api/auth/sign-up/email')
        .set('origin', WEB_ORIGIN)
        .send({ ...user, email: user.email.toUpperCase() });

      expect(again.status).not.toBe(200);
      const { rows } = await deps.pool.query(
        'SELECT id FROM users WHERE lower(email) = lower($1)',
        [user.email],
      );
      expect(rows).toHaveLength(1);
    });

    it('stores the password as a hash, never in plain text', async () => {
      const user = newUser();
      await request(app).post('/api/auth/sign-up/email').set('origin', WEB_ORIGIN).send(user);

      const { rows } = await deps.pool.query<{ password: string }>(
        `SELECT a.password FROM accounts a JOIN users u ON u.id = a.user_id
         WHERE u.email = $1 AND a.provider_id = 'credential'`,
        [user.email],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.password).not.toContain(PASSWORD);
    });
  });

  describe('sign-in and sign-out', () => {
    it('rejects a wrong password', async () => {
      const user = newUser();
      await request(app).post('/api/auth/sign-up/email').set('origin', WEB_ORIGIN).send(user);

      const res = await request(app)
        .post('/api/auth/sign-in/email')
        .set('origin', WEB_ORIGIN)
        .send({ email: user.email, password: 'wrong-password-123' });

      expect(res.status).toBe(401);
      expect(cookieHeader(res)).not.toContain('session_token');
    });

    it('signs in with the right password', async () => {
      const user = newUser();
      await request(app).post('/api/auth/sign-up/email').set('origin', WEB_ORIGIN).send(user);

      const agent = request.agent(app);
      const res = await agent
        .post('/api/auth/sign-in/email')
        .set('origin', WEB_ORIGIN)
        .send({ email: user.email, password: PASSWORD });
      expect(res.status).toBe(200);

      expect((await agent.get('/api/v1/me')).status).toBe(200);
    });

    it('ends the session on sign-out', async () => {
      const agent = request.agent(app);
      await agent.post('/api/auth/sign-up/email').set('origin', WEB_ORIGIN).send(newUser());
      expect((await agent.get('/api/v1/me')).status).toBe(200);

      const signOut = await agent.post('/api/auth/sign-out').set('origin', WEB_ORIGIN).send({});
      expect(signOut.status).toBe(200);

      expect((await agent.get('/api/v1/me')).status).toBe(401);
    });
  });

  describe('sessions across replicas', () => {
    it('writes the session to Redis and to Postgres', async () => {
      const user = newUser();
      await request(app).post('/api/auth/sign-up/email').set('origin', WEB_ORIGIN).send(user);

      const { rows } = await deps.pool.query(
        'SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1',
        [user.email],
      );
      expect(rows).toHaveLength(1);
      expect(await deps.redis.keys('bmt:auth:*')).not.toHaveLength(0);
    });

    it('accepts a session created on another replica', async () => {
      // Two independent sets of clients = two API processes sharing Postgres and Redis.
      const other = createTestDeps();
      try {
        const replicaA = app;
        const replicaB = createApp(other);

        const signUp = await request(replicaA)
          .post('/api/auth/sign-up/email')
          .set('origin', WEB_ORIGIN)
          .send(newUser());

        const me = await request(replicaB).get('/api/v1/me').set('cookie', cookieHeader(signUp));
        expect(me.status).toBe(200);
      } finally {
        await other.close();
      }
    });
  });

  describe('roles', () => {
    // A minimal app with one admin-only route, wired the way feature modules will be.
    function appWithAdminRoute() {
      const adminApp = express();
      adminApp.use(requestLogger(deps.logger));
      adminApp.all('/api/auth/*splat', toNodeHandler(deps.auth));
      adminApp.get('/admin-only', requireAuth(deps.auth), requireRole('admin'), (_req, res) => {
        res.json({ ok: true });
      });
      adminApp.use(errorHandler);
      return adminApp;
    }

    it('returns 401 without a session and 403 for a normal user', async () => {
      const adminApp = appWithAdminRoute();
      expect((await request(adminApp).get('/admin-only')).status).toBe(401);

      const agent = request.agent(adminApp);
      await agent.post('/api/auth/sign-up/email').set('origin', WEB_ORIGIN).send(newUser());
      const res = await agent.get('/admin-only');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('lets the account created by ensureAdmin through', async () => {
      const admin = { ...newUser(), name: 'Admin' };
      await ensureAdmin(deps.auth, deps.pool, admin);

      const adminApp = appWithAdminRoute();
      const agent = request.agent(adminApp);
      await agent
        .post('/api/auth/sign-in/email')
        .set('origin', WEB_ORIGIN)
        .send({ email: admin.email, password: admin.password });

      expect((await agent.get('/admin-only')).status).toBe(200);
    });

    it('ensureAdmin is safe to run twice', async () => {
      const admin = { ...newUser(), name: 'Admin' };

      const first = await ensureAdmin(deps.auth, deps.pool, admin);
      const second = await ensureAdmin(deps.auth, deps.pool, admin);

      expect(first.created).toBe(true);
      expect(second).toEqual({ userId: first.userId, created: false });
      const { rows } = await deps.pool.query<{ role: string }>(
        'SELECT role FROM users WHERE email = $1',
        [admin.email],
      );
      expect(rows).toEqual([{ role: 'admin' }]);
    });

    it('promotes an existing normal user', async () => {
      const user = newUser();
      await request(app).post('/api/auth/sign-up/email').set('origin', WEB_ORIGIN).send(user);

      const result = await ensureAdmin(deps.auth, deps.pool, user);

      expect(result.created).toBe(false);
      const { rows } = await deps.pool.query<{ role: string }>(
        'SELECT role FROM users WHERE email = $1',
        [user.email],
      );
      expect(rows).toEqual([{ role: 'admin' }]);
    });
  });
});
