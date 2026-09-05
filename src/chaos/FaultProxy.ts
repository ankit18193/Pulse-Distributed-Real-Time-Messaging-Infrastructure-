import net from 'net';
import {
  FaultProxyOptions,
  FaultState,
  FrameDropPredicate,
  LatencyFaultConfig
} from './types.js';
import { WebSocketFrameFilter } from './WebSocketFrameFilter.js';
import { logger } from '../utils/logger.js';

interface SocketPair {
  clientSocket: net.Socket;
  targetSocket: net.Socket;
  clientFilter: WebSocketFrameFilter;
  targetFilter: WebSocketFrameFilter;
}

/**
 * FaultProxy
 *
 * A zero-intrusion programmable TCP loopback proxy that sits between:
 * - Client <-> Pulse Server Node
 * - Pulse Server Node <-> Redis
 *
 * Provides out-of-band fault injection (severance, blackhole, latency, frame dropping)
 * without requiring test switches or modifications to production runtime code.
 */
export class FaultProxy {
  private readonly options: FaultProxyOptions;
  private server: net.Server | null = null;
  private state: FaultState = 'NORMAL';
  private latencyConfig: LatencyFaultConfig | null = null;
  private frameDropPredicate: FrameDropPredicate | null = null;
  private activePairs: Set<SocketPair> = new Set();
  private pendingTimers: Set<NodeJS.Timeout> = new Set();
  private boundPort: number = 0;

  constructor(options: FaultProxyOptions) {
    this.options = {
      ...options,
      mode: options.mode ?? 'tcp'
    };
    this.boundPort = options.listenPort;
  }

  public getState(): FaultState {
    return this.state;
  }

  public getBoundPort(): number {
    return this.boundPort;
  }

  public getActiveConnectionCount(): number {
    return this.activePairs.size;
  }

  /**
   * Starts listening on the configured listenPort.
   */
  public async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((clientSocket) => {
        this.handleClientConnection(clientSocket);
      });

      this.server.on('error', (err) => {
        logger.error('FaultProxy server error', {
          name: this.options.name,
          error: err.message
        });
        reject(err);
      });

