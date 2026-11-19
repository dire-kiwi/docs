//! JSON endpoints: feedback from the frontend, and documents and labels for the
//! frontend and other clients (which sign in with a bearer token instead).

use std::collections::HashMap;

use axum::Json;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::db::{self, User};
use crate::mcp::{self, ToolError};
use crate::render::{self, Format, Options};
use crate::web::auth::{Viewer, constant_time_eq};
use crate::web::pages;
use crate::{labels, paths};
use docs_render::images;
use docs_render::publish::{self, ImageUpload};

pub struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(e: E) -> Self {
        tracing::error!("{:#}", e.into());
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, "internal error".into())
    }
}

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.into())
}

/// Signed-in user, with the CSRF token sent in the `X-CSRF-Token` header.
fn authorize<'a>(viewer: &'a Viewer, headers: &HeaderMap) -> Result<&'a User, ApiError> {
    let user = viewer
        .user
        .as_ref()
        .ok_or_else(|| ApiError(StatusCode::UNAUTHORIZED, "sign in first".into()))?;
    let sent = headers.get("x-csrf-token").and_then(|v| v.to_str().ok()).unwrap_or("");
    if !constant_time_eq(sent.as_bytes(), viewer.csrf.as_bytes()) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "session expired; reload the page".into(),
        ));
    }
    Ok(user)
}

/// The user of a bearer token (personal access token or OAuth access token), if one is sent.
async fn bearer(state: &AppState, headers: &HeaderMap) -> Result<Option<User>, ApiError> {
    let Some(token) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")))
    else {
        return Ok(None);
    };
    match db::bearer_user(&state.db, token.trim()).await? {
        Some(u) if state.config.user_allowed(&u.login) => Ok(Some(u)),
        _ => Err(ApiError(StatusCode::UNAUTHORIZED, "token is invalid or expired".into())),
    }
}

/// A bearer token's user, or the signed-in user (who needs the CSRF token to change things).
async fn api_user(state: &AppState, viewer: &Viewer, headers: &HeaderMap, write: bool) -> Result<User, ApiError> {
    if let Some(u) = bearer(state, headers).await? {
        return Ok(u);
    }
    if write {
        return authorize(viewer, headers).cloned();
    }
    viewer
        .user
        .clone()
        .ok_or_else(|| ApiError(StatusCode::UNAUTHORIZED, "sign in first".into()))
}

#[derive(Deserialize)]
pub struct DocumentsQuery {
    label: Option<String>,
    organization: Option<String>,
}

/// `GET /api/documents[?label=research][&organization=acme]`: what `list_documents` returns.
pub async fn list_documents(
    State(state): State<AppState>,
    viewer: Viewer,
    headers: HeaderMap,
    Query(q): Query<DocumentsQuery>,
) -> Result<Json<Value>, ApiError> {
    let user = api_user(&state, &viewer, &headers, false).await?;
    let docs = mcp::list_documents(&state.db, &user, q.label.as_deref(), q.organization.as_deref())
        .await
        .map_err(|ToolError(e)| bad(e))?;
    Ok(Json(mcp::documents_json(&state.config.base_url, &docs)))
}

#[derive(Deserialize)]
pub struct LabelsQuery {
    organization: Option<String>,
}

/// `GET /api/labels[?organization=acme]`: what `list_labels` returns.
pub async fn list_labels(
    State(state): State<AppState>,
    viewer: Viewer,
    headers: HeaderMap,
    Query(q): Query<LabelsQuery>,
) -> Result<Json<Value>, ApiError> {
    let user = api_user(&state, &viewer, &headers, false).await?;
    let labels = mcp::list_labels(&state.db, &user, q.organization.as_deref())
        .await
        .map_err(|ToolError(e)| bad(e))?;
    Ok(Json(labels))
}

#[derive(Deserialize)]
pub struct SetLabels {
    labels: Vec<String>,
}

