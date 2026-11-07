-- Pending OAuth device authorizations (RFC 8628). `hash` is the SHA-256 of the
-- device_code; `user_code` is what the person types, stored normalized (no dash).
CREATE TABLE oauth_device_codes (
    hash TEXT PRIMARY KEY,
    user_code TEXT NOT NULL UNIQUE,
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, -- who approved or denied it
    interval INTEGER NOT NULL, -- seconds between polls; grows on slow_down
    last_polled_at INTEGER,
    expires_at INTEGER NOT NULL
);
