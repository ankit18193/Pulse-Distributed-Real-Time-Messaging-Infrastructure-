import { Connection } from './Connection.js';
import { logger } from '../utils/logger.js';

export class ConnectionManager {
  private readonly connections: Map<string, Connection> = new Map();
  private readonly userConnections: Map<string, Set<string>> = new Map();

  public addConnection(connection: Connection): void {
    this.connections.set(connection.connectionId, connection);

    let userConns = this.userConnections.get(connection.userId);
    if (!userConns) {
      userConns = new Set<string>();
      this.userConnections.set(connection.userId, userConns);
    }
    userConns.add(connection.connectionId);

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

    connection.markCleanedUp();

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
  }
}
