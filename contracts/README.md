# Contracts Directory

## Overview

This directory contains the **canonical interfaces** for the DistortSignals system. All services MUST implement these contracts to ensure compatibility.

## Structure

### `/schemas/`
JSON Schema definitions for core data structures:
- `signal_outbox.schema.json` - Trading signal format
- `trade_directive.schema.json` - Execution commands
- `execution_event.schema.json` - Execution results

### `/openapi/`
OpenAPI 3.0 specifications for HTTP APIs:
- `director-api.yaml` - Admin interface for trade management
- `public-signals-api.yaml` - Public read-only signal viewing

### `/enums/`
Shared enumerations:
- `event_types.json` - System event taxonomy
- `error_classes.json` - Standardized error codes

## Usage

### TypeScript
```typescript
import signalSchema from '@distortsignals/contracts/schemas/signal_outbox.schema.json';
import Ajv from 'ajv';

const ajv = new Ajv();
const validate = ajv.compile(signalSchema);
const isValid = validate(signalData);
```

### Python
```python
import jsonschema
import json

with open('contracts/schemas/signal_outbox.schema.json') as f:
    schema = json.load(f)

jsonschema.validate(instance=signal_data, schema=schema)
```

## Versioning

- Schemas are versioned via `$id` field
- Breaking changes require new schema version
- Backward-compatible changes can be patched
- See ADR-002 (future) for full versioning strategy

## Validation

All services SHOULD validate:
1. **Incoming data** against schemas before processing
2. **Outgoing data** before publishing to ensure compliance

## Tools

Generate TypeScript types:
```bash
npm run generate:types
```

Validate OpenAPI specs:
```bash
npm run validate:openapi
```

---

**Maintainer**: Architecture Team  
**Last Updated**: 2026-01-03
