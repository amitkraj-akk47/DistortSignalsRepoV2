import { z } from 'zod';

/**
 * Signal Outbox Schema
 */
export const SignalOutboxSchema = z.object({
  id: z.string().uuid().optional(),
  created_at: z.string().datetime().optional(),
  symbol: z.string(),
  direction: z.enum(['BUY', 'SELL']),
  entry_price: z.number().positive(),
  stop_loss: z.number().positive(),
  take_profit: z.number().positive(),
  lot_size: z.number().positive().optional(),
  status: z.enum(['pending', 'active', 'filled', 'cancelled']).default('pending'),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * Trade Directive Schema
 */
export const TradeDirectiveSchema = z.object({
  id: z.string().uuid().optional(),
  created_at: z.string().datetime().optional(),
  signal_id: z.string().uuid(),
  directive_type: z.enum(['OPEN', 'MODIFY', 'CLOSE', 'CANCEL']),
  parameters: z.record(z.unknown()),
  status: z.enum(['pending', 'processing', 'completed', 'failed']).default('pending'),
  priority: z.number().int().min(0).max(10).default(5),
});

/**
 * Execution Event Schema
 */
export const ExecutionEventSchema = z.object({
  id: z.string().uuid().optional(),
  created_at: z.string().datetime().optional(),
  directive_id: z.string().uuid(),
  event_type: z.string(),
  event_data: z.record(z.unknown()),
  timestamp: z.string().datetime(),
  source: z.string(),
});
