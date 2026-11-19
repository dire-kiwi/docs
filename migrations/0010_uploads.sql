-- Images uploaded on their own over HTTP (DOC-22), so that their bytes don't go through
-- a tool call: an agent asks for an upload URL (`create_upload_url`), sends files to it,
-- and names the uploads in `publish_document`'s `images`.

-- An upload URL, by the SHA-256 of the random token in it: whose uploads it takes, and until when.
CREATE TABLE upload_urls (
    hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
);

-- An uploaded image waiting to be published. Its id is a random UUID; its AVIF is the
-- uploader's in `images`. Deleted when it expires, and the image with it unless a version has it.
CREATE TABLE uploads (
    uuid TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    sha256 TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX uploads_owner ON uploads (owner_id, sha256);
