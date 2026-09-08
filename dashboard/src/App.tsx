import React, { useState, useEffect } from 'react';
import { useTelemetry } from './hooks/useTelemetry';
import { Header } from './components/Header';
import { Navigation, TabId } from './components/Navigation';
import { MetricCard } from './components/MetricCard';
import { ThroughputChart } from './components/ThroughputChart';
import { EventLoopGauge } from './components/EventLoopGauge';
import { TopologyGrid } from './components/TopologyGrid';
import { EventStream } from './components/EventStream';
import { TrafficSandbox } from './components/TrafficSandbox';
import { RoomsTable } from './components/RoomsTable';
import { GatewayInspector } from './components/GatewayInspector';
import { SystemEvent } from './types/telemetry';
import { Users, Activity, Radio, Cpu, AlertTriangle } from 'lucide-react';

export const App: React.FC = () => {
  const {
    stats,
    history,
    isPaused,
    pollInterval,
    setPollInterval,
    togglePause,
    manualRefresh,
    isConnected,
    lastError,
    latencyMs
  } = useTelemetry();

  const [activeTab, setActiveTab] = useState<TabId>('cockpit');
  const [events, setEvents] = useState<SystemEvent[]>([]);

  // Keyboard shortcut listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore key events when user is typing inside an input or textarea
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }

      if (e.altKey && e.key === '1') {
        e.preventDefault();
        setActiveTab('cockpit');
      } else if (e.altKey && e.key === '2') {
        e.preventDefault();
        setActiveTab('rooms');
      } else if (e.altKey && e.key === '3') {
        e.preventDefault();
        setActiveTab('routex');
      } else if (e.altKey && e.key === '4') {
        e.preventDefault();
        setActiveTab('sandbox');
      } else if (e.code === 'Space' || e.key.toLowerCase() === 'p') {
        e.preventDefault();
        togglePause();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePause]);

  // Generate synthetic / live system events when stats update
  useEffect(() => {
    if (!stats) return;

    const newEvent: SystemEvent = {
      id: `evt-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      level: stats.status === 'unhealthy' ? 'ERROR' : stats.status === 'degraded' ? 'WARN' : 'INFO',
      component: 'PulseServer',
      message: `Cluster telemetry polled: ${stats.connections.active} active connections, ${stats.rooms.activeCount} channels, Redis ${stats.redis.status}`
    };

    setEvents((prev) => {
      const updated = [...prev, newEvent];
      if (updated.length > 50) {
        return updated.slice(-50);
      }
      return updated;
    });
  }, [stats]);

  // Initial seed event
  useEffect(() => {
    setEvents([
      {
        id: 'seed-1',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        level: 'INFO',
        component: 'PulseServer',
        message: 'Pulse Mission Control Dashboard initialized. Connected to telemetry collector.'
      },
      {
        id: 'seed-2',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        level: 'INFO',
        component: 'RouteX',
        message: 'Unified edge gateway active on port 3000. Reverse proxy pipeline operational.'
      }
    ]);
  }, []);

  const activeConns = stats?.connections?.active || 0;
  const totalConns = stats?.connections?.total || 0;
  const inMsgSec = stats?.throughput?.inbound?.messagesPerSec || 0;
  const outMsgSec = stats?.throughput?.outbound?.messagesPerSec || 0;
  const totalMsgSec = inMsgSec + outMsgSec;
  const activeRooms = stats?.rooms?.activeCount || 0;
  const p99Lag = stats?.eventLoopLag?.p99 || 0;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--pulse-bg-space)' }}>
      {/* Global Status Header */}
      <Header
        stats={stats}
        isConnected={isConnected}
        isPaused={isPaused}
        pollInterval={pollInterval}
        latencyMs={latencyMs}
        onTogglePause={togglePause}
        onManualRefresh={manualRefresh}
        onIntervalChange={setPollInterval}
      />

      {/* Navigation Sub-header */}
      <Navigation
        activeTab={activeTab}
        onTabChange={setActiveTab}
        activeRoomsCount={activeRooms}
      />

      {/* Connection Warning Banner if offline */}
      {!isConnected && (
        <div style={{
          background: 'rgba(239, 68, 68, 0.15)',
          borderBottom: '1px solid var(--pulse-accent-crimson)',
          padding: '8px 20px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          color: 'var(--pulse-accent-crimson)',
          fontSize: '12px',
          fontFamily: 'var(--font-mono)'
        }}>
          <AlertTriangle size={15} />
          <span>
            Telemetry endpoint unreachable ({lastError || 'Connection refused'}). Polling continues in background...
          </span>
        </div>
      )}

      {/* Main Telemetry Body */}
      <main style={{ flex: 1, padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '1600px', width: '100%', margin: '0 auto' }}>
        {activeTab === 'cockpit' && (
          <>
            {/* Top KPI Metrics Row */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px' }}>
              <MetricCard
                label="Active Connections"
                value={activeConns.toLocaleString()}
                subValue={`Total lifetime: ${totalConns.toLocaleString()}`}
                icon={Users}
                accentColor="cyan"
                statusGlyph="[●]"
                statusLabel="STREAMING"
              />

              <MetricCard
                label="Total Wire Throughput"
                value={`${totalMsgSec.toLocaleString()} msg/s`}
                subValue={`In: ${inMsgSec} msg/s • Out: ${outMsgSec} msg/s`}
                icon={Activity}
                accentColor="emerald"
                statusGlyph="[●]"
                statusLabel="NORMAL"
              />

              <MetricCard
                label="Active Channels"
                value={activeRooms.toLocaleString()}
                subValue={`Presence users: ${stats?.presence?.totalTrackedUsers || 0}`}
                icon={Radio}
                accentColor="violet"
                statusGlyph="[●]"
                statusLabel="DISPATCHING"
              />

              <MetricCard
                label="Event Loop Lag (p99)"
                value={`${p99Lag.toFixed(2)} ms`}
                subValue={`Mean: ${(stats?.eventLoopLag?.mean || 0).toFixed(1)}ms • Max: ${(stats?.eventLoopLag?.max || 0).toFixed(1)}ms`}
                icon={Cpu}
                accentColor={p99Lag > 20 ? 'crimson' : p99Lag > 10 ? 'amber' : 'emerald'}
                statusGlyph={p99Lag > 20 ? '[✖]' : p99Lag > 10 ? '[▲]' : '[●]'}
                statusLabel={p99Lag > 20 ? 'DEGRADED' : p99Lag > 10 ? 'ELEVATED' : 'OPTIMAL'}
              />
            </div>

            {/* Throughput Rolling Waveform & Event Loop Lag Gauge */}
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(400px, 2fr) minmax(280px, 1fr)', gap: '16px' }}>
              <ThroughputChart
                data={history}
                currentInbound={inMsgSec}
                currentOutbound={outMsgSec}
              />
              <EventLoopGauge
                lag={stats?.eventLoopLag || { mean: 0, p50: 0, p99: 0, max: 0 }}
              />
            </div>

            {/* Distributed Subsystem Topology Grid */}
            <TopologyGrid stats={stats} isConnected={isConnected} />

            {/* Infrastructure Event Stream */}
            <EventStream events={events} />
          </>
        )}

        {activeTab === 'rooms' && (
          <RoomsTable
            stats={stats}
            onSelectRoom={(_roomId) => {
              setActiveTab('sandbox');
            }}
          />
        )}

        {activeTab === 'routex' && (
          <GatewayInspector stats={stats} />
        )}

        {activeTab === 'sandbox' && (
          <TrafficSandbox />
        )}
      </main>
    </div>
  );
};

export default App;
