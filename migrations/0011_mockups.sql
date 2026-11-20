-- Mockups: a page can be an HTML document ('html'), which the design editor shows as a
-- frame on a canvas. SQLite can't change a CHECK, so the table is made again.
CREATE TABLE pages_new (
    id INTEGER PRIMARY KEY,
    version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    title TEXT NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('md', 'mdx', 'html')),
    source TEXT NOT NULL,
    position INTEGER NOT NULL,
    UNIQUE (version_id, path)
);
INSERT INTO pages_new (id, version_id, path, title, format, source, position)
    SELECT id, version_id, path, title, format, source, position FROM pages;
DROP TABLE pages;
ALTER TABLE pages_new RENAME TO pages;

-- A comment on a mockup is on one of its elements rather than on selected text:
-- `anchor` is a CSS selector for it ('' for a comment on text), and `quote` describes it.
ALTER TABLE selections ADD COLUMN anchor TEXT NOT NULL DEFAULT '';
