import { EventEmitter } from 'events';
import { Redis, RedisOptions } from 'ioredis';
import {
  RedisConnectionOptions,
  RedisConnectionRole,
  RedisConnectionState,
  RedisConnectionStatus
} from './types.js';
import { logger } from '../utils/logger.js';

export class RedisConnectionManager extends EventEmitter {
  private readonly options: RedisConnectionOptions;
  private readonly instanceId: string;
  private publisher: Redis | null = null;
  private subscriber: Redis | null = null;
  private publisherStatus: RedisConnectionState = 'idle';
  private subscriberStatus: RedisConnectionState = 'idle';
  private isShuttingDown = false;

  constructor(options: RedisConnectionOptions, instanceId: string = 'pulse-node-1') {
    super();
    this.options = options;
    this.instanceId = instanceId;
  }

  public async connect(): Promise<void> {
    if (this.publisher && this.subscriber && this.isConnected()) {
      return;
    }

    this.isShuttingDown = false;
    this.publisherStatus = 'connecting';
    this.subscriberStatus = 'connecting';

    this.publisher = this.createClient('publisher');
    this.subscriber = this.createClient('subscriber');

    const connectTimeoutMs = this.options.connectTimeoutMs ?? 5000;

    const waitForReady = (client: Redis, role: RedisConnectionRole): Promise<void> => {
      return new Promise<void>((resolve, reject) => {
        if (client.status === 'ready') {
          this.updateStatus(role, 'connected');
          return resolve();
        }

        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Redis ${role} connection timed out after ${connectTimeoutMs}ms`));
        }, connectTimeoutMs);

        const onReady = () => {
          cleanup();
          this.updateStatus(role, 'connected');
          resolve();
        };

        const onError = (err: Error) => {
          cleanup();
          reject(err);
        };

        const cleanup = () => {
          clearTimeout(timer);
          client.off('ready', onReady);
          client.off('error', onError);
        };

        client.once('ready', onReady);
        client.once('error', onError);

        // Only call connect() if the client is in 'wait' state (lazyConnect)
        if (client.status === 'wait') {
          client.connect().catch((err) => {
            cleanup();
            reject(err);
          });
        }
      });
    };

    try {
      await Promise.all([
        waitForReady(this.publisher, 'publisher'),
        waitForReady(this.subscriber, 'subscriber')
      ]);

      logger.info('Redis connections established successfully', {
        instanceId: this.instanceId,
        publisherStatus: this.publisherStatus,
        subscriberStatus: this.subscriberStatus
      });

      this.emit('connected');
    } catch (error) {
      this.publisherStatus = 'error';
      this.subscriberStatus = 'error';

      logger.warn('Failed to establish Redis connections during connect()', {
        instanceId: this.instanceId,
        error: error instanceof Error ? error.message : String(error)
      });

      this.emit('error', error);
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    this.isShuttingDown = true;
    this.publisherStatus = 'disconnecting';
    this.subscriberStatus = 'disconnecting';

    const closeClient = async (client: Redis | null, role: RedisConnectionRole): Promise<void> => {
      if (!client) return;

      try {
        // Attempt clean quit with 2000ms timeout, then force disconnect
        const quitPromise = client.quit();
        const timeoutPromise = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000));
        const res = await Promise.race([quitPromise, timeoutPromise]);

        if (res === 'timeout') {
          logger.warn(`Redis ${role} quit timed out; forcing disconnect()`, {
            instanceId: this.instanceId
          });
          client.disconnect();
        }
      } catch (err) {
        logger.warn(`Error during Redis ${role} disconnect`, {
          instanceId: this.instanceId,
          error: err instanceof Error ? err.message : String(err)
        });
        client.disconnect();
      }
    };

    await Promise.all([
      closeClient(this.publisher, 'publisher'),
      closeClient(this.subscriber, 'subscriber')
    ]);

    this.publisher = null;
    this.subscriber = null;
    this.publisherStatus = 'disconnected';
    this.subscriberStatus = 'disconnected';

    logger.info('Redis connections closed cleanly', {
      instanceId: this.instanceId
    });

    this.emit('disconnected');
  }

  public isConnected(): boolean {
    return (
      this.publisher !== null &&
      this.subscriber !== null &&
      this.publisherStatus === 'connected' &&
      this.subscriberStatus === 'connected'
    );
  }

  public getStatus(): RedisConnectionStatus {
    return {
      publisher: this.publisherStatus,
      subscriber: this.subscriberStatus,
      isConnected: this.isConnected()
    };
  }

  public getPublisher(): Redis {
    if (!this.publisher) {
      throw new Error('Redis publisher client is not initialized. Call connect() first.');
    }
    return this.publisher;
  }

  public getSubscriber(): Redis {
    if (!this.subscriber) {
      throw new Error('Redis subscriber client is not initialized. Call connect() first.');
    }
    return this.subscriber;
  }

  private createClient(role: RedisConnectionRole): Redis {
    if (this.options.customClientFactory) {
      const customClient = this.options.customClientFactory(role);
      this.attachClientListeners(customClient, role);
      return customClient;
    }

    const retryStrategy = (times: number) => {
      if (this.isShuttingDown) {
        return null;
      }
      if (this.options.retryMaxAttempts && times > this.options.retryMaxAttempts) {
        logger.warn(`Redis ${role} maximum reconnect attempts reached (${this.options.retryMaxAttempts})`, {
          instanceId: this.instanceId,
          times
        });
        return null;
      }

      const initial = this.options.retryInitialDelayMs ?? 100;
      const max = this.options.retryMaxDelayMs ?? 3000;
      const backoff = Math.min(initial * Math.pow(1.5, times - 1), max);
      const jitter = Math.floor(Math.random() * (initial * 0.5));
      const delay = Math.min(backoff + jitter, max);

      logger.info(`Scheduling Redis ${role} reconnect attempt #${times} in ${delay}ms`, {
        instanceId: this.instanceId,
        attempt: times,
        delayMs: delay
      });

      return delay;
    };

    const redisOptions: RedisOptions = {
      lazyConnect: true,
      enableReadyCheck: true,
      maxRetriesPerRequest: this.options.maxRetriesPerRequest ?? null,
      retryStrategy,
      connectionName: `pulse:${this.instanceId}:${role}`
    };

    if (this.options.url) {
      const client = new Redis(this.options.url, redisOptions);
      this.attachClientListeners(client, role);
      return client;
    }

    if (this.options.host) {
      redisOptions.host = this.options.host;
    }
    if (this.options.port) {
      redisOptions.port = this.options.port;
    }
    if (this.options.password) {
      redisOptions.password = this.options.password;
    }

    const client = new Redis(redisOptions);
    this.attachClientListeners(client, role);
    return client;
  }

