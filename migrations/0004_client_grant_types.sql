-- The grants each OAuth client registered for (JSON array), so they can be enforced.
-- Clients registered before this could use the device grant, and the code grant if
-- they had redirect URIs; keep that.
ALTER TABLE oauth_clients ADD COLUMN grant_types TEXT NOT NULL DEFAULT '[]';
UPDATE oauth_clients SET grant_types = CASE
    WHEN redirect_uris = '[]'
        THEN '["urn:ietf:params:oauth:grant-type:device_code","refresh_token"]'
    ELSE '["authorization_code","urn:ietf:params:oauth:grant-type:device_code","refresh_token"]'
END;
