-- Images in documents, converted to AVIF when published (the uploaded originals
-- aren't kept). Content-addressed by the SHA-256 of the AVIF and owned by the
-- documents' owner, so the same image in several documents or versions is stored once.
CREATE TABLE images (
    owner_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    sha256 TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, sha256)
);

-- The images a version has, by the name its pages refer to them with ('images/chart.png').
CREATE TABLE version_images (
    version_id INTEGER NOT NULL REFERENCES versions (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    PRIMARY KEY (version_id, name)
);

CREATE INDEX version_images_sha256 ON version_images (sha256);
