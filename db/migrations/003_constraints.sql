-- DistortSignals Data Integrity Constraints
-- Enforces business rules and data consistency

BEGIN;

-- ============================================================================
-- SIGNAL OUTBOX CONSTRAINTS
-- ============================================================================

-- Status must be valid
ALTER TABLE signal_outbox
ADD CONSTRAINT chk_signal_status 
CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED'));

-- Signal type must be valid
ALTER TABLE signal_outbox
ADD CONSTRAINT chk_signal_type 
CHECK (signal_type IN ('BUY', 'SELL', 'CLOSE', 'HOLD'));

-- Published signals must have published_at timestamp
ALTER TABLE signal_outbox
ADD CONSTRAINT chk_signal_published 
CHECK (
    (status = 'PUBLISHED' AND published_at IS NOT NULL) OR
    (status != 'PUBLISHED')
);

-- ============================================================================
-- TRADE DIRECTIVES CONSTRAINTS
-- ============================================================================

-- Status must be valid
ALTER TABLE trade_directives
ADD CONSTRAINT chk_directive_status 
CHECK (status IN ('PENDING', 'ASSIGNED', 'EXECUTED', 'FAILED', 'CANCELLED', 'EXPIRED'));

-- Action must be valid
ALTER TABLE trade_directives
ADD CONSTRAINT chk_directive_action 
CHECK (action IN ('OPEN_LONG', 'OPEN_SHORT', 'CLOSE', 'MODIFY', 'CLOSE_ALL'));

-- Order type must be valid
ALTER TABLE trade_directives
ADD CONSTRAINT chk_directive_order_type 
CHECK (order_type IN ('MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT'));

-- Quantity must be positive
ALTER TABLE trade_directives
ADD CONSTRAINT chk_directive_quantity 
CHECK (quantity > 0);

-- Assigned directives must have assigned_to and assigned_at
ALTER TABLE trade_directives
ADD CONSTRAINT chk_directive_assigned 
CHECK (
    (status = 'ASSIGNED' AND assigned_to IS NOT NULL AND assigned_at IS NOT NULL) OR
    (status != 'ASSIGNED')
);

-- Expires_at must be after issued_at
ALTER TABLE trade_directives
ADD CONSTRAINT chk_directive_expiry 
CHECK (expires_at IS NULL OR expires_at > issued_at);

-- Stop loss and take profit validation for LONG positions
-- (Stop loss should be below entry, take profit above)
ALTER TABLE trade_directives
ADD CONSTRAINT chk_directive_sl_tp_long 
CHECK (
    action != 'OPEN_LONG' OR
    (stop_loss IS NULL OR stop_loss < price) AND
    (take_profit IS NULL OR take_profit > price)
);

-- Stop loss and take profit validation for SHORT positions
-- (Stop loss should be above entry, take profit below)
ALTER TABLE trade_directives
ADD CONSTRAINT chk_directive_sl_tp_short 
CHECK (
    action != 'OPEN_SHORT' OR
    (stop_loss IS NULL OR stop_loss > price) AND
    (take_profit IS NULL OR take_profit < price)
);

-- ============================================================================
-- EXECUTION EVENTS CONSTRAINTS
-- ============================================================================

-- Event class must be valid
ALTER TABLE execution_events
ADD CONSTRAINT chk_event_class 
CHECK (event_class IN ('INFO', 'SUCCESS', 'WARNING', 'ERROR', 'CRITICAL'));

-- Event type must be valid (common MT5 event types)
ALTER TABLE execution_events
ADD CONSTRAINT chk_event_type 
CHECK (event_type IN (
    'DIRECTIVE_RECEIVED',
    'ORDER_PLACED',
    'ORDER_FILLED',
    'ORDER_PARTIAL_FILL',
    'ORDER_REJECTED',
    'ORDER_CANCELLED',
    'ORDER_MODIFIED',
    'ORDER_EXPIRED',
    'POSITION_OPENED',
    'POSITION_CLOSED',
    'POSITION_MODIFIED',
    'SL_TRIGGERED',
    'TP_TRIGGERED',
    'MARGIN_CALL',
    'CONNECTION_LOST',
    'CONNECTION_RESTORED',
    'BROKER_ERROR',
    'SYSTEM_ERROR'
));

