import { redisStorage } from '@better-auth/redis-storage';
import type { Logger, Pool, Redis } from '@bmt/platform';
import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins';

export interface AuthConfig {
  /** Signs cookies and tokens. At least 32 random characters. */
  secret: string;
  /** Public URL of this API, e.g. http://localhost:4000 */
  baseURL: string;
  /** Browser origins allowed to call the auth endpoints (the web app). */
  trustedOrigins: string[];
}

export interface AuthDeps {
  pool: Pool;
  redis: Redis;
  logger: Logger;
  config: AuthConfig;
}

const DAY_SECONDS = 60 * 60 * 24;

/**
 * Better Auth handles passwords, sessions and roles (ADR 0004). Everything here
 * maps its schema onto ours: plural tables, snake_case columns, uuid ids. Keep
 * this mapping and db/migrations/0002_identity.sql in sync; the "auth schema"
 * integration test fails if they drift.
 */
export function createAuth({ pool, redis, logger, config }: AuthDeps) {
  const authLogger = logger.child({ module: 'better-auth' });

  return betterAuth({
    appName: 'BookMyTicket',
    secret: config.secret,
    baseURL: config.baseURL,
    basePath: '/api/auth',
    trustedOrigins: config.trustedOrigins,
    telemetry: { enabled: false },
    // Route Better Auth's own logs into pino: JSON in production, silent in tests.
    logger: {
      log: (level, message, ...args) => {
        const context = args.length > 0 ? { details: args } : {};
        if (level === 'error') authLogger.error(context, message);
        else if (level === 'warn') authLogger.warn(context, message);
        else if (level === 'debug') authLogger.debug(context, message);
        else authLogger.info(context, message);
      },
    },

    database: pool,
    // Sessions and verification tokens are read from Redis first, so every API
    // replica shares one session store without a Postgres query per request.
    secondaryStorage: redisStorage({ client: redis, keyPrefix: 'bmt:auth:' }),

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      // Email verification arrives with the email worker in M4.
      requireEmailVerification: false,
    },

    session: {
      modelName: 'sessions',
      fields: {
        userId: 'user_id',
        expiresAt: 'expires_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
      expiresIn: 7 * DAY_SECONDS,
      // Extend the expiry at most once a day of activity.
      updateAge: DAY_SECONDS,
      // Write sessions to Postgres as well as Redis, so a Redis flush does not
      // log everyone out. Reads still hit Redis first.
      storeSessionInDatabase: true,
    },

    user: {
      modelName: 'users',
      fields: {
        emailVerified: 'email_verified',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },

    account: {
      modelName: 'accounts',
      fields: {
        userId: 'user_id',
        accountId: 'account_id',
        providerId: 'provider_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },

    // Counters live in Redis, so the limit holds across replicas. Better Auth
    // only enforces it when NODE_ENV=production. Our own limiter replaces it in M5.
    rateLimit: { storage: 'secondary-storage' },

    advanced: {
      cookiePrefix: 'bmt',
      database: { generateId: 'uuid' },
    },

    plugins: [
      admin({
        schema: {
          user: { fields: { banReason: 'ban_reason', banExpires: 'ban_expires' } },
          session: { fields: { impersonatedBy: 'impersonated_by' } },
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
/** What getSession returns for a signed-in request: { session, user }. */
export type AuthSession = Auth['$Infer']['Session'];
