-- Organizations: groups of people who share documents. Every member can see an
-- organization's documents and publish, label, move and share them; owners also
-- manage who is a member.
CREATE TABLE organizations (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE, -- lowercase, used in URLs and by agents
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- Members by login, like shares, so people can be added before they first sign in.
CREATE TABLE organization_members (
    org_id INTEGER NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    login TEXT NOT NULL, -- lowercase
    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, login)
);

CREATE INDEX organization_members_login ON organization_members (login);

-- The organization a document belongs to; NULL for its owner's own documents.
-- `owner_id` stays the person who created it (and whose image store it uses).
-- An organization's documents have their own folders and labels.
ALTER TABLE documents ADD COLUMN org_id INTEGER REFERENCES organizations (id);
CREATE INDEX documents_org_folder ON documents (org_id, folder);
