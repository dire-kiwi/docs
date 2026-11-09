//! The MCP server's instructions and tool definitions (names, descriptions and
//! JSON input schemas). The hosted server advertises these, and the WASM package
//! exports them so other MCP servers can advertise identical tools.

use serde_json::{Value, json};

/// The `instructions` sent in the MCP `initialize` result.
pub const INSTRUCTIONS: &str = "Docs hosts Markdown documents for people to read and respond to: reports, plans, research. \
If you can start sub-agents, have one write and publish the document: give it what the document should say, \
let it look up components, publish and fix any problems, and have it return the URL. \
That keeps the component reference and the page sources out of your own context. \
Publish with `publish_document` (one or more pages; nested paths like `plan/phase-1` make a nested menu). \
Every publish creates a new version, so you can revise freely. \
Documents are organised in folders: when you create one, set `folder` to the name of the project or repository you are working in (e.g. \"docs\"), \
optionally with a subfolder (\"docs/plans\"). Later versions stay in whatever folder the document is in; use `move_document` only when the user asks to move one. \
Documents can also have labels, nested with '/' (\"research/ai\"): pass `labels` to `publish_document` or call `set_document_labels`, \
and call `list_labels` to reuse the labels that already exist rather than inventing near-duplicates. \
Plain Markdown needs no reference. For components (callouts, collapsible sections, form fields), call `list_components` \
for their names, props and examples, and use format \"mdx\". \
`publish_document` is the check: it rejects a page it can't publish and says why, and returns warnings (an unknown component, a bad prop) with the URL; \
fix them and publish again. Don't install or run npm packages, renderers or other tools to check pages. \
Add form fields when you need a decision or input from the reader, \
then call `get_feedback` later to read their answers and any text they selected and commented on. \
Documents are private to the user you act for; use `share_document` to share one with other people (by username) or to get a share link. \
Always give the reader the URL returned by `publish_document`.";

