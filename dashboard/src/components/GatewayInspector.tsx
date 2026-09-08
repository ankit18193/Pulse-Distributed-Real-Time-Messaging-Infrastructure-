import React from 'react';
import { ServerStats } from '../types/telemetry';
import { Network, ShieldCheck, Cpu, ArrowRight, CheckCircle2 } from 'lucide-react';

interface GatewayInspectorProps {
  stats: ServerStats | null;
}

export const GatewayInspector: React.FC<GatewayInspectorProps> = ({ stats }) => {
  const upstreamInstance = stats?.instanceId || 'pulse-core-cluster';
  const routes = [
    { method: 'GET', path: '/api/stats', type: 'HTTP API', target: 'Telemetry Controller', auth: 'None', status: 'Active' },
    { method: 'GET', path: '/api/telemetry', type: 'HTTP API (Alias)', target: 'Telemetry Controller', auth: 'None', status: 'Active' },
    { method: 'GET', path: '/dashboard/*', type: 'Static SPA', target: 'Dashboard Static Server', auth: 'Public', status: 'Active' },
    { method: 'GET', path: '/health', type: 'HTTP Probe', target: 'Health Check Handler', auth: 'None', status: 'Active' },
    { method: 'WS', path: '/ws', type: 'WebSocket Upgrade', target: 'Pulse Real-Time Engine (RFC 6455)', auth: 'Token/Optional', status: 'Active' }
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* RouteX Gateway Summary Cards */}
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        <div className="telemetry-card" style={{ flex: 1, minWidth: '220px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span style={{ fontSize: '11px', color: 'var(--pulse-text-secondary)', textTransform: 'uppercase' }}>
              Gateway Engine
            </span>
            <Network size={16} color="var(--pulse-accent-violet)" />
          </div>
          <div style={{ fontSize: '22px', fontWeight: 700, color: 'var(--pulse-accent-violet)' }}>
            RouteX v1.0
          </div>
          <div style={{ fontSize: '11px', color: 'var(--pulse-text-muted)', fontFamily: 'var(--font-mono)', marginTop: '4px' }}>
            Upstream: {upstreamInstance}
          </div>
        </div>

        <div className="telemetry-card" style={{ flex: 1, minWidth: '220px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span style={{ fontSize: '11px', color: 'var(--pulse-text-secondary)', textTransform: 'uppercase' }}>
              Port Multiplexing
            </span>
            <Cpu size={16} color="var(--pulse-accent-cyan)" />
          </div>
          <div className="tabular-nums" style={{ fontSize: '22px', fontWeight: 700, color: 'var(--pulse-accent-cyan)' }}>
            Unified :3000
          </div>
          <div style={{ fontSize: '11px', color: 'var(--pulse-text-muted)', fontFamily: 'var(--font-mono)', marginTop: '4px' }}>
            Zero-overhead RFC 6455 upgrade
          </div>
        </div>

        <div className="telemetry-card" style={{ flex: 1, minWidth: '220px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span style={{ fontSize: '11px', color: 'var(--pulse-text-secondary)', textTransform: 'uppercase' }}>
              Security Pipeline
            </span>
            <ShieldCheck size={16} color="var(--pulse-accent-emerald)" />
          </div>
          <div style={{ fontSize: '22px', fontWeight: 700, color: 'var(--pulse-accent-emerald)' }}>
            Shield Active
          </div>
          <div style={{ fontSize: '11px', color: 'var(--pulse-text-muted)', fontFamily: 'var(--font-mono)', marginTop: '4px' }}>
            CORS Preflight + Path Traversal Guard
          </div>
        </div>
      </div>

      {/* Gateway Routing Table */}
      <div className="telemetry-card">
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '14px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Network size={16} color="var(--pulse-accent-violet)" />
            <span style={{ fontSize: '13px', fontWeight: 600, textTransform: 'uppercase', color: 'var(--pulse-text-primary)' }}>
              Registered Route Table & Pipeline
            </span>
          </div>
          <span className="badge badge-violet">{routes.length} Registered Endpoints</span>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontFamily: 'var(--font-mono)',
            fontSize: '12px',
            textAlign: 'left'
          }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--pulse-border-medium)', color: 'var(--pulse-text-muted)' }}>
                <th style={{ padding: '8px 12px', fontWeight: 600 }}>METHOD</th>
                <th style={{ padding: '8px 12px', fontWeight: 600 }}>URI PATTERN</th>
                <th style={{ padding: '8px 12px', fontWeight: 600 }}>TYPE</th>
                <th style={{ padding: '8px 12px', fontWeight: 600 }}>DISPATCH TARGET</th>
                <th style={{ padding: '8px 12px', fontWeight: 600 }}>STATUS</th>
              </tr>
            </thead>
            <tbody>
              {routes.map((route, idx) => (
                <tr
                  key={idx}
                  style={{
                    borderBottom: '1px solid var(--pulse-border-subtle)',
                    background: idx % 2 === 0 ? 'transparent' : 'rgba(255, 255, 255, 0.01)'
                  }}
                >
                  <td style={{ padding: '10px 12px' }}>
                    <span className={`badge ${route.method === 'WS' ? 'badge-cyan' : 'badge-violet'}`}>
                      {route.method}
                    </span>
                  </td>
                  <td style={{ padding: '10px 12px', color: 'var(--pulse-text-primary)', fontWeight: 600 }}>
                    {route.path}
                  </td>
                  <td style={{ padding: '10px 12px', color: 'var(--pulse-text-secondary)' }}>
                    {route.type}
                  </td>
                  <td style={{ padding: '10px 12px', color: 'var(--pulse-text-secondary)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <ArrowRight size={12} color="var(--pulse-accent-violet)" />
                      <span>{route.target}</span>
                    </div>
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <span className="badge badge-emerald">
                      <CheckCircle2 size={11} /> {route.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