/// `PUT /api/documents/{slug}/labels` with `{"labels": [...]}`: replace a document's labels.
pub async fn set_labels(
    State(state): State<AppState>,
    viewer: Viewer,
    headers: HeaderMap,
    Path(slug): Path<String>,
    Json(req): Json<SetLabels>,
) -> Result<Json<Value>, ApiError> {
    let user = api_user(&state, &viewer, &headers, true).await?;
    let doc = db::get_document(&state.db, &slug, &user)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "no such document".into()))?;
    if !doc.can_edit {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "only the owner, or its organization's members, can label this document".into(),
        ));
    }
    let wanted = labels::normalize_labels(&req.labels).map_err(bad)?;
    let stored = db::set_labels(&state.db, doc.id, &wanted).await?;
    Ok(Json(json!({ "slug": doc.slug, "labels": stored })))
}

#[derive(Deserialize)]
pub struct SaveResponse {
    version_id: i64,
    page: String,
    field: String,
    value: Value,
}

pub async fn save_response(
    State(state): State<AppState>,
    viewer: Viewer,
    headers: HeaderMap,
    Json(req): Json<SaveResponse>,
) -> Result<Json<Value>, ApiError> {
    let user = authorize(&viewer, &headers)?;
    if !db::can_view_version(&state.db, req.version_id, user).await? {
        return Err(bad("no such page"));
    }
    let page = db::page(&state.db, req.version_id, &req.page)
        .await?
        .ok_or_else(|| bad("no such page"))?;
    // Only accept answers for fields the page actually has.
    let answers = HashMap::new();
    let opts = Options {
        page_path: &page.path,
        base_url: "/",
        answers: &answers,
        images: &HashMap::new(),
    };
    let format = Format::parse(&page.format).unwrap_or(Format::Md);
    let fields = render::render(&page.source, format, &opts)
        .map(|r| r.fields)
        .unwrap_or_default();
    if !fields.iter().any(|f| f.name == req.field) {
        return Err(bad(format!("page has no field {:?}", req.field)));
    }
    if req.value.to_string().len() > 100_000 {
        return Err(bad("answer is too long"));
    }
    db::save_response(&state.db, req.version_id, &page.path, &req.field, user.id, &req.value).await?;
    Ok(Json(json!({ "ok": true, "saved_at": db::now() })))
}

#[derive(Deserialize)]
pub struct AddSelection {
    version_id: i64,
    page: String,
    quote: String,
    #[serde(default)]
    prefix: String,
    #[serde(default)]
    suffix: String,
    #[serde(default)]
    comment: String,
}

fn clip(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

pub async fn add_selection(
    State(state): State<AppState>,
    viewer: Viewer,
    headers: HeaderMap,
    Json(req): Json<AddSelection>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let user = authorize(&viewer, &headers)?;
    let quote = req.quote.trim();
    if quote.is_empty() {
        return Err(bad("select some text first"));
    }
    if quote.chars().count() > 10_000 || req.comment.chars().count() > 20_000 {
        return Err(bad("selection or comment is too long"));
    }
    if !db::can_view_version(&state.db, req.version_id, user).await? {
        return Err(bad("no such page"));
    }
    db::page(&state.db, req.version_id, &req.page)
        .await?
        .ok_or_else(|| bad("no such page"))?;
    let id = db::add_selection(
        &state.db,
        db::NewSelection {
            version_id: req.version_id,
            page_path: &req.page,
            user_id: user.id,
            quote,
            prefix: clip(&req.prefix, 200),
            suffix: clip(&req.suffix, 200),
            comment: req.comment.trim(),
        },
    )
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "id": id, "user": user.login, "created_at": db::now() })),
    ))
}

pub async fn delete_selection(
    State(state): State<AppState>,
    viewer: Viewer,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let user = authorize(&viewer, &headers)?;
    if db::delete_selection(&state.db, id, user.id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError(StatusCode::NOT_FOUND, "not found".into()))
    }
}

// ---------- the editor ----------

#[derive(Deserialize)]
pub struct PreviewRequest {
    /// The document the page is in, for its images and links.
    slug: Option<String>,
    /// The version whose images to show (the latest when omitted).
    version: Option<i64>,
    #[serde(default)]
    path: String,
    #[serde(default)]
    format: String,
    content: String,
}

