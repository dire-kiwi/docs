use anyhow::Context;
use docs::{AppState, config::Config};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "docs=info,tower_http=info".into()))
        .init();
    let config = Config::from_env()?;
    if config.github.is_none() && !config.dev_login {
        tracing::warn!(
            "no sign-in method: set GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET, or DOCS_DEV_LOGIN=1 for local use"
        );
    }
    if config.dev_login {
        tracing::warn!("DOCS_DEV_LOGIN is on: anyone can sign in as anyone. Only use this locally.");
    }
    let bind = config.bind;
    let base = config.base_url.clone();
    let state = AppState::new(config).await?;
    let db = state.db.clone();
    tokio::spawn(async move {
        let mut every = tokio::time::interval(std::time::Duration::from_secs(600));
        loop {
            every.tick().await;
            if let Err(e) = docs::db::purge_device_codes(&db).await {
                tracing::warn!("purging expired device codes: {e:#}");
            }
        }
    });
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .with_context(|| format!("binding {bind}"))?;
    tracing::info!("listening on {bind}, public URL {base}, MCP endpoint {base}/mcp");
    axum::serve(listener, docs::app(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