/// The `tools/list` result: one entry per tool.
pub fn tool_definitions() -> Value {
    let slug =
        json!({ "type": "string", "description": "Document slug, as returned by publish_document or list_documents." });
    let version = json!({ "type": "integer", "description": "Version number. Defaults to the latest." });
    let folder = json!({
        "type": "string",
        "description": "Folder for a new document: the name of the project or repository you are working in, e.g. \"docs\", \
    optionally with subfolders separated by '/' (\"docs/plans\"). Only used when the document is created; \
    new versions keep the folder the document is in. Omit for the top level.",
    });
    let labels = |what: &str| {
        json!({
            "type": "array",
            "items": { "type": "string" },
            "description": format!("{what} Labels nest with '/' (e.g. [\"research/ai\", \"needs-review\"]) and match ignoring case; \
        a label keeps the spelling it was first used with. At most 20, each up to 100 characters."),
        })
    };
    json!([
        {
            "name": "list_documents",
            "title": "List documents",
            "description": "List the documents you can see (yours and those shared with you) with their folder, labels, latest version and URL. \
    Labels are yours alone: documents shared with you are listed without their owner's labels.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "label": { "type": "string", "description": "Only your documents with this label or one nested under it (\"research\" includes \"research/ai\")." },
                },
            },
            "annotations": { "readOnlyHint": true },
        },
        {
            "name": "get_document",
            "title": "Get document",
            "description": "Get a document's folder, labels, pages (paths, titles, URLs) and its version history.",
            "inputSchema": { "type": "object", "properties": { "slug": slug, "version": version }, "required": ["slug"] },
            "annotations": { "readOnlyHint": true },
        },
        {
            "name": "read_page",
            "title": "Read page",
            "description": "Read the Markdown/MDX source of one page.",
            "inputSchema": {
                "type": "object",
                "properties": { "slug": slug, "path": { "type": "string", "description": "Page path, e.g. \"index\" or \"plan/phase-1\"." }, "version": version },
                "required": ["slug", "path"],
            },
            "annotations": { "readOnlyHint": true },
        },
        {
            "name": "publish_document",
            "title": "Publish document",
            "description": "Create a document, or publish a new version of an existing one. Each call creates a new version. \
    Pages are CommonMark/GFM Markdown (\"md\") or MDX (\"mdx\", which can use the components from list_components). \
    Paths may be nested (\"plan/phase-1\"); \"index\" is the landing page and \"plan/index\" the page for the \"plan\" folder. \
    Pages are listed in the order given, unless their YAML frontmatter has `order: <n>`; the title comes from `title`, the frontmatter, or the first # heading. \
    Relative links between pages (\"phase-2.md\", \"../index.md\") work like links between files. \
    Returns the URL to give to the reader, plus any rendering warnings.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "slug": { "type": "string", "description": "Existing document to update, or the slug for a new one. Omit to create a new document with a slug derived from the title." },
                    "title": { "type": "string", "description": "Document title. Defaults to the title of the index (or first) page for new documents." },
                    "folder": folder,
                    "labels": labels("The document's labels. When given they replace its labels; when omitted its labels are kept. Labels belong to the document, not to a version."),
                    "message": { "type": "string", "description": "What changed in this version." },
                    "pages": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "path": { "type": "string", "description": "Page path, e.g. \"index\", \"plan/phase-1\" or \"notes.md\"." },
                                "content": { "type": "string", "description": "Markdown or MDX source." },
                                "format": { "type": "string", "enum": ["md", "mdx"], "description": "Defaults to the path's extension, else mdx if the content uses <Components>, else md." },
                                "title": { "type": "string", "description": "Page title for the menu." },
                            },
                            "required": ["path", "content"],
                        },
                    },
                    "mode": { "type": "string", "enum": ["replace", "merge"], "description": "replace (default): the new version has exactly these pages. merge: keep the previous version's other pages." },
                    "delete_paths": { "type": "array", "items": { "type": "string" }, "description": "With mode merge, pages to drop from the previous version." },
                },
                "required": ["pages"],
            },
        },
        {
            "name": "move_document",
            "title": "Move document",
            "description": "Move one of your documents to another folder, e.g. when the user asks you to. \
    Folders are '/'-separated paths (\"docs/plans\"); \"\" is the top level. A folder exists while it has documents in it. \
    Moving a document does not change its URL. Only the owner can move a document.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "slug": slug,
                    "folder": { "type": "string", "description": "The folder to move it to, e.g. \"docs/plans\", or \"\" for the top level." },
                },
                "required": ["slug", "folder"],
            },
            "annotations": { "idempotentHint": true },
        },
        {
            "name": "set_document_labels",
            "title": "Set document labels",
            "description": "Replace the labels of one of your documents (pass [] to remove them all). \
    This doesn't publish a new version. Only the owner can label a document. Returns the labels as stored.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "document": slug,
                    "labels": labels("The document's new labels."),
                },
                "required": ["document", "labels"],
            },
            "annotations": { "idempotentHint": true },
        },
        {
            "name": "list_labels",
            "title": "List labels",
            "description": "Your labels as a tree, with how many of your documents have each label or one nested under it, \
    and how many have no labels. Reuse these labels when you label a document.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true },
        },
        {
            "name": "get_feedback",
            "title": "Get feedback",
            "description": "Read what people answered in a document's form fields and the text they selected and commented on. \
    Use `cursor` from the result as `since` to poll for new feedback.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "slug": slug,
                    "version": { "type": "integer", "description": "Only feedback on this version. Defaults to all versions." },
                    "since": { "type": "integer", "description": "Unix time; only feedback at or after it." },
                },
                "required": ["slug"],
            },
            "annotations": { "readOnlyHint": true },
        },
        {
            "name": "share_document",
            "title": "Share document",
            "description": "Documents are private to their owner. Share one with people by username (they see it after signing in), \
    and/or turn on a share link: anyone who signs in and opens it gets access. People it is shared with can read it and leave feedback, \
    but only the owner can publish versions. Only the owner can change sharing. Returns who it is shared with and the link.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "slug": slug,
                    "add_users": { "type": "array", "items": { "type": "string" }, "description": "Usernames (e.g. GitHub logins) to share with." },
                    "remove_users": { "type": "array", "items": { "type": "string" }, "description": "Usernames to stop sharing with." },
                    "link": { "type": "string", "enum": ["keep", "enable", "disable", "regenerate"], "description": "Share link: enable (keeps an existing link), disable, or regenerate (invalidates the old link). Default keep." },
                },
                "required": ["slug"],
            },
        },
        {
            "name": "list_components",
            "title": "List MDX components",
            "description": "Reference for the MDX components (form fields, callouts…) pages can use: names, props and examples. \
    It is long, so call it from the sub-agent writing the document if you have one.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true },
        },
    ])
}
