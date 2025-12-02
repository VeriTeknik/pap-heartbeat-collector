# PAP Heartbeat Collector

Local heartbeat collector for PAP (Plugged.in Agent Protocol) agents. Collects heartbeats within a cluster and alerts the central pluggedin-app only when problems occur.

## Overview

Instead of each agent sending heartbeats directly to the central pluggedin-app (which doesn't scale), agents send heartbeats to this local collector. The collector:

1. **Stores state in memory** - Fast O(1) heartbeat recording
2. **Performs local zombie detection** - Detects missed heartbeats within the cluster
3. **Pushes alerts only on problems** - Agent death, EMERGENCY mode, restarts
4. **Responds to on-demand queries** - Central can query agent status when needed
5. **Provides WebSocket streaming** - Real-time observation mode for debugging

## Traffic Reduction

| Scenario | Without Collector | With Collector | Reduction |
|----------|-------------------|----------------|-----------|
| Normal (10K agents) | 333 req/s | ~0 req/s | 100% |
| 1 agent dies | 333 req/s | 1 req (alert) | 99.997% |
| UI opens agent page | 333 req/s | 1 req (query) | 99.997% |

## Quick Start

### Docker

```bash
docker run -d \
  -p 8080:8080 \
  -e CLUSTER_ID=my-cluster \
  -e CLUSTER_NAME="My Cluster" \
  -e STATION_ALERT_URL=https://plugged.in/api/clusters/my-cluster/alerts \
  -e STATION_ALERT_KEY=pg_in_xxx \
  ghcr.io/veriteknik/pap-heartbeat-collector:v1.0.0
```

### Kubernetes

```bash
# Edit configmap.yaml with your cluster details
kubectl apply -f k8s/configmap.yaml

# Create secrets
kubectl create secret generic pap-collector-secrets -n agents \
  --from-literal=station-alert-key=<your-api-key>

# Deploy
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
```

### Development

```bash
npm install
npm run dev
```

## API Endpoints

### Receive Heartbeat

```bash
POST /heartbeat/:agentId
Content-Type: application/json

{
  "mode": "IDLE",           # EMERGENCY | IDLE | SLEEP
  "uptime_seconds": 3600,
  "agent_name": "my-agent"  # Optional
}
```

Response:
```json
{
  "received": true,
  "is_new": false,
  "restart_detected": false,
  "next_heartbeat_ms": 30000
}
```

### List All Agents

```bash
GET /agents
```

Response:
```json
{
  "cluster_id": "is.plugged.in",
  "cluster_name": "Production Cluster",
  "stats": {
    "total": 42,
    "healthy": 41,
    "unhealthy": 1,
    "by_mode": { "EMERGENCY": 1, "IDLE": 40, "SLEEP": 1 },
    "observed": 2
  },
  "agents": [...]
}
```

### Get Single Agent

```bash
GET /agents/:agentId
```

### Real-time Observation (WebSocket)

```javascript
const ws = new WebSocket('ws://localhost:8080/observe/my-agent-uuid');

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Heartbeat:', data);
};
```

### Health Check

```bash
GET /health
```

### Prometheus Metrics

```bash
GET /metrics
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CLUSTER_ID` | Yes | - | Unique cluster identifier |
| `CLUSTER_NAME` | No | Same as CLUSTER_ID | Human-readable name |
| `COLLECTOR_PORT` | No | 8080 | HTTP server port |
| `STATION_ALERT_URL` | No | - | Central alerts endpoint |
| `STATION_ALERT_KEY` | No | - | API key for central |
| `ZOMBIE_CHECK_INTERVAL_MS` | No | 10000 | Zombie check frequency |
| `ALERT_QUEUE_MAX_SIZE` | No | 100 | Max queued alerts |
| `ALERT_QUEUE_TTL_MS` | No | 300000 | Alert queue TTL (5 min) |

## Alert Types

The collector sends these alerts to central:

| Type | Severity | Trigger |
|------|----------|---------|
| `AGENT_DEATH` | critical | Agent missed 2x heartbeat interval |
| `EMERGENCY_MODE` | warning | Agent switched to EMERGENCY mode |
| `RESTART_DETECTED` | info | Agent uptime decreased (restart) |

## Graceful Degradation

| Scenario | Behavior |
|----------|----------|
| Collector unavailable | Agents fall back to direct central heartbeat |
| Central unavailable | Collector queues alerts (max 100, 5 min TTL) |
| Collector restart | Agents re-heartbeat within 30s, state rebuilds |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│          Kubernetes Cluster / Docker Environment                     │
│                                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                           │
│  │ Agent 1  │  │ Agent 2  │  │ Agent N  │                           │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                           │
│       │             │             │                                  │
│       └─────────────┼─────────────┘                                  │
│                     │ Heartbeats (30s)                               │
│                     ▼                                                │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │            PAP Heartbeat Collector (this service)            │   │
│  │                                                                │   │
│  │  - In-memory state                                            │   │
│  │  - Local zombie detection                                     │   │
│  │  - Alert-only push to central                                 │   │
│  └────────────────────────────────┬─────────────────────────────┘   │
└───────────────────────────────────┼──────────────────────────────────┘
                                    │
            ┌───────────────────────┴───────────────────────┐
            │ PUSH (only on problems)      PULL (on-demand)  │
            ▼                              ▲                  │
┌──────────────────────────────────────────────────────────────────┐
│                      pluggedin-app (Central)                      │
└──────────────────────────────────────────────────────────────────┘
```

## PAP Compliance

This collector implements PAP-RFC-001 §8.1:

- **Heartbeat intervals**: EMERGENCY (5s), IDLE (30s), SLEEP (15min)
- **Zombie detection**: 2x interval grace period
- **Liveness only**: Heartbeats contain only mode and uptime (no metrics)
- **Metrics separation**: Not handled by collector (separate channel)

## License

MIT
