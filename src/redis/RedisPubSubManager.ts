import { EventEmitter } from 'events';
import { RedisConnectionManager } from './RedisConnectionManager.js';
import { RedisConnectionOptions, RedisConnectionStatus } from './types.js';
import { RedisMetrics, RedisMetricsSnapshot } from './RedisMetrics.js';
import { PulseEventEnvelope } from '../types/index.js';
import { logger } from '../utils/logger.js';

export type InboundMessageHandler = (channel: string, message: string) => void;

export class RedisPubSubManager extends EventEmitter {
  private readonly connectionManager: RedisConnectionManager;
  private readonly instanceId: string;
  private readonly subscribedChannels: Set<string> = new Set<string>();
  private readonly metrics: RedisMetrics = new RedisMetrics();
  private readonly maxInFlightPublishes: number;
  private messageHandler: InboundMessageHandler | null = null;
  private isSubscribedToClientEvents = false;

  constructor(
    connectionOrOptions: RedisConnectionManager | RedisConnectionOptions,
    instanceId: string = 'pulse-node-1',
    maxInFlightPublishes: number = 1000
  ) {
    super();
    this.instanceId = instanceId;
    this.maxInFlightPublishes = maxInFlightPublishes;

    if (connectionOrOptions instanceof RedisConnectionManager) {
      this.connectionManager = connectionOrOptions;
    } else {
      this.connectionManager = new RedisConnectionManager(connectionOrOptions, instanceId);
    }

    this.setupConnectionEvents();
  }

  public getMetrics(): RedisMetrics {
    return this.metrics;
  }

  public getMetricsSnapshot(): RedisMetricsSnapshot {
    return this.metrics.getSnapshot();
  }

  public async connect(): Promise<void> {
    await this.connectionManager.connect();
    this.metrics.setConnectionState('connected');
    this.attachSubscriberListener();
  }

  public async disconnect(): Promise<void> {
    this.subscribedChannels.clear();
    this.metrics.setChannelsActive(0);
    this.metrics.setConnectionState('disconnected');
    this.isSubscribedToClientEvents = false;
    await this.connectionManager.disconnect();
  }

  public async publish(
    channel: string,
    message: string | PulseEventEnvelope | Record<string, unknown>
  ): Promise<number> {
    if (!this.connectionManager.isConnected()) {
      throw new Error(`Cannot publish to channel "${channel}": Redis is not connected.`);
    }

    // Bounded backpressure policy: reject publish if in-flight limit reached
    if (this.metrics.getInFlightCount() >= this.maxInFlightPublishes) {
      this.metrics.recordPublishRejected();
      const backpressureError = new Error(
        `Redis publish backpressure limit reached (${this.maxInFlightPublishes} in-flight)`
      );
      logger.warn('Rejected Redis publish due to backpressure limit', {
        instanceId: this.instanceId,
        channel,
        inFlight: this.metrics.getInFlightCount(),
        maxInFlight: this.maxInFlightPublishes
      });
      throw backpressureError;
    }

    this.metrics.recordPublishStart();
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    const startTime = Date.now();

    try {
      const publisher = this.connectionManager.getPublisher();
      const recipients = await publisher.publish(channel, payload);
      const duration = Date.now() - startTime;
      this.metrics.recordPublishEnd(duration, false);

      logger.debug('Published event to Redis channel', {
        instanceId: this.instanceId,
        channel,
        recipients,
        durationMs: duration
      });

      return recipients;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.metrics.recordPublishEnd(duration, true);
      logger.warn('Failed to publish to Redis channel', {
        instanceId: this.instanceId,
        channel,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  public async subscribe(channel: string): Promise<void> {
    if (this.subscribedChannels.has(channel)) {
      return;
    }

    this.subscribedChannels.add(channel);
    this.metrics.setChannelsActive(this.subscribedChannels.size);

    if (this.connectionManager.isConnected()) {
      try {
        const subscriber = this.connectionManager.getSubscriber();
        await subscriber.subscribe(channel);

        logger.debug('Subscribed to Redis channel', {
          instanceId: this.instanceId,
          channel,
          activeSubscriptions: this.subscribedChannels.size
        });
      } catch (error) {
        logger.warn('Error subscribing to Redis channel', {
          instanceId: this.instanceId,
          channel,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    }
  }

  public async unsubscribe(channel: string): Promise<void> {
    if (!this.subscribedChannels.has(channel)) {
      return;
    }

    this.subscribedChannels.delete(channel);
    this.metrics.setChannelsActive(this.subscribedChannels.size);

    if (this.connectionManager.isConnected()) {
      try {
        const subscriber = this.connectionManager.getSubscriber();
        await subscriber.unsubscribe(channel);

        logger.debug('Unsubscribed from Redis channel', {
          instanceId: this.instanceId,
          channel,
          activeSubscriptions: this.subscribedChannels.size
        });
      } catch (error) {
        logger.warn('Error unsubscribing from Redis channel', {
          instanceId: this.instanceId,
          channel,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    }
  }

  public onMessage(handler: InboundMessageHandler): void {
    this.messageHandler = handler;
  }

  public isConnected(): boolean {
    return this.connectionManager.isConnected();
  }

  public getStatus(): RedisConnectionStatus {
    return this.connectionManager.getStatus();
  }

  public getSubscribedChannels(): string[] {
    return Array.from(this.subscribedChannels);
  }

  public getSubscribedChannelCount(): number {
    return this.subscribedChannels.size;
  }

  public getConnectionManager(): RedisConnectionManager {
    return this.connectionManager;
  }

  private setupConnectionEvents(): void {
    this.connectionManager.on('connected', async () => {
      this.metrics.setConnectionState('connected');
      this.attachSubscriberListener();
      await this.restoreSubscriptions();
      this.emit('connected');
    });

    this.connectionManager.on('disconnected', () => {
      this.metrics.setConnectionState('disconnected');
      this.emit('disconnected');
    });

    this.connectionManager.on('reconnecting', (info) => {
      this.metrics.setConnectionState('reconnecting');
      this.emit('reconnecting', info);
    });

    this.connectionManager.on('error', (err) => {
      this.metrics.setConnectionState('error');
      this.emit('error', err);
    });
  }

  private attachSubscriberListener(): void {
    if (this.isSubscribedToClientEvents || !this.connectionManager.isConnected()) {
      return;
    }

    const subscriber = this.connectionManager.getSubscriber();
    subscriber.on('message', (channel: string, message: string) => {
      this.emit('message', channel, message);
      if (this.messageHandler) {
        try {
          this.messageHandler(channel, message);
        } catch (err) {
          logger.error('Unhandled error in RedisPubSubManager message handler', {
            instanceId: this.instanceId,
            channel,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    });

    this.isSubscribedToClientEvents = true;
  }

  private async restoreSubscriptions(): Promise<void> {
    if (this.subscribedChannels.size === 0 || !this.connectionManager.isConnected()) {
      return;
    }

    try {
      const subscriber = this.connectionManager.getSubscriber();
      const channels = Array.from(this.subscribedChannels);
      await subscriber.subscribe(...channels);

      logger.info('Restored Redis channel subscriptions after reconnection', {
        instanceId: this.instanceId,
        count: channels.length,
        channels
      });
    } catch (error) {
      logger.warn('Failed to restore subscriptions upon reconnection', {
        instanceId: this.instanceId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
