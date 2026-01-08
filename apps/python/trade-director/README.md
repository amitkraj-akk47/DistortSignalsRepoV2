# Trade Director

Python service that makes trade execution decisions.

## Purpose

- Monitors signal_outbox for new signals
- Applies risk management rules
- Generates trade directives for Execution Officer
- Tracks position sizing and portfolio exposure

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
DIRECTOR_ENDPOINTS_URL=https://director.example.com
DIRECTOR_API_KEY=secret-key
```
