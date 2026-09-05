import { loadConfig } from './config/index.js';
import { PulseServer } from './core/PulseServer.js';
import { logger } from './utils/logger.js';

export * from './types/index.js';
export * from './config/index.js';
export * from './utils/logger.js';
export * from './utils/uuidv7.js';
export * from './core/Connection.js';
export * from './core/ConnectionManager.js';
export * from './core/RoomManager.js';
export * from './core/MessageDispatcher.js';
export * from './core/HeartbeatManager.js';
export * from './core/IdempotencyManager.js';
export * from './events/EventValidator.js';
export * from './auth/Authenticator.js';
export * from './core/PulseServer.js';
export * from './client/PulseClientSession.js';
export * from './redis/types.js';
export * from './redis/RedisConnectionManager.js';
export * from './redis/RedisPubSubManager.js';
export * from './redis/ChannelRegistry.js';
export { CHANNEL_PRESENCE_EVENTS } from './redis/ChannelRegistry.js';
export * from './redis/PresenceLuaScripts.js';
export * from './redis/PresenceEventTracker.js';
export * from './redis/PresenceManager.js';
export * from './redis/RedisMetrics.js';
export * from './metrics/types.js';
export * from './metrics/Counter.js';
export * from './metrics/Gauge.js';
export * from './metrics/Histogram.js';
export * from './metrics/PulseMetricsRegistry.js';
export * from './metrics/PrometheusSerializer.js';
export * from './metrics/EventLoopMonitor.js';
export * from './metrics/telemetry.js';
export * from './bench/types.js';
export * from './bench/StatsAggregator.js';
export * from './bench/BenchmarkRunner.js';
export * from './bench/profiles/RampProfile.js';
export * from './bench/profiles/BroadcastProfile.js';
export * from './bench/profiles/DirectProfile.js';
export * from './bench/profiles/DistributedTwoNodeProfile.js';
export * from './bench/profiles/BackpressureProfile.js';
export * from './bench/profiles/PresenceChurnProfile.js';

async function bootstrap() {
  const config = loadConfig();
  const server = new PulseServer(config);

  const handleSignal = async (signal: string) => {
    logger.info(`Received ${signal}, initiating graceful shutdown...`);
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));

  try {
    await server.start();
  } catch (err) {
    logger.error('Fatal error during Pulse server bootstrap', {
      error: err instanceof Error ? err.message : String(err)
    });
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  bootstrap();
}
