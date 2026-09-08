export interface ServerStats {
  status: 'healthy' | 'degraded' | 'unhealthy';
  instanceId: string;
  timestamp: string;
  uptime: number;
  connections: {
    active: number;
    total: number;
  };
  rooms: {
    activeCount: number;
    list: Array<{
      id: string;
      subscribersCount: number;
    }>;
  };
  throughput: {
    inbound: {
      totalMessages: number;
      messagesPerSec: number;
      bytesPerSec: number;
    };
    outbound: {
      totalMessages: number;
      messagesPerSec: number;
      bytesPerSec: number;
    };
  };
  eventLoopLag: {
    mean: number;
    p50: number;
    p99: number;
    max: number;
  };
  redis: {
    status: 'connected' | 'reconnecting' | 'disconnected' | 'disabled';
    isCluster: boolean;
    pingLatencyMs: number;
    bufferPending: number;
    pubsubSubscriptions: number;
  };
  presence: {
    totalTrackedUsers: number;
    trackedRooms: number;
  };
}

export interface ThroughputPoint {
  time: string;
  timestamp: number;
  inboundMsgSec: number;
  outboundMsgSec: number;
}

export interface WireFrame {
  id: string;
  timestamp: string;
  direction: 'inbound' | 'outbound';
  type: string;
  action?: string;
  room?: string;
  payload: Record<string, unknown>;
  raw: string;
  sizeBytes: number;
}

export interface SystemEvent {
  id: string;
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  component: string;
  message: string;
  details?: Record<string, unknown>;
}
