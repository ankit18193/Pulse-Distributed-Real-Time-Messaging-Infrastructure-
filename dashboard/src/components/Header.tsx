import React from 'react';
import { ServerStats } from '../types/telemetry';
import { Activity, Play, Pause, RefreshCw, Copy, Check, Clock } from 'lucide-react';

interface HeaderProps {
  stats: ServerStats | null;
  isConnected: boolean;
  isPaused: boolean;
  pollInterval: number;
  latencyMs: number;
  onTogglePause: () => void;
  onManualRefresh: () => void;
  onIntervalChange: (interval: number) => void;
}

export const Header: React.FC<HeaderProps> = ({
  stats,
  isConnected,
  isPaused,
  pollInterval,
  latencyMs,
  onTogglePause,
  onManualRefresh,
  onIntervalChange
}) => {
  const [copied, setCopied] = React.useState(false);

  const instanceId = stats?.instanceId || 'pulse-cluster-node';
  const status = !isConnected ? 'unhealthy' : (stats?.status || 'healthy');

  const copyInstanceId = () => {
    navigator.clipboard.writeText(instanceId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const formatUptime = (seconds: number = 0) => {
    const days = Math.floor(seconds / 86400);
    const hrs = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hrs > 0) parts.push(`${hrs}h`);
    if (mins > 0) parts.push(`${mins}m`);
    parts.push(`${secs}s`);
    return parts.join(' ');
  };

  return (
    <header style={{
      height: '60px',
      backgroundColor: 'var(--pulse-bg-surface)',
      borderBottom: '1px solid var(--pulse-border-subtle)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 20px',
      position: 'sticky',
      top: 0,
      zIndex: 50
    }}>
      {/* Brand & Identity */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '34px',
          height: '34px',
          borderRadius: '8px',
          background: 'rgba(6, 182, 212, 0.12)',
          border: '1px solid rgba(6, 182, 212, 0.3)',
          color: 'var(--pulse-accent-cyan)'
        }}>
          <Activity size={20} />
        </div>

        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <h1 style={{
              fontSize: '15px',
              fontWeight: 700,
              letterSpacing: '0.04em',
              color: 'var(--pulse-text-primary)',
              textTransform: 'uppercase'
            }}>
              Pulse Mission Control
            </h1>
            <span className="badge badge-cyan">v0.1.0-prod</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
            <span style={{ fontSize: '11px', color: 'var(--pulse-text-muted)', fontFamily: 'var(--font-mono)' }}>
              NODE:
            </span>
            <button
              onClick={copyInstanceId}
              title="Click to copy instance ID"
              style={{
                background: 'transparent',
                color: 'var(--pulse-text-secondary)',
                fontSize: '11px',
                fontFamily: 'var(--font-mono)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                padding: '1px 4px',
                borderRadius: '3px'
              }}
            >
              <span>{instanceId}</span>
              {copied ? <Check size={11} color="var(--pulse-accent-emerald)" /> : <Copy size={11} />}
            </button>
          </div>
        </div>
      </div>

      {/* Cluster Status & Telemetry Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        {/* Live Status Beacon */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '4px 10px',
          borderRadius: '20px',
          background: 'var(--pulse-bg-card)',
          border: '1px solid var(--pulse-border-subtle)'
        }}>
          <div className={
            status === 'healthy' ? 'beacon-healthy' :
            status === 'degraded' ? 'beacon-degraded' : 'beacon-offline'
          } />
          <span style={{
            fontSize: '12px',
            fontFamily: 'var(--font-mono)',
            fontWeight: 600,
            color: status === 'healthy' ? 'var(--pulse-accent-emerald)' :
                   status === 'degraded' ? 'var(--pulse-accent-amber)' : 'var(--pulse-accent-crimson)'
          }}>
            {status === 'healthy' ? '[● OPERATIONAL]' :
             status === 'degraded' ? '[▲ DEGRADED]' : '[✖ OFFLINE]'}
          </span>
          <span style={{ fontSize: '11px', color: 'var(--pulse-text-muted)', fontFamily: 'var(--font-mono)' }}>
            ({latencyMs}ms)
          </span>
        </div>

        {/* Uptime Badge */}
        {stats && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '12px',
            color: 'var(--pulse-text-secondary)',
            fontFamily: 'var(--font-mono)',
            background: 'var(--pulse-bg-card)',
            padding: '4px 10px',
            borderRadius: '6px',
            border: '1px solid var(--pulse-border-subtle)'
          }}>
            <Clock size={13} color="var(--pulse-text-muted)" />
            <span>UP: {formatUptime(stats.uptime)}</span>
          </div>
        )}

        {/* Polling Interval Selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <label htmlFor="poll-interval" style={{ fontSize: '12px', color: 'var(--pulse-text-muted)' }}>
            Rate:
          </label>
          <select
            id="poll-interval"
            value={pollInterval}
            onChange={(e) => onIntervalChange(Number(e.target.value))}
            style={{ fontSize: '12px', padding: '4px 8px' }}
          >
            <option value={500}>500ms (High)</option>
            <option value={1000}>1.0s (Normal)</option>
            <option value={2000}>2.0s (Eco)</option>
            <option value={5000}>5.0s (Low)</option>
          </select>
        </div>

        {/* Pause / Resume Button */}
        <button
          onClick={onTogglePause}
          className="btn-secondary"
          style={{ padding: '6px 10px', fontSize: '12px' }}
          title="Pause or resume live telemetry (Shortcut: Space)"
        >
          {isPaused ? (
            <>
              <Play size={13} color="var(--pulse-accent-emerald)" />
              <span>Resume</span>
            </>
          ) : (
            <>
              <Pause size={13} color="var(--pulse-accent-amber)" />
              <span>Pause</span>
            </>
          )}
        </button>

        {/* Manual Refresh */}
        <button
          onClick={onManualRefresh}
          className="btn-secondary"
          style={{ padding: '6px 8px' }}
          title="Force telemetry poll now"
        >
          <RefreshCw size={13} />
        </button>
      </div>
    </header>
  );
};