  private attachClientListeners(client: Redis, role: RedisConnectionRole): void {
    client.on('connect', () => {
      this.updateStatus(role, 'connecting');
    });

    client.on('ready', () => {
      this.updateStatus(role, 'connected');
      if (this.isConnected()) {
        this.emit('connected');
      }
    });

    client.on('reconnecting', (delay: number) => {
      this.updateStatus(role, 'reconnecting');
      this.emit('reconnecting', { role, delay });
    });

    client.on('close', () => {
      if (this.isShuttingDown) {
        this.updateStatus(role, 'disconnected');
      } else {
        this.updateStatus(role, 'reconnecting');
      }
      this.checkDisconnected();
    });

    client.on('error', (err: Error) => {
      logger.warn(`Redis ${role} client error: ${err.message}`, {
        instanceId: this.instanceId,
        role,
        error: err.message
      });
      this.updateStatus(role, 'error');
      this.emit('error', { role, error: err });
    });

    client.on('end', () => {
      this.updateStatus(role, 'disconnected');
      this.checkDisconnected();
    });
  }

  private updateStatus(role: RedisConnectionRole, status: RedisConnectionState): void {
    if (role === 'publisher') {
      this.publisherStatus = status;
    } else {
      this.subscriberStatus = status;
    }
  }

  private checkDisconnected(): void {
    if (this.publisherStatus !== 'connected' || this.subscriberStatus !== 'connected') {
      this.emit('disconnected');
    }
  }
}