-- Fill quantity must be positive if present
ALTER TABLE execution_events
ADD CONSTRAINT chk_event_fill_quantity 
CHECK (fill_quantity IS NULL OR fill_quantity > 0);

-- Error events must have error_code
ALTER TABLE execution_events
ADD CONSTRAINT chk_event_error_details 
CHECK (
    event_class NOT IN ('ERROR', 'CRITICAL') OR
    error_code IS NOT NULL
);

-- ============================================================================
-- AUDIT LOG CONSTRAINTS
-- ============================================================================

-- Entity type must be valid
ALTER TABLE audit_log
ADD CONSTRAINT chk_audit_entity_type 
CHECK (entity_type IN ('signal', 'directive', 'execution', 'system'));

-- Action must be valid
ALTER TABLE audit_log
ADD CONSTRAINT chk_audit_action 
CHECK (action IN ('CREATE', 'UPDATE', 'DELETE', 'STATE_CHANGE'));

-- ============================================================================
-- TRIGGERS FOR UPDATED_AT
-- ============================================================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to signal_outbox
CREATE TRIGGER trg_signal_outbox_updated_at
BEFORE UPDATE ON signal_outbox
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- Apply trigger to trade_directives
CREATE TRIGGER trg_trade_directives_updated_at
BEFORE UPDATE ON trade_directives
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- AUDIT TRIGGERS
-- ============================================================================

-- Function to log changes to audit_log
CREATE OR REPLACE FUNCTION log_audit_changes()
RETURNS TRIGGER AS $$
DECLARE
    entity_type_val VARCHAR(50);
    entity_id_val VARCHAR(64);
BEGIN
    -- Determine entity type based on table
    entity_type_val := CASE TG_TABLE_NAME
        WHEN 'signal_outbox' THEN 'signal'
        WHEN 'trade_directives' THEN 'directive'
        WHEN 'execution_events' THEN 'execution'
        ELSE 'unknown'
    END;
    
    -- Get entity ID based on operation
    IF TG_OP = 'DELETE' THEN
        entity_id_val := CASE TG_TABLE_NAME
            WHEN 'signal_outbox' THEN OLD.signal_id
            WHEN 'trade_directives' THEN OLD.directive_id
            WHEN 'execution_events' THEN OLD.event_id
        END;
        
        INSERT INTO audit_log (entity_type, entity_id, action, changes, occurred_at)
        VALUES (entity_type_val, entity_id_val, 'DELETE', row_to_json(OLD), NOW());
        
        RETURN OLD;
    ELSIF TG_OP = 'INSERT' THEN
        entity_id_val := CASE TG_TABLE_NAME
            WHEN 'signal_outbox' THEN NEW.signal_id
            WHEN 'trade_directives' THEN NEW.directive_id
            WHEN 'execution_events' THEN NEW.event_id
        END;
        
        INSERT INTO audit_log (entity_type, entity_id, action, changes, occurred_at)
        VALUES (entity_type_val, entity_id_val, 'CREATE', row_to_json(NEW), NOW());
        
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        entity_id_val := CASE TG_TABLE_NAME
            WHEN 'signal_outbox' THEN NEW.signal_id
            WHEN 'trade_directives' THEN NEW.directive_id
            WHEN 'execution_events' THEN NEW.event_id
        END;
        
        INSERT INTO audit_log (entity_type, entity_id, action, changes, occurred_at)
        VALUES (entity_type_val, entity_id_val, 'UPDATE', 
                jsonb_build_object('old', row_to_json(OLD), 'new', row_to_json(NEW)), 
                NOW());
        
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Apply audit triggers
CREATE TRIGGER trg_signal_outbox_audit
AFTER INSERT OR UPDATE OR DELETE ON signal_outbox
FOR EACH ROW
EXECUTE FUNCTION log_audit_changes();

CREATE TRIGGER trg_trade_directives_audit
AFTER INSERT OR UPDATE OR DELETE ON trade_directives
FOR EACH ROW
EXECUTE FUNCTION log_audit_changes();

CREATE TRIGGER trg_execution_events_audit
AFTER INSERT OR UPDATE OR DELETE ON execution_events
FOR EACH ROW
EXECUTE FUNCTION log_audit_changes();

COMMIT;
