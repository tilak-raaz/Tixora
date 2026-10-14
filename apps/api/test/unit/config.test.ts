import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';

const valid = {
  DATABASE_URL: 'postgres://bmt:bmt@localhost:5432/bmt',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadConfig', () => {
  it('applies defaults for optional variables', () => {
    const config = loadConfig(valid);
    expect(config).toMatchObject({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      PORT: 4000,
      DATABASE_POOL_MAX: 10,
      SHUTDOWN_TIMEOUT_MS: 10_000,
    });
  });

  it('coerces numeric strings', () => {
    const config = loadConfig({ ...valid, PORT: '5050', DATABASE_POOL_MAX: '3' });
    expect(config.PORT).toBe(5050);
    expect(config.DATABASE_POOL_MAX).toBe(3);
  });

  it('lists every missing variable in one error', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*REDIS_URL/);
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadConfig({ ...valid, PORT: '70000' })).toThrow(/PORT/);
  });
});
