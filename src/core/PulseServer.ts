import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';
import { PulseConfig, PulseEventEnvelope } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { Connection } from './Connection.js';
import { ConnectionManager } from './ConnectionManager.js';
import { Authenticator, AuthResult } from '../auth/Authenticator.js';

export interface PulseServerHooks {
  onConnectionAuthenticated?: (connection: Connection) => void;
  onConnectionClosed?: (connection: Connection, code: number, reason: string) => void;
}

export class PulseServer {
  private readonly config: PulseConfig;
  private readonly connectionManager: ConnectionManager;
  private readonly authenticator: Authenticator;
  private readonly hooks: PulseServerHooks;
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private isRunning: boolean = false;
  private isShuttingDown: boolean = false;

  constructor(config: PulseConfig, hooks: PulseServerHooks = {}) {
    this.config = config;
    this.hooks = hooks;
    this.connectionManager = new ConnectionManager();
    this.authenticator = new Authenticator(this.config.authSecret);
    logger.setInstanceId(this.config.instanceId);
  }

  public getConfig(): PulseConfig {
    return this.config;
  }

  public getConnectionManager(): ConnectionManager {
    return this.connectionManager;
  }

  public getAuthenticator(): Authenticator {
    return this.authenticator;
  }

  public getHttpServer(): http.Server | null {
    return this.httpServer;
  }

  public getWss(): WebSocketServer | null {
    return this.wss;
  }

  public getActiveConnectionCount(): number {
    return this.connectionManager.getCount();
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Pulse server start requested but server is already running', {
        component: 'PulseServer',
        event: 'ALREADY_RUNNING'
      });
      return;
    }

    return new Promise<void>((resolve, reject) => {
      try {
        this.httpServer = http.createServer((req, res) => {
          if (req.url === '/healthz') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                status: 'OK',
                instanceId: this.config.instanceId,
                connections: this.connectionManager.getCount(),
                uniqueUsers: this.connectionManager.getUserCount()
              })
            );
            return;
          }

          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Pulse Realtime Infrastructure');
        });

        // Use noServer mode so we can control the upgrade and authenticate first
        this.wss = new WebSocketServer({
          noServer: true,
          maxPayload: this.config.maxPayloadBytes
        });

        this.httpServer.on('upgrade', (req: http.IncomingMessage, socket, head) => {
          if (this.isShuttingDown) {
            socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
            socket.destroy();
            return;
          }

          const authResult = this.authenticator.authenticateRequest(req);
          if (!authResult.authenticated) {
            const body = JSON.stringify({ error: authResult.error || 'Unauthorized' });
            socket.write(
              'HTTP/1.1 401 Unauthorized\r\n' +
                'Content-Type: application/json\r\n' +
                `Content-Length: ${Buffer.byteLength(body)}\r\n` +
                'Connection: close\r\n\r\n' +
                body
            );
            socket.destroy();
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
          logger.info('Pulse Realtime Engine started successfully', {
            component: 'PulseServer',
            event: 'SERVER_STARTED',
            port: this.config.port,
            host: this.config.host,
            instanceId: this.config.instanceId
          });
          resolve();
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private handleAuthenticatedConnection(
    socket: WebSocket,
    req: http.IncomingMessage,
    auth: AuthResult
  ): void {
    if (this.isShuttingDown) {
      socket.close(1001, 'Server shutting down');
      return;
    }

    const connection = new Connection({
      userId: auth.userId!,
      roles: auth.roles,
      socket,
      remoteAddress: req.socket.remoteAddress
    });

    this.connectionManager.addConnection(connection);

    logger.info('Realtime connection authenticated and bound', {
      component: 'PulseServer',
      event: 'CONNECTION_BOUND',
      connectionId: connection.connectionId,
      userId: connection.userId,
      roles: connection.roles,
      remoteAddress: connection.remoteAddress
    });

    // Emit connection ack frame to client
    const ackEnvelope: PulseEventEnvelope = {
      eventId: crypto.randomUUID(),
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

    socket.on('close', (code, reason) => {
      this.connectionManager.removeConnection(connection.connectionId);
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

  public async stop(): Promise<void> {
    if (!this.isRunning && !this.httpServer) {
      return;
    }

    this.isShuttingDown = true;
    logger.info('Stopping Pulse Realtime Engine...', {
      component: 'PulseServer',
      event: 'SERVER_STOPPING',
      activeConnections: this.connectionManager.getCount()
    });

    // Cleanly close all managed connections
    const conns = this.connectionManager.getAllConnections();
    for (const conn of conns) {
      conn.close(1001, 'Server shutting down');
    }
    this.connectionManager.clear();

    return new Promise<void>((resolve) => {
      if (this.wss) {
        this.wss.close(() => {
          if (this.httpServer) {
            this.httpServer.close(() => {
              this.isRunning = false;
              this.isShuttingDown = false;
              logger.info('Pulse Realtime Engine stopped cleanly', {
                component: 'PulseServer',
                event: 'SERVER_STOPPED'
              });
              resolve();
            });
          } else {
            this.isRunning = false;
            this.isShuttingDown = false;
            resolve();
          }
        });
      } else if (this.httpServer) {
        this.httpServer.close(() => {
          this.isRunning = false;
          this.isShuttingDown = false;
          resolve();
        });
      } else {
        this.isRunning = false;
        this.isShuttingDown = false;
        resolve();
      }
    });
  }
}
