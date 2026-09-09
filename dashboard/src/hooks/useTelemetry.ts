import { useState, useEffect, useRef, useCallback } from 'react';
import { ServerStats, ThroughputPoint } from '../types/telemetry';

const MAX_HISTORY_POINTS = 60;

export function useTelemetry(apiUrl: string = '') {
  const [stats, setStats] = useState<ServerStats | null>(null);
  const [history, setHistory] = useState<ThroughputPoint[]>([]);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [pollInterval, setPollInterval] = useState<number>(1000);
  const [isConnected, setIsConnected] = useState<boolean>(true);
  const [lastError, setLastError] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number>(0);

  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef<boolean>(true);
  const lastSampleRef = useRef<{ timestamp: number; rx: number; tx: number } | null>(null);

  const fetchStats = useCallback(async () => {
    if (isPaused || !isMountedRef.current) return;

    const startTime = performance.now();
    try {
      const baseApi = apiUrl || (import.meta.env.VITE_API_URL as string) || '';
      const endpoint = baseApi ? `${baseApi.replace(/\/$/, '')}/api/stats` : '/api/stats';
      const res = await fetch(endpoint, {
        headers: { 'Accept': 'application/json' },
        cache: 'no-store'
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw: any = await res.json();
      const elapsed = Math.round(performance.now() - startTime);

      if (isMountedRef.current) {
        const now = Date.now();
        const rxTotal = raw.throughput?.messagesReceived ?? raw.throughput?.inbound?.totalMessages ?? 0;
        const txTotal = raw.throughput?.messagesDelivered ?? raw.throughput?.outbound?.totalMessages ?? 0;

        let inboundMsgSec = 0;
        let outboundMsgSec = 0;

        if (lastSampleRef.current) {
          const timeDiffSec = (now - lastSampleRef.current.timestamp) / 1000;
          if (timeDiffSec > 0) {
            inboundMsgSec = Math.max(0, Math.round((rxTotal - lastSampleRef.current.rx) / timeDiffSec));
            outboundMsgSec = Math.max(0, Math.round((txTotal - lastSampleRef.current.tx) / timeDiffSec));
          }
        }
        lastSampleRef.current = { timestamp: now, rx: rxTotal, tx: txTotal };

        // Normalize raw server payload into strongly-typed ServerStats
        const normalized: ServerStats = {
          status: raw.status === 'OK' ? 'healthy' : raw.status === 'DEGRADED' ? 'degraded' : 'unhealthy',
          instanceId: raw.instanceId || 'pulse-core',
          timestamp: new Date(raw.timestamp || now).toISOString(),
          uptime: raw.uptimeSeconds ?? raw.uptime ?? 0,
          connections: {
            active: raw.connections?.active ?? 0,
            total: raw.connections?.total ?? 0
          },
          rooms: {
            activeCount: raw.rooms?.active ?? raw.rooms?.activeCount ?? 0,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            list: (raw.rooms?.list || []).map((r: any) => ({
              id: r.roomId || r.id || 'unknown',
              subscribersCount: r.subscriberCount ?? r.subscribersCount ?? 0
            }))
          },
          throughput: {
            inbound: {
              totalMessages: rxTotal,
              messagesPerSec: inboundMsgSec,
              bytesPerSec: 0
            },
            outbound: {
              totalMessages: txTotal,
              messagesPerSec: outboundMsgSec,
              bytesPerSec: 0
            }
          },
          eventLoopLag: {
            mean: raw.eventLoopLag?.meanMs ?? raw.eventLoopLag?.mean ?? 0,
            p50: raw.eventLoopLag?.p50Ms ?? raw.eventLoopLag?.p50 ?? 0,
            p99: raw.eventLoopLag?.p99Ms ?? raw.eventLoopLag?.p99 ?? 0,
            max: raw.eventLoopLag?.maxMs ?? raw.eventLoopLag?.max ?? 0
          },
          redis: {
            status: raw.redis?.status || (raw.redis?.enabled ? 'connected' : 'disabled'),
            isCluster: Boolean(raw.redis?.isCluster),
            pingLatencyMs: raw.redis?.metrics?.lastPingLatencyMs ?? raw.redis?.pingLatencyMs ?? 0,
            bufferPending: raw.redis?.metrics?.bufferPending ?? 0,
            pubsubSubscriptions: raw.redis?.metrics?.pubsubSubscriptions ?? 0
          },
          presence: {
            totalTrackedUsers: raw.presence?.metrics?.totalTrackedUsers ?? raw.connections?.active ?? 0,
            trackedRooms: raw.presence?.metrics?.trackedRooms ?? raw.rooms?.active ?? 0
          }
        };

        setStats(normalized);
        setIsConnected(true);
        setLastError(null);
        setLatencyMs(elapsed);

        // Append to 60s throughput window
        const timeStr = new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const newPoint: ThroughputPoint = {
          time: timeStr,
          timestamp: now,
          inboundMsgSec,
          outboundMsgSec
        };

        setHistory((prev) => {
          const updated = [...prev, newPoint];
          if (updated.length > MAX_HISTORY_POINTS) {
            return updated.slice(-MAX_HISTORY_POINTS);
          }
          return updated;
        });
      }
    } catch (err: unknown) {
      if (isMountedRef.current) {
        const msg = err instanceof Error ? err.message : String(err);
        setIsConnected(false);
        setLastError(msg);
      }
    } finally {
      if (isMountedRef.current && !isPaused) {
        timeoutRef.current = setTimeout(fetchStats, pollInterval);
      }
    }
  }, [apiUrl, isPaused, pollInterval]);

  useEffect(() => {
    isMountedRef.current = true;
    fetchStats();

    return () => {
      isMountedRef.current = false;
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [fetchStats]);

  // Handle visibility change (pause when tab hidden to save CPU/battery)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
      } else if (!isPaused) {
        fetchStats();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [fetchStats, isPaused]);

  const togglePause = useCallback(() => {
    setIsPaused((prev) => !prev);
  }, []);

  const manualRefresh = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    fetchStats();
  }, [fetchStats]);

  return {
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
  };
}
