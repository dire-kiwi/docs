pub mod api;
pub mod auth;
pub mod layout;
pub mod pages;

use axum::Router;
use axum::http::{HeaderValue, header};
use axum::routing::{delete, get, post};
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;

use crate::{AppState, mcp, oauth};

pub fn router(state: AppState) -> Router {
    // Endpoints MCP clients (possibly browser-based) call cross-origin. They use bearer
    // tokens or public OAuth clients, never cookies.
    let cors = CorsLayer::new()
        .allow_origin(tower_http::cors::Any)
        .allow_methods(tower_http::cors::Any)
        .allow_headers(tower_http::cors::Any)
        .expose_headers([header::WWW_AUTHENTICATE, "mcp-session-id".parse().unwrap()]);
    let public_api = Router::new()
        .route("/mcp", post(mcp::handle).get(mcp::not_allowed).delete(mcp::not_allowed))
        .route("/.well-known/oauth-protected-resource", get(oauth::protected_resource))
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            get(oauth::protected_resource),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get(oauth::authorization_server),
        )
        .route("/oauth/register", post(oauth::register))
        .route("/oauth/token", post(oauth::token))
        .route("/oauth/device_authorization", post(oauth::device_authorization))
        .layer(cors);

    let static_files = ServeDir::new(&state.config.assets_dir);
    let csp = content_security_policy(state.config.vite_dev_url.as_deref());

    Router::new()
        .route("/", get(pages::home))
        .route("/components", get(pages::components_page))
        .route("/login", get(auth::login_page))
        .route("/logout", post(auth::logout))
        .route("/auth/dev", post(auth::dev_login))
        .route("/auth/github", get(auth::github_start))
        .route("/auth/github/callback", get(auth::github_callback))
        .route(
            "/oauth/authorize",
            get(oauth::authorize_page).post(oauth::authorize_decision),
        )
        .route("/device", get(oauth::device_page).post(oauth::device_decision))
        .route("/settings/tokens", get(pages::tokens_page).post(pages::create_token))
        .route("/settings/tokens/{id}/revoke", post(pages::revoke_token))
        .route("/d/{slug}", get(pages::doc_redirect))
        .route("/d/{slug}/", get(pages::doc_root))
        .route("/d/{slug}/-/versions", get(pages::versions_page))
        .route("/d/{slug}/-/feedback", get(pages::feedback_page))
        .route("/d/{slug}/-/share", get(pages::share_page).post(pages::share_update))
        .route("/s/{token}", get(pages::share_link))
        .route("/d/{slug}/-/v/{n}/", get(pages::version_root))
        .route("/d/{slug}/-/v/{n}/{*path}", get(pages::version_page))
        .route("/d/{slug}/{*path}", get(pages::doc_page))
        .route("/api/responses", post(api::save_response))
        .route("/api/selections", post(api::add_selection))
        .route("/api/selections/{id}", delete(api::delete_selection))
        .merge(public_api)
        .nest_service(
            "/static",
            tower::ServiceBuilder::new()
                .layer(SetResponseHeaderLayer::if_not_present(
                    header::CACHE_CONTROL,
                    HeaderValue::from_static("public, max-age=31536000, immutable"),
                ))
                .service(static_files),
        )
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CONTENT_SECURITY_POLICY,
            csp,
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::REFERRER_POLICY,
            HeaderValue::from_static("same-origin"),
        ))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// Agent-written content is sanitized when rendered; the CSP is a second line of defence.
/// (No `form-action`: the OAuth consent form must redirect to the client.)
fn content_security_policy(vite_dev_url: Option<&str>) -> HeaderValue {
    let (dev, dev_ws) = match vite_dev_url {
        Some(u) => (format!(" {u}"), format!(" {u} {}", u.replacen("http", "ws", 1))),
        None => (String::new(), String::new()),
    };
    let policy = format!(
        "default-src 'self'; script-src 'self'{dev}; style-src 'self' 'unsafe-inline'{dev}; img-src * data:; \
         connect-src 'self'{dev_ws}; font-src 'self' data:{dev}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    );
    HeaderValue::from_str(&policy).expect("valid CSP header")
}
