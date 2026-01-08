# Database Schema

This directory contains the canonical data model for DistortSignals.

## Structure

- **migrations/** - SQL migration files (numbered sequentially)
- **seeds/** - Test and development data

## Running Migrations

```bash
# Apply migrations to Supabase
supabase db push

# Generate TypeScript types
supabase gen types typescript --local > packages/ts-supabase/src/database.types.ts
```

## Migration Guidelines

1. Never modify existing migrations
2. Create new migration for schema changes
3. Use transactions for complex migrations
4. Include rollback strategy in comments
