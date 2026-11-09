//! MCP server over Streamable HTTP (JSON responses, stateless).

use std::collections::{HashMap, HashSet};

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::avif;
use crate::components;
use crate::db::{self, DocumentSummary, User};
use crate::labels;
use crate::oauth;
use crate::paths;
use crate::render::{self, Format, Options};
use crate::web::pages::{doc_base, image_path};
use docs_render::images;
use docs_render::publish::{self, ImageInput, PageInput, PageWarning};
use docs_render::tools::{INSTRUCTIONS, tool_definitions};

/// The largest `/mcp` request: room for a publish whose images are uploaded at full size
/// (only the AVIF, at most 500 KB each, is kept).
pub const MAX_REQUEST_BYTES: usize = 64 * 1024 * 1024;

const PROTOCOL_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

pub async fn not_allowed() -> impl IntoResponse {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        [(header::ALLOW, "POST")],
        "This MCP server only accepts POST.",
    )
}

fn unauthorized(state: &AppState, msg: &str) -> Response {
    let challenge = format!(
        "Bearer resource_metadata=\"{}\", scope=\"{}\"",
        oauth::resource_metadata_url(&state.config.base_url),
        oauth::SCOPE
    );
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, challenge)],
        Json(json!({ "error": "invalid_token", "error_description": msg })),
    )
        .into_response()
}

