# Execution Officer - MT5 Expert Advisor

MetaTrader 5 Expert Advisor that executes trade directives.

## Purpose

- Polls for trade directives from Director Endpoints API
- Executes trades via MT5 broker connection
- Reports execution events back to the system
- Manages open positions and order lifecycle

## Installation

1. Copy files to MT5 data folder:
   - `MQL5/Experts/DistortSignalsEA.mq5` → `<MT5_DATA>/MQL5/Experts/`
   - `MQL5/Include/` files → `<MT5_DATA>/MQL5/Include/`

2. Compile in MetaEditor

3. Configure EA parameters in MT5 terminal

## Configuration

Set these input parameters in MT5:

- `DirectorEndpointsURL` - API endpoint URL
- `APIKey` - Authentication key
- `ExecutionOfficerID` - Unique identifier for this instance
- `PollIntervalSeconds` - How often to check for new directives
- `MaxSlippagePoints` - Maximum allowed slippage

## Architecture

See [docs/polling-contract.md](docs/polling-contract.md) for API contract details.

## Development

Edit in MetaEditor and compile with MQL5.
