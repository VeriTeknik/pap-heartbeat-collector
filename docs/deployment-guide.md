# PAP Heartbeat Collector Deployment Guide

## Overview

This guide covers deploying the PAP Heartbeat Collector architecture across different environments.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Kubernetes Cluster (e.g., is.plugged.in)                       │
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                       │
│  │ Agent 1  │  │ Agent 2  │  │ Agent N  │                       │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                       │
│       │             │             │                              │
│       └─────────────┼─────────────┘                              │
│                     │ Heartbeats (every 30s)                     │
│                     ▼                                            │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │         PAP Heartbeat Collector (in-cluster)              │   │
│  │         http://pap-collector.agents.svc:8080              │   │
│  └────────────────────────────┬─────────────────────────────┘   │
│                               │                                  │
└───────────────────────────────┼──────────────────────────────────┘
                                │ PUSH alerts only (on problems)
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│  Central: plugged.in                                             │
│  POST /api/clusters/{clusterId}/alerts                           │
└──────────────────────────────────────────────────────────────────┘
```

---

## Components

| Component | Repository | Image |
|-----------|------------|-------|
| Heartbeat Collector | `veriteknik/pap-heartbeat-collector` | `ghcr.io/veriteknik/pap-heartbeat-collector:v1.0.0` |
| Compass Agent | `veriteknik/compass-agent` | `ghcr.io/veriteknik/compass-agent:v1.0.1` |
| Central App | `veriteknik/pluggedin-app` | - |

---

## Environment Checklist

### 1. Central App (plugged.in server)

| Task | Command/Action | Status |
|------|----------------|--------|
| Add collector API key to env | `PAP_COLLECTOR_API_KEY=pap_collector_bd2772afdac81e02aba33da7f2f9ce96d02b793818988f398111bcf450ed44f5` | |
| Run database migration | `npx drizzle-kit migrate` | |
| Deploy updated app | Pull `feature/pap-agents` branch, rebuild | |

**Environment Variables:**
```bash
# .env or deployment config
PAP_COLLECTOR_API_KEY=pap_collector_bd2772afdac81e02aba33da7f2f9ce96d02b793818988f398111bcf450ed44f5
```

**Database Tables Created:**
- `clusters` - Registered clusters
- `cluster_alerts` - Alerts from collectors

---

### 2. Kubernetes Cluster (is.plugged.in)

#### 2.1 Create Collector Secret

```bash
kubectl create secret generic pap-collector-secrets \
  --namespace=agents \
  --from-literal=station-alert-key=pap_collector_bd2772afdac81e02aba33da7f2f9ce96d02b793818988f398111bcf450ed44f5
```

#### 2.2 Deploy Collector

```bash
kubectl apply -f pap-heartbeat-collector/k8s/is-plugged-in-deploy.yaml
```

Or manually:

```yaml
# ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: pap-collector-config
  namespace: agents
data:
  cluster-id: "is.plugged.in"
  cluster-name: "Production Cluster (is.plugged.in)"
  station-alert-url: "https://plugged.in/api/clusters/is.plugged.in/alerts"
---
# Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pap-heartbeat-collector
  namespace: agents
spec:
  replicas: 1
  selector:
    matchLabels:
      app: pap-heartbeat-collector
  template:
    metadata:
      labels:
        app: pap-heartbeat-collector
    spec:
      containers:
      - name: collector
        image: ghcr.io/veriteknik/pap-heartbeat-collector:v1.0.0
        ports:
        - containerPort: 8080
        env:
        - name: CLUSTER_ID
          valueFrom:
            configMapKeyRef:
              name: pap-collector-config
              key: cluster-id
        - name: CLUSTER_NAME
          valueFrom:
            configMapKeyRef:
              name: pap-collector-config
              key: cluster-name
        - name: STATION_ALERT_URL
          valueFrom:
            configMapKeyRef:
              name: pap-collector-config
              key: station-alert-url
        - name: STATION_ALERT_KEY
          valueFrom:
            secretKeyRef:
              name: pap-collector-secrets
              key: station-alert-key
---
# Service
apiVersion: v1
kind: Service
metadata:
  name: pap-collector
  namespace: agents
