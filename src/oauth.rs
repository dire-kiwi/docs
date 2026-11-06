//! OAuth 2.1 authorization server for MCP clients
//! (authorization code + PKCE, dynamic client registration, refresh tokens).
//!
//! See the MCP authorization spec: protected resource metadata (RFC 9728),
//! authorization server metadata (RFC 8414) and dynamic registration (RFC 7591).

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Redirect, Response};
use axum::{Form, Json};
use base64::Engine;
use maud::html;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::AppState;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::web::auth::Viewer;
use crate::web::layout;

pub const SCOPE: &str = "docs";

pub fn resource_metadata_url(base: &str) -> String {
    format!("{base}/.well-known/oauth-protected-resource/mcp")
}

pub async fn protected_resource(State(state): State<AppState>) -> Json<Value> {
    let base = &state.config.base_url;
    Json(json!({
        "resource": format!("{base}/mcp"),
        "authorization_servers": [base],
        "scopes_supported": [SCOPE],
        "bearer_methods_supported": ["header"],
        "resource_name": "Docs",
    }))
}

pub async fn authorization_server(State(state): State<AppState>) -> Json<Value> {
    let base = &state.config.base_url;
    Json(json!({
        "issuer": base,
        "authorization_endpoint": format!("{base}/oauth/authorize"),
        "token_endpoint": format!("{base}/oauth/token"),
        "registration_endpoint": format!("{base}/oauth/register"),
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        "scopes_supported": [SCOPE],
    }))
}

fn oauth_error(status: StatusCode, error: &str, description: &str) -> Response {
    (
        status,
        Json(json!({ "error": error, "error_description": description })),
    )
        .into_response()
}

fn valid_redirect_uri(uri: &str) -> bool {
    let Ok(u) = url::Url::parse(uri) else { return false };
    if u.fragment().is_some() {
        return false;
    }
    match u.scheme() {
        "https" => true,
        // Loopback redirects for CLI clients.
        "http" => matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")),
        // Private-use schemes for native apps (e.g. `cursor://`), but nothing a browser would execute.
        s => !matches!(s, "javascript" | "data" | "file" | "vbscript" | "blob" | "about"),
    }
}

#[derive(Deserialize)]
pub struct Registration {
    #[serde(default)]
    client_name: Option<String>,
    #[serde(default)]
    redirect_uris: Vec<String>,
    #[serde(default)]
    token_endpoint_auth_method: Option<String>,
}

pub async fn register(State(state): State<AppState>, Json(reg): Json<Registration>) -> Response {
    if reg.redirect_uris.is_empty() || reg.redirect_uris.len() > 10 {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_redirect_uri",
            "provide 1 to 10 redirect_uris",
        );
    }
    if let Some(bad) = reg.redirect_uris.iter().find(|u| !valid_redirect_uri(u)) {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_redirect_uri",
            &format!("redirect URI not allowed: {bad} (use https, or http on localhost)"),
        );
    }
    if reg.token_endpoint_auth_method.as_deref().is_some_and(|m| m != "none") {
        // We only issue public clients; tell the client what it got rather than failing.
        tracing::debug!(
            "client asked for {:?}; registering a public client",
            reg.token_endpoint_auth_method
        );
    }
    let name: String = reg
        .client_name
        .unwrap_or_else(|| "MCP client".into())
        .chars()
        .take(100)
        .collect();
    match db::register_client(&state.db, &name, &reg.redirect_uris).await {
        Ok(client_id) => (
            StatusCode::CREATED,
            Json(json!({
                "client_id": client_id,
                "client_name": name,
                "redirect_uris": reg.redirect_uris,
                "token_endpoint_auth_method": "none",
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "client_id_issued_at": db::now(),
            })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("{e:#}");
            oauth_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "server_error",
                "could not register client",
            )
        }
    }
}

#[derive(Deserialize, Clone)]
pub struct AuthorizeParams {
    response_type: Option<String>,
    client_id: Option<String>,
    redirect_uri: Option<String>,
    code_challenge: Option<String>,
    code_challenge_method: Option<String>,
    state: Option<String>,
    scope: Option<String>,
    #[allow(dead_code)]
    resource: Option<String>,
}

/// Validated authorization request.
struct AuthRequest {
    client: db::Client,
    redirect_uri: String,
    code_challenge: String,
}

