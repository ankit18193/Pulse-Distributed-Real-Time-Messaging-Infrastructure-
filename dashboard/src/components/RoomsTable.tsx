import React, { useState } from 'react';
import { ServerStats } from '../types/telemetry';
import { Search, Radio, Hash } from 'lucide-react';

interface RoomsTableProps {
  stats: ServerStats | null;
  onSelectRoom?: (roomName: string) => void;
}

export const RoomsTable: React.FC<RoomsTableProps> = ({ stats, onSelectRoom }) => {
  const [search, setSearch] = useState('');

  const roomsList = stats?.rooms?.list || [];
  const totalSubscribers = roomsList.reduce((acc, r) => acc + (r.subscribersCount || 0), 0);
  const totalPresenceUsers = stats?.presence?.totalTrackedUsers || 0;

  const filteredRooms = roomsList.filter((r) =>
    r.id.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Presence & Room Summary Cards */}
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        <div className="telemetry-card" style={{ flex: 1, minWidth: '200px' }}>
          <div style={{ fontSize: '11px', color: 'var(--pulse-text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>
            Active Channels
          </div>
          <div className="tabular-nums" style={{ fontSize: '24px', fontWeight: 700, color: 'var(--pulse-accent-cyan)' }}>
            {roomsList.length}
          </div>
        </div>

        <div className="telemetry-card" style={{ flex: 1, minWidth: '200px' }}>
          <div style={{ fontSize: '11px', color: 'var(--pulse-text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>
            Total Subscriptions
          </div>
          <div className="tabular-nums" style={{ fontSize: '24px', fontWeight: 700, color: 'var(--pulse-accent-emerald)' }}>
            {totalSubscribers}
          </div>
        </div>

        <div className="telemetry-card" style={{ flex: 1, minWidth: '200px' }}>
          <div style={{ fontSize: '11px', color: 'var(--pulse-text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>
            Tracked Presence Users
          </div>
          <div className="tabular-nums" style={{ fontSize: '24px', fontWeight: 700, color: 'var(--pulse-accent-violet)' }}>
            {totalPresenceUsers}
          </div>
        </div>
      </div>

      {/* Rooms Table Card */}
      <div className="telemetry-card">
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '14px',
          gap: '12px',
          flexWrap: 'wrap'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Radio size={16} color="var(--pulse-accent-cyan)" />
            <span style={{ fontSize: '13px', fontWeight: 600, textTransform: 'uppercase', color: 'var(--pulse-text-primary)' }}>
              Active Room Registry
            </span>
            <span className="badge badge-cyan">{filteredRooms.length} rooms</span>
          </div>

          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <Search size={14} style={{ position: 'absolute', left: '10px', color: 'var(--pulse-text-muted)' }} />
            <input
              type="text"
              placeholder="Search rooms..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ paddingLeft: '30px', fontSize: '12px', width: '220px' }}
            />
          </div>
        </div>

        {/* Table */}
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
                <th style={{ padding: '8px 12px', fontWeight: 600 }}>ROOM IDENTIFIER</th>
                <th style={{ padding: '8px 12px', fontWeight: 600 }}>LOCAL SUBSCRIBERS</th>
                <th style={{ padding: '8px 12px', fontWeight: 600 }}>STATUS</th>
                <th style={{ padding: '8px 12px', fontWeight: 600, textAlign: 'right' }}>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {filteredRooms.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ padding: '24px', textAlign: 'center', color: 'var(--pulse-text-muted)' }}>
                    {roomsList.length === 0 ? 'No active rooms currently instantiated.' : 'No rooms match search query.'}
                  </td>
                </tr>
              ) : (
                filteredRooms.map((room) => (
                  <tr
                    key={room.id}
                    style={{
                      borderBottom: '1px solid var(--pulse-border-subtle)',
                      transition: 'background 0.1s ease'
                    }}
                  >
                    <td style={{ padding: '10px 12px', color: 'var(--pulse-text-primary)', fontWeight: 600 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <Hash size={14} color="var(--pulse-accent-cyan)" />
                        <span>{room.id}</span>
                      </div>
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <span className="tabular-nums" style={{ color: 'var(--pulse-accent-emerald)', fontWeight: 600 }}>
                        {room.subscribersCount} clients
                      </span>
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <span className="badge badge-emerald">[● ACTIVE]</span>
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                      {onSelectRoom && (
                        <button
                          onClick={() => onSelectRoom(room.id)}
                          className="btn-secondary"
                          style={{ padding: '3px 8px', fontSize: '11px' }}
                        >
                          Inspect in Sandbox
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