spec:
  selector:
    app: pap-heartbeat-collector
  ports:
  - port: 8080
    targetPort: 8080
```

#### 2.3 Update Network Policy

The `agent-isolation` network policy must allow:
- **Egress**: Agents → Collector on port 8080
- **Ingress**: Collector accepts from all pods in namespace

```bash
kubectl patch networkpolicy agent-isolation -n agents --type='json' -p='[
  {"op": "add", "path": "/spec/egress/-", "value": {"ports": [{"port": 8080, "protocol": "TCP"}], "to": [{"podSelector": {"matchLabels": {"app": "pap-heartbeat-collector"}}}]}},
  {"op": "add", "path": "/spec/ingress/-", "value": {"from": [{"podSelector": {}}], "ports": [{"port": 8080, "protocol": "TCP"}]}}
]'
```

#### 2.4 Verify Collector

```bash
# Check pod is running
kubectl get pods -n agents -l app=pap-heartbeat-collector

# Check health
kubectl exec -n agents deploy/pap-heartbeat-collector -- wget -qO- http://localhost:8080/health

# Check registered agents
kubectl exec -n agents deploy/pap-heartbeat-collector -- wget -qO- http://localhost:8080/agents
```

---

### 3. Agent Configuration

Agents need these environment variables:

| Variable | Value | Required |
|----------|-------|----------|
| `PAP_COLLECTOR_URL` | `http://pap-collector.agents.svc:8080` | Yes |
| `PAP_STATION_URL` | `https://plugged.in/api/agents` | Yes (fallback) |
| `PAP_AGENT_ID` | Agent UUID | Yes |
| `PAP_AGENT_KEY` | API key for station auth | Yes |

**For existing agents**, patch the deployment:

```bash
kubectl patch deployment <agent-name> -n agents --type='json' -p='[
  {"op": "add", "path": "/spec/template/spec/containers/0/env/-",
   "value": {"name": "PAP_COLLECTOR_URL", "value": "http://pap-collector.agents.svc:8080"}}
]'
```

**For new agents**, the pluggedin-app should include `PAP_COLLECTOR_URL` in deployment env vars.

---

## Local Development

### Running Collector Locally

```bash
cd pap-heartbeat-collector
npm install
npm run build

# Set environment
export CLUSTER_ID=dev-local
export CLUSTER_NAME="Local Development"
export COLLECTOR_PORT=8080
# Optional: export STATION_ALERT_URL=http://localhost:3000/api/clusters/dev-local/alerts

npm start
```

### Testing Heartbeat

```bash
# Send test heartbeat
curl -X POST http://localhost:8080/heartbeat/test-agent-123 \
  -H "Content-Type: application/json" \
  -d '{"mode": "IDLE", "uptime_seconds": 100, "agent_name": "test-agent"}'

# Check agents
curl http://localhost:8080/agents
```

### Running pluggedin-app Locally

```bash
cd pluggedin-app
npm install

# Set environment
export DATABASE_URL=postgresql://user:pass@localhost:5432/pluggedin
export PAP_COLLECTOR_API_KEY=pap_collector_bd2772afdac81e02aba33da7f2f9ce96d02b793818988f398111bcf450ed44f5

# Run migrations
npx drizzle-kit migrate

# Start dev server
npm run dev
```

### Testing Alert Endpoint

```bash
curl -X POST http://localhost:3000/api/clusters/dev-local/alerts \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer pap_collector_bd2772afdac81e02aba33da7f2f9ce96d02b793818988f398111bcf450ed44f5" \
  -d '{
    "type": "AGENT_DEATH",
    "agent_uuid": "550e8400-e29b-41d4-a716-446655440000",
    "agent_name": "test-agent",
    "cluster_id": "dev-local",
    "severity": "critical",
    "details": {"reason": "heartbeat_timeout"},
    "timestamp": "2025-12-02T10:00:00Z"
  }'
```

---

## Multi-Cluster Setup

For additional clusters, repeat steps 2.1-2.4 with cluster-specific values:

