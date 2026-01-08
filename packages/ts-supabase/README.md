# @distortsignals/ts-supabase

Supabase client and utilities for DistortSignals applications.

## Features

- Pre-configured Supabase client
- Type-safe database operations
- Shared database types
- Authentication helpers

## Usage

```typescript
import { createClient } from '@distortsignals/ts-supabase';

const supabase = createClient({
  url: process.env.SUPABASE_URL,
  key: process.env.SUPABASE_KEY
});
```

## Exports

- `client` - Supabase client factory
- `types` - Database type definitions
