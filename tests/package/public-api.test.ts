import * as PublicPackage from '../../src/index.js';
import { PulseServer, loadConfig, Authenticator, OriginMatcher, generateUUIDv7, PulseMetricsRegistry } from '../../src/index.js';

describe('Public Package Surface (@ankit18193/pulse)', () => {
  it('exports only intentional public classes and functions', () => {
    expect(typeof PublicPackage.PulseServer).toBe('function');
    expect(typeof PublicPackage.loadConfig).toBe('function');
    expect(typeof PublicPackage.Authenticator).toBe('function');
    expect(typeof PublicPackage.OriginMatcher).toBe('function');
    expect(typeof PublicPackage.generateUUIDv7).toBe('function');
    expect(typeof PublicPackage.PulseMetricsRegistry).toBe('function');
    expect(typeof PublicPackage.PrometheusSerializer).toBe('function');
  });

  it('strictly hides internal messaging engine and infrastructure classes', () => {
    const pkg = PublicPackage as Record<string, unknown>;

    // Core internals
    expect(pkg['ConnectionManager']).toBeUndefined();
    expect(pkg['MessageDispatcher']).toBeUndefined();
    expect(pkg['RoomManager']).toBeUndefined();
    expect(pkg['HeartbeatManager']).toBeUndefined();
    expect(pkg['IdempotencyManager']).toBeUndefined();
    expect(pkg['Connection']).toBeUndefined();

    // Redis internals & Lua scripts
    expect(pkg['PresenceManager']).toBeUndefined();
    expect(pkg['RedisPubSubManager']).toBeUndefined();
    expect(pkg['RedisConnectionManager']).toBeUndefined();
    expect(pkg['ChannelRegistry']).toBeUndefined();
    expect(pkg['PresenceLuaScripts']).toBeUndefined();
    expect(pkg['LUA_PRESENCE_HEARTBEAT']).toBeUndefined();

    // Security & utils internals
    expect(pkg['TokenBucket']).toBeUndefined();
    expect(pkg['logger']).toBeUndefined();
    expect(pkg['FaultProxy']).toBeUndefined();
  });

  describe('PulseServer Constructor & Configuration Normalization', () => {
    it('instantiates with default options when called with zero arguments', () => {
      const server = new PulseServer();
      const config = server.getConfig();

      expect(config.port).toBeDefined();
      expect(config.host).toBe('0.0.0.0');
      expect(config.maxConnections).toBe(10000);
      expect(config.inboundRateLimitMax).toBe(100);
      expect(server.isServerRunning()).toBe(false);
    });

    it('instantiates cleanly with partial configuration overrides', () => {
      const server = new PulseServer({
        port: 9876,
        heartbeatIntervalMs: 15000,
        maxConnections: 2500
      });

      const config = server.getConfig();
      expect(config.port).toBe(9876);
      expect(config.heartbeatIntervalMs).toBe(15000);
      expect(config.maxConnections).toBe(2500);
      // Defaults preserved for unspecified options
      expect(config.host).toBe('0.0.0.0');
      expect(config.inboundRateLimitMax).toBe(100);
    });

    it('exposes public getters for metrics registry and authenticator', () => {
      const server = new PulseServer({ port: 9877 });
      expect(server.getMetricsRegistry()).toBeInstanceOf(PulseMetricsRegistry);
      expect(server.getAuthenticator()).toBeInstanceOf(Authenticator);
      expect(server.getActiveConnectionCount()).toBe(0);
      expect(server.getActiveRoomCount()).toBe(0);
    });

    it('enforces Phase 10 production hardening rules during instantiation', () => {
      expect(() => {
        new PulseServer({
          nodeEnv: 'production',
          authSecret: 'short-secret'
        });
      }).toThrow('AUTH_SECRET must be at least 32 characters long in production mode.');

      expect(() => {
        new PulseServer({
          port: 99999
        });
      }).toThrow('Invalid PORT configuration: 99999');
    });
  });

  describe('loadConfig API', () => {
    it('returns a fully populated and validated PulseConfig object', () => {
      const config = loadConfig({ port: 8088 });
      expect(config.port).toBe(8088);
      expect(typeof config.authSecret).toBe('string');
      expect(typeof config.maxPayloadBytes).toBe('number');
      expect(typeof config.drainTimeoutMs).toBe('number');
    });
  });

  describe('generateUUIDv7 Utility', () => {
    it('generates chronologically sortable UUIDv7 identifiers', () => {
      const id1 = generateUUIDv7();
      const id2 = generateUUIDv7();
      expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(id2).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(id1 < id2 || id1.localeCompare(id2) <= 0).toBe(true);
    });
  });
});
