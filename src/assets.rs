//! Script and style tags for the Vite+ frontend.

use std::path::Path;

use maud::{Markup, PreEscaped, html};
use serde::Deserialize;

/// URL prefix the build output is served under (matches `base` in vite.config.ts).
pub const PREFIX: &str = "/static/";
const ENTRY: &str = "src/main.ts";

#[derive(Debug, Default)]
pub struct Assets {
    scripts: Vec<String>,
    styles: Vec<String>,
    dev: bool,
}

#[derive(Deserialize)]
struct ManifestEntry {
    file: String,
    #[serde(default)]
    css: Vec<String>,
}

impl Assets {
    pub fn load(dist: &Path, vite_dev_url: Option<&str>) -> Self {
        if let Some(dev) = vite_dev_url {
            return Assets {
                scripts: vec![format!("{dev}{PREFIX}@vite/client"), format!("{dev}{PREFIX}{ENTRY}")],
                styles: vec![],
                dev: true,
            };
        }
        let manifest_path = dist.join(".vite/manifest.json");
        let manifest: std::collections::HashMap<String, ManifestEntry> = match std::fs::read_to_string(&manifest_path)
            .map_err(|e| e.to_string())
            .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
        {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(
                    "no frontend build at {} ({e}); run `vp build` in frontend/ — pages will be unstyled",
                    manifest_path.display()
                );
                return Assets::default();
            }
        };
        let Some(entry) = manifest.get(ENTRY) else {
            tracing::warn!("{} has no entry for {ENTRY}", manifest_path.display());
            return Assets::default();
        };
        Assets {
            scripts: vec![format!("{PREFIX}{}", entry.file)],
            styles: entry.css.iter().map(|c| format!("{PREFIX}{c}")).collect(),
            dev: false,
        }
    }

    pub fn head(&self) -> Markup {
        html! {
            @for href in &self.styles { link rel="stylesheet" href=(href); }
            @for src in &self.scripts { script type="module" src=(src) {} }
            @if self.dev { (PreEscaped("<!-- vite dev server -->")) }
        }
    }
}
