/**
 * Heartbeat Route - Receives heartbeats from agents
 *
 * POST /heartbeat/:agentId
 *
 * PAP-RFC-001 compliant: Only accepts liveness data (mode, uptime)
 * NO CPU/memory data - that goes to metrics endpoint (separate channel)
 */

import { Router, type Request, type Response } from 'express';
import { type HeartbeatMode, HEARTBEAT_INTERVALS } from '../config.js';
import { heartbeatStore } from '../store.js';
import { ZombieDetector } from '../zombie-detector.js';

interface HeartbeatPayload {
  mode: HeartbeatMode;
  uptime_seconds: number;
  agent_name?: string;
}

export function createHeartbeatRouter(zombieDetector: ZombieDetector): Router {
  const router = Router();

  /**
   * POST /heartbeat/:agentId
   *
   * Receive heartbeat from an agent.
   * No authentication required - internal cluster network only.
   */
  router.post('/:agentId', async (req: Request, res: Response) => {
    const { agentId } = req.params;
    const body = req.body as HeartbeatPayload;

    // Validate required fields
    if (!body.mode || typeof body.uptime_seconds !== 'number') {
      res.status(400).json({
        error: 'Invalid heartbeat payload',
        required: ['mode', 'uptime_seconds'],
      });
      return;
    }

    // Validate mode
    if (!Object.keys(HEARTBEAT_INTERVALS).includes(body.mode)) {
      res.status(400).json({
        error: 'Invalid mode',
        valid: Object.keys(HEARTBEAT_INTERVALS),
      });
      return;
    }

    // Get agent name from body or use agentId
    const agentName = body.agent_name || agentId;

    // Get current state before update (for change detection)
    const currentAgent = heartbeatStore.getAgent(agentId);
    const previousMode = currentAgent?.mode;
    const previousUptime = currentAgent?.uptime_seconds;

    // Record heartbeat
    const { isNew, restartDetected } = heartbeatStore.recordHeartbeat(
      agentId,
      agentName,
      body.mode,
      body.uptime_seconds
    );

    // Get updated entry for alerts
    const updatedAgent = heartbeatStore.getAgent(agentId);

    // Handle special events
    if (updatedAgent) {
      // Check for mode change to EMERGENCY
      if (body.mode === 'EMERGENCY' && previousMode && previousMode !== 'EMERGENCY') {
        // Fire and forget - don't block heartbeat response
        zombieDetector
          .handleEmergencyMode(
            {
              agent_uuid: agentId,
              agent_name: agentName,
              mode: body.mode,
              uptime_seconds: body.uptime_seconds,
              last_seen: new Date(),
              first_seen: new Date(),
              consecutive_heartbeats: 1,
              observation_mode: false,
            },
            previousMode
          )
          .catch((err) => console.error('Failed to handle emergency mode:', err));
      }

      // Check for restart
      if (restartDetected && previousUptime !== undefined) {
        zombieDetector
          .handleRestartDetected(
            {
              agent_uuid: agentId,
              agent_name: agentName,
              mode: body.mode,
              uptime_seconds: body.uptime_seconds,
              last_seen: new Date(),
              first_seen: new Date(),
              consecutive_heartbeats: 1,
              observation_mode: false,
            },
            previousUptime,
            body.uptime_seconds
          )
          .catch((err) => console.error('Failed to handle restart:', err));
      }
    }

    // Return success with next expected heartbeat window
    const nextExpectedMs = HEARTBEAT_INTERVALS[body.mode];

    res.status(200).json({
      received: true,
      is_new: isNew,
      restart_detected: restartDetected,
      next_heartbeat_ms: nextExpectedMs,
    });
  });

  return router;
}
