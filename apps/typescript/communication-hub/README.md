# Communication Hub Worker

Central message broker for DistortSignals events.

## Purpose

- Receives events from all sources
- Routes messages to appropriate destinations
- Provides pub/sub functionality
- WebSocket support for real-time updates

## Endpoints

- `POST /events/:type` - Publish event
- `GET /events/stream` - WebSocket stream
- `GET /health` - Health check

## Environment Variables

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-key
```

## Development

```bash
pnpm dev
```

## Deployment

```bash
pnpm deploy
```