/// `POST /api/preview`: a page as it would render (for the editor's preview), with the
/// images of the document's version, without storing anything.
pub async fn preview(
    State(state): State<AppState>,
    viewer: Viewer,
    headers: HeaderMap,
    Json(req): Json<PreviewRequest>,
) -> Result<Json<Value>, ApiError> {
    let user = api_user(&state, &viewer, &headers, false).await?;
    if req.content.len() > publish::MAX_PAGE_BYTES * 2 {
        return Err(bad("the page is too large to preview"));
    }
    let path = paths::normalize(&req.path).unwrap_or_else(|_| "index".into());
    let format = Format::parse(&req.format).unwrap_or(Format::Md);
    let mut images = HashMap::new();
    let mut base = "/".to_string();
    if let Some(slug) = &req.slug
        && let Some(doc) = db::get_document(&state.db, slug, &user).await?
    {
        base = pages::doc_base(&doc.uuid, None);
        if let Some(v) = db::version(&state.db, doc.id, req.version).await? {
            for i in db::version_images(&state.db, v.id).await? {
                images.insert(i.name, pages::image_path(&doc.uuid, &i.sha256));
            }
        }
    }
    let answers = HashMap::new();
    let opts = Options {
        page_path: &path,
        base_url: &base,
        answers: &answers,
        images: &images,
    };
    Ok(Json(match render::render(&req.content, format, &opts) {
        Ok(r) => json!({ "html": r.html, "has_h1": r.has_h1, "warnings": r.warnings, "error": null }),
        Err(e) => {
            json!({ "html": null, "has_h1": false, "warnings": [], "error": format!("This page isn't valid {}: {e}", format.as_str()) })
        }
    }))
}

/// `POST /api/uploads/{token}` (or `PUT`): an image file as the request body, sent to the URL
/// `create_upload_url` gave. The token in the URL says whose upload it is, so nothing else is asked.
pub async fn upload_to_url(
    State(state): State<AppState>,
    Path(token): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<Value>, ApiError> {
    let user = match db::upload_url_user(&state.db, &token).await? {
        Some(u) if state.config.user_allowed(&u.login) => u,
        _ => return Err(ApiError(StatusCode::NOT_FOUND, images::upload_url_error())),
    };
    store_upload(&state, &user, &headers, body).await
}

/// `POST /api/uploads`: the same, for a bearer token's user or the signed-in user.
pub async fn upload(
    State(state): State<AppState>,
    viewer: Viewer,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<Value>, ApiError> {
    let user = api_user(&state, &viewer, &headers, true).await?;
    store_upload(&state, &user, &headers, body).await
}

/// Convert an uploaded image file to AVIF and keep it for `user` to publish:
/// `{ id, bytes, expires_in }`, the id to give as `upload` in `publish_document`'s `images`.
/// The body is read here, once it is known whose upload it is.
async fn store_upload(state: &AppState, user: &User, headers: &HeaderMap, body: Body) -> Result<Json<Value>, ApiError> {
    let form = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| t.trim_start().to_ascii_lowercase().starts_with("multipart/"));
    if form {
        return Err(bad(images::upload_body_error()));
    }
    let body = axum::body::to_bytes(body, images::MAX_UPLOAD_BYTES)
        .await
        .map_err(|_| ApiError(StatusCode::PAYLOAD_TOO_LARGE, images::upload_too_big_error()))?;
    if body.is_empty() {
        return Err(bad(images::upload_body_error()));
    }
    let label = images::UPLOAD_LABEL;
    let format = images::sniff(label, &body).map_err(bad)?;
    let converted = crate::avif::convert_all(vec![ImageUpload {
        name: String::new(),
        label: label.into(),
        format,
        data: body.into(),
    }])
    .await
    .map_err(bad)?;
    let image = converted.first().ok_or_else(|| bad("no image"))?;
    let id = db::add_upload(&state.db, user.id, &image.sha256, &image.avif)
        .await?
        .map_err(|e| ApiError(StatusCode::TOO_MANY_REQUESTS, e))?;
    Ok(Json(json!({
        "id": id,
        "bytes": image.avif.len(),
        "expires_in": images::UPLOAD_KEPT_SECONDS,
    })))
}

/// What the editor saves: every page of the document, and the images uploaded in it.
#[derive(Deserialize)]
pub struct SaveDocument {
    /// The version the editor opened; saving fails with 409 if another was published since.
    base_version: Option<i64>,
    title: String,
    /// A new document's folder.
    folder: Option<String>,
    message: Option<String>,
    pages: Vec<Value>,
    #[serde(default)]
    images: Vec<Value>,
}

fn saved(doc: &db::DocumentSummary, number: i64, published: &Value) -> Json<Value> {
    Json(json!({
        "slug": doc.slug,
        "uuid": doc.uuid,
        "version": number,
        "url": pages::doc_base(&doc.uuid, None),
        "warnings": published.get("warnings").cloned().unwrap_or_else(|| json!([])),
    }))
}

fn title_of(raw: &str) -> Result<String, ApiError> {
    let title = raw.trim();
    if title.is_empty() {
        return Err(bad("give the document a title"));
    }
    Ok(title.chars().take(publish::MAX_TITLE_CHARS).collect())
}

/// `POST /api/documents`: a new document from the editor.
pub async fn create_document(
    State(state): State<AppState>,
    viewer: Viewer,
    headers: HeaderMap,
    Json(req): Json<SaveDocument>,
) -> Result<Json<Value>, ApiError> {
    let user = api_user(&state, &viewer, &headers, true).await?;
    let title = title_of(&req.title)?;
    let published = mcp::publish_as(
        &state,
        &user,
        json!({
            "title": title,
            "folder": req.folder.unwrap_or_default(),
            "message": req.message,
            "pages": req.pages,
            "images": req.images,
        }),
    )
    .await
    .map_err(|ToolError(e)| bad(e))?;
    let slug = published["slug"].as_str().unwrap_or_default();
    let number = published["version"].as_i64().unwrap_or_default();
    let doc = db::get_document(&state.db, slug, &user)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "no such document".into()))?;
    Ok(saved(&doc, number, &published))
}

