import { Connection } from './Connection.js';
import { logger } from '../utils/logger.js';
import type { ChannelRegistry } from '../redis/ChannelRegistry.js';
import type { PulseMetricsRegistry } from '../metrics/PulseMetricsRegistry.js';

export class ConnectionManager {
  private readonly connections: Map<string, Connection> = new Map();
  private readonly userConnections: Map<string, Set<string>> = new Map();
  private channelRegistry?: ChannelRegistry;
  private metricsRegistry?: PulseMetricsRegistry;

  constructor(channelRegistry?: ChannelRegistry, metricsRegistry?: PulseMetricsRegistry) {
    this.channelRegistry = channelRegistry;
    this.metricsRegistry = metricsRegistry;
  }

  public setMetricsRegistry(metricsRegistry: PulseMetricsRegistry): void {
    this.metricsRegistry = metricsRegistry;
  }

  public setChannelRegistry(channelRegistry: ChannelRegistry): void {
    this.channelRegistry = channelRegistry;
  }

  public getChannelRegistry(): ChannelRegistry | undefined {
    return this.channelRegistry;
  }

  public addConnection(connection: Connection): void {
    this.connections.set(connection.connectionId, connection);

    let userConns = this.userConnections.get(connection.userId);
    if (!userConns) {
      userConns = new Set<string>();
      this.userConnections.set(connection.userId, userConns);
    }
    userConns.add(connection.connectionId);

    if (this.channelRegistry) {
      this.channelRegistry.subscribeUser(connection.userId).catch((err) => {
        logger.warn('Failed to subscribe user channel in Redis channel registry', {
          component: 'ConnectionManager',
          userId: connection.userId,
          connectionId: connection.connectionId,
          error: err instanceof Error ? err.message : String(err)
        });
      });
    }

    this.metricsRegistry?.getGauge('pulse_connections_active')?.set(this.connections.size);

    logger.debug('Registered connection in ConnectionManager', {
      component: 'ConnectionManager',
      event: 'CONNECTION_REGISTERED',
      connectionId: connection.connectionId,
      userId: connection.userId,
      userActiveConnectionCount: userConns.size,
      totalActiveConnections: this.connections.size
    });
  }

  public removeConnection(connectionId: string): Connection | undefined {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return undefined;
    }

    this.connections.delete(connectionId);

    const userConns = this.userConnections.get(connection.userId);
    if (userConns) {
      userConns.delete(connectionId);
      if (userConns.size === 0) {
        this.userConnections.delete(connection.userId);
      }
    }

    if (this.channelRegistry) {
      this.channelRegistry.unsubscribeUser(connection.userId).catch((err) => {
        logger.warn('Failed to unsubscribe user channel in Redis channel registry', {
          component: 'ConnectionManager',
          userId: connection.userId,
          connectionId: connection.connectionId,
          error: err instanceof Error ? err.message : String(err)
        });
      });
    }

    connection.markCleanedUp();

    this.metricsRegistry?.getGauge('pulse_connections_active')?.set(this.connections.size);

    logger.debug('Unregistered connection from ConnectionManager', {
      component: 'ConnectionManager',
      event: 'CONNECTION_UNREGISTERED',
      connectionId,
      userId: connection.userId,
      userRemainingConnections: userConns ? userConns.size : 0,
      totalActiveConnections: this.connections.size
    });

    return connection;
  }

  public getConnection(connectionId: string): Connection | undefined {
    return this.connections.get(connectionId);
  }

  public getConnectionsByUserId(userId: string): Connection[] {
    const connIds = this.userConnections.get(userId);
    if (!connIds || connIds.size === 0) {
      return [];
    }

    const result: Connection[] = [];
    for (const id of connIds) {
      const conn = this.connections.get(id);
      if (conn) {
        result.push(conn);
      }
    }
    return result;
  }

  public getAllConnections(): Connection[] {
    return Array.from(this.connections.values());
  }

  public getCount(): number {
    return this.connections.size;
  }

  public getUserCount(): number {
    return this.userConnections.size;
  }

  public clear(): void {
    this.connections.clear();
    this.userConnections.clear();
    this.metricsRegistry?.getGauge('pulse_connections_active')?.set(0);
  }
}
