import React, { useState, useEffect, useRef } from 'react';
import { SystemEvent } from '../types/telemetry';
import { Terminal, Search, ArrowDown } from 'lucide-react';

interface EventStreamProps {
  events: SystemEvent[];
}

export const EventStream: React.FC<EventStreamProps> = ({ events }) => {
  const [filter, setFilter] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const filteredEvents = events.filter((e) => {
    if (!filter) return true;
    const query = filter.toLowerCase();
    return (
      e.message.toLowerCase().includes(query) ||
      e.component.toLowerCase().includes(query) ||
      e.level.toLowerCase().includes(query)
    );
  });

  useEffect(() => {
    if (autoScroll && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [events, autoScroll]);

  return (
    <div className="telemetry-card" style={{ display: 'flex', flexDirection: 'column', height: '280px' }}>
      {/* Controls Bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: '10px',
        gap: '10px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Terminal size={16} color="var(--pulse-accent-cyan)" />
          <span style={{
            fontSize: '12px',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: 'var(--pulse-text-primary)'
          }}>
            Infrastructure Event Journal
          </span>
          <span className="badge badge-muted" style={{ fontSize: '10px' }}>
            {filteredEvents.length} events
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {/* Search Box */}
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <Search size={13} style={{ position: 'absolute', left: '8px', color: 'var(--pulse-text-muted)' }} />
            <input
              type="text"
              placeholder="Filter events..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{
                paddingLeft: '26px',
                paddingTop: '4px',
                paddingBottom: '4px',
                fontSize: '12px',
                width: '150px'
              }}
            />
          </div>

          {/* Auto Scroll Toggle */}
          <button
            onClick={() => setAutoScroll((prev) => !prev)}
            className={`btn-secondary ${autoScroll ? 'glow-cyan' : ''}`}
            style={{ padding: '4px 8px', fontSize: '11px' }}
            title="Toggle auto-scroll to latest"
          >
            <ArrowDown size={12} color={autoScroll ? 'var(--pulse-accent-cyan)' : 'var(--pulse-text-muted)'} />
            <span>Stick</span>
          </button>
        </div>
      </div>

      {/* Log Console Viewport */}
      <div style={{
        flex: 1,
        background: 'var(--pulse-bg-sunken)',
        borderRadius: '6px',
        border: '1px solid var(--pulse-border-subtle)',
        overflowY: 'auto',
        padding: '8px 12px',
        fontFamily: 'var(--font-mono)',
        fontSize: '11px',
        lineHeight: 1.6
      }}>
        {filteredEvents.length === 0 ? (
          <div style={{ color: 'var(--pulse-text-muted)', textAlign: 'center', paddingTop: '30px' }}>
            No matching infrastructure events recorded in current session.
          </div>
        ) : (
          filteredEvents.map((evt) => {
            const levelClass =
              evt.level === 'ERROR' ? 'badge-crimson' :
              evt.level === 'WARN' ? 'badge-amber' : 'badge-cyan';

            return (
              <div key={evt.id} style={{ display: 'flex', alignItems: 'baseline', gap: '8px', padding: '2px 0' }}>
                <span style={{ color: 'var(--pulse-text-muted)', flexShrink: 0 }}>
                  {evt.timestamp}
                </span>
                <span className={`badge ${levelClass}`} style={{ fontSize: '9px', padding: '0px 4px', flexShrink: 0 }}>
                  {evt.level}
                </span>
                <span style={{ color: 'var(--pulse-accent-violet)', flexShrink: 0 }}>
                  [{evt.component}]
                </span>
                <span style={{ color: 'var(--pulse-text-primary)', wordBreak: 'break-all' }}>
                  {evt.message}
                </span>
              </div>
            );
          })
        )}
        <div ref={logEndRef} />
      </div>
    </div>
  );
};
