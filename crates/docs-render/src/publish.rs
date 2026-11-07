//! The checks `publish_document` runs on the pages it is given, shared so that
//! other publishers accept and reject exactly what the hosted server does.

use std::collections::HashMap;

use serde::Deserialize;

use crate::paths;
use crate::render::{self, Format, Options};

pub const MAX_PAGE_BYTES: usize = 1_000_000;
pub const MAX_PAGES: usize = 500;
/// Page titles are cut to this many characters.
pub const MAX_TITLE_CHARS: usize = 200;

/// A page as an agent passes it to `publish_document`.
#[derive(Debug, Clone, Deserialize)]
pub struct PageInput {
    pub path: String,
    pub content: String,
    pub format: Option<String>,
    pub title: Option<String>,
}

/// A page that passed validation.
#[derive(Debug, Clone, PartialEq)]
pub struct ValidPage {
    /// Normalised page path.
    pub path: String,
    pub format: Format,
    pub title: String,
    /// Menu position: frontmatter `order`, else the page's index in the input.
    pub position: i64,
    pub source: String,
}

/// A rendering warning for one page (the publish still succeeds).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct PageWarning {
    pub page: String,
    pub warning: String,
}

/// Validate the pages of a publish. `Err` is the message `publish_document` reports.
pub fn validate_pages(input: Vec<PageInput>) -> Result<(Vec<ValidPage>, Vec<PageWarning>), String> {
    if input.len() > MAX_PAGES {
        return Err(format!("at most {MAX_PAGES} pages per document"));
    }
    let mut pages: Vec<ValidPage> = Vec::new();
    let mut warnings = Vec::new();
    let empty = HashMap::new();
    for (i, p) in input.into_iter().enumerate() {
        let path = paths::normalize(&p.path)?;
        if pages.iter().any(|np| np.path == path) {
            return Err(format!("page {path:?} is listed twice"));
        }
        if p.content.len() > MAX_PAGE_BYTES {
            return Err(format!("page {path:?} is larger than {MAX_PAGE_BYTES} bytes"));
        }
        let format = match p.format.as_deref() {
            Some(f) => Format::parse(f).ok_or_else(|| format!("page {path:?}: format must be md or mdx"))?,
            None if p.path.trim().ends_with(".mdx") => Format::Mdx,
            None if p.path.trim().ends_with(".md") => Format::Md,
            None if looks_like_mdx(&p.content) => Format::Mdx,
            None => Format::Md,
        };
        let tree = render::parse(&p.content, format)
            .map_err(|e| format!("page {path:?} is not valid {}: {e}", format.as_str()))?;
        let meta = render::meta(&tree);
        let opts = Options {
            page_path: &path,
            base_url: "/",
            answers: &empty,
        };
        for w in render::render_tree(&tree, &opts).warnings {
            warnings.push(PageWarning {
                page: path.clone(),
                warning: w,
            });
        }
        let title = p.title.or(meta.title).unwrap_or_else(|| paths::title_from_path(&path));
        pages.push(ValidPage {
            position: meta.order.unwrap_or(i as i64),
            title: title.chars().take(MAX_TITLE_CHARS).collect(),
            path,
            format,
            source: p.content,
        });
    }
    Ok((pages, warnings))
}

/// Content that uses one of our components (or any capitalised JSX tag).
pub fn looks_like_mdx(content: &str) -> bool {
    content
        .match_indices('<')
        .any(|(i, _)| content[i + 1..].chars().next().is_some_and(|c| c.is_ascii_uppercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(path: &str, content: &str) -> PageInput {
        PageInput {
            path: path.into(),
            content: content.into(),
            format: None,
            title: None,
        }
    }

    #[test]
    fn validates_like_publish() {
        let (pages, warnings) = validate_pages(vec![
            page("Plan/Phase 1.md", "# One"),
            page("notes", "<Chart />"),
            page("x", "---\norder: 7\n---\nno heading"),
        ])
        .unwrap();
        assert_eq!(pages[0].path, "plan/phase-1");
        assert_eq!(pages[0].title, "One");
        assert_eq!(pages[1].format, Format::Mdx);
        assert_eq!(pages[2].position, 7);
        assert_eq!(pages[2].title, "X");
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].page, "notes");

        let err = |pages| validate_pages(pages).unwrap_err();
        assert_eq!(err(vec![page("a", ""), page("a.md", "")]), "page \"a\" is listed twice");
        assert!(err(vec![page("../x", "")]).starts_with("invalid page path"));
        assert!(err(vec![page("a.mdx", "<Callout>\n\nunclosed")]).starts_with("page \"a\" is not valid mdx: "));
        let mut bad = page("a", "");
        bad.format = Some("html".into());
        assert_eq!(err(vec![bad]), "page \"a\": format must be md or mdx");
    }
}
