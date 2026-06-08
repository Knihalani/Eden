# Eden — Real-Time Streaming & Event Architecture

> **Date:** May 29, 2026  
> **Purpose:** Define how Eden delivers real-time updates to users during pipeline execution, agent tracing, benchmark runs, and production monitoring. Covers protocol selection, event sourcing, stream processing, connection management at scale, and ordered delivery guarantees.

---

## Table of Contents

1. [Strategic Thesis](#1-strategic-thesis)
2. [Protocol Selection](#2-protocol-selection)
3. [Event Sourcing for Agent Traces](#3-event-sourcing-for-agent-traces)
4. [Pipeline Streaming](#4-pipeline-streaming)
5. [Real-Time Dashboards](#5-real-time-dashboards)
6. [Stream Processing for Metrics](#6-stream-processing-for-metrics)
7. [Backpressure & Circuit Breakers](#7-backpressure--circuit-breakers)
8. [Connection Management at Scale](#8-connection-management-at-scale)
9. [Ordered Delivery Guarantees](#9-ordered-delivery-guarantees)
10. [Event Schema & Taxonomy](#10-event-schema--taxonomy)
11. [Implementation Roadmap](#11-implementation-roadmap)

---

## 1. Strategic Thesis

Eden's pipeline can take minutes to hours. Users cannot wait blindly — they need **real-time visibility** into:

- Which pipeline node is currently running
- What the agent is thinking, tool calls it's making, observations it's receiving
- How benchmarks are progressing, which tests passed/failed
- Production anomalies, regressions, and alerts

Real-time streaming is not a UI luxury. It is a **product requirement** that:

- Builds user trust through transparency
- Enables early intervention when things go wrong
- Supports debugging by showing the exact moment of failure
- Creates engagement during long-running operations

**Design Principles:**

| Principle | Description |
|-----------|-------------|
| **Ordered Delivery** | Events for a single agent/pipeline must arrive in sequence |
| **At-Least-Once** | No event is lost; duplicates are handled idempotently |
| **Backpressure Aware** | Slow consumers must not crash fast producers |
| **Scalable Fanout** | One event source can stream to millions of viewers |
| **Protocol Agnostic** | Same event stream can power SSE, WebSockets, and webhooks |

---

## 2. Protocol Selection

### 2.1 Decision Matrix

| Use Case | Protocol | Justification |
|----------|----------|---------------|
| **Pipeline progress** | SSE | Server-to-client only, simple, works through proxies |
| **Agent trace replay** | WebSocket | Bidirectional for pause/resume/step-through |
| **Live benchmark results** | SSE | High fanout, low latency, easy load balancing |
| **Production alerts** | WebSocket + Push | Bidirectional for acknowledgment/actions |
| **Inter-service events** | gRPC streaming | Binary, typed, efficient internal mesh |
| **Mobile app** | SSE | Battery efficient, reconnects gracefully |

### 2.2 Server-Sent Events (SSE)

**For:** Pipeline stages, benchmark progress, simple trace viewing

```http
GET /v1/jobs/job_abc123/stream HTTP/1.1
Accept: text/event-stream

HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

event: stage_start
data: {"stage":"design","timestamp":"2026-05-29T12:00:05Z","message":"Analyzing requirements..."}

event: stage_progress
data: {"stage":"design","progress":0.45,"timestamp":"2026-05-29T12:00:12Z"}

event: stage_complete
data: {"stage":"design","status":"completed","timestamp":"2026-05-29T12:00:15Z","output_hash":"sha256:abc..."}

event: stage_start
data: {"stage":"generate","timestamp":"2026-05-29T12:00:16Z","message":"Writing environment code..."}
```

**Advantages:**
- Native HTTP — works through all proxies, CDNs, and load balancers
- Automatic reconnection with `Last-Event-ID`
- Simple client implementation (EventSource API)
- No WebSocket handshake overhead

**Limitations:**
- Unidirectional (server → client only)
- Max 6 connections per browser (HTTP/1.1 limit) — mitigated by HTTP/2
- No binary data (base64 encode if needed)

### 2.3 WebSockets

**For:** Interactive trace inspection, real-time collaboration, alert management

```javascript
const ws = new WebSocket('wss://api.eden.dev/v1/traces/trace_abc123/ws');

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case 'agent_thought':
      renderThought(msg.content);
      break;
    case 'tool_call':
      renderToolCall(msg.tool, msg.arguments);
      break;
    case 'tool_result':
      renderToolResult(msg.result);
      break;
    case 'user_intervention_required':
      showInterventionDialog(msg.reason);
      break;
  }
};

// Bidirectional: send commands back
ws.send(JSON.stringify({
  type: 'command',
  action: 'pause',
  at_step: msg.step_number
}));
```

**Advantages:**
- Bidirectional (client can pause, step through, inject messages)
- Lower latency than SSE for frequent messages
- Binary data support

**Limitations:**
- Harder to scale (sticky sessions, custom load balancing)
- Connection state complicates horizontal scaling
- Firewall/proxy issues in corporate networks

### 2.4 gRPC Streaming

**For:** Internal microservice communication

```protobuf
service TraceStreamer {
  rpc StreamTrace(TraceRequest) returns (stream TraceEvent);
  rpc StreamMetrics(MetricsRequest) returns (stream MetricEvent);
}

message TraceEvent {
  string trace_id = 1;
  int32 step_number = 2;
  EventType type = 3;
  google.protobuf.Struct payload = 4;
  google.protobuf.Timestamp timestamp = 5;
}
```

**Used for:**
- Pipeline node → Event bus
- Event bus → Stream processor
- Stream processor → Database

---

## 3. Event Sourcing for Agent Traces

### 3.1 Trace as Event Log

Instead of storing the final state, Eden stores every step as an immutable event:

```json
{
  "trace_id": "trace_abc123",
  "events": [
    {
      "sequence": 1,
      "timestamp": "2026-05-29T12:00:01Z",
      "type": "system_prompt_loaded",
      "payload": {"prompt_version": "agent-v2.1", "hash": "sha256:..."}
    },
    {
      "sequence": 2,
      "timestamp": "2026-05-29T12:00:02Z",
      "type": "user_message",
      "payload": {"role": "user", "content": "Find the cheapest flight to Tokyo"}
    },
    {
      "sequence": 3,
      "timestamp": "2026-05-29T12:00:03Z",
      "type": "agent_thought",
      "payload": {"content": "The user wants to find flights. I should use the flight_search tool."}
    },
    {
      "sequence": 4,
      "timestamp": "2026-05-29T12:00:04Z",
      "type": "tool_call",
      "payload": {"tool": "flight_search", "arguments": {"destination": "NRT", "date": "2026-06-15"}}
    },
    {
      "sequence": 5,
      "timestamp": "2026-05-29T12:00:06Z",
      "type": "tool_result",
      "payload": {"tool": "flight_search", "result": [...], "latency_ms": 1200}
    },
    {
      "sequence": 6,
      "timestamp": "2026-05-29T12:00:07Z",
      "type": "agent_response",
      "payload": {"content": "I found 5 flights to Tokyo...", "tokens_used": 450}
    }
  ]
}
```

### 3.2 Benefits of Event Sourcing

| Benefit | Description |
|---------|-------------|
| **Time-travel debugging** | Replay any trace from the beginning at any point |
| **Partial recovery** | If streaming fails at step 50, resume from step 51 |
| **Human-in-the-loop** | Pause at any step, modify context, continue |
| **Audit trail** | Complete, immutable record of agent reasoning |
| **Analytics** | Aggregate events to derive insights |

### 3.3 Event Store Implementation

```python
class TraceEventStore:
    """Append-only event store for agent traces."""

    async def append(self, trace_id: str, event: TraceEvent):
        # Get current sequence number
        current_seq = await self.redis.incr(f"trace:{trace_id}:seq")

        event.sequence = current_seq

        # Write to Kafka (durable, partitioned by trace_id)
        await self.kafka.send(
            topic="agent-traces",
            key=trace_id,  # Ensures ordering within trace
            value=event.to_json()
        )

        # Also write to Redis for fast recent access
        await self.redis.xadd(
            f"trace:{trace_id}:events",
            fields=event.to_dict(),
            maxlen=10000  # Keep last 10K events per trace
        )

    async def get_trace(self, trace_id: str, from_sequence: int = 0) -> list[TraceEvent]:
        # Hot path: read from Redis streams
        events = await self.redis.xrange(
            f"trace:{trace_id}:events",
            min=f"{from_sequence}",
            max="+"
        )

        if len(events) < 100:  # Likely incomplete
            # Cold path: read from ClickHouse
            events = await self.clickhouse.query(
                "SELECT * FROM trace_events WHERE trace_id = {trace_id} AND sequence >= {from} ORDER BY sequence"
            )

        return [TraceEvent.from_dict(e) for e in events]
```

---

## 4. Pipeline Streaming

### 4.1 Pipeline Event Flow

```
Pipeline Node (design, generate, validate, ...)
       │
       ▼
┌──────────────────┐
│  Node Event      │  {"node": "design", "status": "in_progress", "progress": 0.5}
│  Emitter         │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Kafka Topic     │  "pipeline-events" (partitioned by job_id)
│  (durable buffer)│
└────────┬─────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌────────┐
│ SSE    │ │ WebSocket│  Different clients consume same events
│ Stream │ │ Fanout   │
└────────┘ └────────┘
```

### 4.2 Event Types by Pipeline Stage

| Stage | Events Emitted | Frequency |
|-------|---------------|-----------|
| **Design** | `stage_start`, `requirement_analysis`, `design_decision`, `stage_complete` | 5–20 events |
| **Generate** | `stage_start`, `file_created`, `code_chunk`, `test_generated`, `stage_complete` | 50–200 events |
| **Validate** | `stage_start`, `test_running`, `test_result`, `lint_result`, `stage_complete` | 20–100 events |
| **Audit** | `stage_start`, `review_started`, `review_decision`, `kb_update`, `stage_complete` | 5–10 events |

### 4.3 Progress Calculation

```python
class PipelineProgressTracker:
    STAGE_WEIGHTS = {
        "design": 0.15,
        "generate": 0.45,
        "validate": 0.25,
        "audit": 0.10,
        "finalize": 0.05
    }

    def calculate_progress(self, current_stage: str, stage_progress: float) -> float:
        completed_weight = sum(
            self.STAGE_WEIGHTS[s]
            for s in self.STAGE_WEIGHTS
            if self.is_completed(s)
        )
        current_weight = self.STAGE_WEIGHTS.get(current_stage, 0)
        return completed_weight + (current_weight * stage_progress)
```

---

## 5. Real-Time Dashboards

### 5.1 Architecture

```
Browser Dashboard
       │
       ▼ (WebSocket connection)
┌──────────────────┐
│  Edge Fanout     │  Cloudflare Workers / Ably / Pusher
│  Service         │  (handles millions of concurrent connections)
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Real-Time       │  Aggregates events into dashboard views
│  Aggregator      │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Kafka Consumer  │  Reads from multiple event topics
└──────────────────┘
```

### 5.2 Dashboard Views

| View | Data Source | Update Frequency |
|------|------------|-------------------|
| **Pipeline monitor** | Pipeline events | Real-time (SSE) |
| **Trace inspector** | Agent trace events | Real-time (WebSocket) |
| **Benchmark progress** | Benchmark runner events | Every 5 seconds |
| **Cost dashboard** | Metering events | Every minute |
| **Alert feed** | Insights engine alerts | Real-time (WebSocket) |
| **Organization overview** | Aggregated metrics | Every 30 seconds |

### 5.3 Live Benchmark Progress

```json
{
  "type": "benchmark_progress",
  "benchmark_id": "bench_abc123",
  "timestamp": "2026-05-29T12:00:00Z",
  "overall": {
    "total_cases": 500,
    "completed": 342,
    "passed": 310,
    "failed": 32,
    "progress": 0.684
  },
  "current_case": {
    "id": "case_343",
    "status": "running",
    "elapsed_ms": 1200,
    "agent_steps": 15
  },
  "metrics_trend": {
    "success_rate": [0.85, 0.87, 0.86, 0.88, 0.89, 0.91],
    "avg_latency_ms": [1200, 1150, 1180, 1100, 1050, 1020]
  }
}
```

---

## 6. Stream Processing for Metrics

### 6.1 Kafka Stream Topology

```
Raw Events (pipeline, traces, benchmarks)
       │
       ▼
┌──────────────────┐
│  kafka-topics    │
│  - pipeline-events│
│  - trace-events   │
│  - benchmark-events│
│  - metering-events│
└────────┬─────────┘
         │
    ┌────┴────┬────────┬────────┐
    ▼         ▼        ▼        ▼
┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐
│Flink  │ │ksqlDB │ │Custom │ │Kafka  │
│Jobs   │ │Views  │ │Consumer││Connect│
└───┬───┘ └───┬───┘ └───┬───┘ └───┬───┘
    │         │         │         │
    ▼         ▼         ▼         ▼
┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐
│Alerts │ │Metrics│ │Cost   │ │Export │
│       │ │Dashboard│ │Tracking│ │to S3 │
└───────┘ └───────┘ └───────┘ └───────┘
```

### 6.2 Real-Time Metrics Aggregation

```sql
-- ksqlDB: Rolling error rate per tenant
CREATE TABLE tenant_error_rates AS
SELECT
  tenant_id,
  COUNT(*) AS total_requests,
  SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
  (SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) * 100.0 / COUNT(*)) AS error_rate
FROM pipeline_events
WINDOW TUMBLING (SIZE 5 MINUTES)
GROUP BY tenant_id;
```

### 6.3 Alert Generation Stream

```python
class AlertStreamProcessor:
    async def process(self, event: MetricEvent):
        # Check against alert rules
        rules = await self.get_rules(event.tenant_id)

        for rule in rules:
            if rule.matches(event):
                alert = Alert(
                    rule_id=rule.id,
                    severity=rule.severity,
                    message=rule.generate_message(event),
                    context=event.to_dict(),
                    timestamp=datetime.utcnow()
                )

                # Emit to alert topic
                await self.kafka.send("alerts", key=event.tenant_id, value=alert.to_json())

                # Notify via WebSocket if user is online
                await self.websocket_fanout.send_to_tenant(event.tenant_id, alert)
```

---

## 7. Backpressure & Circuit Breakers

### 7.1 Backpressure Handling

When consumers cannot keep up with producers:

```python
class BackpressureController:
    def __init__(self, max_buffer_size: int = 10000):
        self.buffer = asyncio.Queue(maxsize=max_buffer_size)
        self.dropped_count = 0

    async def emit(self, event: Event):
        try:
            self.buffer.put_nowait(event)
        except asyncio.QueueFull:
            # Buffer full — apply shedding strategy
            self.dropped_count += 1
            if self.should_shed(event):
                # Drop low-priority events, keep critical ones
                return
            else:
                # Block producer until space available
                await self.buffer.put(event)

    def should_shed(self, event: Event) -> bool:
        # Shed non-critical events first
        return event.priority in ("debug", "info")
```

### 7.2 Circuit Breakers

Protect downstream services from overload:

```python
class CircuitBreaker:
    def __init__(self, failure_threshold=5, recovery_timeout=30):
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.state = State.CLOSED  # CLOSED → OPEN → HALF_OPEN → CLOSED
        self.failures = 0

    async def call(self, func, *args, **kwargs):
        if self.state == State.OPEN:
            if time.time() - self.last_failure < self.recovery_timeout:
                raise CircuitBreakerOpen("Service temporarily unavailable")
            self.state = State.HALF_OPEN

        try:
            result = await func(*args, **kwargs)
            if self.state == State.HALF_OPEN:
                self.state = State.CLOSED
                self.failures = 0
            return result
        except Exception as e:
            self.failures += 1
            self.last_failure = time.time()
            if self.failures >= self.failure_threshold:
                self.state = State.OPEN
            raise
```

### 7.3 Streaming Rate Limits

| Consumer Type | Max Events/Second | Action on Exceed |
|--------------|--------------------|-----------------|
| Free tier dashboard | 10 | Drop non-critical events |
| Team tier dashboard | 100 | Buffer with backpressure |
| Enterprise dashboard | 1000 | Dedicated stream partition |
| Webhook endpoint | 100 | Queue for retry |

---

## 8. Connection Management at Scale

### 8.1 Connection Scaling Targets

| Metric | Target |
|--------|--------|
| Concurrent WebSocket connections | 1,000,000 per region |
| Concurrent SSE connections | 2,000,000 per region |
| Message fanout latency (p99) | < 100ms |
| Reconnection time | < 2 seconds |
| Memory per connection | < 10KB |

### 8.2 Edge Fanout Architecture

Instead of maintaining millions of connections on application servers, use edge fanout services:

```
┌─────────────────────────────────────────────────────────────┐
│                        Edge Layer                            │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐      │
│  │ CF Durable│  │ Ably    │  │ Pusher  │  │ Azure   │      │
│  │ Objects │  │ Edge    │  │ Edge    │  │ Web PubSub│     │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘      │
│       │            │            │            │             │
│       └────────────┴────────────┴────────────┘             │
│                      Edge Fanout Service                     │
│                      (manages 1M+ connections)               │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
                    ┌──────────────┐
                    │  API Gateway │  (tunnels to origin)
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
                    │  Event Bus     │  (Kafka)
                    └──────────────┘
```

### 8.3 Connection Resilience

```javascript
// Client-side reconnection with exponential backoff
class ResilientEventSource {
  constructor(url) {
    this.url = url;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.baseDelay = 1000;
    this.connect();
  }

  connect() {
    this.es = new EventSource(this.url);

    this.es.onmessage = (event) => {
      this.reconnectAttempts = 0;  // Reset on success
      this.handleMessage(event);
    };

    this.es.onerror = () => {
      this.es.close();
      this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('fatal_error');
      return;
    }

    const delay = Math.min(
      this.baseDelay * Math.pow(2, this.reconnectAttempts),
      30000  // Max 30 seconds
    );

    setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }
}
```

---

## 9. Ordered Delivery Guarantees

### 9.1 Ordering Requirements

| Stream Type | Ordering Guarantee | Implementation |
|------------|--------------------|----------------|
| **Agent trace steps** | Strict ordering (sequence numbers) | Kafka partition by trace_id |
| **Pipeline stages** | Strict ordering (stage sequence) | Kafka partition by job_id |
| **Benchmark cases** | Best-effort ordering | Kafka partition by benchmark_id |
| **Metrics** | No ordering required | Kafka round-robin partitioning |
| **Alerts** | Priority-based (severity order) | Separate topic per severity |

### 9.2 Kafka Partitioning Strategy

```python
class EventPartitioner:
    def partition(self, event: Event, num_partitions: int) -> int:
        if event.type in ("agent_trace", "pipeline"):
            # Strict ordering: partition by entity ID
            return hash(event.entity_id) % num_partitions

        elif event.type == "benchmark":
            # Best-effort: partition by benchmark ID
            return hash(event.benchmark_id) % num_partitions

        elif event.type == "metric":
            # No ordering needed: round-robin
            return random.randint(0, num_partitions - 1)

        elif event.type == "alert":
            # Priority: partition by severity
            severity_map = {"critical": 0, "high": 1, "medium": 2, "low": 3}
            return severity_map.get(event.severity, 3)
```

### 9.3 Idempotency

For at-least-once delivery, consumers must be idempotent:

```python
class IdempotentConsumer:
    def __init__(self, redis: Redis):
        self.redis = redis

    async def process(self, event: Event):
        # Check if already processed
        processed_key = f"processed:{event.id}"
        if await self.redis.set(processed_key, "1", nx=True, ex=3600):
            # Not processed yet — process now
            await self.handle(event)
        else:
            # Duplicate — skip
            logger.debug(f"Skipping duplicate event: {event.id}")
```

---

## 10. Event Schema & Taxonomy

### 10.1 Core Event Schema

```json
{
  "$schema": "https://eden.dev/schemas/event/v1",
  "type": "object",
  "required": ["event_id", "event_type", "timestamp", "version"],
  "properties": {
    "event_id": {"type": "string", "format": "uuid"},
    "event_type": {"type": "string", "enum": [
      "pipeline.stage_start",
      "pipeline.stage_progress",
      "pipeline.stage_complete",
      "agent.thought",
      "agent.tool_call",
      "agent.tool_result",
      "agent.response",
      "benchmark.case_start",
      "benchmark.case_complete",
      "benchmark.suite_complete",
      "metric.gauge",
      "metric.counter",
      "alert.triggered",
      "alert.resolved",
      "user.intervention_required"
    ]},
    "timestamp": {"type": "string", "format": "date-time"},
    "version": {"type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$"},
    "tenant_id": {"type": "string"},
    "user_id": {"type": "string"},
    "entity_id": {"type": "string", "description": "job_id, trace_id, or benchmark_id"},
    "sequence": {"type": "integer", "description": "Ordering within entity"},
    "priority": {"type": "string", "enum": ["critical", "high", "medium", "low", "debug"]},
    "payload": {"type": "object"}
  }
}
```

### 10.2 Event Topics

| Topic | Partitions | Retention | Consumers |
|-------|-----------|-----------|-----------|
| `pipeline-events` | 64 | 7 days | Dashboards, metrics, audit |
| `trace-events` | 256 | 30 days | Dashboards, dataset export, replay |
| `benchmark-events` | 32 | 7 days | Progress bars, result aggregation |
| `metering-events` | 64 | 90 days | Billing, cost dashboards |
| `alerts` | 16 | 30 days | Notification service, PagerDuty |
| `insights` | 32 | 90 days | Dataset generator, KB updater |

---

## 11. Implementation Roadmap

### Phase 1: Foundation (Weeks 1–4)
- [ ] Deploy Kafka cluster with topic partitioning strategy
- [ ] Implement SSE endpoint for pipeline streaming
- [ ] Build basic event sourcing for agent traces (Redis + Kafka)
- [ ] Add event schema validation (JSON Schema)
- [ ] Implement idempotent consumer pattern

### Phase 2: Scale (Weeks 5–8)
- [ ] Deploy WebSocket endpoint for interactive trace inspection
- [ ] Implement edge fanout (Cloudflare Workers or Ably)
- [ ] Add circuit breakers for all streaming endpoints
- [ ] Build backpressure handling with event shedding
- [ ] Create real-time benchmark progress dashboard

### Phase 3: Intelligence (Weeks 9–12)
- [ ] Deploy ksqlDB/Flink for real-time metrics aggregation
- [ ] Build alert generation stream with severity-based routing
- [ ] Implement trace replay from event log
- [ ] Add human-in-the-loop pause/resume via WebSocket commands
- [ ] Build cost tracking stream with real-time dashboards

### Phase 4: Polish (Weeks 13–16)
- [ ] Implement gRPC streaming for internal service mesh
- [ ] Add mobile-optimized SSE with battery-aware reconnects
- [ ] Build public event Webhooks for third-party integrations
- [ ] Add event archival to S3 with Parquet format
- [ ] Launch public streaming API documentation

---

*This document should be read alongside [`eden-observability-and-knowledge-architecture.md`](./eden-observability-and-knowledge-architecture.md) for how observability data flows through these streams and [`eden-sdk-integration-architecture.md`](./eden-sdk-integration-architecture.md) for client-side streaming consumption.*
