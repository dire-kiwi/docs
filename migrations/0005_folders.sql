-- The folder a document is filed in on its owner's home page: a '/'-separated
-- path, '' for the top level. Folders exist only while documents are in them.
ALTER TABLE documents ADD COLUMN folder TEXT NOT NULL DEFAULT '';
CREATE INDEX documents_owner_folder ON documents (owner_id, folder);
