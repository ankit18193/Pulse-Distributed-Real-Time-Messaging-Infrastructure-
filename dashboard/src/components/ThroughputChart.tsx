import React from 'react';
import { ThroughputPoint } from '../types/telemetry';
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';

interface ThroughputChartProps {
  data: ThroughputPoint[];
  currentInbound: number;
  currentOutbound: number;
}

export const ThroughputChart: React.FC<ThroughputChartProps> = ({
  data,
  currentInbound,
  currentOutbound
}) => {
  const width = 800;
  const height = 180;
  const padding = { top: 20, right: 20, bottom: 25, left: 45 };

  // Calculate max values to scale Y-axis dynamically (minimum 10 to avoid flat empty graph)
  const allValues = data.flatMap((d) => [d.inboundMsgSec, d.outboundMsgSec, currentInbound, currentOutbound]);
  const maxValue = Math.max(10, ...allValues);
  const peakInbound = Math.max(0, ...data.map((d) => d.inboundMsgSec), currentInbound);
  const peakOutbound = Math.max(0, ...data.map((d) => d.outboundMsgSec), currentOutbound);

  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;

  // Generate SVG path for a dataset
  const generatePath = (key: 'inboundMsgSec' | 'outboundMsgSec') => {
    if (data.length === 0) return { line: '', area: '' };

    const points = data.map((d, index) => {
      const x = padding.left + (index / Math.max(1, data.length - 1)) * innerWidth;
      const y = padding.top + innerHeight - (d[key] / maxValue) * innerHeight;
      return { x, y };
    });

    if (points.length === 1) {
      const p = points[0];
      return {
        line: `M ${padding.left} ${p.y} L ${padding.left + innerWidth} ${p.y}`,
        area: `M ${padding.left} ${p.y} L ${padding.left + innerWidth} ${p.y} L ${padding.left + innerWidth} ${padding.top + innerHeight} L ${padding.left} ${padding.top + innerHeight} Z`
      };
    }

    const linePath = points.reduce((acc, p, i) => {
      if (i === 0) return `M ${p.x} ${p.y}`;
      // Smooth cubic bezier curves between points
      const prev = points[i - 1];
      const cx1 = prev.x + (p.x - prev.x) / 2;
      const cy1 = prev.y;
      const cx2 = prev.x + (p.x - prev.x) / 2;
      const cy2 = p.y;
      return `${acc} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${p.x} ${p.y}`;
    }, '');

    const last = points[points.length - 1];
    const first = points[0];
    const areaPath = `${linePath} L ${last.x} ${padding.top + innerHeight} L ${first.x} ${padding.top + innerHeight} Z`;

    return { line: linePath, area: areaPath };
  };

  const ingressPaths = generatePath('inboundMsgSec');
  const egressPaths = generatePath('outboundMsgSec');

  // Grid tick levels
  const yTicks = [0, Math.round(maxValue / 2), Math.round(maxValue)];

  return (
    <div className="telemetry-card" style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Header with KPI summaries */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: '12px',
        flexWrap: 'wrap',
        gap: '10px'
      }}>
        <div>
          <div style={{
            fontSize: '13px',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: 'var(--pulse-text-primary)'
          }}>
            Real-Time Wire Throughput (60-Second Rolling Window)
          </div>
          <div style={{ fontSize: '11px', color: 'var(--pulse-text-muted)', fontFamily: 'var(--font-mono)', marginTop: '2px' }}>
            Telemetry frequency: 1000ms sliding buffer • Zero memory drift
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          {/* Ingress Stats */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <ArrowDownLeft size={16} color="var(--pulse-accent-cyan)" />
            <span style={{ fontSize: '11px', color: 'var(--pulse-text-secondary)', textTransform: 'uppercase' }}>
              Ingress:
            </span>
            <span className="tabular-nums" style={{ fontSize: '13px', fontWeight: 700, color: 'var(--pulse-accent-cyan)' }}>
              {currentInbound.toLocaleString()} msg/s
            </span>
            <span style={{ fontSize: '10px', color: 'var(--pulse-text-muted)', fontFamily: 'var(--font-mono)' }}>
              (peak {peakInbound})
            </span>
          </div>

          {/* Egress Stats */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <ArrowUpRight size={16} color="var(--pulse-accent-emerald)" />
            <span style={{ fontSize: '11px', color: 'var(--pulse-text-secondary)', textTransform: 'uppercase' }}>
              Egress:
            </span>
            <span className="tabular-nums" style={{ fontSize: '13px', fontWeight: 700, color: 'var(--pulse-accent-emerald)' }}>
              {currentOutbound.toLocaleString()} msg/s
            </span>
            <span style={{ fontSize: '10px', color: 'var(--pulse-text-muted)', fontFamily: 'var(--font-mono)' }}>
              (peak {peakOutbound})
            </span>
          </div>
        </div>
      </div>

      {/* SVG Waveform Canvas */}
      <div style={{ width: '100%', overflow: 'hidden', position: 'relative' }}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          style={{ width: '100%', height: 'auto', display: 'block' }}
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id="cyan-gradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--pulse-accent-cyan)" stopOpacity="0.25" />
              <stop offset="100%" stopColor="var(--pulse-accent-cyan)" stopOpacity="0.0" />
            </linearGradient>
            <linearGradient id="emerald-gradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--pulse-accent-emerald)" stopOpacity="0.25" />
              <stop offset="100%" stopColor="var(--pulse-accent-emerald)" stopOpacity="0.0" />
            </linearGradient>
          </defs>

          {/* Horizontal Grid Lines */}
          {yTicks.map((tick) => {
            const y = padding.top + innerHeight - (tick / maxValue) * innerHeight;
            return (
              <g key={tick}>
                <line
                  x1={padding.left}
                  y1={y}
                  x2={width - padding.right}
                  y2={y}
                  stroke="var(--pulse-border-subtle)"
                  strokeDasharray="4 4"
                />
                <text
                  x={padding.left - 8}
                  y={y + 4}
                  fill="var(--pulse-text-muted)"
                  fontSize="10"
                  fontFamily="var(--font-mono)"
                  textAnchor="end"
                >
                  {tick}
                </text>
              </g>
            );
          })}

          {/* Egress Waveform (Emerald) */}
          {egressPaths.area && (
            <path d={egressPaths.area} fill="url(#emerald-gradient)" />
          )}
          {egressPaths.line && (
            <path
              d={egressPaths.line}
              fill="none"
              stroke="var(--pulse-accent-emerald)"
              strokeWidth="2"
              strokeLinecap="round"
            />
          )}

          {/* Ingress Waveform (Cyan) */}
          {ingressPaths.area && (
            <path d={ingressPaths.area} fill="url(#cyan-gradient)" />
          )}
          {ingressPaths.line && (
            <path
              d={ingressPaths.line}
              fill="none"
              stroke="var(--pulse-accent-cyan)"
              strokeWidth="2"
              strokeLinecap="round"
            />
          )}

          {/* Baseline axis */}
          <line
            x1={padding.left}
            y1={padding.top + innerHeight}
            x2={width - padding.right}
            y2={padding.top + innerHeight}
            stroke="var(--pulse-border-medium)"
          />

          {/* Time axis indicators */}
          <text
            x={padding.left}
            y={height - 6}
            fill="var(--pulse-text-muted)"
            fontSize="10"
            fontFamily="var(--font-mono)"
          >
            -60s
          </text>
          <text
            x={padding.left + innerWidth / 2}
            y={height - 6}
            fill="var(--pulse-text-muted)"
            fontSize="10"
            fontFamily="var(--font-mono)"
            textAnchor="middle"
          >
            -30s
          </text>
          <text
            x={width - padding.right}
            y={height - 6}
            fill="var(--pulse-text-muted)"
            fontSize="10"
            fontFamily="var(--font-mono)"
            textAnchor="end"
          >
            LIVE
          </text>
        </svg>
      </div>
    </div>
  );
};