      this.server.listen(this.options.listenPort, '127.0.0.1', () => {
        const address = this.server?.address() as net.AddressInfo;
        if (address && typeof address === 'object') {
          this.boundPort = address.port;
        }
        logger.info('FaultProxy started listening', {
          name: this.options.name,
          port: this.boundPort,
          target: `${this.options.targetHost}:${this.options.targetPort}`,
          mode: this.options.mode
        });
        resolve();
      });
    });
  }

  /**
   * Sever Fault Semantics:
   * - Abruptly destroys all currently active client and target sockets (TCP RST/FIN).
   * - Rejects all new incoming connections while severed.
   * - Simulates hardware death, cable cut, or sudden process kill.
   * - Does NOT resurrect destroyed connections upon restore().
   */
  public sever(): void {
    this.state = 'SEVERED';
    logger.warn('FaultProxy severed: destroying all active connections', {
      name: this.options.name,
      activeCount: this.activePairs.size
    });

    for (const pair of Array.from(this.activePairs)) {
      this.cleanupPair(pair, true);
    }
    this.activePairs.clear();
  }

  /**
   * Blackhole Fault Semantics:
   * - Keeps existing TCP connections in ESTABLISHED state.
   * - Silently swallows and discards all incoming bytes in both directions.
   * - Simulates half-open connections, dropped radio links, or frozen routes.
   */
  public blackhole(enabled: boolean): void {
    this.state = enabled ? 'BLACKHOLE' : 'NORMAL';
    logger.warn(`FaultProxy blackhole state set to ${enabled}`, {
      name: this.options.name,
      state: this.state
    });
  }

  /**
   * Latency Injection Semantics:
   * - Enqueues byte stream chunks with delay between minDelayMs and maxDelayMs.
   * - Preserves byte stream FIFO ordering.
   */
  public injectLatency(config: LatencyFaultConfig | null): void {
    this.latencyConfig = config;
    if (config) {
      this.state = 'DEGRADED';
      logger.info('FaultProxy latency injected', {
        name: this.options.name,
        minDelayMs: config.minDelayMs,
        maxDelayMs: config.maxDelayMs
      });
    } else if (this.state === 'DEGRADED') {
      this.state = 'NORMAL';
    }
  }

  /**
   * Frame-Level Drop Semantics:
   * - Uses WebSocketFrameFilter to reconstruct complete RFC 6455 frames.
   * - Evaluates predicate against completed frames, omitting matching frames from stream.
   */
  public dropFrames(predicate: FrameDropPredicate | null): void {
    this.frameDropPredicate = predicate;
    for (const pair of this.activePairs) {
      pair.clientFilter.setDropPredicate(predicate);
      pair.targetFilter.setDropPredicate(predicate);
    }
  }

  /**
   * Restoration Semantics:
   * - Resets fault state to NORMAL.
   * - Clears latency and drop predicates.
   * - Allows new incoming TCP connections.
   * - Resumes forwarding for surviving sockets (e.g. from blackhole).
   * - Does NOT resurrect sockets that were destroyed by sever().
   */
  public restore(): void {
    this.state = 'NORMAL';
    this.latencyConfig = null;
    this.frameDropPredicate = null;

    for (const pair of this.activePairs) {
      pair.clientFilter.setDropPredicate(null);
      pair.targetFilter.setDropPredicate(null);
    }

    logger.info('FaultProxy state restored to NORMAL', {
      name: this.options.name,
      activeSurvivingCount: this.activePairs.size
    });
  }

  /**
   * Shuts down the proxy, destroying all sockets and clearing timers.
   */
  public async close(): Promise<void> {
    for (const timer of this.pendingTimers) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();

    for (const pair of Array.from(this.activePairs)) {
      this.cleanupPair(pair, true);
    }
    this.activePairs.clear();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private handleClientConnection(clientSocket: net.Socket): void {
    // If severed, reject/destroy immediately
    if (this.state === 'SEVERED') {
      clientSocket.destroy();
      return;
    }

    const targetSocket = net.connect({
      host: this.options.targetHost,
      port: this.options.targetPort
    });

    const pair: SocketPair = {
      clientSocket,
      targetSocket,
      clientFilter: new WebSocketFrameFilter(this.frameDropPredicate),
      targetFilter: new WebSocketFrameFilter(this.frameDropPredicate)
    };

    this.activePairs.add(pair);

    const safeClose = () => {
      this.cleanupPair(pair, false);
    };

    clientSocket.on('error', (err) => {
      logger.debug('FaultProxy client socket error', { error: err.message });
      safeClose();
    });

    targetSocket.on('error', (err) => {
      logger.debug('FaultProxy target socket error', { error: err.message });
      safeClose();
    });

    clientSocket.on('close', safeClose);
    targetSocket.on('close', safeClose);

    // Forward client -> target
    clientSocket.on('data', (chunk) => {
      this.forwardTraffic(chunk, pair.clientFilter, targetSocket);
    });

    // Forward target -> client
    targetSocket.on('data', (chunk) => {
      this.forwardTraffic(chunk, pair.targetFilter, clientSocket);
    });
  }

  private forwardTraffic(
    chunk: Buffer,
    filter: WebSocketFrameFilter,
    destinationSocket: net.Socket
  ): void {
    // 1. If severed or blackhole, silently discard
    if (this.state === 'SEVERED' || this.state === 'BLACKHOLE') {
      return;
    }

    // 2. If destination is not writable, skip
    if (destinationSocket.destroyed || !destinationSocket.writable) {
      return;
    }

    // 3. Process through frame filter if in websocket mode
    let buffersToSend: Buffer[];
    if (this.options.mode === 'websocket') {
      buffersToSend = filter.processChunk(chunk);
    } else {
      buffersToSend = [chunk];
    }

    if (buffersToSend.length === 0) {
      return;
    }

    // 4. Handle latency injection or immediate send
    if (this.latencyConfig) {
      const min = this.latencyConfig.minDelayMs;
      const max = this.latencyConfig.maxDelayMs;
      const delay = Math.floor(Math.random() * (max - min + 1)) + min;

      const timer = setTimeout(() => {
        this.pendingTimers.delete(timer);
        if (!destinationSocket.destroyed && destinationSocket.writable) {
          for (const buf of buffersToSend) {
            destinationSocket.write(buf);
          }
        }
      }, delay);

      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      this.pendingTimers.add(timer);
    } else {
      for (const buf of buffersToSend) {
        destinationSocket.write(buf);
      }
    }
  }

  private cleanupPair(pair: SocketPair, forceDestroy: boolean): void {
    if (this.activePairs.has(pair)) {
      this.activePairs.delete(pair);
    }

    if (forceDestroy) {
      if (!pair.clientSocket.destroyed) {
        pair.clientSocket.destroy();
      }
      if (!pair.targetSocket.destroyed) {
        pair.targetSocket.destroy();
      }
    } else {
      if (!pair.clientSocket.destroyed) {
        pair.clientSocket.end();
      }
      if (!pair.targetSocket.destroyed) {
        pair.targetSocket.end();
      }
    }
  }
}
