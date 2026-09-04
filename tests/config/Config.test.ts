import { loadConfig } from '../../src/config/index.js';

describe('Config Loader & Redis Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PORT;
    delete process.env.REDIS_ENABLED;
    delete process.env.REDIS_URL;
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;
    delete process.env.REDIS_PASSWORD;
    delete process.env.REDIS_RETRY_MAX_ATTEMPTS;
    delete process.env.REDIS_RETRY_INITIAL_DELAY_MS;
    delete process.env.REDIS_RETRY_MAX_DELAY_MS;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('preserves isolated single-node operation by default when Redis is not configured', () => {
    const config = loadConfig();
    expect(config.redisEnabled).toBe(false);
    expect(config.redisHost).toBe('127.0.0.1');
    expect(config.redisPort).toBe(6379);
  });

  test('enables Redis when REDIS_ENABLED is set to true', () => {
    process.env.REDIS_ENABLED = 'true';
    const config = loadConfig();
    expect(config.redisEnabled).toBe(true);
    expect(config.redisHost).toBe('127.0.0.1');
    expect(config.redisPort).toBe(6379);
    expect(config.redisRetryMaxAttempts).toBe(10);
  });

  test('automatically enables Redis when REDIS_URL is provided', () => {
    process.env.REDIS_URL = 'redis://custom-host:6380';
    const config = loadConfig();
    expect(config.redisEnabled).toBe(true);
    expect(config.redisUrl).toBe('redis://custom-host:6380');
  });

  test('honors REDIS_ENABLED=false even if REDIS_URL is present', () => {
    process.env.REDIS_ENABLED = 'false';
    process.env.REDIS_URL = 'redis://custom-host:6380';
    const config = loadConfig();
    expect(config.redisEnabled).toBe(false);
  });

  test('allows programmatic overrides to take precedence', () => {
    const config = loadConfig({
      redisEnabled: true,
      redisHost: '10.0.0.5',
      redisPort: 6388,
      redisRetryMaxAttempts: 5,
      redisRetryInitialDelayMs: 200,
      redisRetryMaxDelayMs: 5000
    });

    expect(config.redisEnabled).toBe(true);
    expect(config.redisHost).toBe('10.0.0.5');
    expect(config.redisPort).toBe(6388);
    expect(config.redisRetryMaxAttempts).toBe(5);
    expect(config.redisRetryInitialDelayMs).toBe(200);
    expect(config.redisRetryMaxDelayMs).toBe(5000);
  });

  test('throws on invalid REDIS_PORT when redisEnabled is true', () => {
    expect(() =>
      loadConfig({
        redisEnabled: true,
        redisPort: 70000
      })
    ).toThrow('Invalid REDIS_PORT configuration');

    expect(() =>
      loadConfig({
        redisEnabled: true,
        redisPort: -1
      })
    ).toThrow('Invalid REDIS_PORT configuration');
  });

  test('throws on invalid retry configuration when redisEnabled is true', () => {
    expect(() =>
      loadConfig({
        redisEnabled: true,
        redisRetryMaxAttempts: 0
      })
    ).toThrow('Invalid REDIS_RETRY_MAX_ATTEMPTS configuration');

    expect(() =>
      loadConfig({
        redisEnabled: true,
        redisRetryInitialDelayMs: -10
      })
    ).toThrow('Invalid REDIS_RETRY_INITIAL_DELAY_MS configuration');

    expect(() =>
      loadConfig({
        redisEnabled: true,
        redisRetryInitialDelayMs: 1000,
        redisRetryMaxDelayMs: 500
      })
    ).toThrow('Invalid REDIS_RETRY_MAX_DELAY_MS configuration (500) must be >= initial delay (1000)');
  });

  test('loads presence configuration with safe defaults and validates ranges', () => {
    const defaultConfig = loadConfig();
    expect(defaultConfig.presenceTtlMs).toBe(60000);
    expect(defaultConfig.presenceFlushIntervalMs).toBe(15000);

    process.env.PRESENCE_TTL_MS = '90000';
    process.env.PRESENCE_FLUSH_INTERVAL_MS = '20000';
    const customConfig = loadConfig();
    expect(customConfig.presenceTtlMs).toBe(90000);
    expect(customConfig.presenceFlushIntervalMs).toBe(20000);

    delete process.env.PRESENCE_TTL_MS;
    delete process.env.PRESENCE_FLUSH_INTERVAL_MS;

    expect(() =>
      loadConfig({
        presenceTtlMs: 500
      })
    ).toThrow('Invalid PRESENCE_TTL_MS configuration: 500');

    expect(() =>
      loadConfig({
        presenceTtlMs: 60000,
        presenceFlushIntervalMs: 70000
      })
    ).toThrow('Invalid PRESENCE_FLUSH_INTERVAL_MS configuration');
  });
});
