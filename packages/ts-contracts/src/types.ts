import { z } from 'zod';
import { SignalOutboxSchema, TradeDirectiveSchema, ExecutionEventSchema } from './schemas';

/**
 * Signal Outbox Type
 */
export type SignalOutbox = z.infer<typeof SignalOutboxSchema>;

/**
 * Trade Directive Type
 */
export type TradeDirective = z.infer<typeof TradeDirectiveSchema>;

/**
 * Execution Event Type
 */
export type ExecutionEvent = z.infer<typeof ExecutionEventSchema>;

/**
 * Signal Direction
 */
export type SignalDirection = 'BUY' | 'SELL';

/**
 * Signal Status
 */
export type SignalStatus = 'pending' | 'active' | 'filled' | 'cancelled';

/**
 * Directive Type
 */
export type DirectiveType = 'OPEN' | 'MODIFY' | 'CLOSE' | 'CANCEL';

/**
 * Directive Status
 */
export type DirectiveStatus = 'pending' | 'processing' | 'completed' | 'failed';
