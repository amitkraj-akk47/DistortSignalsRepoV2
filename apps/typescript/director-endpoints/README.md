# Director Endpoints Worker

Backend-for-Frontend (BFF) for Trade Director service.

## Purpose

- Provides HTTP endpoints for Trade Director Python service
- Handles directive management
- Interfaces with Supabase for persistence

## Endpoints

See [contracts/openapi/director-api.yaml](../../../contracts/openapi/director-api.yaml)

## Environment Variables

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-key
DIRECTOR_API_KEY=secret-key
```

## Development

```bash
pnpm dev
```

## Deployment

```bash
pnpm deploy
```
