import React from 'react';
import { ServerStats } from '../types/telemetry';
import { Users, Network, Activity, Database, ArrowRight, ArrowLeftRight } from 'lucide-react';

interface TopologyGridProps {
  stats: ServerStats | null;
  isConnected: boolean;
}

export const TopologyGrid: React.FC<TopologyGridProps> = ({ stats, isConnected }) => {
  const activeConns = stats?.connections?.active || 0;
  const activeRooms = stats?.rooms?.activeCount || 0;
  const redisStatus = stats?.redis?.status || 'disconnected';
  const redisLatency = stats?.redis?.pingLatencyMs || 0;
  const redisSubs = stats?.redis?.pubsubSubscriptions || 0;

  return (
    <div className="telemetry-card" style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{
        fontSize: '13px',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        color: 'var(--pulse-text-primary)',
        marginBottom: '14px'
      }}>
        Distributed Subsystem Topology & Data Flow
      </div>

      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        overflowX: 'auto',
        padding: '10px 0'
      }}>
        {/* Node 1: Connected Clients */}
        <div style={{
          flex: 1,
          minWidth: '180px',
          background: 'var(--pulse-bg-surface)',
          border: '1px solid var(--pulse-border-subtle)',
          borderRadius: '8px',
          padding: '14px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--pulse-text-secondary)', textTransform: 'uppercase' }}>
              Clients Ingress
            </span>
            <Users size={16} color="var(--pulse-accent-cyan)" />
          </div>
          <div className="tabular-nums" style={{ fontSize: '20px', fontWeight: 700, color: 'var(--pulse-accent-cyan)' }}>
            {activeConns} Active
          </div>
          <div style={{ fontSize: '11px', color: 'var(--pulse-text-muted)', fontFamily: 'var(--font-mono)', marginTop: '4px' }}>
            WS / WSS Protocols
          </div>
          <div style={{ marginTop: '8px' }}>
            <span className="badge badge-cyan">[● STREAMING]</span>
          </div>
        </div>

        {/* Link 1 -> 2 */}
        <div style={{ display: 'flex', alignItems: 'center', color: 'var(--pulse-border-medium)' }}>
          <ArrowRight size={20} color="var(--pulse-accent-cyan)" />
        </div>

        {/* Node 2: RouteX API Gateway */}
        <div style={{
          flex: 1,
          minWidth: '180px',
          background: 'var(--pulse-bg-surface)',
          border: '1px solid var(--pulse-border-subtle)',
          borderRadius: '8px',
          padding: '14px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--pulse-text-secondary)', textTransform: 'uppercase' }}>
              RouteX Gateway
            </span>
            <Network size={16} color="var(--pulse-accent-violet)" />
          </div>
          <div className="tabular-nums" style={{ fontSize: '20px', fontWeight: 700, color: 'var(--pulse-accent-violet)' }}>
            Unified :3000
          </div>
          <div style={{ fontSize: '11px', color: 'var(--pulse-text-muted)', fontFamily: 'var(--font-mono)', marginTop: '4px' }}>
            HTTP / WS Reverse Proxy
          </div>
          <div style={{ marginTop: '8px' }}>
            <span className="badge badge-violet">[● ROUTING]</span>
          </div>
        </div>

        {/* Link 2 -> 3 */}
        <div style={{ display: 'flex', alignItems: 'center', color: 'var(--pulse-border-medium)' }}>
          <ArrowRight size={20} color="var(--pulse-accent-violet)" />
        </div>

        {/* Node 3: Pulse Core Engine */}
        <div style={{
          flex: 1,
          minWidth: '180px',
          background: 'var(--pulse-bg-surface)',
          border: isConnected ? '1px solid var(--pulse-accent-cyan)' : '1px solid var(--pulse-accent-crimson)',
          boxShadow: isConnected ? 'var(--pulse-glow-cyan)' : 'none',
          borderRadius: '8px',
          padding: '14px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--pulse-text-secondary)', textTransform: 'uppercase' }}>
              Pulse Engine
            </span>
            <Activity size={16} color="var(--pulse-accent-cyan)" />
          </div>
          <div className="tabular-nums" style={{ fontSize: '20px', fontWeight: 700, color: 'var(--pulse-text-primary)' }}>
            {activeRooms} Rooms
          </div>
          <div style={{ fontSize: '11px', color: 'var(--pulse-text-muted)', fontFamily: 'var(--font-mono)', marginTop: '4px' }}>
            Room & Event Dispatcher
          </div>
          <div style={{ marginTop: '8px' }}>
            <span className={`badge ${isConnected ? 'badge-emerald' : 'badge-crimson'}`}>
              {isConnected ? '[● CORE READY]' : '[✖ UNREACHABLE]'}
            </span>
          </div>
        </div>

        {/* Link 3 <-> 4 */}
        <div style={{ display: 'flex', alignItems: 'center', color: 'var(--pulse-border-medium)' }}>
          <ArrowLeftRight size={20} color={redisStatus === 'connected' ? 'var(--pulse-accent-emerald)' : 'var(--pulse-text-muted)'} />
        </div>

        {/* Node 4: Redis Pub/Sub Cluster */}
        <div style={{
          flex: 1,
          minWidth: '180px',
          background: 'var(--pulse-bg-surface)',
          border: '1px solid var(--pulse-border-subtle)',
          borderRadius: '8px',
          padding: '14px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--pulse-text-secondary)', textTransform: 'uppercase' }}>
              Redis Pub/Sub
            </span>
            <Database size={16} color="var(--pulse-accent-emerald)" />
          </div>
          <div className="tabular-nums" style={{ fontSize: '20px', fontWeight: 700, color: redisStatus === 'connected' ? 'var(--pulse-accent-emerald)' : 'var(--pulse-accent-amber)' }}>
            {redisStatus === 'connected' ? `${redisLatency}ms Ping` : redisStatus.toUpperCase()}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--pulse-text-muted)', fontFamily: 'var(--font-mono)', marginTop: '4px' }}>
            {redisSubs} Subscriptions
          </div>
          <div style={{ marginTop: '8px' }}>
            <span className={`badge ${redisStatus === 'connected' ? 'badge-emerald' : 'badge-amber'}`}>
              {redisStatus === 'connected' ? '[● CONNECTED]' : `[▲ ${redisStatus.toUpperCase()}]`}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
