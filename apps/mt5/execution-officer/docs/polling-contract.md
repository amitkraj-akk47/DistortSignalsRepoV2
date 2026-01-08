# Execution Officer Polling Contract

## Overview

The MT5 Execution Officer polls the Director Endpoints API to retrieve trade directives and report execution events.

## Endpoints

### GET /v1/directives/pending

Retrieve pending directives for this execution officer.

**Query Parameters:**
- `officer` (string, required) - Execution Officer ID

**Response:**
```json
{
  "directives": [
    {
      "directive_id": "dir_12345",
      "signal_id": "sig_001",
      "symbol": "EURUSD",
      "action": "OPEN_LONG",
      "order_type": "MARKET",
      "quantity": 0.01,
      "price": 1.0950,
      "stop_loss": 1.0900,
      "take_profit": 1.1000,
      "issued_at": "2026-01-04T10:00:00Z",
      "expires_at": "2026-01-04T10:05:00Z"
    }
  ]
}
```

### POST /v1/execution-events

Report an execution event.

**Headers:**
- `X-API-Key` - Authentication key
- `Content-Type: application/json`

**Body:**
```json
{
  "directive_id": "dir_12345",
  "event_type": "ORDER_FILLED",
  "event_class": "SUCCESS",
  "occurred_at": "2026-01-04T10:00:05Z",
  "reported_by": "eo-001",
  "broker_order_id": "123456789",
  "fill_price": 1.0951,
  "fill_quantity": 0.01,
  "commission": 0.10
}
```

**Response:**
```json
{
  "success": true,
  "event_id": "evt_67890"
}
```

## Event Types

- `DIRECTIVE_RECEIVED` - Officer received the directive
- `ORDER_PLACED` - Order sent to broker
- `ORDER_FILLED` - Order successfully filled
- `ORDER_PARTIAL_FILL` - Order partially filled
- `ORDER_REJECTED` - Broker rejected order
- `ORDER_CANCELLED` - Order was cancelled
- `POSITION_OPENED` - Position opened successfully
- `POSITION_CLOSED` - Position closed
- `SL_TRIGGERED` - Stop loss hit
- `TP_TRIGGERED` - Take profit hit
- `CONNECTION_LOST` - Lost connection to broker
- `CONNECTION_RESTORED` - Connection restored
- `BROKER_ERROR` - Broker returned error
- `SYSTEM_ERROR` - EA internal error

## Polling Frequency

Default: Every 5 seconds

Configurable via EA input parameters.

## Error Handling

1. Connection failures → retry with exponential backoff
2. Invalid directives → report ORDER_REJECTED event
3. Broker errors → report with error details
4. Network issues → log locally, retry on recovery
