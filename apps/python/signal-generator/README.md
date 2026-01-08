# Signal Generator

Python service that generates trading signals from market data.

## Purpose

- Consumes market ticks from Communication Hub
- Applies trading algorithms/strategies
- Publishes signals to signal_outbox table

## Setup

```bash
poetry install
```

## Development

```bash
poetry run python -m src.main
```

## Testing

```bash
poetry run pytest
```

## Environment Variables

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-service-key
COMMUNICATION_HUB_URL=https://comm-hub.example.com
```
