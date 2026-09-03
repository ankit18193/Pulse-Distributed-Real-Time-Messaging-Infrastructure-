import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { PulseConfig, PulseEventEnvelope } from '../types/index.js';
import { Authenticator, AuthResult } from '../auth/Authenticator.js';
import { Connection } from './Connection.js';
import { ConnectionManager } from './ConnectionManager.js';
import { RoomManager } from './RoomManager.js';
import { MessageDispatcher } from './MessageDispatcher.js';
import { HeartbeatManager } from './HeartbeatManager.js';
import { IdempotencyManager } from './IdempotencyManager.js';
import { RedisPubSubManager } from '../redis/RedisPubSubManager.js';
import { ChannelRegistry } from '../redis/ChannelRegistry.js';
import { generateUUIDv7 } from '../utils/uuidv7.js';
import { logger } from '../utils/logger.js';

export interface PulseServerHooks {
  onConnectionAuthenticated?: (connection: Connection) => void;
  onConnectionClosed?: (
    connection: Connection,
    code: number,
    reason: string
  ) => void;
}

export interface PulseServerDependencies {
  redisPubSubManager?: RedisPubSubManager;
}

export class PulseServer {
  private readonly config: PulseConfig;
  private readonly authenticator: Authenticator;
  private readonly connectionManager: ConnectionManager;
  private readonly roomManager: RoomManager;
  private readonly idempotencyManager: IdempotencyManager;
  private readonly dispatcher: MessageDispatcher;
  private readonly heartbeatManager: HeartbeatManager;
  private readonly hooks: PulseServerHooks;
  private readonly redisPubSubManager?: RedisPubSubManager;
  private readonly channelRegistry?: ChannelRegistry;

  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private isRunning: boolean = false;
  private isShuttingDown: boolean = false;

  constructor(
    config: PulseConfig,
    hooks: PulseServerHooks = {},
    deps: PulseServerDependencies = {}
  ) {
    this.config = config;
    this.hooks = hooks;
    this.authenticator = new Authenticator(config.authSecret);

    if (deps.redisPubSubManager) {
      this.redisPubSubManager = deps.redisPubSubManager;
    } else if (config.redisEnabled) {
      this.redisPubSubManager = new RedisPubSubManager({
        url: config.redisUrl,
        host: config.redisHost,
        port: config.redisPort,
        password: config.redisPassword,
        retryMaxAttempts: config.redisRetryMaxAttempts,
        retryInitialDelayMs: config.redisRetryInitialDelayMs,
        retryMaxDelayMs: config.redisRetryMaxDelayMs
      }, config.instanceId);
    }

    if (this.redisPubSubManager) {
      this.channelRegistry = new ChannelRegistry(this.redisPubSubManager, config.instanceId);
    }

    this.connectionManager = new ConnectionManager(this.channelRegistry);
    this.roomManager = new RoomManager(this.channelRegistry);
    this.idempotencyManager = new IdempotencyManager({
      capacity: config.idempotencyCapacity,
      ttlMs: config.idempotencyTtlMs
    });

    this.dispatcher = new MessageDispatcher({
      connectionManager: this.connectionManager,
      roomManager: this.roomManager,
      idempotencyManager: this.idempotencyManager,
      redisPubSubManager: this.redisPubSubManager,
      instanceId: config.instanceId
    });

    this.heartbeatManager = new HeartbeatManager({
      connectionManager: this.connectionManager,
      intervalMs: config.heartbeatIntervalMs,
      timeoutMs: config.heartbeatTimeoutMs
    });
  }

  public getRedisPubSubManager(): RedisPubSubManager | undefined {
    return this.redisPubSubManager;
  }

  public getChannelRegistry(): ChannelRegistry | undefined {
    return this.channelRegistry;
  }

  public getConnectionManager(): ConnectionManager {
    return this.connectionManager;
  }

  public getRoomManager(): RoomManager {
    return this.roomManager;
  }

  public getIdempotencyManager(): IdempotencyManager {
    return this.idempotencyManager;
  }

  public getMessageDispatcher(): MessageDispatcher {
    return this.dispatcher;
  }

  public getHeartbeatManager(): HeartbeatManager {
    return this.heartbeatManager;
  }

  public getAuthenticator(): Authenticator {
    return this.authenticator;
  }

