import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';

const valid = {
  DATABASE_URL: 'postgres://bmt:bmt@localhost:5432/bmt',
  REDIS_URL: 'redis://localhost:6379',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
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
      BETTER_AUTH_URL: 'http://localhost:4000',
      WEB_ORIGINS: ['http://localhost:3000'],
    });
  });

  it('coerces numeric strings', () => {
    const config = loadConfig({ ...valid, PORT: '5050', DATABASE_POOL_MAX: '3' });
    expect(config.PORT).toBe(5050);
    expect(config.DATABASE_POOL_MAX).toBe(3);
  });

  it('splits WEB_ORIGINS on commas and trims spaces', () => {
    const config = loadConfig({
      ...valid,
      WEB_ORIGINS: 'http://localhost:3000, https://bmt.tilakraaz.cloud',
    });
    expect(config.WEB_ORIGINS).toEqual(['http://localhost:3000', 'https://bmt.tilakraaz.cloud']);
  });

  it('lists every missing variable in one error', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*REDIS_URL[\s\S]*BETTER_AUTH_SECRET/);
  });

  it('rejects a short auth secret', () => {
    expect(() => loadConfig({ ...valid, BETTER_AUTH_SECRET: 'too-short' })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });

  it('treats empty Razorpay keys as not set', () => {
    const config = loadConfig({ ...valid, RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '' });
    expect(config.RAZORPAY_KEY_ID).toBeUndefined();
    expect(config.RAZORPAY_KEY_SECRET).toBeUndefined();
  });

  it('accepts a Razorpay key pair and refuses half of one', () => {
    expect(
      loadConfig({ ...valid, RAZORPAY_KEY_ID: 'rzp_test_abc', RAZORPAY_KEY_SECRET: 'shh' })
        .RAZORPAY_KEY_ID,
    ).toBe('rzp_test_abc');
    expect(() => loadConfig({ ...valid, RAZORPAY_KEY_ID: 'rzp_test_abc' })).toThrow(
      /RAZORPAY_KEY_SECRET/,
    );
    expect(() =>
      loadConfig({ ...valid, RAZORPAY_KEY_ID: 'abc', RAZORPAY_KEY_SECRET: 'shh' }),
    ).toThrow(/RAZORPAY_KEY_ID/);
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadConfig({ ...valid, PORT: '70000' })).toThrow(/PORT/);
  });

  it('accepts PAYMENT_GATEWAY=fake in development but never in production', () => {
    expect(loadConfig({ ...valid, PAYMENT_GATEWAY: 'fake' }).PAYMENT_GATEWAY).toBe('fake');
    expect(() => loadConfig({ ...valid, NODE_ENV: 'production', PAYMENT_GATEWAY: 'fake' })).toThrow(
      /PAYMENT_GATEWAY/,
    );
  });
});
