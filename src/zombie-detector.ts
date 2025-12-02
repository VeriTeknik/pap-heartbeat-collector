/**
 * Zombie Detector - Local heartbeat monitoring
 *
 * Runs a periodic check for agents that have missed their heartbeat deadline.
 * When a zombie is detected, alerts are sent to central pluggedin-app.
 *
 * PAP-RFC-001 §8.1 defines:
 * - EMERGENCY: 5s interval
 * - IDLE: 30s interval (default)
 * - SLEEP: 15m interval
 *
 * Grace period: 2x interval before marking unhealthy
 */

import type { Config } from './config.js';
import { HEARTBEAT_INTERVALS, ZOMBIE_GRACE_MULTIPLIER } from './config.js';
import { type HeartbeatEntry, heartbeatStore } from './store.js';
import { AlertClient } from './alert-client.js';

export class ZombieDetector {
  private intervalHandle: NodeJS.Timeout | null = null;
  private alertedAgents: Set<string> = new Set();

  constructor(
    private config: Config,
    private alertClient: AlertClient
  ) {}

  /**
   * Start the zombie detection loop
   */
  start(): void {
    if (this.intervalHandle) {
      console.warn('[ZombieDetector] Already running');
      return;
    }

    console.log(
      `[ZombieDetector] Starting with check interval: ${this.config.zombieCheckIntervalMs}ms`
    );

    this.intervalHandle = setInterval(() => this.check(), this.config.zombieCheckIntervalMs);

    // Run initial check immediately
    this.check();
  }

  /**
   * Stop the zombie detection loop
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      console.log('[ZombieDetector] Stopped');
    }
  }

  /**
   * Perform a zombie check
   */
  private async check(): Promise<void> {
    const unhealthy = heartbeatStore.getUnhealthyAgents();

    for (const agent of unhealthy) {
      // Only alert once per agent (until they recover)
      if (!this.alertedAgents.has(agent.agent_uuid)) {
        await this.handleUnhealthyAgent(agent);
        this.alertedAgents.add(agent.agent_uuid);
      }
    }

    // Clear alerts for agents that have recovered
    const allAgents = heartbeatStore.getAllAgents();
    for (const agent of allAgents) {
      if (agent.healthy && this.alertedAgents.has(agent.agent_uuid)) {
        this.alertedAgents.delete(agent.agent_uuid);
        console.log(`[ZombieDetector] Agent recovered: ${agent.agent_name}`);
      }
    }
  }

  /**
   * Handle an unhealthy agent - calculate details and send alert
   */
  private async handleUnhealthyAgent(entry: HeartbeatEntry): Promise<void> {
    const now = Date.now();
    const elapsed = now - entry.last_seen.getTime();
    const interval = HEARTBEAT_INTERVALS[entry.mode];
    const missedIntervals = Math.floor(elapsed / interval);

    console.warn(
      `[ZombieDetector] Agent unhealthy: ${entry.agent_name} ` +
        `(mode: ${entry.mode}, missed: ${missedIntervals} intervals, ` +
        `last seen: ${entry.last_seen.toISOString()})`
    );

    await this.alertClient.alertAgentDeath(entry, missedIntervals);
  }

  /**
   * Handle mode change to EMERGENCY
   * Called from heartbeat route when mode changes
   */
  async handleEmergencyMode(entry: HeartbeatEntry, previousMode?: string): Promise<void> {
    if (entry.mode === 'EMERGENCY' && previousMode !== 'EMERGENCY') {
      console.warn(`[ZombieDetector] Agent entered EMERGENCY mode: ${entry.agent_name}`);
      await this.alertClient.alertEmergencyMode(entry, previousMode);
    }
  }

  /**
   * Handle restart detection
   * Called from heartbeat route when uptime decreases
   */
  async handleRestartDetected(
    entry: HeartbeatEntry,
    previousUptime: number,
    newUptime: number
  ): Promise<void> {
    console.info(
      `[ZombieDetector] Agent restart detected: ${entry.agent_name} ` +
        `(uptime: ${previousUptime}s → ${newUptime}s)`
    );
    await this.alertClient.alertRestartDetected(entry, previousUptime, newUptime);
  }

  /**
   * Get currently alerted agents
   */
  getAlertedAgents(): string[] {
    return Array.from(this.alertedAgents);
  }
}