/// Errors before the redirect URI is known to be valid are shown to the user;
/// later ones are sent back to the client.
async fn validate(state: &AppState, p: &AuthorizeParams) -> AppResult<Result<AuthRequest, String>> {
    let client_id = p
        .client_id
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("missing client_id".into()))?;
    let client = db::get_client(&state.db, client_id)
        .await?
        .ok_or_else(|| AppError::BadRequest("unknown client; register it first".into()))?;
    let redirect_uri = match p.redirect_uri.as_deref() {
        Some(u) if client.redirect_uris.iter().any(|r| r == u) => u.to_string(),
        None if client.redirect_uris.len() == 1 => client.redirect_uris[0].clone(),
        _ => {
            return Err(AppError::BadRequest(
                "redirect_uri does not match the registered client".into(),
            ));
        }
    };
    if p.response_type.as_deref() != Some("code") {
        return Ok(Err(redirect_error(
            &redirect_uri,
            "unsupported_response_type",
            p.state.as_deref(),
        )));
    }
    let challenge = match (p.code_challenge.as_deref(), p.code_challenge_method.as_deref()) {
        (Some(c), Some("S256")) if (43..=128).contains(&c.len()) => c.to_string(),
        _ => {
            return Ok(Err(redirect_error(
                &redirect_uri,
                "invalid_request",
                p.state.as_deref(),
            )));
        }
    };
    Ok(Ok(AuthRequest {
        client,
        redirect_uri,
        code_challenge: challenge,
    }))
}

fn redirect_error(redirect_uri: &str, error: &str, state: Option<&str>) -> String {
    let mut u = url::Url::parse(redirect_uri).expect("validated redirect uri");
    u.query_pairs_mut().append_pair("error", error);
    if let Some(s) = state {
        u.query_pairs_mut().append_pair("state", s);
    }
    u.to_string()
}

pub async fn authorize_page(
    State(state): State<AppState>,
    viewer: Viewer,
    Query(p): Query<AuthorizeParams>,
) -> AppResult<Response> {
    let user = viewer.require()?;
    let req = match validate(&state, &p).await? {
        Ok(r) => r,
        Err(redirect) => return Ok(Redirect::to(&redirect).into_response()),
    };
    let host = url::Url::parse(&req.redirect_uri)
        .ok()
        .and_then(|u| u.host_str().map(String::from))
        .unwrap_or_default();
    let hidden = [
        ("client_id", Some(req.client.client_id.as_str())),
        ("redirect_uri", Some(req.redirect_uri.as_str())),
        ("code_challenge", Some(req.code_challenge.as_str())),
        ("state", p.state.as_deref()),
        ("scope", p.scope.as_deref()),
    ];
    Ok(layout::simple(
        "Authorize",
        Some(user),
        &viewer.csrf,
        html! {
            div.card.narrow {
                h1 { "Connect " (req.client.client_name) "?" }
                p { strong { (req.client.client_name) } " wants to act as " strong { (user.login) } " on this site. It will be able to:" }
                ul {
                    li { "read your documents and the ones shared with you" }
                    li { "publish new documents and versions, and share them" }
                    li { "read the answers and comments people leave" }
                }
                p.muted { "You will be sent back to " code { (host) } ". You can revoke access at any time under "
                    a href="/settings/tokens" { "Access" } "." }
                form method="post" action="/oauth/authorize" {
                    input type="hidden" name="csrf" value=(viewer.csrf);
                    @for (k, v) in hidden { @if let Some(v) = v { input type="hidden" name=(k) value=(v); } }
                    div.row {
                        button.primary type="submit" name="decision" value="allow" { "Allow" }
                        button type="submit" name="decision" value="deny" { "Deny" }
                    }
                }
            }
        },
    )
    .into_response())
}

#[derive(Deserialize)]
pub struct Decision {
    csrf: String,
    decision: String,
    client_id: String,
    redirect_uri: String,
    code_challenge: String,
    state: Option<String>,
    scope: Option<String>,
}

pub async fn authorize_decision(
    State(state): State<AppState>,
    viewer: Viewer,
    Form(d): Form<Decision>,
) -> AppResult<Redirect> {
    viewer.check_csrf(&d.csrf)?;
    let user = viewer.require()?;
    let params = AuthorizeParams {
        response_type: Some("code".into()),
        client_id: Some(d.client_id),
        redirect_uri: Some(d.redirect_uri),
        code_challenge: Some(d.code_challenge),
        code_challenge_method: Some("S256".into()),
        state: d.state.clone(),
        scope: d.scope.clone(),
        resource: None,
    };
    let req = match validate(&state, &params).await? {
        Ok(r) => r,
        Err(redirect) => return Ok(Redirect::to(&redirect)),
    };
    if d.decision != "allow" {
        return Ok(Redirect::to(&redirect_error(
            &req.redirect_uri,
            "access_denied",
            d.state.as_deref(),
        )));
    }
    let code = db::create_code(
        &state.db,
        &req.client.client_id,
        user.id,
        &req.redirect_uri,
        &req.code_challenge,
        Some(SCOPE),
    )
    .await?;
    let mut u = url::Url::parse(&req.redirect_uri)?;
    u.query_pairs_mut().append_pair("code", &code);
    if let Some(s) = &d.state {
        u.query_pairs_mut().append_pair("state", s);
    }
    u.query_pairs_mut().append_pair("iss", &state.config.base_url);
    Ok(Redirect::to(u.as_str()))
}

