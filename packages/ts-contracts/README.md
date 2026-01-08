# @distortsignals/ts-contracts

Type-safe contract interfaces generated from canonical JSON schemas in `/contracts`.

## Features

- TypeScript interfaces for all schemas
- Zod validators for runtime validation
- Enums from canonical definitions
- OpenAPI-derived types

## Usage

```typescript
import { SignalOutbox, validateSignalOutbox } from '@distortsignals/ts-contracts';

const signal: SignalOutbox = {
  symbol: 'EURUSD',
  direction: 'BUY',
  entry_price: 1.0850,
  stop_loss: 1.0800,
  take_profit: 1.0900
};

// Runtime validation
const result = validateSignalOutbox(signal);
```

## Structure

- `schemas` - Zod schemas for validation
- `types` - TypeScript interfaces
- `validators` - Validation helpers
- `enums` - Canonical enumerations

## Generation

Types are generated from `/contracts` schemas:
```bash
pnpm generate
```
