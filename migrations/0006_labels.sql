-- Labels on a document: '/'-separated paths ('research/ai'), nested by their
-- prefixes. They belong to the document (not a version) and so to its owner.
-- `key` is the label lowercased, for matching; `label` keeps the spelling.
CREATE TABLE document_labels (
    document_id INTEGER NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    PRIMARY KEY (document_id, key)
);
