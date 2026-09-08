import React from 'react';
import { Cpu, AlertCircle } from 'lucide-react';

interface EventLoopGaugeProps {
  lag: {
    mean: number;
    p50: number;
    p99: number;
    max: number;
  };
}

export const EventLoopGauge: React.FC<EventLoopGaugeProps> = ({ lag }) => {
  const p99 = lag.p99 || 0;
  const max = lag.max || 0;
  const mean = lag.mean || 0;
  const p50 = lag.p50 || 0;

  // Thresholds
  let status: 'normal' | 'elevated' | 'degraded' = 'normal';
  let statusColor = 'var(--pulse-accent-emerald)';
  let statusBadge = 'badge-emerald';
  let glyph = '[● OK]';

  if (p99 >= 20 || max >= 50) {
    status = 'degraded';
    statusColor = 'var(--pulse-accent-crimson)';
    statusBadge = 'badge-crimson';
    glyph = '[✖ DEGRADED]';
  } else if (p99 >= 10 || max >= 25) {
    status = 'elevated';
    statusColor = 'var(--pulse-accent-amber)';
    statusBadge = 'badge-amber';
    glyph = '[▲ ELEVATED]';
  }

  // Visual meter percentage (capped at 50ms = 100%)
  const maxScale = 50;
  const p99Percent = Math.min(100, Math.round((p99 / maxScale) * 100));

  return (
    <div className="telemetry-card" style={{ display: 'flex', flexDirection: 'column', minWidth: '280px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Cpu size={16} color="var(--pulse-accent-cyan)" />
          <span style={{
            fontSize: '12px',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: 'var(--pulse-text-secondary)'
          }}>
            Event Loop Lag (I/O Jitter)
          </span>
        </div>
        <span className={`badge ${statusBadge}`}>{glyph}</span>
      </div>

      {/* Primary KPI: p99 Lag */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '8px' }}>
        <span className="tabular-nums" style={{
          fontSize: '32px',
          fontWeight: 700,
          color: statusColor,
          lineHeight: 1
        }}>
          {p99.toFixed(2)}
        </span>
        <span style={{ fontSize: '13px', color: 'var(--pulse-text-muted)', fontFamily: 'var(--font-mono)' }}>
          ms (p99)
        </span>
      </div>

      {/* Gauge bar */}
      <div style={{
        height: '6px',
        width: '100%',
        background: 'rgba(255, 255, 255, 0.08)',
        borderRadius: '3px',
        overflow: 'hidden',
        marginBottom: '12px'
      }}>
        <div style={{
          height: '100%',
          width: `${p99Percent}%`,
          background: statusColor,
          borderRadius: '3px',
          transition: 'width 0.3s ease, background 0.3s ease'
        }} />
      </div>

      {/* Latency Quantile Breakdown Table */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: '6px',
        background: 'var(--pulse-bg-sunken)',
        padding: '8px',
        borderRadius: '6px',
        border: '1px solid var(--pulse-border-subtle)',
        fontFamily: 'var(--font-mono)'
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '10px', color: 'var(--pulse-text-muted)', textTransform: 'uppercase' }}>MEAN</div>
          <div className="tabular-nums" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--pulse-text-primary)' }}>
            {mean.toFixed(1)}ms
          </div>
        </div>

        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '10px', color: 'var(--pulse-text-muted)', textTransform: 'uppercase' }}>p50</div>
          <div className="tabular-nums" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--pulse-text-primary)' }}>
            {p50.toFixed(1)}ms
          </div>
        </div>

        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '10px', color: 'var(--pulse-text-muted)', textTransform: 'uppercase' }}>p99</div>
          <div className="tabular-nums" style={{ fontSize: '12px', fontWeight: 600, color: statusColor }}>
            {p99.toFixed(1)}ms
          </div>
        </div>

        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '10px', color: 'var(--pulse-text-muted)', textTransform: 'uppercase' }}>MAX</div>
          <div className="tabular-nums" style={{ fontSize: '12px', fontWeight: 600, color: max > 30 ? 'var(--pulse-accent-amber)' : 'var(--pulse-text-primary)' }}>
            {max.toFixed(1)}ms
          </div>
        </div>
      </div>

      {status === 'degraded' && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          marginTop: '8px',
          color: 'var(--pulse-accent-crimson)',
          fontSize: '11px',
          fontFamily: 'var(--font-mono)'
        }}>
          <AlertCircle size={12} />
          <span>High event loop starvation detected!</span>
        </div>
      )}
    </div>
  );
};
