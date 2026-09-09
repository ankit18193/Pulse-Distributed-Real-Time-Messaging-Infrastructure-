import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { PulseConfig, PulseEventEnvelope } from '../types/index.js';
import { loadConfig, PulseServerOptions } from '../config/index.js';
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
import { OriginMatcher } from '../utils/OriginMatcher.js';
import { logger } from '../utils/logger.js';
import type { RouteXGatewayServer } from '@ankit18193/routex-gateway';

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
  routexGateway?: RouteXGatewayServer;
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
  private readonly routexGateway?: RouteXGatewayServer;
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
    options: PulseServerOptions = {},
    hooks: PulseServerHooks = {},
    deps: PulseServerDependencies = {}
  ) {
    this.config = loadConfig(options);
    this.hooks = hooks;
    this.authenticator = new Authenticator(this.config.authSecret);
    this.routexGateway = deps.routexGateway;
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
    } else if (this.config.redisEnabled) {
      this.redisPubSubManager = new RedisPubSubManager({
        url: this.config.redisUrl,
        host: this.config.redisHost,
        port: this.config.redisPort,
        password: this.config.redisPassword,
        retryMaxAttempts: this.config.redisRetryMaxAttempts,
        retryInitialDelayMs: this.config.redisRetryInitialDelayMs,
        retryMaxDelayMs: this.config.redisRetryMaxDelayMs
      }, this.config.instanceId);
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

      this.channelRegistry = new ChannelRegistry(this.redisPubSubManager, this.config.instanceId);

      if (typeof (this.redisPubSubManager as any).on === 'function') {
        (this.redisPubSubManager as any).on('connected', async () => {
          await this.handleRedisReconnect();
        });
        (this.redisPubSubManager as any).on('error', (err: unknown) => {
          logger.warn('Redis connection reported error in PulseServer', {
            component: 'PulseServer',
            instanceId: this.config.instanceId,
            error: err instanceof Error ? err.message : String(err)
          });
        });
      } else if (typeof (this.redisPubSubManager as any).getConnectionManager === 'function') {
        const cm = (this.redisPubSubManager as any).getConnectionManager();
        if (typeof cm?.on === 'function') {
          cm.on('connected', async () => {
            await this.handleRedisReconnect();
          });
          cm.on('error', (err: unknown) => {
            logger.warn('Redis connection manager reported error in PulseServer', {
              component: 'PulseServer',
              instanceId: this.config.instanceId,
              error: err instanceof Error ? err.message : String(err)
            });
          });
        }
      }
    }

    this.connectionManager = new ConnectionManager(this.channelRegistry, this.metricsRegistry);
    this.connectionManager.setMaxConnections(this.config.maxConnections ?? 50000);
    this.roomManager = new RoomManager(this.channelRegistry, this.metricsRegistry);
    this.idempotencyManager = new IdempotencyManager({
      capacity: this.config.idempotencyCapacity,
      ttlMs: this.config.idempotencyTtlMs
    });

    this.dispatcher = new MessageDispatcher({
      connectionManager: this.connectionManager,
      roomManager: this.roomManager,
      idempotencyManager: this.idempotencyManager,
      redisPubSubManager: this.redisPubSubManager,
      presenceManager: this.presenceManager,
      metricsRegistry: this.metricsRegistry,
      instanceId: this.config.instanceId,
      maxRoomsPerConnection: this.config.maxRoomsPerConnection,
      maxRoomIdLength: this.config.maxRoomIdLength
    });

    this.heartbeatManager = new HeartbeatManager({
      connectionManager: this.connectionManager,
      intervalMs: this.config.heartbeatIntervalMs,
      timeoutMs: this.config.heartbeatTimeoutMs
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

  public getConfig(): Readonly<PulseConfig> {
    return this.config;
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

  public getRouteXGateway(): RouteXGatewayServer | undefined {
    return this.routexGateway;
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
      (async () => {
        try {
          if (this.routexGateway) {
            await this.routexGateway.ready();
          }

          this.httpServer = http.createServer(async (req, res) => {
            if (this.routexGateway) {
              try {
                const handled = await this.routexGateway.handleRequest(req, res);
                if (handled) {
                  return;
                }
              } catch (err) {
                logger.error('Error in embedded RouteX gateway request handling', {
                  component: 'PulseServer',
                  event: 'ROUTEX_HANDLE_REQUEST_ERROR',
                  error: err instanceof Error ? err.message : String(err)
                });
                if (!res.headersSent) {
                  res.writeHead(500, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'Internal Server Error', message: 'Gateway error' }));
                }
                return;
              }
            }
            this.handleHttpRequest(req, res);
          });

          // Construct WebSocketServer without its own HTTP server port (we manage upgrade manually)
          this.wss = new WebSocketServer({
            noServer: true,
            maxPayload: this.config.maxPayloadBytes
          });

          this.httpServer.on('upgrade', async (req: http.IncomingMessage, socket, head) => {
            // Prevent uncaughtException from client TCP resets (ECONNRESET/EPIPE) during handshake
            socket.on('error', (err: unknown) => {
              logger.debug('Socket error during HTTP upgrade handshake', {
                component: 'PulseServer',
                event: 'UPGRADE_SOCKET_ERROR',
                error: err instanceof Error ? err.message : String(err)
              });
            });

            if (this.isShuttingDown) {
              this.metricsRegistry.getCounter('pulse_connections_rejected_total')?.inc({ reason: 'draining' });
              socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
              return;
            }

            // Phase 10: Cross-Site WebSocket Hijacking (CSWSH) Origin Defense
            const originHeader = req.headers.origin as string | undefined;
            const allowedOrigins = this.config.allowedOrigins ?? ['*'];
            if (!OriginMatcher.isAllowed(originHeader, allowedOrigins)) {
              this.metricsRegistry.getCounter('pulse_connections_rejected_total')?.inc({ reason: 'origin_forbidden' });
              socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
              return;
            }

            if (this.routexGateway) {
              try {
                const handled = await this.routexGateway.handleUpgrade(req, socket, head);
                if (handled) {
                  return;
                }
              } catch (err) {
                logger.error('Error in embedded RouteX gateway upgrade handling', {
                  component: 'PulseServer',
                  event: 'ROUTEX_HANDLE_UPGRADE_ERROR',
                  error: err instanceof Error ? err.message : String(err)
                });
                if (!socket.destroyed) {
                  socket.destroy();
                }
                return;
              }
            }

            // Phase 10: Atomic Admission Control (Race Condition Free)
            if (!this.connectionManager.tryAcquireSlot()) {
              this.metricsRegistry.getCounter('pulse_connections_rejected_total')?.inc({ reason: 'max_connections' });
              const body = JSON.stringify({ error: 'Max connections reached' });
              socket.end(
                'HTTP/1.1 503 Service Unavailable\r\n' +
                  'Content-Type: application/json\r\n' +
                  `Content-Length: ${Buffer.byteLength(body)}\r\n` +
                  'Connection: close\r\n\r\n' +
                  body
              );
              return;
            }

            const authResult = this.authenticator.authenticateRequest(req);
            if (!authResult.authenticated) {
              this.connectionManager.releasePendingSlot();
              this.metricsRegistry.getCounter('pulse_connections_total')?.inc({ status: 'rejected' });
              this.metricsRegistry.getCounter('pulse_connections_rejected_total')?.inc({ reason: 'auth_failed' });
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

            let slotClaimed = true;
            const onEarlyClose = () => {
              if (slotClaimed) {
                slotClaimed = false;
                this.connectionManager.releasePendingSlot();
              }
            };
            socket.once('close', onEarlyClose);
            socket.once('error', onEarlyClose);

            this.metricsRegistry.getCounter('pulse_connections_total')?.inc({ status: 'success' });

            this.wss!.handleUpgrade(req, socket, head, (ws) => {
              slotClaimed = false;
              socket.removeListener('close', onEarlyClose);
              socket.removeListener('error', onEarlyClose);
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
    })();
  });
}

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const rawUrl = req.url || '';
    const pathname = rawUrl.split('?')[0];

    // Standard CORS headers for frontend and local dev tooling
    const origin = (req.headers.origin as string) || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

    // HTTP Security Headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && (pathname === '/api/stats' || pathname === '/api/telemetry')) {
      this.updateEventLoopMetrics();

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

      // Aggregate throughput counters
      let totalMessagesReceived = 0;
      const rxCounter = this.metricsRegistry.getCounter('pulse_messages_received_total');
      if (rxCounter) {
        for (const sample of rxCounter.collect()) {
          totalMessagesReceived += sample.value;
        }
      }

      let totalMessagesDelivered = 0;
      const txCounter = this.metricsRegistry.getCounter('pulse_messages_delivered_total');
      if (txCounter) {
        for (const sample of txCounter.collect()) {
          totalMessagesDelivered += sample.value;
        }
      }

      let totalConnectionsAttempted = 0;
      const connCounter = this.metricsRegistry.getCounter('pulse_connections_total');
      if (connCounter) {
        for (const sample of connCounter.collect()) {
          totalConnectionsAttempted += sample.value;
        }
      }

      const eventLoopMetrics = this.eventLoopMonitor?.isActive()
        ? this.eventLoopMonitor.getMetrics()
        : {
            meanSec: this.gaugeEventLoopMean?.get() ?? 0,
            p50Sec: this.gaugeEventLoopP50?.get() ?? 0,
            p99Sec: this.gaugeEventLoopP99?.get() ?? 0,
            maxSec: this.gaugeEventLoopMax?.get() ?? 0
          };

      const roomsList = this.roomManager.getAllRoomIds().slice(0, 50).map((roomId) => ({
        roomId,
        subscriberCount: this.roomManager.getConnectionCountInRoom(roomId)
      }));

      const activeConnectionsSample = this.connectionManager.getAllConnections().slice(0, 50).map((c) => ({
        connectionId: c.connectionId,
        userId: c.userId,
        remoteAddress: c.remoteAddress,
        roles: c.roles,
        connectedAt: c.connectedAt,
        bufferedAmountBytes: c.getBufferedAmount(),
        rooms: c.getRooms()
      }));

      const statsData = {
        status,
        statusCode,
        instanceId: this.config.instanceId,
        nodeEnv: this.config.nodeEnv,
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: Date.now(),
        connections: {
          active: this.connectionManager.getCount(),
          total: totalConnectionsAttempted,
          sample: activeConnectionsSample
        },
        rooms: {
          active: this.roomManager.getRoomCount(),
          list: roomsList
        },
        throughput: {
          messagesReceived: totalMessagesReceived,
          messagesDelivered: totalMessagesDelivered
        },
        eventLoopLag: {
          meanMs: Number((eventLoopMetrics.meanSec * 1000).toFixed(2)),
          p50Ms: Number((eventLoopMetrics.p50Sec * 1000).toFixed(2)),
          p99Ms: Number((eventLoopMetrics.p99Sec * 1000).toFixed(2)),
          maxMs: Number((eventLoopMetrics.maxSec * 1000).toFixed(2))
        },
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
          : { enabled: false, mode: 'disabled' },
        routex: this.routexGateway
          ? {
              enabled: true,
              version: '1.2.0'
            }
          : { enabled: false }
      };

      res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end(JSON.stringify(statsData));
      return;
    }

    if (pathname === '/dashboard') {
      res.writeHead(301, { Location: '/dashboard/' });
      res.end();
      return;
    }

    if (pathname.startsWith('/dashboard/')) {
      const dashboardDistPath = path.resolve(process.cwd(), 'dashboard', 'dist');
      if (!fs.existsSync(dashboardDistPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Dashboard build not found',
          message: 'Run npm run build:dashboard to compile dashboard static assets or run npm run dev:dashboard for development.'
        }));
        return;
      }

      let relativeFile = pathname.replace(/^\/dashboard\/?/, '');
      try {
        relativeFile = decodeURIComponent(relativeFile);
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request');
        return;
      }

      if (relativeFile.includes('\0') || relativeFile.includes('..')) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      if (!relativeFile || relativeFile === '') {
        relativeFile = 'index.html';
      }

      const filePath = path.resolve(dashboardDistPath, relativeFile);
      const normalizedDist = path.normalize(dashboardDistPath) + path.sep;
      const normalizedFile = path.normalize(filePath);

      if (normalizedFile !== path.normalize(dashboardDistPath) && !normalizedFile.startsWith(normalizedDist)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      let finalPath = filePath;
      if (!fs.existsSync(finalPath) || fs.statSync(finalPath).isDirectory()) {
        if (path.extname(relativeFile) && path.extname(relativeFile) !== '.html') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }
        finalPath = path.resolve(dashboardDistPath, 'index.html');
      }

      if (fs.existsSync(finalPath)) {
        const ext = path.extname(finalPath).toLowerCase();
        const mimeTypes: Record<string, string> = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.ico': 'image/x-icon',
          '.json': 'application/json; charset=utf-8'
        };
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        const stream = fs.createReadStream(finalPath);
        stream.on('error', (err) => {
          logger.error('Error streaming dashboard static asset', {
            component: 'PulseServer',
            file: finalPath,
            error: err instanceof Error ? err.message : String(err)
          });
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Server Error');
          }
        });
        stream.pipe(res);
        return;
      }
    }

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

    const immediateRemote = req.socket.remoteAddress || '127.0.0.1';
    let remoteAddress = immediateRemote;

    if (this.config.trustProxy) {
      const defaultTrusted = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
      const trustedList = this.config.trustedProxies ?? defaultTrusted;
      const trustedSet = new Set(
        trustedList.map((ip) => (ip.startsWith('::ffff:') ? ip.slice(7) : ip))
      );
      const normalizedImmediate = immediateRemote.startsWith('::ffff:')
        ? immediateRemote.slice(7)
        : immediateRemote;

      if (trustedSet.has(normalizedImmediate) || trustedSet.has(immediateRemote)) {
        const forwarded = req.headers['x-forwarded-for'];
        if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
          const firstToken = forwarded.split(',')[0]?.trim();
          if (firstToken) {
            remoteAddress = firstToken;
          }
        }
      }
    }

    const requestId =
      typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].trim().length > 0
        ? req.headers['x-request-id'].trim()
        : undefined;

    const connection = new Connection({
      socket,
      connectionId,
      userId,
      roles,
      remoteAddress,
      maxBufferedAmountBytes: this.config.maxBufferedAmountBytes,
      metricsRegistry: this.metricsRegistry,
      inboundRateLimitMax: this.config.inboundRateLimitMax,
      inboundRateLimitBurst: this.config.inboundRateLimitBurst
    });

    this.connectionManager.addConnection(connection);

    logger.info('New authenticated connection established', {
      component: 'PulseServer',
      event: 'CONNECTION_ESTABLISHED',
      connectionId,
      userId,
      roles,
      remoteAddress,
      ...(requestId ? { requestId } : {})
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
      } else if (
        code === 4000 ||
        connection.isHeartbeatTimedOut ||
        reason.toString().toLowerCase().includes('heartbeat')
      ) {
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

  public drain(drainTimeoutMs?: number): void {
    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;
    const timeout = drainTimeoutMs ?? this.config.drainTimeoutMs ?? 2000;

    logger.info('Initiating graceful draining for PulseServer...', {
      component: 'PulseServer',
      event: 'DRAINING_INITIATED',
      activeConnections: this.connectionManager.getCount(),
      drainTimeoutMs: timeout
    });

    // Notify all connected clients with SYS_SHUTDOWN frame
    const shutdownEnvelope: PulseEventEnvelope = {
      eventId: generateUUIDv7(),
      type: 'SYS_SHUTDOWN',
      timestamp: Date.now(),
      senderId: 'system',
      payload: {
        reason: 'Server shutting down gracefully',
        instanceId: this.config.instanceId,
        drainTimeoutMs: timeout
      }
    };

    const activeConnections = this.connectionManager.getAllConnections();
    for (const conn of activeConnections) {
      conn.send(shutdownEnvelope);
    }
  }

  public async stop(options: { gracePeriodMs?: number } = {}): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    const gracePeriodMs = options.gracePeriodMs ?? this.config.drainTimeoutMs ?? 2000;

    if (!this.isShuttingDown) {
      this.drain(gracePeriodMs);
    }

    logger.info('Initiating graceful shutdown for PulseServer...', {
      component: 'PulseServer',
      event: 'SHUTDOWN_INITIATED',
      activeConnections: this.connectionManager.getCount(),
      gracePeriodMs
    });

    // 1. Stop heartbeat manager sweeps
    this.heartbeatManager.stop();

    // 2. Allow staged handoff window for sockets to self-disconnect gracefully
    await new Promise<void>((resolve) => {
      const startTime = Date.now();
      const checkInterval = setInterval(() => {
        if (this.connectionManager.getCount() === 0 || (Date.now() - startTime) >= gracePeriodMs) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 50);
      if (typeof (checkInterval as any).unref === 'function') {
        (checkInterval as any).unref();
      }
    });

    // 3. Force-close any remaining active connections with RFC 6455 code 1001 (Going Away)
    const activeConnections = this.connectionManager.getAllConnections();
    for (const conn of activeConnections) {
      conn.close(1001, 'Server shutting down');
    }

    // 4. Close WebSocket server and HTTP server
    return new Promise((resolve) => {
      const shutdownTimer = setTimeout(async () => {
        if (this.routexGateway) {
          try {
            await this.routexGateway.close();
          } catch {
            // best-effort
          }
        }
        await this.cleanupAndFinalize();
        resolve();
      }, gracePeriodMs);

      if (this.wss) {
        this.wss.close(() => {
          if (this.httpServer) {
            this.httpServer.close(async () => {
              clearTimeout(shutdownTimer);
              if (this.routexGateway) {
                try {
                  await this.routexGateway.close();
                } catch {
                  // best-effort
                }
              }
              await this.cleanupAndFinalize();
              resolve();
            });
          } else {
            clearTimeout(shutdownTimer);
            (async () => {
              if (this.routexGateway) {
                try {
                  await this.routexGateway.close();
                } catch {
                  // best-effort
                }
              }
              await this.cleanupAndFinalize();
              resolve();
            })();
          }
        });
      } else {
        clearTimeout(shutdownTimer);
        (async () => {
          if (this.routexGateway) {
            try {
              await this.routexGateway.close();
            } catch {
              // best-effort
            }
          }
          await this.cleanupAndFinalize();
          resolve();
        })();
      }
    });
  }

  private async cleanupAndFinalize(): Promise<void> {
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
      try {
        await this.channelRegistry.clear();
      } catch {
        // best-effort
      }
    }
    if (this.redisPubSubManager) {
      try {
        await this.redisPubSubManager.disconnect();
      } catch {
        // best-effort
      }
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
