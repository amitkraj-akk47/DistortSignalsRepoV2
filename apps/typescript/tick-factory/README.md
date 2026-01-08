# Tick Factory Worker

Cloudflare Worker that generates market ticks and time-based signals.

## Purpose

- Receives market data from external sources
- Generates time-based events (heartbeats)
- Publishes to Communication Hub

## Environment Variables

```env
COMMUNICATION_HUB_URL=https://comm-hub.example.com
API_KEY=your-api-key
```

## Development

```bash
pnpm dev
```

## Deployment

```bash
pnpm deploy
```
