# Supabase Infrastructure

Configuration for Supabase database, auth, and edge functions.

## Database

### Migrations
Located in `/db/migrations/`:
- `001_init.sql` - Initial schema
- `002_indexes.sql` - Performance indexes
- `003_constraints.sql` - Data integrity

### Tables
- `signal_outbox` - Trading signals
- `trade_directives` - Execution directives
- `execution_events` - Execution event log
- `user_subscriptions` - User signal subscriptions
- `audit_log` - System audit trail

## Authentication

### Providers
- Email/Password
- OAuth (Google, GitHub)
- Magic Links

### Row Level Security (RLS)
All tables have RLS enabled with policies:
- Users can only read their own data
- Service role has full access
- Audit logs are append-only

## Edge Functions

### signal-webhook
- **Purpose**: Receive external signal webhooks
- **Method**: POST
- **Auth**: API Key

### user-sync
- **Purpose**: Sync user data with external systems
- **Trigger**: Database trigger on user changes

## Storage

### Buckets
- `charts`: Chart images and analysis
- `documents`: User documents and reports
- `backups`: Automated backups

## Deployment

```bash
# Initialize project
supabase init

# Link to remote project
supabase link --project-ref your-project-ref

# Push migrations
supabase db push

# Deploy edge functions
supabase functions deploy signal-webhook
```

## Local Development

```bash
# Start local Supabase
supabase start

# Stop local Supabase
supabase stop

# Reset database
supabase db reset
```

## Environment Variables

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-key
```
