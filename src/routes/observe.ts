/**
 * Observe Route - WebSocket real-time streaming
 *
 * WS /observe/:agentId - Real-time heartbeat stream for a specific agent
 *
 * Used when UI has observation mode enabled for an agent.
 * Streams heartbeat updates as they arrive.
 */

import type { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { heartbeatStore } from '../store.js';
import type { Config } from '../config.js';

// WebSocket ready states
const WS_OPEN = WebSocket.OPEN;

interface ObserveConnection {
  ws: WebSocket;
  agentId: string;
  cleanup: () => void;
}

export function setupObserveWebSocket(server: Server, config: Config): void {
  const wss = new WebSocketServer({
    server,
    path: '/observe',
  });

  const connections: Map<WebSocket, ObserveConnection> = new Map();

  wss.on('connection', (ws: WebSocket, req) => {
    // Extract agentId from URL path: /observe/agent-uuid
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const pathParts = url.pathname.split('/').filter(Boolean);
    const agentId = pathParts[1]; // /observe/:agentId

    if (!agentId) {
      ws.send(
        JSON.stringify({
          error: 'Agent ID required',
          usage: 'ws://host/observe/:agentId',
        })
      );
      ws.close(4000, 'Agent ID required');
      return;
    }

    console.log(`[Observe] Client connected for agent: ${agentId}`);

    // Send initial state
    const currentStatus = heartbeatStore.getAgent(agentId);
    ws.send(
      JSON.stringify({
        type: 'initial',
        cluster_id: config.clusterId,
        agent: currentStatus || { agent_uuid: agentId, status: 'unknown' },
      })
    );

    // Register for updates
    const cleanup = heartbeatStore.enableObservation(agentId, (entry) => {
      if (ws.readyState === WS_OPEN) {
        ws.send(
          JSON.stringify({
            type: 'heartbeat',
            cluster_id: config.clusterId,
            agent: {
              agent_uuid: entry.agent_uuid,
              agent_name: entry.agent_name,
              mode: entry.mode,
              uptime_seconds: entry.uptime_seconds,
              last_seen: entry.last_seen.toISOString(),
              consecutive_heartbeats: entry.consecutive_heartbeats,
            },
            timestamp: new Date().toISOString(),
          })
        );
      }
    });

    connections.set(ws, { ws, agentId, cleanup });

    // Handle client messages (ping/pong, etc.)
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
        }
      } catch {
        // Ignore invalid messages
      }
    });

    // Handle disconnection
    ws.on('close', () => {
      console.log(`[Observe] Client disconnected for agent: ${agentId}`);
      const conn = connections.get(ws);
      if (conn) {
        conn.cleanup();
        connections.delete(ws);
      }
    });

    // Handle errors
    ws.on('error', (error) => {
      console.error(`[Observe] WebSocket error for agent ${agentId}:`, error);
      const conn = connections.get(ws);
      if (conn) {
        conn.cleanup();
        connections.delete(ws);
      }
    });
  });

  // Periodic ping to keep connections alive
  setInterval(() => {
    for (const [ws] of connections) {
      if (ws.readyState === WS_OPEN) {
        ws.ping();
      }
    }
  }, 30000);

  console.log('[Observe] WebSocket server initialized at /observe/:agentId');
}
