-- Documents are private to their owner unless shared.
-- Shares are by login, so a document can be shared before that person first signs in.
CREATE TABLE document_shares (
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    login TEXT NOT NULL, -- lowercase
    created_at INTEGER NOT NULL,
    PRIMARY KEY (document_id, login)
);

-- Secret for the document's share link; NULL when link sharing is off.
ALTER TABLE documents ADD COLUMN share_token TEXT;
CREATE UNIQUE INDEX documents_share_token ON documents (share_token);
