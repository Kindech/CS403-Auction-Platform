-- Brute-force protection: lock an account out for a while after too many
-- wrong passwords in a row.
ALTER TABLE users
    ADD COLUMN failed_login_attempts INT NOT NULL DEFAULT 0,
    ADD COLUMN locked_until TIMESTAMPTZ;

CREATE INDEX idx_users_locked_until ON users(locked_until) WHERE locked_until IS NOT NULL;
