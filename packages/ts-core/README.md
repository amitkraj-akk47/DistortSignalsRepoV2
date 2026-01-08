# TS Core Package

Core TypeScript utilities shared across Cloudflare Workers.

## Purpose

Provides common utilities for all TypeScript services:
- Logging utilities
- Error handling
- Type utilities
- Validation helpers

## Installation

This is a workspace package:

```json
{
  "dependencies": {
    "@distortsignals/ts-core": "workspace:*"
  }
}
```

## Usage

```typescript
import { logger, ErrorHandler } from '@distortsignals/ts-core';

logger.info('Service started');
```

## Exports

- `logger` - Structured logging
- `ErrorHandler` - Standard error handling
- `validateEnv` - Environment variable validation
- `TimeUtils` - Time manipulation utilities