/// `POST /api/documents/{uuid}/versions` (or its slug): a new version of one of your documents from the
/// editor, with all its pages (pages left out are deleted; images it still uses are kept).
/// 409 with `latest_version` if a version was published after `base_version`.
pub async fn save_version(
    State(state): State<AppState>,
    viewer: Viewer,
    headers: HeaderMap,
    Path(slug): Path<String>,
    Json(req): Json<SaveDocument>,
) -> Result<Response, ApiError> {
    let user = api_user(&state, &viewer, &headers, true).await?;
    let doc = db::get_document(&state.db, &slug, &user)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "no such document".into()))?;
    if !doc.can_edit {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "only the owner, or its organization's members, can edit this document".into(),
        ));
    }
    if req.base_version.is_some_and(|b| b != doc.latest_version) {
        return Ok((
            StatusCode::CONFLICT,
            Json(json!({
                "error": format!("Version {} was published while you were editing.", doc.latest_version),
                "latest_version": doc.latest_version,
            })),
        )
            .into_response());
    }
    if req.pages.is_empty() {
        return Err(bad("a document needs at least one page"));
    }
    let title = title_of(&req.title)?;
    // The pages it had that the editor no longer has.
    let kept: Vec<String> = req
        .pages
        .iter()
        .filter_map(|p| p.get("path").and_then(Value::as_str))
        .filter_map(|p| paths::normalize(p).ok())
        .collect();
    let mut delete = Vec::new();
    if let Some(v) = db::version(&state.db, doc.id, None).await? {
        for p in db::pages(&state.db, v.id).await? {
            if !kept.contains(&p.path) {
                delete.push(p.path);
            }
        }
    }
    // A merge with every page, so the images the pages still use carry over.
    let published = mcp::publish_as(
        &state,
        &user,
        json!({
            "slug": doc.slug,
            "title": title,
            "message": req.message,
            "pages": req.pages,
            "images": req.images,
            "mode": "merge",
            "delete_paths": delete,
        }),
    )
    .await
    .map_err(|ToolError(e)| bad(e))?;
    let number = published["version"].as_i64().unwrap_or_default();
    Ok(saved(&doc, number, &published).into_response())
}