pub async fn handle(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")))
        .map(str::trim);
    let Some(token) = token else {
        return unauthorized(&state, "sign in to use this server");
    };
    let user = match db::bearer_user(&state.db, token).await {
        Ok(Some(u)) if state.config.user_allowed(&u.login) => u,
        Ok(Some(_)) => return unauthorized(&state, "this user is no longer allowed to use this site"),
        Ok(None) => return unauthorized(&state, "token is invalid or expired"),
        Err(e) => {
            tracing::error!("{e:#}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let msg: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return Json(rpc_error(Value::Null, -32700, &format!("parse error: {e}"))).into_response(),
    };
    let server = Server {
        state: &state,
        user: &user,
    };
    match msg {
        Value::Array(batch) => {
            let mut out = Vec::new();
            for m in batch {
                if let Some(r) = server.message(m).await {
                    out.push(r);
                }
            }
            if out.is_empty() {
                StatusCode::ACCEPTED.into_response()
            } else {
                Json(Value::Array(out)).into_response()
            }
        }
        m => match server.message(m).await {
            Some(r) => Json(r).into_response(),
            None => StatusCode::ACCEPTED.into_response(),
        },
    }
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

struct Server<'a> {
    state: &'a AppState,
    user: &'a User,
}

/// A tool failure reported to the model (as opposed to a protocol error).
pub(crate) struct ToolError(pub String);

impl<E: std::fmt::Display> From<E> for ToolError {
    fn from(e: E) -> Self {
        ToolError(e.to_string())
    }
}

type ToolResult = Result<Value, ToolError>;

fn args<T: for<'de> Deserialize<'de>>(v: Value) -> Result<T, ToolError> {
    serde_json::from_value(v).map_err(|e| ToolError(format!("invalid arguments: {e}")))
}

impl Server<'_> {
    async fn message(&self, m: Value) -> Option<Value> {
        let id = m.get("id").cloned();
        let method = m.get("method").and_then(Value::as_str).unwrap_or("").to_string();
        let Some(id) = id else {
            return None; // notification (e.g. notifications/initialized) or a response to us
        };
        if method.is_empty() {
            return Some(rpc_error(id, -32600, "invalid request"));
        }
        let params = m.get("params").cloned().unwrap_or(Value::Null);
        let result = match method.as_str() {
            "initialize" => {
                let requested = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
                let version = if PROTOCOL_VERSIONS.contains(&requested) {
                    requested
                } else {
                    PROTOCOL_VERSIONS[0]
                };
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "docs", "title": "Docs", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": INSTRUCTIONS,
                })
            }
            "ping" => json!({}),
            "tools/list" => json!({ "tools": tool_definitions() }),
            "tools/call" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
                let outcome = match name {
                    "list_documents" => self.list_documents(arguments).await,
                    "list_labels" => self.list_labels().await,
                    "set_document_labels" => self.set_labels(arguments).await,
                    "get_document" => self.get_document(arguments).await,
                    "read_page" => self.read_page(arguments).await,
                    "publish_document" => self.publish(arguments).await,
                    "get_feedback" => self.get_feedback(arguments).await,
                    "share_document" => self.share(arguments).await,
                    "move_document" => self.move_document(arguments).await,
                    "list_components" => Ok(Value::String(components::reference())),
                    _ => return Some(rpc_error(id, -32602, &format!("unknown tool {name:?}"))),
                };
                match outcome {
                    Ok(Value::String(text)) => json!({ "content": [{ "type": "text", "text": text }] }),
                    Ok(v) => json!({
                        "content": [{ "type": "text", "text": serde_json::to_string_pretty(&v).unwrap_or_default() }],
                        "structuredContent": v,
                    }),
                    Err(ToolError(e)) => json!({ "content": [{ "type": "text", "text": e }], "isError": true }),
                }
            }
            "resources/list" => json!({ "resources": [] }),
            "prompts/list" => json!({ "prompts": [] }),
            _ => return Some(rpc_error(id, -32601, &format!("method not found: {method}"))),
        };
        Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
    }

    fn url(&self, slug: &str, version: Option<i64>, path: &str) -> String {
        format!(
            "{}{}{}",
            self.state.config.base_url,
            doc_base(slug, version),
            paths::url_suffix(path)
        )
    }

    async fn doc(&self, slug: &str) -> Result<db::DocumentSummary, ToolError> {
        db::get_document(&self.state.db, slug, self.user)
            .await?
            .ok_or_else(|| ToolError(format!("no document {slug:?}; call list_documents to see what exists")))
    }

    async fn version(&self, doc: &db::DocumentSummary, number: Option<i64>) -> Result<db::Version, ToolError> {
        db::version(&self.state.db, doc.id, number).await?.ok_or_else(|| {
            ToolError(format!(
                "document {:?} has no version {}",
                doc.slug,
                number.unwrap_or(0)
            ))
        })
    }

    async fn list_documents(&self, a: Value) -> ToolResult {
        #[derive(Deserialize)]
        struct A {
            label: Option<String>,
        }
        let a: A = args(a)?;
        let docs = list_documents(&self.state.db, self.user, a.label.as_deref()).await?;
        Ok(documents_json(&self.state.config.base_url, self.user, &docs))
    }

    async fn list_labels(&self) -> ToolResult {
        let docs = db::list_documents(&self.state.db, self.user).await?;
        Ok(labels_json(self.user, &docs))
    }

    async fn set_labels(&self, a: Value) -> ToolResult {
        #[derive(Deserialize)]
        struct A {
            #[serde(alias = "slug")]
            document: String,
            labels: Vec<String>,
        }
        let a: A = args(a)?;
        let doc = self.doc(&a.document).await?;
        if doc.owner_id != self.user.id {
            return Err(ToolError(format!(
                "only the owner ({}) can label {:?}",
                doc.owner, doc.slug
            )));
        }
        let wanted = labels::normalize_labels(&a.labels).map_err(ToolError)?;
        let stored = db::set_labels(&self.state.db, self.user.id, &doc.slug, &wanted).await?;
        Ok(json!({
            "slug": doc.slug,
            "labels": stored.unwrap_or_default(),
            "url": self.url(&doc.slug, None, "index"),
        }))
    }

    async fn get_document(&self, a: Value) -> ToolResult {
        #[derive(Deserialize)]
        struct A {
            slug: String,
            version: Option<i64>,
        }
        let a: A = args(a)?;
        let doc = self.doc(&a.slug).await?;
        let version = self.version(&doc, a.version).await?;
        let pages = db::pages(&self.state.db, version.id).await?;
        let version_images = self.images_json(&doc.slug, version.id).await?;
        let versions = db::versions(&self.state.db, doc.id).await?;
        let sharing = if doc.owner_id == self.user.id {
            Some(self.sharing(&doc).await?)
        } else {
            None
        };
        Ok(json!({
            "sharing": sharing,
            "slug": doc.slug,
            "title": doc.title,
            "folder": doc.folder,
            "labels": doc.labels,
            "owner": doc.owner,
            "url": self.url(&doc.slug, None, "index"),
            "version": version,
            "latest_version": doc.latest_version,
            "pages": pages.iter().map(|p| json!({
                "path": p.path,
                "title": p.title,
                "format": p.format,
                "url": self.url(&doc.slug, a.version, &p.path),
            })).collect::<Vec<_>>(),
            "images": version_images,
            "versions": versions.iter().take(50).collect::<Vec<_>>(),
        }))
    }

    async fn read_page(&self, a: Value) -> ToolResult {
        #[derive(Deserialize)]
        struct A {
            slug: String,
            path: String,
            version: Option<i64>,
        }
        let a: A = args(a)?;
        let doc = self.doc(&a.slug).await?;
        let version = self.version(&doc, a.version).await?;
        let path = paths::normalize(&a.path)?;
        let mut page = None;
        for candidate in [path.clone(), format!("{path}/index")] {
            if let Some(p) = db::page(&self.state.db, version.id, &candidate).await? {
                page = Some(p);
                break;
            }
        }
        let page = page.ok_or_else(|| ToolError(format!("version {} has no page {path:?}", version.number)))?;
        Ok(json!({
            "path": page.path,
            "title": page.title,
            "format": page.format,
            "version": version.number,
            "url": self.url(&doc.slug, Some(version.number), &page.path),
            "content": page.source,
        }))
    }

    async fn publish(&self, a: Value) -> ToolResult {
        #[derive(Deserialize)]
        struct A {
            slug: Option<String>,
            title: Option<String>,
            folder: Option<String>,
            labels: Option<Vec<String>>,
            message: Option<String>,
            #[serde(default)]
            pages: Vec<PageInput>,
            mode: Option<String>,
            #[serde(default)]
            delete_paths: Vec<String>,
            #[serde(default)]
            images: Vec<ImageInput>,
        }
        let a: A = args(a)?;
        let merge = match a.mode.as_deref().unwrap_or("replace") {
            "replace" => false,
            "merge" => true,
            m => return Err(ToolError(format!("mode must be \"replace\" or \"merge\", not {m:?}"))),
        };
        if a.pages.is_empty() && a.delete_paths.is_empty() {
            return Err(ToolError("pass at least one page".into()));
        }
        let folder = paths::normalize_folder(a.folder.as_deref().unwrap_or("")).map_err(ToolError)?;
        let labels = a
            .labels
            .as_deref()
            .map(labels::normalize_labels)
            .transpose()
            .map_err(ToolError)?;
        let delete: Vec<String> = a.delete_paths.iter().filter_map(|p| paths::normalize(p).ok()).collect();
        let valid = publish::validate_publish(a.pages, a.images).map_err(ToolError)?;
        let mut warnings = valid.warnings;
        let uploaded: HashSet<String> = valid.images.iter().map(|i| i.name.clone()).collect();

        // A merge keeps the previous version's images that the new version's pages refer to.
        let (kept_images, based_on) = if merge {
            self.kept_images(a.slug.as_deref(), &valid.pages, &delete, &uploaded)
                .await?
        } else {
            (Vec::new(), None)
        };
        let count = uploaded.len() + kept_images.len();
        if count > images::MAX_IMAGES {
            return Err(ToolError(images::too_many_error(count)));
        }
        let have: HashSet<&str> = uploaded
            .iter()
            .chain(kept_images.iter().map(|(n, _)| n))
            .map(String::as_str)
            .collect();
        for p in &valid.pages {
            for src in &p.image_srcs {
                if !images::candidates(&p.path, src)
                    .iter()
                    .any(|n| have.contains(n.as_str()))
                {
                    warnings.push(PageWarning {
                        page: p.path.clone(),
                        warning: format!(
                            "image {src:?} isn't one of this version's images; pass it in `images` or inline it as a data: URI"
                        ),
                    });
                }
            }
        }
        let converted = avif::convert_all(valid.images).await.map_err(ToolError)?;

        let pages: Vec<db::NewPage> = valid
            .pages
            .into_iter()
            .map(|p| db::NewPage {
                position: p.position,
                title: p.title,
                path: p.path,
                format: p.format.as_str(),
                source: p.source,
            })
            .collect();

        let exists = match &a.slug {
            Some(s) => db::slug_exists(&self.state.db, &db::doc_slug(s)).await?,
            None => false,
        };
        let title = a.title.clone().or_else(|| {
            if exists {
                return None;
            }
            pages
                .iter()
                .find(|p| p.path == "index")
                .or(pages.first())
                .map(|p| p.title.clone())
        });
        let (slug, number) = db::publish(
            &self.state.db,
            db::Publish {
                user_id: self.user.id,
                slug: a.slug.as_deref(),
                title: title.as_deref(),
                folder: &folder,
                labels: labels.as_deref(),
                message: a.message.as_deref(),
                pages,
                merge,
                delete,
                images: converted
                    .into_iter()
                    .map(|c| db::NewImage {
                        name: c.name,
                        sha256: c.sha256,
                        data: c.avif,
                    })
                    .collect(),
                kept_images,
                based_on,
            },
        )
        .await?;
        let doc = self.doc(&slug).await?;
        let version = self.version(&doc, Some(number)).await?;
        let all = db::pages(&self.state.db, version.id).await?;
        let version_images = self.images_json(&slug, version.id).await?;
        // An existing document stays where it is, so a publish doesn't undo the user's move.
        let note = (a.folder.is_some() && doc.folder != folder).then(|| {
            format!(
                "The document stays in its folder {:?}; call move_document only if the user asks to move it.",
                doc.folder
            )
        });
        Ok(json!({
            "slug": slug,
            "folder": doc.folder,
            "labels": doc.labels,
            "note": note,
            "version": number,
            "url": self.url(&slug, None, "index"),
            "version_url": self.url(&slug, Some(number), "index"),
            "pages": all.iter().map(|p| json!({ "path": p.path, "title": p.title, "url": self.url(&slug, None, &p.path) })).collect::<Vec<_>>(),
            "images": version_images,
            "warnings": warnings,
        }))
    }

    /// For a merge into `slug`: the previous version's images, `(name, sha256)`, that a page of
    /// the new version refers to and that aren't uploaded again, and that version's number.
    async fn kept_images(
        &self,
        slug: Option<&str>,
        pages: &[publish::ValidPage],
        delete: &[String],
        uploaded: &HashSet<String>,
    ) -> Result<(Vec<(String, String)>, Option<i64>), ToolError> {
        let Some(slug) = slug else {
            return Ok((Vec::new(), None));
        };
        let Some(doc) = db::get_document(&self.state.db, &db::doc_slug(slug), self.user).await? else {
            return Ok((Vec::new(), None));
        };
        let Some(prev) = db::version(&self.state.db, doc.id, None).await? else {
            return Ok((Vec::new(), None));
        };
        let old_images = db::version_images(&self.state.db, prev.id).await?;
        if old_images.is_empty() {
            return Ok((Vec::new(), Some(prev.number)));
        }
        let mut refs: HashSet<String> = HashSet::new();
        for p in pages {
            for src in &p.image_srcs {
                refs.extend(images::candidates(&p.path, src));
            }
        }
        let empty = HashMap::new();
        let no_images = HashMap::new();
        for old in db::all_pages(&self.state.db, prev.id).await? {
            if pages.iter().any(|p| p.path == old.path) || delete.contains(&old.path) {
                continue;
            }
            let opts = Options {
                page_path: &old.path,
                base_url: "/",
                answers: &empty,
                images: &no_images,
            };
            let format = Format::parse(&old.format).unwrap_or(Format::Md);
            if let Ok(r) = render::render(&old.source, format, &opts) {
                for src in &r.image_srcs {
                    refs.extend(images::candidates(&old.path, src));
                }
            }
        }
        let kept = old_images
            .into_iter()
            .filter(|i| refs.contains(&i.name) && !uploaded.contains(&i.name))
            .map(|i| (i.name, i.sha256))
            .collect();
        Ok((kept, Some(prev.number)))
    }

    /// A version's images with the URLs they are served from.
    async fn images_json(&self, slug: &str, version_id: i64) -> Result<Value, ToolError> {
        let list = db::version_images(&self.state.db, version_id).await?;
        Ok(json!(
            list.iter()
                .map(|i| json!({
                    "name": i.name,
                    "url": format!("{}{}", self.state.config.base_url, image_path(slug, &i.sha256)),
                    "bytes": i.bytes,
                }))
                .collect::<Vec<_>>()
        ))
    }

    /// Who a document is shared with, and its share link.
    async fn sharing(&self, doc: &db::DocumentSummary) -> Result<Value, ToolError> {
        let shares = db::shares(&self.state.db, doc.id).await?;
        let token = db::share_token(&self.state.db, doc.id).await?;
        Ok(json!({
            "shared_with": shares.iter().map(|s| &s.login).collect::<Vec<_>>(),
            "share_link": token.map(|t| format!("{}/s/{t}", self.state.config.base_url)),
            "manage_url": format!("{}/d/{}/-/share", self.state.config.base_url, doc.slug),
        }))
    }

    async fn share(&self, a: Value) -> ToolResult {
        #[derive(Deserialize)]
        struct A {
            slug: String,
            #[serde(default)]
            add_users: Vec<String>,
            #[serde(default)]
            remove_users: Vec<String>,
            link: Option<String>,
        }
        let a: A = args(a)?;
        let doc = self.doc(&a.slug).await?;
        if doc.owner_id != self.user.id {
            return Err(ToolError(format!(
                "only the owner ({}) can share {:?}",
                doc.owner, doc.slug
            )));
        }
        let login =
            |l: &String| db::normalize_login(l).ok_or_else(|| ToolError(format!("{l:?} is not a valid username")));
        for l in &a.add_users {
            let l = login(l)?;
            if l != self.user.login.to_lowercase() {
                db::add_share(&self.state.db, doc.id, &l).await?;
            }
        }
        for l in &a.remove_users {
            db::remove_share(&self.state.db, doc.id, &login(l)?).await?;
        }
        match a.link.as_deref() {
            None | Some("keep") => {}
            Some("enable") => {
                if db::share_token(&self.state.db, doc.id).await?.is_none() {
                    db::set_share_token(&self.state.db, doc.id, true).await?;
                }
            }
            Some("regenerate") => {
                db::set_share_token(&self.state.db, doc.id, true).await?;
            }
            Some("disable") => {
                db::set_share_token(&self.state.db, doc.id, false).await?;
            }
            Some(other) => {
                return Err(ToolError(format!(
                    "link must be enable, disable, regenerate or keep, not {other:?}"
                )));
            }
        }
        let mut out = self.sharing(&doc).await?;
        out["url"] = json!(self.url(&doc.slug, None, "index"));
        Ok(out)
    }

    async fn move_document(&self, a: Value) -> ToolResult {
        #[derive(Deserialize)]
        struct A {
            slug: String,
            folder: String,
        }
        let a: A = args(a)?;
        let doc = self.doc(&a.slug).await?;
        if doc.owner_id != self.user.id {
            return Err(ToolError(format!(
                "only the owner ({}) can move {:?}",
                doc.owner, doc.slug
            )));
        }
        let folder = paths::normalize_folder(&a.folder).map_err(ToolError)?;
        db::move_document(&self.state.db, self.user.id, &doc.slug, &folder).await?;
        Ok(json!({
            "slug": doc.slug,
            "folder": folder,
            "url": self.url(&doc.slug, None, "index"),
        }))
    }

    async fn get_feedback(&self, a: Value) -> ToolResult {
        #[derive(Deserialize)]
        struct A {
            slug: String,
            version: Option<i64>,
            since: Option<i64>,
        }
        let a: A = args(a)?;
        let doc = self.doc(&a.slug).await?;
        let cursor = db::now();
        let (responses, selections) = db::feedback(&self.state.db, doc.id, a.version, a.since.unwrap_or(0)).await?;

        // Field labels, so answers make sense without re-reading the page.
        let mut labels: HashMap<(i64, String), HashMap<String, String>> = HashMap::new();
        for r in &responses {
            let key = (r.version, r.page.clone());
            if labels.contains_key(&key) {
                continue;
            }
            let mut map = HashMap::new();
            if let Some(v) = db::version(&self.state.db, doc.id, Some(r.version)).await?
                && let Some(p) = db::page(&self.state.db, v.id, &r.page).await?
            {
                let empty = HashMap::new();
                let opts = Options {
                    page_path: &p.path,
                    base_url: "/",
                    answers: &empty,
                    images: &HashMap::new(),
                };
                if let Ok(rendered) = render::render(&p.source, Format::parse(&p.format).unwrap_or(Format::Md), &opts) {
                    map = rendered.fields.into_iter().map(|f| (f.name, f.label)).collect();
                }
            }
            labels.insert(key, map);
        }

        Ok(json!({
            "document": doc.slug,
            "latest_version": doc.latest_version,
            "cursor": cursor,
            "responses": responses.iter().map(|r| json!({
                "version": r.version,
                "page": r.page,
                "field": r.field,
                "label": labels.get(&(r.version, r.page.clone())).and_then(|m| m.get(&r.field)),
                "value": r.value(),
                "user": r.user,
                "updated_at": r.updated_at,
            })).collect::<Vec<_>>(),
            "selections": selections.iter().map(|s| json!({
                "id": s.id,
                "version": s.version,
                "page": s.page,
                "quote": s.quote,
                "comment": s.comment,
                "context_before": s.prefix,
                "context_after": s.suffix,
                "user": s.user,
                "created_at": s.created_at,
            })).collect::<Vec<_>>(),
            "hint": "Pass `since: cursor` next time to get only feedback that is new or changed (items may repeat within the same second).",
        }))
    }
}

