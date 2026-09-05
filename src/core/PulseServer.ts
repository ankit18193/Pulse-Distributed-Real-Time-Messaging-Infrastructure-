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
import { PresenceManager } from '../redis/PresenceManager.js';
import { PulseMetricsRegistry, PrometheusSerializer, EventLoopMonitor, Gauge, registerWebSocketMetrics } from '../metrics/index.js';
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
  presenceManager?: PresenceManager;
  metricsRegistry?: PulseMetricsRegistry;
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
  private presenceManager?: PresenceManager;
  private readonly metricsRegistry: PulseMetricsRegistry;
  private eventLoopMonitor: EventLoopMonitor | null = null;
  private eventLoopTimer: NodeJS.Timeout | null = null;
  private gaugeEventLoopMean: Gauge | null = null;
  private gaugeEventLoopP50: Gauge | null = null;
  private gaugeEventLoopP99: Gauge | null = null;
  private gaugeEventLoopMax: Gauge | null = null;

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
    this.metricsRegistry = deps.metricsRegistry ?? new PulseMetricsRegistry();

    if (this.config.metricsEnabled !== false) {
      registerWebSocketMetrics(this.metricsRegistry);

      this.gaugeEventLoopMean = (this.metricsRegistry.getMetric('pulse_event_loop_lag_seconds') as Gauge) ??
        new Gauge({
          name: 'pulse_event_loop_lag_seconds',
          help: 'Current mean Node.js event-loop lag in seconds'
        });
      this.gaugeEventLoopP50 = (this.metricsRegistry.getMetric('pulse_event_loop_lag_p50_seconds') as Gauge) ??
        new Gauge({
          name: 'pulse_event_loop_lag_p50_seconds',
          help: 'Node.js event-loop lag 50th percentile in seconds'
        });
      this.gaugeEventLoopP99 = (this.metricsRegistry.getMetric('pulse_event_loop_lag_p99_seconds') as Gauge) ??
        new Gauge({
          name: 'pulse_event_loop_lag_p99_seconds',
          help: 'Node.js event-loop lag 99th percentile in seconds'
        });
      this.gaugeEventLoopMax = (this.metricsRegistry.getMetric('pulse_event_loop_lag_max_seconds') as Gauge) ??
        new Gauge({
          name: 'pulse_event_loop_lag_max_seconds',
          help: 'Peak Node.js event-loop lag in seconds'
        });

      if (!this.metricsRegistry.getMetric('pulse_event_loop_lag_seconds')) {
        this.metricsRegistry.register(this.gaugeEventLoopMean);
      }
      if (!this.metricsRegistry.getMetric('pulse_event_loop_lag_p50_seconds')) {
        this.metricsRegistry.register(this.gaugeEventLoopP50);
      }
      if (!this.metricsRegistry.getMetric('pulse_event_loop_lag_p99_seconds')) {
        this.metricsRegistry.register(this.gaugeEventLoopP99);
      }
      if (!this.metricsRegistry.getMetric('pulse_event_loop_lag_max_seconds')) {
        this.metricsRegistry.register(this.gaugeEventLoopMax);
      }
    }

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

    if (deps.presenceManager) {
      this.presenceManager = deps.presenceManager;
      if (typeof (this.presenceManager as any).setMetricsRegistry === 'function') {
        (this.presenceManager as any).setMetricsRegistry(this.metricsRegistry);
      }
    }

    if (this.redisPubSubManager) {
      if (typeof (this.redisPubSubManager as any).setMetricsRegistry === 'function') {
        (this.redisPubSubManager as any).setMetricsRegistry(this.metricsRegistry);
      } else if (typeof (this.redisPubSubManager as any).getMetrics === 'function') {
        (this.redisPubSubManager as any).getMetrics()?.setMetricsRegistry?.(this.metricsRegistry);
      }

      this.channelRegistry = new ChannelRegistry(this.redisPubSubManager, config.instanceId);

      if (typeof (this.redisPubSubManager as any).on === 'function') {
        (this.redisPubSubManager as any).on('connected', async () => {
          await this.handleRedisReconnect();
        });
      } else if (typeof (this.redisPubSubManager as any).getConnectionManager === 'function') {
        const cm = (this.redisPubSubManager as any).getConnectionManager();
        if (typeof cm?.on === 'function') {
          cm.on('connected', async () => {
            await this.handleRedisReconnect();
          });
        }
      }
    }

    this.connectionManager = new ConnectionManager(this.channelRegistry, this.metricsRegistry);
    this.roomManager = new RoomManager(this.channelRegistry, this.metricsRegistry);
    this.idempotencyManager = new IdempotencyManager({
      capacity: config.idempotencyCapacity,
      ttlMs: config.idempotencyTtlMs
    });

    this.dispatcher = new MessageDispatcher({
      connectionManager: this.connectionManager,
      roomManager: this.roomManager,
      idempotencyManager: this.idempotencyManager,
      redisPubSubManager: this.redisPubSubManager,
      presenceManager: this.presenceManager,
      metricsRegistry: this.metricsRegistry,
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

  public getPresenceManager(): PresenceManager | undefined {
    return this.presenceManager;
  }

  public getMetricsRegistry(): PulseMetricsRegistry {
    return this.metricsRegistry;
  }

  public getEventLoopMonitor(): EventLoopMonitor | null {
    return this.eventLoopMonitor;
  }

  public updateEventLoopMetrics(): void {
    if (!this.eventLoopMonitor || !this.eventLoopMonitor.isActive()) {
      return;
    }
    const metrics = this.eventLoopMonitor.getMetrics();
    this.gaugeEventLoopMean?.set(metrics.meanSec);
    this.gaugeEventLoopP50?.set(metrics.p50Sec);
    this.gaugeEventLoopP99?.set(metrics.p99Sec);
    this.gaugeEventLoopMax?.set(metrics.maxSec);
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

    if (this.redisPubSubManager) {
      if (!this.redisPubSubManager.isConnected()) {
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

      if (
        !this.presenceManager &&
        this.redisPubSubManager.isConnected() &&
        typeof (this.redisPubSubManager as any).getConnectionManager === 'function'
      ) {
        try {
          const redisClient = (this.redisPubSubManager as any).getConnectionManager()?.getPublisher();
          if (redisClient) {
            this.presenceManager = new PresenceManager(redisClient, this.config.instanceId, {
              presenceTtlMs: this.config.presenceTtlMs,
              presenceFlushIntervalMs: this.config.presenceFlushIntervalMs,
              pubSubManager: this.redisPubSubManager,
              metricsRegistry: this.metricsRegistry,
              roomsProvider: (userId: string) => {
                const conns = this.connectionManager.getConnectionsByUserId(userId);
                const rooms = new Set<string>();
                for (const c of conns) {
                  for (const r of c.getRooms()) {
                    rooms.add(r);
                  }
                }
                return Array.from(rooms);
              }
            });
            this.dispatcher.setPresenceManager(this.presenceManager);
          }
        } catch {
          // publisher not ready
        }
      }
    }

    if (this.presenceManager) {
      this.presenceManager.startRenewalLoop(() => {
        const conns = this.connectionManager.getAllConnections();
        return conns
          .filter((c) => c.userId && c.isAlive())
          .map((c) => ({ userId: c.userId!, connectionId: c.connectionId }));
      });
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
            this.metricsRegistry.getCounter('pulse_connections_total')?.inc({ status: 'rejected' });
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

          this.metricsRegistry.getCounter('pulse_connections_total')?.inc({ status: 'success' });

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

          if (this.config.metricsEnabled !== false) {
            if (!this.eventLoopMonitor) {
              this.eventLoopMonitor = new EventLoopMonitor();
            }
            this.eventLoopMonitor.start(20);

            const intervalMs = this.config.eventLoopMonitorIntervalMs || 10000;
            this.eventLoopTimer = setInterval(() => {
              this.updateEventLoopMetrics();
              this.eventLoopMonitor?.reset();
            }, intervalMs);
            if (typeof this.eventLoopTimer.unref === 'function') {
              this.eventLoopTimer.unref();
            }
          }

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
    const rawUrl = req.url || '';
    const pathname = rawUrl.split('?')[0];

    if (pathname === '/healthz' || pathname === '/health') {
      const isRedisDegraded = Boolean(
        this.redisPubSubManager && !this.redisPubSubManager.isConnected()
      );

      let status: 'DRAINING' | 'DEGRADED' | 'OK' = 'OK';
      let statusCode = 200;

      if (this.isShuttingDown) {
        status = 'DRAINING';
        statusCode = 503;
      } else if (isRedisDegraded) {
        status = 'DEGRADED';
        statusCode = 200;
      }

      const healthData = {
        status,
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
          : { enabled: false },
        presence: this.presenceManager
          ? {
              enabled: true,
              mode: isRedisDegraded ? 'degraded-local-only' : 'distributed',
              metrics: this.presenceManager.getMetricsSnapshot()
            }
          : { enabled: false, mode: 'disabled' }
      };

      res.writeHead(statusCode, {
        'Content-Type': 'application/json'
      });
      res.end(JSON.stringify(healthData));
      return;
    }

    if (pathname === '/readyz') {
      const isRedisDegraded = Boolean(
        this.config.redisEnabled &&
          (!this.redisPubSubManager || !this.redisPubSubManager.isConnected())
      );

      let ready = true;
      let status: 'READY' | 'DRAINING' | 'NOT_READY' = 'READY';
      let statusCode = 200;
      let reason: string | undefined = undefined;

      if (this.isShuttingDown) {
        ready = false;
        status = 'DRAINING';
        statusCode = 503;
        reason = 'Server is draining connections';
      } else if (isRedisDegraded) {
        ready = false;
        status = 'NOT_READY';
        statusCode = 503;
        reason = 'Redis is enabled but disconnected';
      }

      const readyData = {
        ready,
        status,
        instanceId: this.config.instanceId,
        timestamp: Date.now(),
        ...(reason ? { reason } : {})
      };

      res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end(JSON.stringify(readyData));
      return;
    }

    if (
      req.method === 'GET' &&
      (pathname === '/metrics' || (this.config.metricsPath && pathname === this.config.metricsPath))
    ) {
      if (this.config.metricsEnabled === false) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Metrics endpoint is disabled' }));
        return;
      }

      this.updateEventLoopMetrics();
      const metricsText = PrometheusSerializer.serialize(this.metricsRegistry);
      res.writeHead(200, {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        'Content-Length': Buffer.byteLength(metricsText),
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end(metricsText);
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
      remoteAddress,
      maxBufferedAmountBytes: this.config.maxBufferedAmountBytes,
      metricsRegistry: this.metricsRegistry
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

    // Register presence connection lease after successful authentication
    if (this.presenceManager) {
      this.presenceManager.registerConnection(userId, connectionId).catch((err) => {
        logger.warn('Failed to register presence lease on connection established', {
          component: 'PulseServer',
          userId,
          connectionId,
          error: err instanceof Error ? err.message : String(err)
        });
      });
    }

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
      let closeReason = 'client_close';
      if (code === 1008) {
        closeReason = 'slow_consumer';
      } else if (code === 1001) {
        closeReason = 'server_shutdown';
      } else if (code === 4000 || reason.toString().toLowerCase().includes('heartbeat')) {
        closeReason = 'heartbeat_timeout';
      }
      this.metricsRegistry.getCounter('pulse_connections_closed_total')?.inc({ reason: closeReason });

      this.connectionManager.removeConnection(connection.connectionId);
      this.roomManager.removeConnectionFromAllRooms(
        connection.connectionId,
        connection.getRooms()
      );

      // Remove presence connection lease on connection termination
      if (this.presenceManager && connection.userId) {
        this.presenceManager.removeConnection(connection.userId, connection.connectionId).catch((err) => {
          logger.warn('Failed to remove presence lease on connection close', {
            component: 'PulseServer',
            userId: connection.userId,
            connectionId: connection.connectionId,
            error: err instanceof Error ? err.message : String(err)
          });
        });
      }

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
    if (this.eventLoopTimer) {
      clearInterval(this.eventLoopTimer);
      this.eventLoopTimer = null;
    }
    if (this.eventLoopMonitor) {
      this.eventLoopMonitor.stop();
      this.eventLoopMonitor = null;
    }
    if (this.presenceManager) {
      this.presenceManager.stopRenewalLoop();
    }
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

  private async handleRedisReconnect(): Promise<void> {
    if (
      !this.presenceManager &&
      this.redisPubSubManager?.isConnected() &&
      typeof (this.redisPubSubManager as any).getConnectionManager === 'function'
    ) {
      try {
        const redisClient = (this.redisPubSubManager as any).getConnectionManager()?.getPublisher();
        if (redisClient) {
          this.presenceManager = new PresenceManager(redisClient, this.config.instanceId, {
            presenceTtlMs: this.config.presenceTtlMs,
            presenceFlushIntervalMs: this.config.presenceFlushIntervalMs,
            pubSubManager: this.redisPubSubManager,
            metricsRegistry: this.metricsRegistry,
            roomsProvider: (userId: string) => {
              const conns = this.connectionManager.getConnectionsByUserId(userId);
              const rooms = new Set<string>();
              for (const c of conns) {
                for (const r of c.getRooms()) {
                  rooms.add(r);
                }
              }
              return Array.from(rooms);
            }
          });
          this.dispatcher.setPresenceManager(this.presenceManager);
          this.presenceManager.startRenewalLoop(() => {
            const conns = this.connectionManager.getAllConnections();
            return conns
              .filter((c) => c.userId && c.isAlive())
              .map((c) => ({ userId: c.userId!, connectionId: c.connectionId }));
          });
        }
      } catch {
        // publisher not ready
      }
    }

    if (this.presenceManager) {
      logger.info('Redis reconnected; resynchronizing active local presence leases', {
        component: 'PulseServer',
        instanceId: this.config.instanceId
      });

      const activeConnections = this.connectionManager.getAllConnections();
      for (const conn of activeConnections) {
        if (conn.userId && conn.isAlive()) {
          try {
            await this.presenceManager.registerConnection(conn.userId, conn.connectionId);
          } catch (err) {
            logger.warn('Failed to resynchronize connection presence lease on Redis reconnect', {
              component: 'PulseServer',
              connectionId: conn.connectionId,
              userId: conn.userId,
              error: err instanceof Error ? err.message : String(err)
            });
          }
        }
      }
    }
  }
}
