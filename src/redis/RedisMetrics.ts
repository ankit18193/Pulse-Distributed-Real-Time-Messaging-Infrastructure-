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
}

export class RedisMetrics {
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

  public recordPublishStart(): void {
    this.inFlightPublishes++;
  }

  public recordPublishEnd(durationMs: number, error?: boolean): void {
    this.inFlightPublishes = Math.max(0, this.inFlightPublishes - 1);
    if (error) {
      this.publishErrors++;
    } else {
      this.publishCount++;
      this.publishLatencyTotalMs += durationMs;
      if (durationMs > this.publishLatencyMaxMs) {
        this.publishLatencyMaxMs = durationMs;
      }
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
  }

  public setConnectionState(state: string): void {
    this.connectionState = state;
  }

  public getInFlightCount(): number {
    return this.inFlightPublishes;
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
      'redis.connection.state': this.connectionState
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
  }
}