#[derive(Deserialize)]
pub struct TokenRequest {
    grant_type: String,
    code: Option<String>,
    redirect_uri: Option<String>,
    client_id: Option<String>,
    code_verifier: Option<String>,
    refresh_token: Option<String>,
}

pub fn pkce_challenge(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub async fn token(State(state): State<AppState>, Form(t): Form<TokenRequest>) -> Response {
    match issue(&state, t).await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("{e:#}");
            oauth_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "server_error",
                "token request failed",
            )
        }
    }
}

async fn issue(state: &AppState, t: TokenRequest) -> anyhow::Result<Response> {
    let invalid_grant = |d: &str| Ok(oauth_error(StatusCode::BAD_REQUEST, "invalid_grant", d));
    let (user_id, client_id) = match t.grant_type.as_str() {
        "authorization_code" => {
            let (Some(code), Some(verifier)) = (t.code.as_deref(), t.code_verifier.as_deref()) else {
                return Ok(oauth_error(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "code and code_verifier are required",
                ));
            };
            let Some(c) = db::take_code(&state.db, code).await? else {
                return invalid_grant("unknown or expired code");
            };
            if t.client_id.as_deref().is_some_and(|id| id != c.client_id) {
                return invalid_grant("code was issued to another client");
            }
            if t.redirect_uri.as_deref().is_some_and(|u| u != c.redirect_uri) {
                return invalid_grant("redirect_uri does not match");
            }
            if !crate::web::auth::constant_time_eq(pkce_challenge(verifier).as_bytes(), c.code_challenge.as_bytes()) {
                return invalid_grant("PKCE verification failed");
            }
            let _ = c.scope;
            (c.user_id, c.client_id)
        }
        "refresh_token" => {
            let Some(rt) = t.refresh_token.as_deref() else {
                return Ok(oauth_error(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "refresh_token is required",
                ));
            };
            let Some((user_id, client_id)) = db::take_refresh_token(&state.db, rt).await? else {
                return invalid_grant("unknown or expired refresh token");
            };
            if t.client_id.as_deref().is_some_and(|id| id != client_id) {
                return invalid_grant("refresh token was issued to another client");
            }
            (user_id, client_id)
        }
        _ => {
            return Ok(oauth_error(
                StatusCode::BAD_REQUEST,
                "unsupported_grant_type",
                "use authorization_code or refresh_token",
            ));
        }
    };
    match db::get_user(&state.db, user_id).await? {
        Some(u) if state.config.user_allowed(&u.login) => {}
        _ => return invalid_grant("this user is no longer allowed to use this site"),
    }
    let access = db::create_token(
        &state.db,
        "access",
        user_id,
        Some(&client_id),
        None,
        Some(db::ACCESS_TTL),
    )
    .await?;
    let refresh = db::create_token(
        &state.db,
        "refresh",
        user_id,
        Some(&client_id),
        None,
        Some(db::REFRESH_TTL),
    )
    .await?;
    Ok((
        [("cache-control", "no-store")],
        Json(json!({
            "access_token": access,
            "token_type": "Bearer",
            "expires_in": db::ACCESS_TTL,
            "refresh_token": refresh,
            "scope": SCOPE,
        })),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_matches_rfc7636_example() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn redirect_uri_rules() {
        assert!(valid_redirect_uri("https://claude.ai/api/mcp/auth_callback"));
        assert!(valid_redirect_uri("http://localhost:3334/callback"));
        assert!(valid_redirect_uri("http://127.0.0.1:9999/cb"));
        assert!(valid_redirect_uri("cursor://anysphere.cursor-mcp/oauth/callback"));
        assert!(!valid_redirect_uri("http://evil.com/cb"));
        assert!(!valid_redirect_uri("javascript:alert(1)"));
        assert!(!valid_redirect_uri("not a url"));
    }
}
