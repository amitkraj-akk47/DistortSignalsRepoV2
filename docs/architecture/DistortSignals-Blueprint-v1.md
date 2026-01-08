# DistortSignals Architecture Blueprint v1

## System Overview

DistortSignals is a distributed trading system designed for reliability, observability, and resilience. The system follows an event-driven architecture with clear service boundaries and canonical data models.

## Core Principles

1. **Event Sourcing**: All significant state changes are recorded as immutable events
2. **Idempotency**: Operations can be safely retried without side effects
3. **Circuit Breakers**: Automatic failure detection and recovery
4. **Schema-First**: Contracts define all interfaces between services

## Component Architecture

### TypeScript Layer (Cloudflare Workers)
- **tick-factory**: Ingests real-time market data
- **communication-hub**: WebSocket relay for client updates
- **public-api**: Read-only endpoints for signal viewing
- **director-endpoints**: BFF for Trade Director admin interface

### Python Layer
- **signal-generator**: Technical analysis and signal generation
- **trade-director**: Risk management and position oversight

### MT5 Layer
- **execution-officer**: MQL5 Expert Advisor for order execution

## Data Flow

```
Market Data → tick-factory → Supabase
                                ↓
                          signal-generator → signal_outbox
                                ↓
                          trade-director → trade_directives
                                ↓
                          execution-officer (polls) → MT5 Broker
```

## Failure Modes & Recovery

See `/docs/runbooks/recovery.md` for detailed recovery procedures.

## Security Model

- JWT-based authentication
- Role-based access control (RBAC)
- API keys for service-to-service communication
- Audit logging for all critical operations

## Observability

- Structured logging (JSON)
- Distributed tracing
- Metrics aggregation
- Real-time alerting

## Technology Stack

- **Database**: Supabase (PostgreSQL)
- **Workers**: Cloudflare Workers (TypeScript)
- **Analysis**: Python 3.11+
- **Execution**: MetaTrader 5 (MQL5)
- **Orchestration**: Turbo monorepo

---

**Last Updated**: 2026-01-03  
**Version**: 1.0.0
