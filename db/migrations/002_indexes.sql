-- DistortSignals Performance Indexes
-- Optimizes query performance for common access patterns

BEGIN;

-- ============================================================================
-- SIGNAL OUTBOX INDEXES
-- ============================================================================

-- Lookup by signal_id (already unique, but explicit index)
CREATE INDEX idx_signal_outbox_signal_id ON signal_outbox(signal_id);

-- Filter by status for pending signals
CREATE INDEX idx_signal_outbox_status ON signal_outbox(status) WHERE status = 'PENDING';

-- Time-based queries
CREATE INDEX idx_signal_outbox_generated_at ON signal_outbox(generated_at DESC);
CREATE INDEX idx_signal_outbox_published_at ON signal_outbox(published_at DESC) WHERE published_at IS NOT NULL;

-- Symbol-based queries
CREATE INDEX idx_signal_outbox_symbol ON signal_outbox(symbol);

-- Composite index for active signals by symbol
CREATE INDEX idx_signal_outbox_symbol_status ON signal_outbox(symbol, status, generated_at DESC);

-- ============================================================================
-- TRADE DIRECTIVES INDEXES
-- ============================================================================

-- Lookup by directive_id
CREATE INDEX idx_trade_directives_directive_id ON trade_directives(directive_id);

-- Signal relationship
CREATE INDEX idx_trade_directives_signal_id ON trade_directives(signal_id);

-- Status-based queries (pending directives for assignment)
CREATE INDEX idx_trade_directives_status ON trade_directives(status) WHERE status IN ('PENDING', 'ASSIGNED');

-- Assignment tracking
CREATE INDEX idx_trade_directives_assigned_to ON trade_directives(assigned_to) WHERE assigned_to IS NOT NULL;

-- Time-based queries
CREATE INDEX idx_trade_directives_issued_at ON trade_directives(issued_at DESC);
CREATE INDEX idx_trade_directives_expires_at ON trade_directives(expires_at) WHERE expires_at IS NOT NULL;

-- Symbol-based queries
CREATE INDEX idx_trade_directives_symbol ON trade_directives(symbol);

-- Composite index for active directives
CREATE INDEX idx_trade_directives_status_issued ON trade_directives(status, issued_at DESC);

-- ============================================================================
-- EXECUTION EVENTS INDEXES
-- ============================================================================

-- Lookup by event_id
CREATE INDEX idx_execution_events_event_id ON execution_events(event_id);

-- Directive relationship
CREATE INDEX idx_execution_events_directive_id ON execution_events(directive_id);

-- Event type filtering
CREATE INDEX idx_execution_events_event_type ON execution_events(event_type);

-- Error tracking
CREATE INDEX idx_execution_events_error_class ON execution_events(event_class) WHERE event_class IN ('ERROR', 'CRITICAL');

-- Time-based queries
CREATE INDEX idx_execution_events_occurred_at ON execution_events(occurred_at DESC);

-- Reporter tracking
CREATE INDEX idx_execution_events_reported_by ON execution_events(reported_by);

-- Composite index for directive event timeline
CREATE INDEX idx_execution_events_directive_occurred ON execution_events(directive_id, occurred_at DESC);

-- ============================================================================
-- AUDIT LOG INDEXES
-- ============================================================================

-- Entity tracking
CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id);

-- Time-based queries
CREATE INDEX idx_audit_log_occurred_at ON audit_log(occurred_at DESC);

-- Action filtering
CREATE INDEX idx_audit_log_action ON audit_log(action);

-- User tracking
CREATE INDEX idx_audit_log_changed_by ON audit_log(changed_by) WHERE changed_by IS NOT NULL;

COMMIT;
