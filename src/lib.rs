//! Docs: a place for agents to publish Markdown/MDX documents and collect feedback.

pub mod assets;
pub mod components;
pub mod config;
pub mod db;
pub mod error;
pub mod mcp;
pub mod oauth;
pub mod paths;
pub mod render;
pub mod web;

use std::sync::{Arc, OnceLock};

use config::Config;

#[derive(Clone)]
pub struct AppState {
    pub db: db::Db,
    pub config: Arc<Config>,
    pub http: reqwest::Client,
}

static ASSETS: OnceLock<assets::Assets> = OnceLock::new();

pub fn assets() -> &'static assets::Assets {
    ASSETS.get_or_init(assets::Assets::default)
}

impl AppState {
    pub async fn new(config: Config) -> anyhow::Result<Self> {
        let db = db::connect(&config.database_url).await?;
        let _ = ASSETS.set(assets::Assets::load(&config.assets_dir, config.vite_dev_url.as_deref()));
        let http = reqwest::Client::builder().user_agent("docs-server").build()?;
        Ok(AppState {
            db,
            config: Arc::new(config),
            http,
        })
    }
}

pub fn app(state: AppState) -> axum::Router {
    web::router(state)
}
