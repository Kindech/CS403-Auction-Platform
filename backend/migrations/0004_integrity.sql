-- Data-integrity hardening.

-- Idempotency key for bid audit records. bid-worker processes Kafka
-- at-least-once, so a batch can be re-delivered after a crash or a failed
-- offset commit; the api-server stamps every bid with a unique request_id at
-- produce time, and BatchInsertBids skips any request_id it has already
-- written. NULL for rows written before this column existed (Postgres never
-- treats NULLs as conflicting, so old rows are unaffected).
ALTER TABLE bids ADD COLUMN IF NOT EXISTS request_id UUID;
DO $$ BEGIN
    ALTER TABLE bids ADD CONSTRAINT bids_request_id_key UNIQUE (request_id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $$;

-- The API already validates these; the constraints make the database the
-- last line of defense for rows written by anything else (pgAdmin, scripts).
DO $$ BEGIN
    ALTER TABLE items ADD CONSTRAINT items_starting_price_positive CHECK (starting_price > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
    ALTER TABLE items ADD CONSTRAINT items_bid_increment_positive CHECK (bid_increment > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
    ALTER TABLE items ADD CONSTRAINT items_valid_window CHECK (end_time > start_time);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
-- A winner always comes with a final price, and only ended items have one.
DO $$ BEGIN
    ALTER TABLE items ADD CONSTRAINT items_winner_consistent
        CHECK ((winner_id IS NULL) = (final_price IS NULL) AND (winner_id IS NULL OR status = 'ended'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The API lowercases emails before every insert/lookup; enforce it so
-- "Bob@x.com" and "bob@x.com" can never become two separate accounts.
DO $$ BEGIN
    ALTER TABLE users ADD CONSTRAINT users_email_lowercase CHECK (email = lower(email));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- "Everything that happened to item X" - the per-entity timeline query.
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id, created_at);
