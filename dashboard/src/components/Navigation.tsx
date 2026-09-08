import React from 'react';
import { LayoutDashboard, Users, Network, Terminal } from 'lucide-react';

export type TabId = 'cockpit' | 'rooms' | 'routex' | 'sandbox';

interface NavigationProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  activeRoomsCount?: number;
}

export const Navigation: React.FC<NavigationProps> = ({
  activeTab,
  onTabChange,
  activeRoomsCount = 0
}) => {
  const tabs = [
    { id: 'cockpit' as TabId, label: 'Cockpit Overview', icon: LayoutDashboard, shortcut: 'Alt+1' },
    { id: 'rooms' as TabId, label: 'Rooms & Clients', icon: Users, shortcut: 'Alt+2', badge: activeRoomsCount },
    { id: 'routex' as TabId, label: 'RouteX Gateway', icon: Network, shortcut: 'Alt+3' },
    { id: 'sandbox' as TabId, label: 'Traffic Sandbox', icon: Terminal, shortcut: 'Alt+4' }
  ];

  return (
    <nav style={{
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '12px 20px',
      backgroundColor: 'var(--pulse-bg-surface)',
      borderBottom: '1px solid var(--pulse-border-subtle)'
    }}>
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.id;

        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 14px',
              borderRadius: '6px',
              background: isActive ? 'var(--pulse-bg-card-hover)' : 'transparent',
              color: isActive ? 'var(--pulse-text-primary)' : 'var(--pulse-text-secondary)',
              border: isActive ? '1px solid var(--pulse-border-medium)' : '1px solid transparent',
              fontWeight: isActive ? 600 : 500,
              fontSize: '13px',
              cursor: 'pointer'
            }}
          >
            <Icon size={16} color={isActive ? 'var(--pulse-accent-cyan)' : 'var(--pulse-text-muted)'} />
            <span>{tab.label}</span>

            {tab.badge !== undefined && tab.badge > 0 && (
              <span className="badge badge-cyan" style={{ fontSize: '10px', padding: '1px 5px' }}>
                {tab.badge}
              </span>
            )}

            <span style={{
              fontSize: '10px',
              color: 'var(--pulse-text-muted)',
              fontFamily: 'var(--font-mono)',
              marginLeft: '4px'
            }}>
              [{tab.shortcut}]
            </span>
          </button>
        );
      })}
    </nav>
  );
};
