import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';
import { PulseConfig } from '../types/index.js';
import { logger } from '../utils/logger.js';

export interface PulseServerEvents {
  onConnection?: (socket: WebSocket, request: http.IncomingMessage) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}

export class PulseServer {
  private readonly config: PulseConfig;
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private isRunning: boolean = false;
  private isShuttingDown: boolean = false;
  private activeSockets: Set<WebSocket> = new Set();

  constructor(config: PulseConfig) {
    this.config = config;
    logger.setInstanceId(this.config.instanceId);
  }

  public getConfig(): PulseConfig {
    return this.config;
  }

  public getHttpServer(): http.Server | null {
    return this.httpServer;
  }

  public getWss(): WebSocketServer | null {
    return this.wss;
  }

  public getActiveConnectionCount(): number {
    return this.activeSockets.size;
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
          // Minimal Phase 1 health check endpoint
          if (req.url === '/healthz') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                status: 'OK',
                instanceId: this.config.instanceId,
                connections: this.activeSockets.size
              })
            );
            return;
          }

          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Pulse Realtime Infrastructure');
        });

        this.wss = new WebSocketServer({
          server: this.httpServer,
          maxPayload: this.config.maxPayloadBytes
        });

        this.wss.on('connection', (socket: WebSocket, req: http.IncomingMessage) => {
          this.handleRawConnection(socket, req);
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

  private handleRawConnection(socket: WebSocket, req: http.IncomingMessage): void {
    if (this.isShuttingDown) {
      socket.close(1001, 'Server shutting down');
      return;
    }

    this.activeSockets.add(socket);

    const remoteAddress = req.socket.remoteAddress;
    logger.debug('New incoming WebSocket transport connection accepted', {
      component: 'PulseServer',
      event: 'SOCKET_CONNECTED',
      remoteAddress
    });

    socket.on('close', (code, reason) => {
      this.activeSockets.delete(socket);
      logger.debug('WebSocket transport connection closed', {
        component: 'PulseServer',
        event: 'SOCKET_CLOSED',
        code,
        reason: reason.toString()
      });
    });

    socket.on('error', (err) => {
      logger.error('WebSocket transport error', {
        component: 'PulseServer',
        event: 'SOCKET_ERROR',
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
      activeConnections: this.activeSockets.size
    });

    // Terminate active sockets cleanly
    for (const socket of this.activeSockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1001, 'Server shutting down');
      }
    }
    this.activeSockets.clear();

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