/// Documents `user` can see, only those with `label` or a label under it when given.
/// An invalid `label` is an error for the caller to show.
pub(crate) async fn list_documents(
    db: &db::Db,
    user: &User,
    label: Option<&str>,
) -> Result<Vec<DocumentSummary>, ToolError> {
    let filter = label.map(labels::normalize_label).transpose().map_err(ToolError)?;
    let mut docs = db::list_documents(db, user).await?;
    if let Some(f) = &filter {
        docs.retain(|d| d.labels.iter().any(|l| labels::label_matches(l, f)));
    }
    Ok(docs)
}

/// The `list_documents` result (also `GET /api/documents`).
pub fn documents_json(base_url: &str, user: &User, docs: &[DocumentSummary]) -> Value {
    json!({
        "documents": docs.iter().map(|d| json!({
            "slug": d.slug,
            "title": d.title,
            "folder": d.folder,
            "labels": d.labels,
            "url": format!("{base_url}{}", doc_base(&d.slug, None)),
            "latest_version": d.latest_version,
            "pages": d.page_count,
            "owner": d.owner,
            "shared_with_you": d.owner_id != user.id,
            "updated_at": d.updated_at,
        })).collect::<Vec<_>>()
    })
}

/// The `list_labels` result (also `GET /api/labels`): the tree of `user`'s labels.
pub fn labels_json(user: &User, docs: &[DocumentSummary]) -> Value {
    let own: Vec<&[String]> = docs
        .iter()
        .filter(|d| d.owner_id == user.id)
        .map(|d| d.labels.as_slice())
        .collect();
    let tree = labels::label_tree(&own);
    json!({
        "labels": tree,
        "documents": own.len(),
        "unlabelled": own.iter().filter(|l| l.is_empty()).count(),
    })
}