  public getActiveConnectionCount(): number {
    return this.connectionManager.getCount();
  }

  public getActiveRoomCount(): number {
    return this.roomManager.getRoomCount();
  }

  public isServerRunning(): boolean {
    return this.isRunning;
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('PulseServer is already running');
    }

    if (this.redisPubSubManager && !this.redisPubSubManager.isConnected()) {
      try {
        await this.redisPubSubManager.connect();
      } catch (err) {
        logger.warn('Initial Redis connection failed; server continuing in isolated local mode', {
          component: 'PulseServer',
          instanceId: this.config.instanceId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    return new Promise((resolve, reject) => {
      try {
        this.httpServer = http.createServer((req, res) => {
          this.handleHttpRequest(req, res);
        });

        // Construct WebSocketServer without its own HTTP server port (we manage upgrade manually)
        this.wss = new WebSocketServer({
          noServer: true,
          maxPayload: this.config.maxPayloadBytes
        });

        this.httpServer.on('upgrade', (req: http.IncomingMessage, socket, head) => {
          if (this.isShuttingDown) {
            socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
            return;
          }

          const authResult = this.authenticator.authenticateRequest(req);
          if (!authResult.authenticated) {
            const body = JSON.stringify({ error: authResult.error || 'Unauthorized' });
            socket.end(
              'HTTP/1.1 401 Unauthorized\r\n' +
                'Content-Type: application/json\r\n' +
                `Content-Length: ${Buffer.byteLength(body)}\r\n` +
                'Connection: close\r\n\r\n' +
                body
            );
            return;
          }

          this.wss!.handleUpgrade(req, socket, head, (ws) => {
            this.handleAuthenticatedConnection(ws, req, authResult);
          });
        });

        this.wss.on('error', (err: Error) => {
          logger.error('WebSocketServer encountered error', {
            component: 'PulseServer',
            event: 'WSS_ERROR',
            error: err.message
          });
        });

        this.httpServer.on('error', (err: Error) => {
          logger.error('HTTP Server encountered error', {
            component: 'PulseServer',
            event: 'HTTP_ERROR',
            error: err.message
          });
          if (!this.isRunning) {
            reject(err);
          }
        });

        this.httpServer.listen(this.config.port, this.config.host, () => {
          this.isRunning = true;
          this.heartbeatManager.start();

          logger.info('Pulse Realtime Server started successfully', {
            component: 'PulseServer',
            event: 'SERVER_STARTED',
            instanceId: this.config.instanceId,
            port: this.config.port,
            host: this.config.host,
            environment: this.config.nodeEnv
          });

          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.url === '/healthz' || req.url === '/health') {
      const healthData = {
        status: this.isShuttingDown ? 'DRAINING' : 'OK',
        instanceId: this.config.instanceId,
        timestamp: Date.now(),
        connections: this.connectionManager.getCount(),
        rooms: this.roomManager.getRoomCount(),
        idempotencyCacheSize: this.idempotencyManager.size(),
        redis: this.redisPubSubManager
          ? {
              enabled: true,
              ...this.redisPubSubManager.getStatus(),
              metrics: this.redisPubSubManager.getMetricsSnapshot()
            }
          : { enabled: false }
      };

      res.writeHead(this.isShuttingDown ? 503 : 200, {
        'Content-Type': 'application/json'
      });
      res.end(JSON.stringify(healthData));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }

  private handleAuthenticatedConnection(
    socket: WebSocket,
    req: http.IncomingMessage,
    authResult: AuthResult
  ): void {
    const connectionId = generateUUIDv7();
    const userId = authResult.userId!;
    const roles = authResult.roles || ['user'];

    const forwarded = req.headers['x-forwarded-for'];
    const remoteAddress =
      (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : undefined) ||
      req.socket.remoteAddress;

    const connection = new Connection({
      socket,
      connectionId,
      userId,
      roles,
      remoteAddress
    });

    this.connectionManager.addConnection(connection);

    logger.info('New authenticated connection established', {
      component: 'PulseServer',
      event: 'CONNECTION_ESTABLISHED',
      connectionId,
      userId,
      roles,
      remoteAddress
    });

    // Send initial SYS_CONNECT_ACK envelope
    const ackEnvelope: PulseEventEnvelope = {
      eventId: generateUUIDv7(),
      type: 'SYS_CONNECT_ACK',
      timestamp: Date.now(),
      senderId: 'system',
      payload: {
        connectionId: connection.connectionId,
        userId: connection.userId,
        instanceId: this.config.instanceId,
        connectedAt: connection.connectedAt
      }
    };
    connection.send(ackEnvelope);

    if (this.hooks.onConnectionAuthenticated) {
      this.hooks.onConnectionAuthenticated(connection);
    }

    // Native RFC 6455 transport ping/pong keepalive hooks
    socket.on('pong', () => {
      connection.touch();
    });

    socket.on('ping', () => {
      connection.touch();
      if (socket.readyState === WebSocket.OPEN) {
        socket.pong();
      }
    });

    // Attach message dispatcher to connection socket
    socket.on('message', (data: Buffer | string) => {
      this.dispatcher.dispatchRawMessage(connection, data);
    });

    socket.on('close', (code, reason) => {
      this.connectionManager.removeConnection(connection.connectionId);
      this.roomManager.removeConnectionFromAllRooms(
        connection.connectionId,
        connection.getRooms()
      );

      logger.info('Realtime connection closed and cleaned up', {
        component: 'PulseServer',
        event: 'CONNECTION_CLOSED',
        connectionId: connection.connectionId,
        userId: connection.userId,
        code,
        reason: reason.toString()
      });

      if (this.hooks.onConnectionClosed) {
        this.hooks.onConnectionClosed(connection, code, reason.toString());
      }
    });

    socket.on('error', (err) => {
      logger.error('Realtime connection socket error', {
        component: 'PulseServer',
        event: 'CONNECTION_ERROR',
        connectionId: connection.connectionId,
        userId: connection.userId,
        error: err.message
      });
    });
  }

  public async stop(options: { gracePeriodMs?: number } = {}): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isShuttingDown = true;
    const gracePeriodMs = options.gracePeriodMs ?? 2000;

    logger.info('Initiating graceful shutdown for PulseServer...', {
      component: 'PulseServer',
      event: 'SHUTDOWN_INITIATED',
      activeConnections: this.connectionManager.getCount(),
      gracePeriodMs
    });

    // 1. Stop heartbeat manager sweeps
    this.heartbeatManager.stop();

    // 2. Notify all connected clients with SYS_SHUTDOWN frame
    const shutdownEnvelope: PulseEventEnvelope = {
      eventId: generateUUIDv7(),
      type: 'SYS_SHUTDOWN',
      timestamp: Date.now(),
      senderId: 'system',
      payload: {
        reason: 'Server shutting down gracefully',
        instanceId: this.config.instanceId
      }
    };

    const activeConnections = this.connectionManager.getAllConnections();
    for (const conn of activeConnections) {
      conn.send(shutdownEnvelope);
      // Close socket with RFC 6455 code 1001 (Going Away)
      conn.close(1001, 'Server shutting down');
    }

    // 3. Close WebSocket server and HTTP server
    return new Promise((resolve) => {
      const shutdownTimer = setTimeout(() => {
        this.cleanupAndFinalize();
        resolve();
      }, gracePeriodMs);

      if (this.wss) {
        this.wss.close(() => {
          if (this.httpServer) {
            this.httpServer.close(() => {
              clearTimeout(shutdownTimer);
              this.cleanupAndFinalize();
              resolve();
            });
          } else {
            clearTimeout(shutdownTimer);
            this.cleanupAndFinalize();
            resolve();
          }
        });
      } else {
        clearTimeout(shutdownTimer);
        this.cleanupAndFinalize();
        resolve();
      }
    });
  }

  private cleanupAndFinalize(): void {
    if (this.channelRegistry) {
      this.channelRegistry.clear().catch(() => {});
    }
    if (this.redisPubSubManager) {
      this.redisPubSubManager.disconnect().catch(() => {});
    }
    this.connectionManager.clear();
    this.roomManager.clear();
    this.idempotencyManager.clear();
    this.isRunning = false;
    this.isShuttingDown = false;

    logger.info('PulseServer shut down complete and resources drained', {
      component: 'PulseServer',
      event: 'SHUTDOWN_COMPLETE'
    });
  }
}
