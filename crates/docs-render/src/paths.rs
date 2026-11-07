//! Page paths, URL mapping and the navigation tree.
//!
//! A page path looks like a file path without its extension: `index`,
//! `plan`, `plan/index`, `plan/phase-1`. `index` pages stand for their folder.

/// Normalise a path an agent sent us (`./Plan/Phase 1.md` → `plan/phase-1`).
pub fn normalize(raw: &str) -> Result<String, String> {
    let raw = raw.trim().trim_start_matches("./").trim_matches('/');
    let raw = raw
        .strip_suffix(".mdx")
        .or_else(|| raw.strip_suffix(".md"))
        .or_else(|| raw.strip_suffix(".markdown"))
        .unwrap_or(raw);
    let mut segments = Vec::new();
    for seg in raw.split('/') {
        let seg: String = seg
            .trim()
            .chars()
            .map(|c| if c.is_whitespace() { '-' } else { c.to_ascii_lowercase() })
            .collect();
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".."
            || (seg == "-" && segments.is_empty())
            || !seg.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
        {
            return Err(format!(
                "invalid page path {raw:?}: use letters, digits, '-', '_' or '.' separated by '/'"
            ));
        }
        segments.push(seg);
    }
    if segments.is_empty() {
        return Ok("index".into());
    }
    Ok(segments.join("/"))
}

/// URL suffix (relative to a document/version base ending in `/`) for a page path.
pub fn url_suffix(path: &str) -> String {
    if path == "index" {
        String::new()
    } else if let Some(dir) = path.strip_suffix("/index") {
        format!("{dir}/")
    } else {
        path.to_string()
    }
}

/// Candidate page paths for a URL suffix (the inverse of [`url_suffix`]).
pub fn candidates(suffix: &str) -> Vec<String> {
    let s = suffix.trim_matches('/');
    if s.is_empty() {
        return vec!["index".into()];
    }
    vec![s.to_string(), format!("{s}/index")]
}

/// Resolve a relative link written in page `from` (file semantics) to a page
/// path, keeping any `?query#fragment`. Returns `None` for absolute URLs,
/// root-relative links and pure fragments, which are left untouched.
pub fn resolve_link(from: &str, href: &str) -> Option<(String, String)> {
    if href.is_empty()
        || href.starts_with('#')
        || href.starts_with('/')
        || href.starts_with('?')
        || href.contains("://")
        || href.split(['/', '?', '#']).next().is_some_and(|s| s.contains(':'))
    {
        return None;
    }
    let split = href.find(['?', '#']).unwrap_or(href.len());
    let (path, rest) = href.split_at(split);
    let mut parts: Vec<&str> = from.split('/').collect();
    parts.pop(); // directory of the current page
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    let joined = parts.join("/");
    let normalized = normalize(&joined).ok()?;
    Some((normalized, rest.to_string()))
}

/// Turn the last segment of a path into a readable title.
pub fn title_from_path(path: &str) -> String {
    let seg = path.strip_suffix("/index").unwrap_or(path);
    let seg = seg.rsplit('/').next().unwrap_or(seg);
    if seg == "index" {
        return "Overview".into();
    }
    let words: Vec<String> = seg
        .split(['-', '_'])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect();
    words.join(" ")
}

#[derive(Debug, Clone, PartialEq)]
pub struct NavNode {
    /// Folder or page name (the last path segment).
    pub segment: String,
    pub title: String,
    /// Page path if a page exists for this node.
    pub page: Option<String>,
    pub children: Vec<NavNode>,
}

/// Build the menu tree from `(path, title)` pairs given in display order.
pub fn nav_tree(pages: &[(String, String)]) -> Vec<NavNode> {
    let mut root: Vec<NavNode> = Vec::new();
    for (path, title) in pages {
        // `plan/index` is the page for the `plan` folder; `index` is the root page.
        let (folder_path, is_index) = match path.strip_suffix("/index") {
            Some(dir) => (dir, true),
            None => (path.as_str(), false),
        };
        let segments: Vec<&str> = folder_path.split('/').collect();
        let mut level = &mut root;
        for (i, seg) in segments.iter().enumerate() {
            let pos = match level.iter().position(|n| n.segment == *seg) {
                Some(p) => p,
                None => {
                    level.push(NavNode {
                        segment: seg.to_string(),
                        title: title_from_path(&segments[..=i].join("/")),
                        page: None,
                        children: Vec::new(),
                    });
                    level.len() - 1
                }
            };
            if i == segments.len() - 1 && (is_index || level[pos].page.is_none()) {
                level[pos].page = Some(path.clone());
                level[pos].title = title.clone();
            }
            level = &mut level[pos].children;
        }
    }
    root
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_paths() {
        assert_eq!(normalize("./Plan/Phase 1.md").unwrap(), "plan/phase-1");
        assert_eq!(normalize("index.mdx").unwrap(), "index");
        assert_eq!(normalize("/").unwrap(), "index");
        assert_eq!(normalize("plan/index.md").unwrap(), "plan/index");
        assert!(normalize("../etc/passwd").is_err());
        assert!(normalize("a/<b>").is_err());
        assert!(normalize("-/versions").is_err(), "'-' is reserved for site routes");
    }

    #[test]
    fn maps_urls() {
        assert_eq!(url_suffix("index"), "");
        assert_eq!(url_suffix("plan/index"), "plan/");
        assert_eq!(url_suffix("plan/phase-1"), "plan/phase-1");
        assert_eq!(candidates(""), vec!["index"]);
        assert_eq!(candidates("plan/"), vec!["plan", "plan/index"]);
    }

    #[test]
    fn resolves_links() {
        let r = |from, href| resolve_link(from, href);
        assert_eq!(
            r("plan/phase-1", "phase-2.md"),
            Some(("plan/phase-2".into(), "".into()))
        );
        assert_eq!(
            r("plan/index", "phase-2.md#x"),
            Some(("plan/phase-2".into(), "#x".into()))
        );
        assert_eq!(r("plan/phase-1", "../intro.md"), Some(("intro".into(), "".into())));
        assert_eq!(r("index", "plan/"), Some(("plan".into(), "".into())));
        assert_eq!(r("index", "https://x.y"), None);
        assert_eq!(r("index", "mailto:a@b"), None);
        assert_eq!(r("index", "#top"), None);
        assert_eq!(r("index", "/abs"), None);
    }

    #[test]
    fn builds_nested_nav() {
        let pages = vec![
            ("index".to_string(), "Home".to_string()),
            ("plan/index".to_string(), "The plan".to_string()),
            ("plan/phase-1".to_string(), "Phase 1".to_string()),
            ("notes/a/b".to_string(), "Deep".to_string()),
        ];
        let tree = nav_tree(&pages);
        assert_eq!(tree.len(), 3);
        assert_eq!(tree[1].title, "The plan");
        assert_eq!(tree[1].page.as_deref(), Some("plan/index"));
        assert_eq!(tree[1].children[0].page.as_deref(), Some("plan/phase-1"));
        assert_eq!(tree[2].page, None);
        assert_eq!(tree[2].children[0].children[0].title, "Deep");
    }
}
