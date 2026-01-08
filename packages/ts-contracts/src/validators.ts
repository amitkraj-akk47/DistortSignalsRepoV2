import { SignalOutboxSchema, TradeDirectiveSchema, ExecutionEventSchema } from './schemas';
import type { SignalOutbox, TradeDirective, ExecutionEvent } from './types';

/**
 * Validate Signal Outbox
 */
export function validateSignalOutbox(data: unknown): SignalOutbox {
  return SignalOutboxSchema.parse(data);
}

/**
 * Safely validate Signal Outbox
 */
export function safeValidateSignalOutbox(data: unknown) {
  return SignalOutboxSchema.safeParse(data);
}

/**
 * Validate Trade Directive
 */
export function validateTradeDirective(data: unknown): TradeDirective {
  return TradeDirectiveSchema.parse(data);
}

/**
 * Safely validate Trade Directive
 */
export function safeValidateTradeDirective(data: unknown) {
  return TradeDirectiveSchema.safeParse(data);
}

/**
 * Validate Execution Event
 */
export function validateExecutionEvent(data: unknown): ExecutionEvent {
  return ExecutionEventSchema.parse(data);
}

/**
 * Safely validate Execution Event
 */
export function safeValidateExecutionEvent(data: unknown) {
  return ExecutionEventSchema.safeParse(data);
}