| Cluster | cluster-id | station-alert-url |
|---------|------------|-------------------|
| is.plugged.in | `is.plugged.in` | `https://plugged.in/api/clusters/is.plugged.in/alerts` |
| us-east | `us-east` | `https://plugged.in/api/clusters/us-east/alerts` |
| eu-west | `eu-west` | `https://plugged.in/api/clusters/eu-west/alerts` |

All clusters use the **same** `PAP_COLLECTOR_API_KEY` for simplicity (or generate unique keys per cluster for isolation).

---

## Verification Checklist

### Collector Health
```bash
kubectl exec -n agents deploy/pap-heartbeat-collector -- wget -qO- http://localhost:8080/health
```
Expected: `{"status":"healthy","cluster_id":"is.plugged.in",...}`

### Agent Registration
```bash
kubectl exec -n agents deploy/pap-heartbeat-collector -- wget -qO- http://localhost:8080/agents
```
Expected: List of agents with `healthy: true`

### Alert Flow (simulate agent death)
```bash
# Stop an agent, wait 60s, check collector logs for AGENT_DEATH alert
kubectl logs -n agents deploy/pap-heartbeat-collector | grep -i alert
```

### Central Receives Alerts
Check pluggedin-app logs for:
```
[Clusters] Alert received: AGENT_DEATH for agent <name> in cluster is.plugged.in
```

---

## Troubleshooting

### Agent not sending heartbeats to collector

1. Check `PAP_COLLECTOR_URL` is set:
   ```bash
   kubectl exec -n agents deploy/<agent> -- printenv | grep PAP_COLLECTOR
   ```

2. Check network connectivity:
   ```bash
   kubectl exec -n agents deploy/<agent> -- wget -qO- http://pap-collector.agents.svc:8080/health
   ```

3. Check network policy allows egress to collector

### Collector not sending alerts to central

1. Check `STATION_ALERT_URL` and `STATION_ALERT_KEY`:
   ```bash
   kubectl exec -n agents deploy/pap-heartbeat-collector -- printenv | grep STATION
   ```

2. Check connectivity to central:
   ```bash
   kubectl exec -n agents deploy/pap-heartbeat-collector -- wget -qO- https://plugged.in/health
   ```

3. Check alert queue:
   ```bash
   kubectl exec -n agents deploy/pap-heartbeat-collector -- wget -qO- http://localhost:8080/health | jq .alert_queue
   ```

### Central rejecting alerts (401)

1. Verify `PAP_COLLECTOR_API_KEY` matches in both:
   - pluggedin-app environment
   - Kubernetes secret `pap-collector-secrets`

2. Check central logs for auth warnings

---

## Current Status (is.plugged.in)

| Component | Status | Notes |
|-----------|--------|-------|
| Collector Pod | Running | `pap-heartbeat-collector-6dc8f9d7d6-*` |
| Collector Service | Active | `pap-collector.agents.svc:8080` |
| Network Policy | Updated | Allows agent→collector on 8080 |
| Secret | Created | `pap-collector-secrets` |
| Test Agent (cem) | Healthy | Sending heartbeats every 5s (EMERGENCY mode) |

**Pending on plugged.in server:**
- [ ] Add `PAP_COLLECTOR_API_KEY` to environment
- [ ] Run `npx drizzle-kit migrate`
- [ ] Deploy updated app

---

## API Reference

### Collector Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | None | Health check |
| `/metrics` | GET | None | Prometheus metrics |
| `/heartbeat/:agentId` | POST | None | Receive heartbeat |
| `/agents` | GET | None | List all agents |
| `/agents/:agentId` | GET | None | Get single agent |
| `/observe/:agentId` | WS | None | Real-time stream |

### Central Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/clusters` | GET | Session | List clusters |
| `/api/clusters/:id/alerts` | POST | Bearer (collector key) | Receive alert |
| `/api/clusters/:id/alerts` | GET | Session | List alerts |
| `/api/clusters/:id/agents` | GET | Session | Proxy to collector |

---

## Version History

| Date | Version | Changes |
|------|---------|---------|
| 2025-12-02 | 1.0.0 | Initial deployment |
| 2025-12-02 | 1.0.1 | compass-agent: Added PAP_COLLECTOR_URL support |
