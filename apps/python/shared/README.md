# DS Shared

Shared Python utilities for DistortSignals services.

## Purpose

Provides common utilities used across Python services:
- Database client wrappers
- Claims/validation logic
- Retry/circuit breaker patterns
- Time utilities

## Installation

This is a local package referenced by other Python apps:

```bash
poetry add ../shared
```

## Modules

- `ds_shared.db` - Supabase client utilities
- `ds_shared.claims` - Data validation and claims
- `ds_shared.retries` - Retry logic with exponential backoff
- `ds_shared.circuit_breaker` - Circuit breaker pattern
- `ds_shared.time` - Time utilities and timezone handling
