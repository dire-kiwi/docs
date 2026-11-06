CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    login TEXT NOT NULL,
    name TEXT,
    avatar_url TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (provider, provider_id)
);

-- Browser sessions. `id` is the SHA-256 of the cookie value.
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);

-- Bearer tokens: OAuth access/refresh tokens and personal access tokens ('pat').
CREATE TABLE tokens (
    id INTEGER PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh', 'pat')),
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id TEXT,
    name TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    last_used_at INTEGER
);

CREATE TABLE oauth_clients (
    client_id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL, -- JSON array
    created_at INTEGER NOT NULL
);

CREATE TABLE oauth_codes (
    hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    scope TEXT,
    expires_at INTEGER NOT NULL
);

CREATE TABLE documents (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Each publish creates a new immutable version holding a full snapshot of the pages.
CREATE TABLE versions (
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    message TEXT,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    UNIQUE (document_id, number)
);

CREATE TABLE pages (
    id INTEGER PRIMARY KEY,
    version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    title TEXT NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('md', 'mdx')),
    source TEXT NOT NULL,
    position INTEGER NOT NULL,
    UNIQUE (version_id, path)
);

-- Answers to MDX form fields, one row per user per field per version.
CREATE TABLE responses (
    id INTEGER PRIMARY KEY,
    version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
    page_path TEXT NOT NULL,
    field TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    value TEXT NOT NULL, -- JSON
    updated_at INTEGER NOT NULL,
    UNIQUE (version_id, page_path, field, user_id)
);

-- Text a user selected on a page, with an optional comment for the agent.
CREATE TABLE selections (
    id INTEGER PRIMARY KEY,
    version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
    page_path TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    quote TEXT NOT NULL,
    prefix TEXT NOT NULL DEFAULT '',
    suffix TEXT NOT NULL DEFAULT '',
    comment TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);

CREATE INDEX selections_version ON selections (version_id, page_path);
CREATE INDEX responses_updated ON responses (updated_at);
CREATE INDEX selections_created ON selections (created_at);
