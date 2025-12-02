/**
 * In-Memory Heartbeat Store
 *
 * Stores agent heartbeat state in memory for fast lookup.
 * No persistence - state rebuilds naturally as agents re-heartbeat (max 30s for IDLE mode).
 *
 * Design decisions:
 * - Map-based for O(1) lookup/update
 * - No disk persistence (agents re-heartbeat within interval)
 * - Observation mode tracking for real-time streaming
 */

import { type HeartbeatMode, HEARTBEAT_INTERVALS, ZOMBIE_GRACE_MULTIPLIER } from './config.js';

export interface HeartbeatEntry {
  agent_uuid: string;
  agent_name: string;
  mode: HeartbeatMode;
  uptime_seconds: number;
  last_seen: Date;
  first_seen: Date;
  consecutive_heartbeats: number;
  observation_mode: boolean;
  // Track previous mode for restart detection
  previous_mode?: HeartbeatMode;
  previous_uptime?: number;
}

export interface AgentStatus {
  agent_uuid: string;
  agent_name: string;
  mode: HeartbeatMode;
  uptime_seconds: number;
  last_seen: string; // ISO string
  healthy: boolean;
  observation_mode: boolean;
  consecutive_heartbeats: number;
}

export type HealthStatus = 'healthy' | 'unhealthy' | 'unknown';

export class HeartbeatStore {
  private agents: Map<string, HeartbeatEntry> = new Map();
  private observationCallbacks: Map<string, Set<(entry: HeartbeatEntry) => void>> = new Map();

  /**
   * Record a heartbeat from an agent
   * Returns true if this is a new agent, false if update
   */
  recordHeartbeat(
    agentUuid: string,
    agentName: string,
    mode: HeartbeatMode,
    uptimeSeconds: number
  ): { isNew: boolean; restartDetected: boolean } {
    const now = new Date();
    const existing = this.agents.get(agentUuid);

    let isNew = false;
    let restartDetected = false;

    if (existing) {
      // Check for restart: uptime decreased significantly
      if (existing.uptime_seconds > uptimeSeconds + 10) {
        restartDetected = true;
      }

      // Update existing entry
      existing.previous_mode = existing.mode;
      existing.previous_uptime = existing.uptime_seconds;
      existing.mode = mode;
      existing.uptime_seconds = uptimeSeconds;
      existing.last_seen = now;
      existing.consecutive_heartbeats++;

      // Notify observers
      this.notifyObservers(agentUuid, existing);
    } else {
      // New agent
      isNew = true;
      const entry: HeartbeatEntry = {
        agent_uuid: agentUuid,
        agent_name: agentName,
        mode,
        uptime_seconds: uptimeSeconds,
        last_seen: now,
        first_seen: now,
        consecutive_heartbeats: 1,
        observation_mode: false,
      };
      this.agents.set(agentUuid, entry);

      // Notify observers (in case someone is watching for new agents)
      this.notifyObservers(agentUuid, entry);
    }

    return { isNew, restartDetected };
  }

  /**
   * Get status of a single agent
   */
  getAgent(agentUuid: string): AgentStatus | null {
    const entry = this.agents.get(agentUuid);
    if (!entry) return null;

    return this.entryToStatus(entry);
  }

  /**
   * Get status of all agents
   */
  getAllAgents(): AgentStatus[] {
    return Array.from(this.agents.values()).map((entry) => this.entryToStatus(entry));
  }

  /**
   * Get agents that have missed their heartbeat deadline
   * Returns agents that are unhealthy based on their mode's interval
   */
  getUnhealthyAgents(): HeartbeatEntry[] {
    const unhealthy: HeartbeatEntry[] = [];
    const now = Date.now();

    for (const entry of this.agents.values()) {
      if (!this.isHealthy(entry, now)) {
        unhealthy.push(entry);
      }
    }

    return unhealthy;
  }

  /**
   * Remove an agent from tracking (e.g., after confirmed termination)
   */
  removeAgent(agentUuid: string): boolean {
    const existed = this.agents.has(agentUuid);
    this.agents.delete(agentUuid);
    this.observationCallbacks.delete(agentUuid);
    return existed;
  }

  /**
   * Enable observation mode for an agent
   * Returns a cleanup function to disable observation
   */
  enableObservation(agentUuid: string, callback: (entry: HeartbeatEntry) => void): () => void {
    let callbacks = this.observationCallbacks.get(agentUuid);
    if (!callbacks) {
      callbacks = new Set();
      this.observationCallbacks.set(agentUuid, callbacks);
    }
    callbacks.add(callback);

    // Mark agent as being observed
    const entry = this.agents.get(agentUuid);
    if (entry) {
      entry.observation_mode = true;
    }

    // Return cleanup function
    return () => {
      callbacks?.delete(callback);
      if (callbacks?.size === 0) {
        this.observationCallbacks.delete(agentUuid);
        const entry = this.agents.get(agentUuid);
        if (entry) {
          entry.observation_mode = false;
        }
      }
    };
  }

  /**
   * Get count statistics
   */
  getStats(): {
    total: number;
    healthy: number;
    unhealthy: number;
    byMode: Record<HeartbeatMode, number>;
    observed: number;
  } {
    const now = Date.now();
    let healthy = 0;
    let unhealthy = 0;
    let observed = 0;
    const byMode: Record<HeartbeatMode, number> = {
      EMERGENCY: 0,
      IDLE: 0,
      SLEEP: 0,
    };

    for (const entry of this.agents.values()) {
      if (this.isHealthy(entry, now)) {
        healthy++;
      } else {
        unhealthy++;
      }
      byMode[entry.mode]++;
      if (entry.observation_mode) {
        observed++;
      }
    }

    return {
      total: this.agents.size,
      healthy,
      unhealthy,
      byMode,
      observed,
    };
  }

  /**
   * Check if an agent is healthy based on its heartbeat interval
   */
  private isHealthy(entry: HeartbeatEntry, now: number = Date.now()): boolean {
    const interval = HEARTBEAT_INTERVALS[entry.mode];
    const deadline = interval * ZOMBIE_GRACE_MULTIPLIER;
    const elapsed = now - entry.last_seen.getTime();
    return elapsed < deadline;
  }

  /**
   * Convert internal entry to public status
   */
  private entryToStatus(entry: HeartbeatEntry): AgentStatus {
    return {
      agent_uuid: entry.agent_uuid,
      agent_name: entry.agent_name,
      mode: entry.mode,
      uptime_seconds: entry.uptime_seconds,
      last_seen: entry.last_seen.toISOString(),
      healthy: this.isHealthy(entry),
      observation_mode: entry.observation_mode,
      consecutive_heartbeats: entry.consecutive_heartbeats,
    };
  }

  /**
   * Notify all observers for an agent
   */
  private notifyObservers(agentUuid: string, entry: HeartbeatEntry): void {
    const callbacks = this.observationCallbacks.get(agentUuid);
    if (callbacks) {
      for (const callback of callbacks) {
        try {
          callback(entry);
        } catch (error) {
          console.error(`Observer callback error for agent ${agentUuid}:`, error);
        }
      }
    }
  }
}

// Singleton instance
export const heartbeatStore = new HeartbeatStore();
