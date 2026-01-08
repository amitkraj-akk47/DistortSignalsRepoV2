-- DistortSignals Initial Schema
-- Creates core tables for signal management, trade directives, and execution events

BEGIN;

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_cron";

-- ============================================================================
-- SIGNAL OUTBOX TABLE
-- ============================================================================
CREATE TABLE signal_outbox (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    signal_id VARCHAR(64) NOT NULL UNIQUE,
    
    -- Signal content
    symbol VARCHAR(20) NOT NULL,
    signal_type VARCHAR(20) NOT NULL, -- 'BUY', 'SELL', 'CLOSE'
    confidence DECIMAL(3,2) CHECK (confidence >= 0 AND confidence <= 1),
    price DECIMAL(20,5),
    
    -- Metadata
    generated_at TIMESTAMPTZ NOT NULL,
    published_at TIMESTAMPTZ,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- PENDING, PUBLISHED, FAILED
    
    -- Tracking
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- TRADE DIRECTIVES TABLE
-- ============================================================================
CREATE TABLE trade_directives (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    directive_id VARCHAR(64) NOT NULL UNIQUE,
    
    -- Signal reference
    signal_id VARCHAR(64) REFERENCES signal_outbox(signal_id),
    
    -- Trade details
    symbol VARCHAR(20) NOT NULL,
    action VARCHAR(20) NOT NULL, -- 'OPEN_LONG', 'OPEN_SHORT', 'CLOSE', 'MODIFY'
    order_type VARCHAR(20) NOT NULL, -- 'MARKET', 'LIMIT', 'STOP'
    quantity DECIMAL(20,8) NOT NULL,
    price DECIMAL(20,5),
    stop_loss DECIMAL(20,5),
    take_profit DECIMAL(20,5),
    
    -- Execution tracking
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- PENDING, ASSIGNED, EXECUTED, FAILED, CANCELLED
    assigned_to VARCHAR(100), -- Execution Officer ID
    assigned_at TIMESTAMPTZ,
    
    -- Timing
    issued_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ,
    
    -- Tracking
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- EXECUTION EVENTS TABLE
-- ============================================================================
CREATE TABLE execution_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_id VARCHAR(64) NOT NULL UNIQUE,
    
    -- References
    directive_id VARCHAR(64) REFERENCES trade_directives(directive_id),
    
    -- Event details
    event_type VARCHAR(50) NOT NULL, -- 'ORDER_PLACED', 'ORDER_FILLED', 'ORDER_REJECTED', etc.
    event_class VARCHAR(20) NOT NULL, -- 'INFO', 'SUCCESS', 'ERROR', 'CRITICAL'
    
    -- Execution details
    broker_order_id VARCHAR(100),
    fill_price DECIMAL(20,5),
    fill_quantity DECIMAL(20,8),
    commission DECIMAL(20,5),
    
    -- Error tracking
    error_code VARCHAR(50),
    error_message TEXT,
    
    -- Metadata
    occurred_at TIMESTAMPTZ NOT NULL,
    reported_by VARCHAR(100) NOT NULL, -- Execution Officer ID
    
    -- Tracking
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- AUDIT LOG TABLE
-- ============================================================================
CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Entity tracking
    entity_type VARCHAR(50) NOT NULL, -- 'signal', 'directive', 'execution'
    entity_id VARCHAR(64) NOT NULL,
    
    -- Change tracking
    action VARCHAR(20) NOT NULL, -- 'CREATE', 'UPDATE', 'DELETE'
    changed_by VARCHAR(100),
    changes JSONB,
    
    -- Timing
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
