import type { Logger, Redis } from '@bmt/platform';
import type { Request, RequestHandler } from 'express';
import { AppError } from './errors';

/**
 * Distributed rate limiting (ADR 0010). Each check is one Lua script, so the
 * read, the decision and the update are atomic in Redis: three API replicas
 * share one budget per key instead of each allowing the full limit. Scripts
 * read the clock with Redis TIME, so replicas whose clocks drift cannot refill
 * a bucket early.
 */

export type RateAlgorithm = 'token-bucket' | 'sliding-window';

export interface RatePolicy {
  /** Part of the Redis key and of logs, e.g. "hold". */
  name: string;
  algorithm: RateAlgorithm;
  /** Requests allowed per window (the bucket's capacity). */
  limit: number;
  windowMs: number;
  /**
   * What happens when Redis cannot answer: "open" lets the request through
   * unlimited, "closed" refuses it with 503.
   */
  failMode: 'open' | 'closed';
}

export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Until a refused request would be allowed. */
  retryAfterMs: number;
  /** Until the budget is full again. */
  resetMs: number;
}

/**
 * Token bucket: holds up to `limit` tokens and refills continuously at
 * limit/window. A request takes one. Allows bursts up to the capacity, then
 * an even rate.
 */
const TOKEN_BUCKET = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local capacity = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local rate = capacity / window
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end
tokens = math.min(capacity, tokens + math.max(0, now - ts) * rate)
local allowed = 0
local retry = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry = math.ceil((1 - tokens) / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], window)
return { allowed, math.floor(tokens), retry, math.ceil((capacity - tokens) / rate) }`;

/**
 * Sliding window log: remembers when each allowed request happened and allows
 * at most `limit` in any `window`. Exact, with no burst at window edges; used
 * where precision matters more than memory (sign-in).
 */
const SLIDING_WINDOW = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])
if count < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[3])
  redis.call('PEXPIRE', KEYS[1], window)
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return { 1, limit - count - 1, 0, tonumber(oldest[2]) + window - now }
end
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local retry = tonumber(oldest[2]) + window - now
return { 0, 0, retry, retry }`;

export class RateLimiterUnavailable extends Error {}

export interface RateLimiter {
  check(policy: RatePolicy, subject: string): Promise<RateDecision>;
}

export function createRateLimiter(
  redis: Redis,
  opts: { prefix?: string; timeoutMs?: number } = {},
): RateLimiter {
  const prefix = opts.prefix ?? 'bmt:rl';
  const timeoutMs = opts.timeoutMs ?? 200;
  let sequence = 0;

  return {
    async check(policy, subject) {
      const key = `${prefix}:${policy.name}:${subject}`;
      const call =
        policy.algorithm === 'token-bucket'
          ? redis.eval(TOKEN_BUCKET, 1, key, policy.limit, policy.windowMs)
          : redis.eval(
              SLIDING_WINDOW,
              1,
              key,
              policy.limit,
              policy.windowMs,
              // A unique member per request, so two in the same millisecond both count.
              `${Date.now()}-${process.pid}-${(sequence += 1)}`,
            );
      let result: unknown;
      try {
        result = await withTimeout(call, timeoutMs);
      } catch (err) {
        throw new RateLimiterUnavailable(`rate limiter unavailable: ${(err as Error).message}`, {
          cause: err,
        });
      }
      const [allowed, remaining, retryAfterMs, resetMs] = (result as number[]).map(Number);
      return {
        allowed: allowed === 1,
        limit: policy.limit,
        remaining: Math.max(0, remaining ?? 0),
        retryAfterMs: Math.max(0, retryAfterMs ?? 0),
        resetMs: Math.max(0, resetMs ?? 0),
      };
    },
  };
}

/** Who a request counts against; undefined skips the limit for that request. */
export type RateSubject = (req: Request) => string | undefined;

export const byIp: RateSubject = (req) => (req.ip ? `ip:${req.ip}` : undefined);
/** Use after requireAuth. */
export const byUser: RateSubject = (req) => (req.auth ? `user:${req.auth.user.id}` : undefined);

/**
 * Express middleware for one route class. Allowed responses carry
 * RateLimit-Limit, RateLimit-Remaining and RateLimit-Reset (seconds); a
 * refusal is 429 RATE_LIMITED with Retry-After.
 */
export function rateLimit(
  limiter: RateLimiter,
  policy: RatePolicy,
  subject: RateSubject,
  logger: Logger,
): RequestHandler {
  return async (req, res, next) => {
    const who = subject(req);
    if (!who) return next();

    let decision: RateDecision;
    try {
      decision = await limiter.check(policy, who);
    } catch (err) {
      logger.warn(
        { err, policy: policy.name, failMode: policy.failMode },
        'rate limiter unavailable',
      );
      if (policy.failMode === 'open') return next();
      res.set('Retry-After', '5');
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Please try again in a few seconds');
    }

    res.set('RateLimit-Limit', String(decision.limit));
    res.set('RateLimit-Remaining', String(decision.remaining));
    res.set('RateLimit-Reset', String(Math.ceil(decision.resetMs / 1000)));
    if (!decision.allowed) {
      const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      res.set('Retry-After', String(seconds));
      throw new AppError(429, 'RATE_LIMITED', `Too many requests; try again in ${seconds} s`, {
        retryAfterSeconds: seconds,
      });
    }
    next();
  };
}

/** The route classes and their budgets. */
export interface RateLimitPolicies {
  auth: RatePolicy;
  hold: RatePolicy;
  paymentOrder: RatePolicy;
  browse: RatePolicy;
}

const MINUTE = 60_000;

export const DEFAULT_RATE_LIMITS: RateLimitPolicies = {
  // Exact, and refused while Redis is down: this is what stops password guessing.
  auth: {
    name: 'auth',
    algorithm: 'sliding-window',
    limit: 5,
    windowMs: MINUTE,
    failMode: 'closed',
  },
  // Holds work without Redis (ADR 0005), and one hold per user per show caps abuse already.
  hold: { name: 'hold', algorithm: 'token-bucket', limit: 10, windowMs: MINUTE, failMode: 'open' },
  paymentOrder: {
    name: 'payment-order',
    algorithm: 'token-bucket',
    limit: 5,
    windowMs: MINUTE,
    failMode: 'open',
  },
  browse: {
    name: 'browse',
    algorithm: 'token-bucket',
    limit: 120,
    windowMs: MINUTE,
    failMode: 'open',
  },
};

/** Middleware per route class; every one is a no-op when limiting is off. */
export interface RouteLimits {
  auth: RequestHandler;
  hold: RequestHandler;
  paymentOrder: RequestHandler;
  browse: RequestHandler;
}

const pass: RequestHandler = (_req, _res, next) => next();
export const NO_LIMITS: RouteLimits = { auth: pass, hold: pass, paymentOrder: pass, browse: pass };

export function routeLimits(
  limiter: RateLimiter,
  policies: RateLimitPolicies,
  logger: Logger,
): RouteLimits {
  return {
    auth: rateLimit(limiter, policies.auth, byIp, logger),
    hold: rateLimit(limiter, policies.hold, byUser, logger),
    paymentOrder: rateLimit(limiter, policies.paymentOrder, byUser, logger),
    browse: rateLimit(limiter, policies.browse, byIp, logger),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
