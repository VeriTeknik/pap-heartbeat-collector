/**
 * PAP Heartbeat Collector Configuration
 *
 * Environment Variables:
 * - COLLECTOR_PORT: HTTP server port (default: 8080)
 * - STATION_ALERT_URL: Central pluggedin-app alerts endpoint
 * - STATION_ALERT_KEY: API key for authenticating with central
 * - COLLECTOR_API_KEY: API key for authenticating inbound requests to /agents
 * - CLUSTER_ID: Unique identifier for this cluster
 * - CLUSTER_NAME: Human-readable cluster name
 * - ZOMBIE_CHECK_INTERVAL_MS: How often to check for zombies (default: 10000)
 * - ALERT_QUEUE_MAX_SIZE: Max queued alerts when central unavailable (default: 100)
 * - ALERT_QUEUE_TTL_MS: TTL for queued alerts (default: 300000 = 5 min)
 */

export interface Config {
  // Server
  port: number;

  // Central Station
  stationAlertUrl: string;
  stationAlertKey: string;

  // Collector API Key (for authenticating inbound requests)
  collectorApiKey: string;

  // Cluster Identity
  clusterId: string;
  clusterName: string;

  // Zombie Detection
  zombieCheckIntervalMs: number;

  // Alert Queue (for graceful degradation)
  alertQueueMaxSize: number;
  alertQueueTtlMs: number;
}

// PAP-RFC-001 §8.1 Heartbeat intervals
export const HEARTBEAT_INTERVALS = {
  EMERGENCY: 5000, // 5 seconds
  IDLE: 30000, // 30 seconds
  SLEEP: 900000, // 15 minutes
} as const;

// Grace multiplier before marking agent as unhealthy
// Allows for network jitter and transient failures
export const ZOMBIE_GRACE_MULTIPLIER = 2;

export type HeartbeatMode = keyof typeof HEARTBEAT_INTERVALS;

export function loadConfig(): Config {
  const stationAlertUrl = process.env.STATION_ALERT_URL;
  const stationAlertKey = process.env.STATION_ALERT_KEY;
  const collectorApiKey = process.env.COLLECTOR_API_KEY;
  const clusterId = process.env.CLUSTER_ID;

  if (!stationAlertUrl) {
    console.warn('STATION_ALERT_URL not set - alerts will be logged only');
  }

  if (!stationAlertKey) {
    console.warn('STATION_ALERT_KEY not set - alerts will be logged only');
  }

  if (!collectorApiKey) {
    console.warn('COLLECTOR_API_KEY not set - /agents endpoints will be unprotected!');
  }

  if (!clusterId) {
    throw new Error('CLUSTER_ID environment variable is required');
  }

  return {
    port: parseInt(process.env.COLLECTOR_PORT || '8080', 10),
    stationAlertUrl: stationAlertUrl || '',
    stationAlertKey: stationAlertKey || '',
    collectorApiKey: collectorApiKey || '',
    clusterId,
    clusterName: process.env.CLUSTER_NAME || clusterId,
    zombieCheckIntervalMs: parseInt(process.env.ZOMBIE_CHECK_INTERVAL_MS || '10000', 10),
    alertQueueMaxSize: parseInt(process.env.ALERT_QUEUE_MAX_SIZE || '100', 10),
    alertQueueTtlMs: parseInt(process.env.ALERT_QUEUE_TTL_MS || '300000', 10),
  };
}
