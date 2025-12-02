/**
 * Alert Client - Pushes alerts to central pluggedin-app
 *
 * Features:
 * - Queues alerts when central is unavailable
 * - Automatic retry with exponential backoff
 * - TTL-based queue eviction
 * - Deduplication of repeated alerts
 */

import type { Config } from './config.js';
import type { HeartbeatEntry } from './store.js';

export type AlertType = 'AGENT_DEATH' | 'EMERGENCY_MODE' | 'RESTART_DETECTED' | 'MODE_CHANGE';

export interface ClusterAlert {
  type: AlertType;
  agent_uuid: string;
  agent_name: string;
  cluster_id: string;
  severity: 'critical' | 'warning' | 'info';
  details: Record<string, unknown>;
  timestamp: string;
}

interface QueuedAlert {
  alert: ClusterAlert;
  queuedAt: number;
  attempts: number;
}

export class AlertClient {
  private queue: QueuedAlert[] = [];
  private isProcessing = false;
  private lastAlertByAgent: Map<string, { type: AlertType; timestamp: number }> = new Map();

  // Deduplication window (don't send same alert type for same agent within this window)
  private readonly DEDUP_WINDOW_MS = 60000; // 1 minute

  constructor(private config: Config) {}

  /**
   * Send an agent death alert
   */
  async alertAgentDeath(entry: HeartbeatEntry, missedIntervals: number): Promise<void> {
    const alert: ClusterAlert = {
      type: 'AGENT_DEATH',
      agent_uuid: entry.agent_uuid,
      agent_name: entry.agent_name,
      cluster_id: this.config.clusterId,
      severity: 'critical',
      details: {
        missed_intervals: missedIntervals,
        last_seen: entry.last_seen.toISOString(),
        mode: entry.mode,
        uptime_before_death: entry.uptime_seconds,
      },
      timestamp: new Date().toISOString(),
    };

    await this.sendAlert(alert);
  }

  /**
   * Send an emergency mode alert
   */
  async alertEmergencyMode(entry: HeartbeatEntry, previousMode?: string): Promise<void> {
    const alert: ClusterAlert = {
      type: 'EMERGENCY_MODE',
      agent_uuid: entry.agent_uuid,
      agent_name: entry.agent_name,
      cluster_id: this.config.clusterId,
      severity: 'warning',
      details: {
        previous_mode: previousMode,
        uptime_seconds: entry.uptime_seconds,
      },
      timestamp: new Date().toISOString(),
    };

    await this.sendAlert(alert);
  }

  /**
   * Send a restart detected alert
   */
  async alertRestartDetected(
    entry: HeartbeatEntry,
    previousUptime: number,
    newUptime: number
  ): Promise<void> {
    const alert: ClusterAlert = {
      type: 'RESTART_DETECTED',
      agent_uuid: entry.agent_uuid,
      agent_name: entry.agent_name,
      cluster_id: this.config.clusterId,
      severity: 'info',
      details: {
        previous_uptime: previousUptime,
        new_uptime: newUptime,
        mode: entry.mode,
      },
      timestamp: new Date().toISOString(),
    };

    await this.sendAlert(alert);
  }

  /**
   * Get queue statistics
   */
  getQueueStats(): { size: number; oldestAge: number | null } {
    if (this.queue.length === 0) {
      return { size: 0, oldestAge: null };
    }

    const now = Date.now();
    const oldestAge = now - this.queue[0].queuedAt;
    return { size: this.queue.length, oldestAge };
  }

  /**
   * Manually flush the queue (e.g., on shutdown)
   */
  async flushQueue(): Promise<void> {
    await this.processQueue();
  }

  /**
   * Core alert sending logic with deduplication and queueing
   */
  private async sendAlert(alert: ClusterAlert): Promise<void> {
    // Check deduplication
    if (this.isDuplicate(alert)) {
      console.log(`[AlertClient] Skipping duplicate alert: ${alert.type} for ${alert.agent_name}`);
      return;
    }

    // Record this alert for deduplication
    this.lastAlertByAgent.set(alert.agent_uuid, {
      type: alert.type,
      timestamp: Date.now(),
    });

    // If no station URL configured, just log
    if (!this.config.stationAlertUrl || !this.config.stationAlertKey) {
      console.log(`[AlertClient] Alert (no station configured):`, JSON.stringify(alert, null, 2));
      return;
    }

    // Try to send immediately
    const success = await this.attemptSend(alert);

    if (!success) {
      // Queue for retry
      this.queueAlert(alert);
    }
  }

  /**
   * Check if this alert is a duplicate within the dedup window
   */
  private isDuplicate(alert: ClusterAlert): boolean {
    const last = this.lastAlertByAgent.get(alert.agent_uuid);
    if (!last) return false;

    const now = Date.now();
    const withinWindow = now - last.timestamp < this.DEDUP_WINDOW_MS;
    const sameType = last.type === alert.type;

    return withinWindow && sameType;
  }

  /**
   * Attempt to send an alert to central
   */
  private async attemptSend(alert: ClusterAlert): Promise<boolean> {
    try {
      const response = await fetch(this.config.stationAlertUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.stationAlertKey}`,
        },
        body: JSON.stringify(alert),
        signal: AbortSignal.timeout(10000), // 10s timeout
      });

      if (!response.ok) {
        console.error(
          `[AlertClient] Failed to send alert: ${response.status} ${response.statusText}`
        );
        return false;
      }

      console.log(`[AlertClient] Alert sent successfully: ${alert.type} for ${alert.agent_name}`);
      return true;
    } catch (error) {
      console.error(`[AlertClient] Error sending alert:`, error);
      return false;
    }
  }

  /**
   * Add alert to retry queue
   */
  private queueAlert(alert: ClusterAlert): void {
    // Enforce max queue size
    if (this.queue.length >= this.config.alertQueueMaxSize) {
      // Remove oldest
      const removed = this.queue.shift();
      console.warn(`[AlertClient] Queue full, dropping oldest alert: ${removed?.alert.type}`);
    }

    this.queue.push({
      alert,
      queuedAt: Date.now(),
      attempts: 1,
    });

    console.log(`[AlertClient] Alert queued for retry. Queue size: ${this.queue.length}`);

    // Start processing queue if not already
    if (!this.isProcessing) {
      this.scheduleQueueProcessing();
    }
  }

  /**
   * Schedule queue processing with exponential backoff
   */
  private scheduleQueueProcessing(): void {
    if (this.isProcessing || this.queue.length === 0) return;

    // Start with 5s delay, increase with each retry
    const delay = Math.min(5000 * Math.pow(2, this.queue[0]?.attempts || 0), 60000);

    setTimeout(() => this.processQueue(), delay);
  }

  /**
   * Process queued alerts
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;
    const now = Date.now();

    try {
      const remaining: QueuedAlert[] = [];

      for (const item of this.queue) {
        // Check TTL
        if (now - item.queuedAt > this.config.alertQueueTtlMs) {
          console.warn(`[AlertClient] Dropping expired alert: ${item.alert.type}`);
          continue;
        }

        // Try to send
        const success = await this.attemptSend(item.alert);

        if (!success) {
          item.attempts++;
          remaining.push(item);
        }
      }

      this.queue = remaining;

      // Schedule more processing if needed
      if (this.queue.length > 0) {
        this.scheduleQueueProcessing();
      }
    } finally {
      this.isProcessing = false;
    }
  }
}
