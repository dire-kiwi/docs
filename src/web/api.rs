//! JSON endpoints used by the frontend to record feedback.

use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::db::{self, User};
use crate::render::{self, Format, Options};
use crate::web::auth::{Viewer, constant_time_eq};

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
