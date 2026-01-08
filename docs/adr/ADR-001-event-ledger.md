# ADR-001: Event Ledger Pattern for Trade Execution

## Status
**ACCEPTED**

## Context

The DistortSignals system requires reliable, traceable, and auditable trade execution. We need to handle:

- Multiple services coordinating trade lifecycle (generator → director → officer)
- Network failures and service restarts
- Idempotent operations (same signal shouldn't create duplicate trades)
- Complete audit trail for regulatory compliance
- Recovery from partial failures

## Decision

We will implement an **Event Ledger** pattern using three core tables:

1. **`signal_outbox`**: Published trading signals (source of truth)
2. **`trade_directives`**: Commands from director to execution officer
3. **`execution_events`**: Results from MT5 execution officer

### Key Design Choices

#### 1. Pull-Based Polling (not Push)
The MT5 execution officer polls for directives rather than receiving webhooks because:
- MQL5 cannot reliably receive HTTP requests
- Polling is simpler and more resilient to network issues
- Enables backpressure control

#### 2. Explicit Status Transitions
Each table has well-defined status fields:
- `signal_outbox.status`: `pending` → `processed` → `archived`
- `trade_directives.status`: `pending` → `acknowledged` → `completed` / `failed` / `cancelled`
- `execution_events.status`: `success` / `failed` / `rejected`

#### 3. Idempotency Keys
Use `signal_id` + `symbol` + `created_at` as natural idempotency keys to prevent duplicate processing.

#### 4. Immutable Events
Never UPDATE event records; instead, append new events with references to original records.

## Consequences

### Positive
- ✅ Complete audit trail for every trade
- ✅ Easy to replay events for debugging
- ✅ Services can restart without losing state
- ✅ Idempotent operations prevent duplicate trades
- ✅ Clear ownership boundaries

### Negative
- ❌ More database writes (increased load)
- ❌ Need cleanup jobs for old events
- ❌ Slightly increased latency (multi-step process)

### Mitigation
- Implement archival strategy for events older than 90 days
- Use database indexes on `status` and `created_at` columns
- Monitor write throughput and optimize queries

## Alternatives Considered

### Alternative 1: Direct MT5 API Calls
**Rejected**: Tightly couples services, no audit trail, difficult to retry failures.

### Alternative 2: Message Queue (RabbitMQ, Kafka)
**Rejected**: Adds infrastructure complexity, database already provides ordering and durability.

### Alternative 3: REST API with Webhooks
**Rejected**: MQL5 cannot reliably receive HTTP requests.

## Implementation Notes

See `/contracts/schemas/` for JSON schemas defining each event type.

See `/db/migrations/` for database schema.

## References

- [Event Sourcing Pattern](https://martinfowler.com/eaaDev/EventSourcing.html)
- [Transactional Outbox Pattern](https://microservices.io/patterns/data/transactional-outbox.html)

---

**Date**: 2026-01-03  
**Author**: System Architect  
**Reviewers**: Backend Team
