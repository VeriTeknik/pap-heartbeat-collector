/**
 * PAP Heartbeat Collector - Main Entry Point
 *
 * A local service that collects heartbeats from PAP agents within a cluster.
 * Instead of each agent sending heartbeats to central pluggedin-app,
 * they send to this local collector which:
 *
 * 1. Stores heartbeat state in memory
 * 2. Performs local zombie detection
 * 3. Pushes alerts to central only when problems occur
 * 4. Responds to on-demand queries from central
 * 5. Provides WebSocket streaming for observation mode
 *
 * This reduces network traffic by ~100% in normal operation.
 *
 * See: PAP-RFC-001 §8.1 for heartbeat intervals and zombie detection
 */

import express from 'express';
import { createServer } from 'http';
import { loadConfig } from './config.js';
import { heartbeatStore } from './store.js';
import { AlertClient } from './alert-client.js';
import { ZombieDetector } from './zombie-detector.js';
import { createHeartbeatRouter } from './routes/heartbeat.js';
import { createAgentsRouter } from './routes/agents.js';
import { setupObserveWebSocket } from './routes/observe.js';

async function main() {
  console.log('========================================');
  console.log('  PAP Heartbeat Collector v1.0.0');
  console.log('========================================');

  // Load configuration
  const config = loadConfig();
  console.log(`Cluster ID: ${config.clusterId}`);
  console.log(`Cluster Name: ${config.clusterName}`);
  console.log(`Port: ${config.port}`);
  console.log(`Station Alert URL: ${config.stationAlertUrl || '(not configured)'}`);
  console.log(`Zombie Check Interval: ${config.zombieCheckIntervalMs}ms`);

  // Initialize components
  const alertClient = new AlertClient(config);
  const zombieDetector = new ZombieDetector(config, alertClient);

  // Create Express app
  const app = express();
  app.use(express.json());

  // Health endpoint for K8s probes
  app.get('/health', (_req, res) => {
    const stats = heartbeatStore.getStats();
    const queueStats = alertClient.getQueueStats();

    res.json({
      status: 'healthy',
      cluster_id: config.clusterId,
      cluster_name: config.clusterName,
      uptime: process.uptime(),
      agents: {
        total: stats.total,
        healthy: stats.healthy,
        unhealthy: stats.unhealthy,
      },
      alert_queue: {
        size: queueStats.size,
        oldest_age_ms: queueStats.oldestAge,
      },
    });
  });

  // Readiness endpoint - ready when zombie detector is running
  app.get('/ready', (_req, res) => {
    res.json({ ready: true });
  });

  // Prometheus metrics endpoint
  app.get('/metrics', (_req, res) => {
    const stats = heartbeatStore.getStats();
    const queueStats = alertClient.getQueueStats();
    const alertedAgents = zombieDetector.getAlertedAgents();

    const metrics = [
      `# HELP pap_collector_agents_total Total number of tracked agents`,
      `# TYPE pap_collector_agents_total gauge`,
      `pap_collector_agents_total{cluster="${config.clusterId}"} ${stats.total}`,
      '',
      `# HELP pap_collector_agents_healthy Number of healthy agents`,
      `# TYPE pap_collector_agents_healthy gauge`,
      `pap_collector_agents_healthy{cluster="${config.clusterId}"} ${stats.healthy}`,
      '',
      `# HELP pap_collector_agents_unhealthy Number of unhealthy agents`,
      `# TYPE pap_collector_agents_unhealthy gauge`,
      `pap_collector_agents_unhealthy{cluster="${config.clusterId}"} ${stats.unhealthy}`,
      '',
      `# HELP pap_collector_agents_by_mode Agents by heartbeat mode`,
      `# TYPE pap_collector_agents_by_mode gauge`,
      `pap_collector_agents_by_mode{cluster="${config.clusterId}",mode="EMERGENCY"} ${stats.byMode.EMERGENCY}`,
      `pap_collector_agents_by_mode{cluster="${config.clusterId}",mode="IDLE"} ${stats.byMode.IDLE}`,
      `pap_collector_agents_by_mode{cluster="${config.clusterId}",mode="SLEEP"} ${stats.byMode.SLEEP}`,
      '',
      `# HELP pap_collector_observations_active Number of active observation streams`,
      `# TYPE pap_collector_observations_active gauge`,
      `pap_collector_observations_active{cluster="${config.clusterId}"} ${stats.observed}`,
      '',
      `# HELP pap_collector_alert_queue_size Number of alerts in retry queue`,
      `# TYPE pap_collector_alert_queue_size gauge`,
      `pap_collector_alert_queue_size{cluster="${config.clusterId}"} ${queueStats.size}`,
      '',
      `# HELP pap_collector_alerted_agents Number of agents with active alerts`,
      `# TYPE pap_collector_alerted_agents gauge`,
      `pap_collector_alerted_agents{cluster="${config.clusterId}"} ${alertedAgents.length}`,
      '',
    ].join('\n');

    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(metrics);
  });

  // Mount route handlers
  app.use('/heartbeat', createHeartbeatRouter(zombieDetector));
  app.use('/agents', createAgentsRouter(config));

  // Create HTTP server for both Express and WebSocket
  const server = createServer(app);

  // Setup WebSocket for observation mode
  setupObserveWebSocket(server, config);

  // Start zombie detection loop
  zombieDetector.start();

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');

    zombieDetector.stop();

    // Flush alert queue
    console.log('Flushing alert queue...');
    await alertClient.flushQueue();

    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });

    // Force exit after 10s
    setTimeout(() => {
      console.error('Forced exit after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Start server
  server.listen(config.port, () => {
    console.log('');
    console.log(`Server listening on port ${config.port}`);
    console.log('');
    console.log('Endpoints:');
    console.log(`  POST /heartbeat/:agentId  - Receive agent heartbeats`);
    console.log(`  GET  /agents              - List all agents`);
    console.log(`  GET  /agents/:agentId     - Get single agent status`);
    console.log(`  WS   /observe/:agentId    - Real-time observation stream`);
    console.log(`  GET  /health              - Health check`);
    console.log(`  GET  /metrics             - Prometheus metrics`);
    console.log('');
    console.log('Ready to receive heartbeats!');
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
