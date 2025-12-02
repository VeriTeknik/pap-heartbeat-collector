/**
 * Agents Route - Query agent status
 *
 * GET /agents - List all agents with status
 * GET /agents/:agentId - Get single agent status
 *
 * Called by central pluggedin-app on-demand (e.g., when UI opens agent page)
 */

import { Router, type Request, type Response } from 'express';
import { heartbeatStore } from '../store.js';
import type { Config } from '../config.js';

export function createAgentsRouter(config: Config): Router {
  const router = Router();

  /**
   * GET /agents
   *
   * List all tracked agents with their current status.
   * Includes health assessment based on heartbeat intervals.
   */
  router.get('/', (_req: Request, res: Response) => {
    const agents = heartbeatStore.getAllAgents();
    const stats = heartbeatStore.getStats();

    res.json({
      cluster_id: config.clusterId,
      cluster_name: config.clusterName,
      stats: {
        total: stats.total,
        healthy: stats.healthy,
        unhealthy: stats.unhealthy,
        by_mode: stats.byMode,
        observed: stats.observed,
      },
      agents,
    });
  });

  /**
   * GET /agents/:agentId
   *
   * Get detailed status for a single agent.
   */
  router.get('/:agentId', (req: Request, res: Response) => {
    const { agentId } = req.params;
    const agent = heartbeatStore.getAgent(agentId);

    if (!agent) {
      res.status(404).json({
        error: 'Agent not found',
        agent_uuid: agentId,
        cluster_id: config.clusterId,
      });
      return;
    }

    res.json({
      cluster_id: config.clusterId,
      cluster_name: config.clusterName,
      agent,
    });
  });

  /**
   * DELETE /agents/:agentId
   *
   * Remove an agent from tracking (e.g., after confirmed termination).
   * This is an administrative action, not called by agents themselves.
   */
  router.delete('/:agentId', (req: Request, res: Response) => {
    const { agentId } = req.params;
    const existed = heartbeatStore.removeAgent(agentId);

    if (!existed) {
      res.status(404).json({
        error: 'Agent not found',
        agent_uuid: agentId,
      });
      return;
    }

    res.json({
      removed: true,
      agent_uuid: agentId,
    });
  });

  return router;
}
