-- Real-time Auction Bidding System - initial schema
--
-- Every statement here is idempotent (IF NOT EXISTS / ON CONFLICT): databases
-- created before the migration runner existed were initialized by Postgres's
-- docker-entrypoint-initdb.d instead, so the runner re-applies this file once
-- against them to start tracking it in schema_migrations.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
    CREATE TYPE item_status AS ENUM ('upcoming', 'live', 'ended');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_id       UUID NOT NULL REFERENCES users(id),
    title           TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    image_url       TEXT NOT NULL DEFAULT '',
    starting_price  NUMERIC(14,2) NOT NULL,
    bid_increment   NUMERIC(14,2) NOT NULL DEFAULT 1,
    start_time      TIMESTAMPTZ NOT NULL,
    end_time        TIMESTAMPTZ NOT NULL,
    status          item_status NOT NULL DEFAULT 'upcoming',
    winner_id       UUID REFERENCES users(id),
    final_price     NUMERIC(14,2),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_seller ON items(seller_id);

DO $$ BEGIN
    CREATE TYPE bid_status AS ENUM ('accepted', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS bids (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id     UUID NOT NULL REFERENCES items(id),
    user_id     UUID NOT NULL REFERENCES users(id),
    amount      NUMERIC(14,2) NOT NULL,
    status      bid_status NOT NULL,
    reason      TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bids_item ON bids(item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bids_user ON bids(user_id, created_at);

-- Demo seed data: password for both demo users is "password123"
-- bcrypt hash of "password123"
INSERT INTO users (id, email, password_hash, display_name) VALUES
    ('11111111-1111-1111-1111-111111111111', 'seller@example.com', '$2a$10$RbOQXJ3s.kiv0PCb1sAPn.srJAoI7Z5Z8pwRkhjjLH39cib1cMak.', 'Demo Seller'),
    ('22222222-2222-2222-2222-222222222222', 'bidder@example.com', '$2a$10$RbOQXJ3s.kiv0PCb1sAPn.srJAoI7Z5Z8pwRkhjjLH39cib1cMak.', 'Demo Bidder')
ON CONFLICT DO NOTHING;

INSERT INTO items (id, seller_id, title, description, image_url, starting_price, bid_increment, start_time, end_time, status) VALUES
    ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
     'Vintage Mechanical Watch', 'A rare 1960s automatic watch, fully serviced.',
     'https://images.unsplash.com/photo-1524805444758-089113d48a6d?w=800',
     1000, 50, now() - interval '1 minute', now() + interval '10 minutes', 'live'),
    ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111',
     'Signed First-Edition Novel', 'First edition, signed by the author.',
     'https://images.unsplash.com/photo-1544947950-fa07a98d237f?w=800',
     500, 25, now() + interval '2 minutes', now() + interval '15 minutes', 'upcoming')
ON CONFLICT DO NOTHING;
