-- Documents are served at /d/<uuid>/, a random UUID (v4) that can't be guessed,
-- rather than at their slug, which is made from the title.
ALTER TABLE documents ADD COLUMN uuid TEXT;
UPDATE documents SET uuid = lower(
    hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-'
    || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))
);
CREATE UNIQUE INDEX documents_uuid ON documents (uuid);

-- A public document can be read by anyone with its URL, without signing in.
-- Answering and commenting stay with the owner and the people it is shared with.
ALTER TABLE documents ADD COLUMN public INTEGER NOT NULL DEFAULT 0;
