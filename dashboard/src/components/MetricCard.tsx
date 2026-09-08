import React from 'react';
import { LucideIcon } from 'lucide-react';

interface MetricCardProps {
  label: string;
  value: string | number;
  subValue?: string;
  icon?: LucideIcon;
  accentColor?: 'cyan' | 'emerald' | 'amber' | 'crimson' | 'violet' | 'default';
  statusGlyph?: string;
  statusLabel?: string;
}

export const MetricCard: React.FC<MetricCardProps> = ({
  label,
  value,
  subValue,
  icon: Icon,
  accentColor = 'cyan',
  statusGlyph,
  statusLabel
}) => {
  const colorMap = {
    cyan: 'var(--pulse-accent-cyan)',
    emerald: 'var(--pulse-accent-emerald)',
    amber: 'var(--pulse-accent-amber)',
    crimson: 'var(--pulse-accent-crimson)',
    violet: 'var(--pulse-accent-violet)',
    default: 'var(--pulse-text-primary)'
  };

  const bgMap = {
    cyan: 'rgba(6, 182, 212, 0.08)',
    emerald: 'rgba(16, 185, 129, 0.08)',
    amber: 'rgba(245, 158, 11, 0.08)',
    crimson: 'rgba(239, 68, 68, 0.08)',
    violet: 'rgba(139, 92, 246, 0.08)',
    default: 'rgba(255, 255, 255, 0.04)'
  };

  const currentAccent = colorMap[accentColor];
  const currentBg = bgMap[accentColor];

  return (
    <div className="telemetry-card" style={{ flex: 1, minWidth: '220px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
        <span style={{
          fontSize: '12px',
          fontWeight: 600,
          color: 'var(--pulse-text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em'
        }}>
          {label}
        </span>
        {Icon && (
          <div style={{
            padding: '4px',
            borderRadius: '6px',
            background: currentBg,
            color: currentAccent
          }}>
            <Icon size={16} />
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '6px' }}>
        <span className="tabular-nums" style={{
          fontSize: '28px',
          fontWeight: 700,
          color: 'var(--pulse-text-primary)',
          letterSpacing: '-0.02em',
          lineHeight: 1.1
        }}>
          {value}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: '18px' }}>
        {subValue && (
          <span style={{ fontSize: '11px', color: 'var(--pulse-text-muted)', fontFamily: 'var(--font-mono)' }}>
            {subValue}
          </span>
        )}

        {statusLabel && (
          <span style={{
            fontSize: '11px',
            fontFamily: 'var(--font-mono)',
            fontWeight: 600,
            color: currentAccent
          }}>
            {statusGlyph} {statusLabel}
          </span>
        )}
      </div>
    </div>
  );
};
