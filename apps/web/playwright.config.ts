import { defineConfig, devices } from '@playwright/test';
import { DATABASE_URL } from './e2e/env';

/**
 * End-to-end tests: the real web app, API and databases, with fake payments (no Razorpay).
 * They run on their own ports (web 3100, API 4100), so they can run while `make dev-*` is up.
 * Postgres and Redis must be running, migrated and seeded (`make up migrate seed`).
 *
 * With E2E_BASE_URL set, they start nothing and test that address instead: `make stack-e2e`
 * points them at nginx in front of the containerised stack.
 */
const WEB_PORT = 3100;
const API_PORT = 4100;
const API_URL = `http://localhost:${API_PORT}`;
const EXTERNAL_URL = process.env.E2E_BASE_URL;
const WEB_URL = EXTERNAL_URL ?? `http://localhost:${WEB_PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // One worker: the tests share one seeded catalog and pick free seats as they go.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: EXTERNAL_URL
    ? []
    : [
        {
          // From the repo root, like `make dev-api`, but with settings of its own.
          command: 'npm run start -w @bmt/api',
          cwd: '../..',
          url: `${API_URL}/readyz`,
          timeout: 60_000,
          reuseExistingServer: false,
          env: {
            PORT: String(API_PORT),
            DATABASE_URL,
            REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
            BETTER_AUTH_SECRET: 'e2e-only-secret-that-is-at-least-32-characters',
            BETTER_AUTH_URL: API_URL,
            WEB_ORIGINS: WEB_URL,
            PAYMENT_GATEWAY: 'fake',
            // Every test signs a new user up; the sign-up limit (5 a minute per IP) would stop them.
            RATE_LIMIT_ENABLED: 'false',
            LOG_LEVEL: 'warn',
          },
        },
        {
          command: `npx next build && npx next start --port ${WEB_PORT}`,
          url: WEB_URL,
          timeout: 180_000,
          reuseExistingServer: false,
          env: {
            API_URL,
            NEXT_DIST_DIR: '.next-e2e',
            NEXT_TELEMETRY_DISABLED: '1',
          },
        },
      ],
});
