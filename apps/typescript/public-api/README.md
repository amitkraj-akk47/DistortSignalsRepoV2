# Public API Worker

Public-facing REST API for DistortSignals.

## Purpose

- Exposes trading signals to external clients
- Provides read-only access to signal history
- Handles authentication and rate limiting

## Endpoints

See [contracts/openapi/public-signals-api.yaml](../../../contracts/openapi/public-signals-api.yaml)

## Authentication

Uses JWT tokens or API keys for authentication.

## Development

```bash
pnpm dev
```

## Deployment

```bash
pnpm deploy
```
