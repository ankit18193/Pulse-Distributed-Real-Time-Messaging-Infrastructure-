import type { PulseMetricsRegistry } from '../metrics/PulseMetricsRegistry.js';
import { registerRedisMetrics } from '../metrics/telemetry.js';

export interface RedisMetricsSnapshot {
  'redis.publish.count': number;
  'redis.publish.errors': number;
  'redis.publish.latency.avgMs': number;
  'redis.publish.latency.maxMs': number;
  'redis.publish.inFlight': number;
  'redis.inbound.count': number;
  'redis.inbound.latency.avgMs': number;
  'redis.inbound.latency.maxMs': number;
  'redis.echoes.suppressed': number;
  'redis.duplicates.suppressed': number;
  'redis.channels.active': number;
  'redis.connection.state': string;
  'presence.users.online': number;
  'presence.connections.active': number;
  'presence.events.published': number;
  'presence.events.received': number;
  'presence.prune.latency.ms': number;
  'presence.lease.renewals': number;
}

export class RedisMetrics {
  private metricsRegistry?: PulseMetricsRegistry;

  private publishCount = 0;
  private publishErrors = 0;
  private publishLatencyTotalMs = 0;
  private publishLatencyMaxMs = 0;
  private inFlightPublishes = 0;

  private inboundCount = 0;
  private inboundLatencyTotalMs = 0;
  private inboundLatencyMaxMs = 0;

  private echoesSuppressed = 0;
  private duplicatesSuppressed = 0;
  private channelsActive = 0;
  private connectionState = 'disconnected';

  private presenceUsersOnline = 0;
  private presenceConnectionsActive = 0;
  private presenceEventsPublished = 0;
  private presenceEventsReceived = 0;
  private presencePruneLatencyMs = 0;
  private presenceLeaseRenewals = 0;

  constructor(metricsRegistry?: PulseMetricsRegistry) {
    this.metricsRegistry = metricsRegistry;
    if (metricsRegistry) {
      registerRedisMetrics(metricsRegistry);
    }
  }

  public setMetricsRegistry(metricsRegistry: PulseMetricsRegistry): void {
    this.metricsRegistry = metricsRegistry;
    registerRedisMetrics(metricsRegistry);
  }

  public getMetricsRegistry(): PulseMetricsRegistry | undefined {
    return this.metricsRegistry;
  }

  public recordPublishStart(): void {
    this.inFlightPublishes++;
    this.metricsRegistry?.getGauge('pulse_redis_publish_in_flight')?.set(this.inFlightPublishes);
  }

  public recordPublishRejected(): void {
    this.publishErrors++;
    this.metricsRegistry?.getCounter('pulse_redis_publish_total')?.inc({ status: 'error' });
  }

  public recordPublishEnd(durationMs: number, error?: boolean): void {
    this.inFlightPublishes = Math.max(0, this.inFlightPublishes - 1);
    this.metricsRegistry?.getGauge('pulse_redis_publish_in_flight')?.set(this.inFlightPublishes);
    if (error) {
      this.publishErrors++;
      this.metricsRegistry?.getCounter('pulse_redis_publish_total')?.inc({ status: 'error' });
    } else {
      this.publishCount++;
      this.publishLatencyTotalMs += durationMs;
      if (durationMs > this.publishLatencyMaxMs) {
        this.publishLatencyMaxMs = durationMs;
      }
      this.metricsRegistry?.getCounter('pulse_redis_publish_total')?.inc({ status: 'success' });
      this.metricsRegistry?.getHistogram('pulse_redis_publish_duration_seconds')?.record(durationMs / 1000);
    }
  }

  public recordInbound(durationMs: number): void {
    this.inboundCount++;
    this.inboundLatencyTotalMs += durationMs;
    if (durationMs > this.inboundLatencyMaxMs) {
      this.inboundLatencyMaxMs = durationMs;
    }
  }

  public recordEchoSuppressed(): void {
    this.echoesSuppressed++;
  }

  public recordDuplicateSuppressed(): void {
    this.duplicatesSuppressed++;
  }

  public setChannelsActive(count: number): void {
    this.channelsActive = count;
    this.metricsRegistry?.getGauge('pulse_redis_subscriptions_active')?.set(count);
  }

  public setConnectionState(state: string): void {
    this.connectionState = state;
    this.metricsRegistry?.getGauge('pulse_redis_connection_state')?.set(state === 'connected' ? 1 : 0);
  }

  public getInFlightCount(): number {
    return this.inFlightPublishes;
  }

  public recordPresenceEventPublished(): void {
    this.presenceEventsPublished++;
  }

  public recordPresenceEventReceived(): void {
    this.presenceEventsReceived++;
  }

  public recordPresencePruneLatency(durationMs: number): void {
    if (durationMs > this.presencePruneLatencyMs) {
      this.presencePruneLatencyMs = durationMs;
    }
  }

  public recordPresenceLeaseRenewals(count: number): void {
    this.presenceLeaseRenewals += count;
  }

  public setPresenceCounts(users: number, connections: number): void {
    this.presenceUsersOnline = users;
    this.presenceConnectionsActive = connections;
  }

  public getSnapshot(): RedisMetricsSnapshot {
    return {
      'redis.publish.count': this.publishCount,
      'redis.publish.errors': this.publishErrors,
      'redis.publish.latency.avgMs':
        this.publishCount > 0
          ? Math.round((this.publishLatencyTotalMs / this.publishCount) * 100) / 100
          : 0,
      'redis.publish.latency.maxMs': this.publishLatencyMaxMs,
      'redis.publish.inFlight': this.inFlightPublishes,
      'redis.inbound.count': this.inboundCount,
      'redis.inbound.latency.avgMs':
        this.inboundCount > 0
          ? Math.round((this.inboundLatencyTotalMs / this.inboundCount) * 100) / 100
          : 0,
      'redis.inbound.latency.maxMs': this.inboundLatencyMaxMs,
      'redis.echoes.suppressed': this.echoesSuppressed,
      'redis.duplicates.suppressed': this.duplicatesSuppressed,
      'redis.channels.active': this.channelsActive,
      'redis.connection.state': this.connectionState,
      'presence.users.online': this.presenceUsersOnline,
      'presence.connections.active': this.presenceConnectionsActive,
      'presence.events.published': this.presenceEventsPublished,
      'presence.events.received': this.presenceEventsReceived,
      'presence.prune.latency.ms': this.presencePruneLatencyMs,
      'presence.lease.renewals': this.presenceLeaseRenewals
    };
  }

  public reset(): void {
    this.publishCount = 0;
    this.publishErrors = 0;
    this.publishLatencyTotalMs = 0;
    this.publishLatencyMaxMs = 0;
    this.inFlightPublishes = 0;
    this.inboundCount = 0;
    this.inboundLatencyTotalMs = 0;
    this.inboundLatencyMaxMs = 0;
    this.echoesSuppressed = 0;
    this.duplicatesSuppressed = 0;
    this.channelsActive = 0;
    this.connectionState = 'disconnected';
    this.presenceUsersOnline = 0;
    this.presenceConnectionsActive = 0;
    this.presenceEventsPublished = 0;
    this.presenceEventsReceived = 0;
    this.presencePruneLatencyMs = 0;
    this.presenceLeaseRenewals = 0;
    this.metricsRegistry?.getGauge('pulse_redis_publish_in_flight')?.set(0);
    this.metricsRegistry?.getGauge('pulse_redis_subscriptions_active')?.set(0);
    this.metricsRegistry?.getGauge('pulse_redis_connection_state')?.set(0);
  }
}
