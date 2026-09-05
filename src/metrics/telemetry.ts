/**
 * Pulse — Distributed Real-Time Messaging Infrastructure
 * Telemetry Registration and Instrumentations
 */

import { PulseMetricsRegistry } from './PulseMetricsRegistry.js';
import { Counter } from './Counter.js';
import { Gauge } from './Gauge.js';
import { Histogram } from './Histogram.js';

export function registerWebSocketMetrics(registry: PulseMetricsRegistry): void {
  if (!registry.getMetric('pulse_connections_active')) {
    registry.register(
      new Gauge({
        name: 'pulse_connections_active',
        help: 'Active WebSocket connections on this node'
      })
    );
  }

  if (!registry.getMetric('pulse_connections_total')) {
    registry.register(
      new Counter({
        name: 'pulse_connections_total',
        help: 'Cumulative connection attempts by status',
        labelNames: ['status']
      })
    );
  }

  if (!registry.getMetric('pulse_connections_closed_total')) {
    registry.register(
      new Counter({
        name: 'pulse_connections_closed_total',
        help: 'Cumulative closed connections by reason',
        labelNames: ['reason']
      })
    );
  }

  if (!registry.getMetric('pulse_rooms_active')) {
    registry.register(
      new Gauge({
        name: 'pulse_rooms_active',
        help: 'Active room count on this node'
      })
    );
  }

  if (!registry.getMetric('pulse_messages_received_total')) {
    registry.register(
      new Counter({
        name: 'pulse_messages_received_total',
        help: 'Total inbound messages received by event type',
        labelNames: ['event_type']
      })
    );
  }

  if (!registry.getMetric('pulse_messages_delivered_total')) {
    registry.register(
      new Counter({
        name: 'pulse_messages_delivered_total',
        help: 'Total outbound messages delivered to sockets',
        labelNames: ['event_type']
      })
    );
  }

  if (!registry.getMetric('pulse_messages_dropped_total')) {
    registry.register(
      new Counter({
        name: 'pulse_messages_dropped_total',
        help: 'Total dropped message frames by reason',
        labelNames: ['reason']
      })
    );
  }

  if (!registry.getMetric('pulse_acknowledgements_total')) {
    registry.register(
      new Counter({
        name: 'pulse_acknowledgements_total',
        help: 'Total delivery acknowledgements created by status',
        labelNames: ['status']
      })
    );
  }

  if (!registry.getMetric('pulse_message_processing_duration_seconds')) {
    registry.register(
      new Histogram({
        name: 'pulse_message_processing_duration_seconds',
        help: 'Inbound message processing duration in seconds'
      })
    );
  }

  if (!registry.getMetric('pulse_local_delivery_duration_seconds')) {
    registry.register(
      new Histogram({
        name: 'pulse_local_delivery_duration_seconds',
        help: 'Local socket delivery execution duration in seconds'
      })
    );
  }
}

export function registerRedisMetrics(registry: PulseMetricsRegistry): void {
  if (!registry.getMetric('pulse_redis_publish_total')) {
    registry.register(
      new Counter({
        name: 'pulse_redis_publish_total',
        help: 'Total Redis publishes attempted and completed by status',
        labelNames: ['status']
      })
    );
  }

  if (!registry.getMetric('pulse_redis_publish_duration_seconds')) {
    registry.register(
      new Histogram({
        name: 'pulse_redis_publish_duration_seconds',
        help: 'Redis PUBLISH command latency in seconds'
      })
    );
  }

  if (!registry.getMetric('pulse_redis_publish_in_flight')) {
    registry.register(
      new Gauge({
        name: 'pulse_redis_publish_in_flight',
        help: 'Current in-flight Redis PUBLISH commands'
      })
    );
  }

  if (!registry.getMetric('pulse_redis_subscriptions_active')) {
    registry.register(
      new Gauge({
        name: 'pulse_redis_subscriptions_active',
        help: 'Active Redis channel subscriptions'
      })
    );
  }

  if (!registry.getMetric('pulse_redis_connection_state')) {
    registry.register(
      new Gauge({
        name: 'pulse_redis_connection_state',
        help: 'Redis connection state (1 = connected, 0 = disconnected)'
      })
    );
  }

  if (!registry.getMetric('pulse_cross_node_transit_seconds')) {
    registry.register(
      new Histogram({
        name: 'pulse_cross_node_transit_seconds',
        help: 'Cross-node Redis Pub/Sub transit latency in seconds (wall-clock, negative skew clamped to 0)'
      })
    );
  }

  registerPresenceMetrics(registry);
}

export function registerPresenceMetrics(registry: PulseMetricsRegistry): void {
  if (!registry.getMetric('pulse_presence_users_online')) {
    registry.register(
      new Gauge({
        name: 'pulse_presence_users_online',
        help: 'Active online distinct users tracked for presence'
      })
    );
  }

  if (!registry.getMetric('pulse_presence_connections_active')) {
    registry.register(
      new Gauge({
        name: 'pulse_presence_connections_active',
        help: 'Active presence connection leases on this node'
      })
    );
  }

  if (!registry.getMetric('pulse_presence_events_total')) {
    registry.register(
      new Counter({
        name: 'pulse_presence_events_total',
        help: 'Total presence update events by direction',
        labelNames: ['direction']
      })
    );
  }

  if (!registry.getMetric('pulse_presence_lease_renewals_total')) {
    registry.register(
      new Counter({
        name: 'pulse_presence_lease_renewals_total',
        help: 'Total presence lease renewals processed'
      })
    );
  }

  if (!registry.getMetric('pulse_presence_prune_duration_seconds')) {
    registry.register(
      new Histogram({
        name: 'pulse_presence_prune_duration_seconds',
        help: 'Redis presence pruning execution duration in seconds'
      })
    );
  }

  if (!registry.getMetric('pulse_presence_operations_total')) {
    registry.register(
      new Counter({
        name: 'pulse_presence_operations_total',
        help: 'Total presence registration and removal operations by status',
        labelNames: ['operation', 'status']
      })
    );
  }
}

