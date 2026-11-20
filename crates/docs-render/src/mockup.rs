//! Mockups: pages published as HTML (`format: "html"`).
//!
//! A mockup is a self-contained HTML document (its CSS in `<style>` or `style=""`),
//! shown in the design editor as a frame on a canvas rather than rendered into the
//! reader. Nothing here parses it as a browser would: the editor shows it in a
//! sandboxed frame where scripts don't run, so these scans only read what a publish
//! needs (a title, the images it refers to, what to warn about) and never have to be
//! right about what is markup and what is text.

use crate::render::Rendered;

/// Whether `content` is an HTML document rather than Markdown: it starts with a
/// doctype or an `<html>` tag.
pub fn looks_like_html(content: &str) -> bool {
    let start = content.trim_start().as_bytes();
    starts_with_ignore_case(start, b"<!doctype html") || starts_with_ignore_case(start, b"<html")
}

/// The text of the first `<title>`, if it has any.
pub fn title(source: &str) -> Option<String> {
    let open = find_ignore_case(source, "<title", 0)?;
    let start = source[open..].find('>')? + open + 1;
    let end = find_ignore_case(source, "</title", start)?;
    let text = decode_entities(&source[start..end]);
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (!text.is_empty()).then_some(text)
}

/// The relative references in the mockup's `src`, `srcset` and `poster` attributes and its
/// CSS `url(...)`s, each once and as written: what may name one of the document's images
/// (see [`crate::images::candidates`]). Like a Markdown page's `image_srcs`, it leaves out
/// URLs with a scheme (`https:`, `data:`) or a host.
pub fn image_srcs(source: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut add = |raw: &str| {
        let raw = raw.trim();
        // Only what can name one of the document's images: not another site's, nor a part of the page.
        let elsewhere = raw.starts_with("//")
            || raw.starts_with('#')
            || raw.starts_with('?')
            || raw.split('/').next().is_some_and(|s| s.contains(':'));
        if !raw.is_empty() && !elsewhere && !out.iter().any(|o| o == raw) {
            out.push(raw.to_string());
        }
    };
    for (attr, list) in [("src", false), ("poster", false), ("srcset", true)] {
        let mut from = 0;
        while let Some(i) = find_ignore_case(source, attr, from) {
            from = i + attr.len();
            // An attribute's name, not the end of a longer one (`data-src` is someone else's).
            let before = source[..i].chars().next_back();
            if !before.is_some_and(|c| c.is_whitespace() || c == '"' || c == '\'') {
                continue;
            }
            let rest = source[from..].trim_start();
            let Some(rest) = rest.strip_prefix('=') else { continue };
            let rest = rest.trim_start();
            let value = match rest.chars().next() {
                Some(q @ ('"' | '\'')) => rest[1..].split(q).next().unwrap_or_default(),
                Some(_) => rest
                    .split(|c: char| c.is_whitespace() || c == '>')
                    .next()
                    .unwrap_or_default(),
                None => continue,
            };
            if list {
                // `a.png 1x, b.png 2x`: the URL is each candidate's first word.
                for candidate in value.split(',') {
                    add(candidate.split_whitespace().next().unwrap_or_default());
                }
            } else {
                add(value);
            }
        }
    }
    let mut from = 0;
    while let Some(i) = find_ignore_case(source, "url(", from) {
        from = i + 4;
        let Some(len) = source[from..].find(')') else { break };
        add(source[from..from + len].trim().trim_matches(|c| c == '"' || c == '\''));
        from += len;
    }
    out
}

/// What the publisher should know about a mockup: the parts of it the editor won't show.
pub fn warnings(source: &str) -> Vec<String> {
    let mut out = Vec::new();
    if find_ignore_case(source, "<script", 0).is_some() {
        out.push(
            "scripts in a mockup don't run: the design editor shows its HTML and CSS only, so show each state as its own markup".to_string(),
        );
    }
    let mut from = 0;
    while let Some(i) = find_ignore_case(source, "<link", from) {
        from = i + 5;
        let tag = &source[from..source[from..].find('>').map_or(source.len(), |e| e + from)];
        if find_ignore_case(tag, "stylesheet", 0).is_some()
            && (find_ignore_case(tag, "http:", 0).is_some()
                || find_ignore_case(tag, "https:", 0).is_some()
                || tag.contains("\"//")
                || tag.contains("'//"))
        {
            out.push(
                "a mockup's stylesheets from other sites may not load: put its CSS in a <style> element".to_string(),
            );
            break;
        }
    }
    out
}

/// A mockup as [`crate::render::render`] gives it: no reader HTML (the design editor shows
/// its source), the images it refers to, and its warnings.
pub fn rendered(source: &str) -> Rendered {
    Rendered {
        // A mockup has no page title to add above it.
        has_h1: true,
        warnings: warnings(source),
        image_srcs: image_srcs(source),
        ..Rendered::default()
    }
}

fn starts_with_ignore_case(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.len() >= needle.len() && haystack[..needle.len()].eq_ignore_ascii_case(needle)
}

/// Where `needle` (ASCII) first is in `haystack` at or after `from`, whatever its case.
fn find_ignore_case(haystack: &str, needle: &str, from: usize) -> Option<usize> {
    let (h, n) = (haystack.as_bytes(), needle.as_bytes());
    if n.is_empty() || h.len() < n.len() {
        return None;
    }
    // A match starts at an ASCII byte, so it is on a character boundary.
    (from..=h.len() - n.len()).find(|&i| h[i..i + n.len()].eq_ignore_ascii_case(n))
}

fn decode_entities(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = r#"<!DOCTYPE html>
<html><head><TITLE> Sign in &amp;
 up </TITLE>
<style>.hero { background: url("images/hero.png") } .x { background: url(data:image/png;base64,AAAA) }</style></head>
<body><img class="logo" src="images/logo.png" alt=""><img src='../shots/a.png' data-src="not-this.png">
<img src=plain.png><img srcset="images/a.png 1x, images/a@2x.png 2x">
<a href="https://example.com">x</a><img src="https://example.com/remote.png"><img src="//cdn.example/x.png">
<svg><rect fill="url(#grad)"/></svg></body></html>"#;

    #[test]
    fn recognises_html_documents() {
        assert!(looks_like_html("  <!doctype html><p>x"));
        assert!(looks_like_html("<HTML lang=en>"));
        assert!(!looks_like_html("# Heading\n\n<div>html in markdown</div>"));
        assert!(!looks_like_html("<Callout>x</Callout>"));
    }

    #[test]
    fn title_comes_from_the_title_element() {
        assert_eq!(title(PAGE).as_deref(), Some("Sign in & up"));
        assert_eq!(title("<p>no title</p>"), None);
        assert_eq!(title("<title>  </title>"), None);
    }

    #[test]
    fn finds_the_images_a_mockup_refers_to() {
        assert_eq!(
            image_srcs(PAGE),
            [
                "images/logo.png",
                "../shots/a.png",
                "plain.png",
                "images/a.png",
                "images/a@2x.png",
                "images/hero.png",
            ]
        );
    }

    #[test]
    fn warns_about_what_will_not_show() {
        assert!(warnings(PAGE).is_empty());
        let w = warnings("<link rel=\"stylesheet\" href=\"https://cdn.example/x.css\"><SCRIPT>alert(1)</SCRIPT>");
        assert_eq!(w.len(), 2);
        assert!(w[0].contains("scripts"));
        assert!(w[1].contains("stylesheets"));
        assert!(warnings("<link rel=stylesheet href=local.css><link rel=icon href=\"https://x/y.ico\">").is_empty());
    }

    #[test]
    fn scans_do_not_split_characters() {
        let s = "héllo <title>Ünïcode ✓</title> url(ïmages/x.png) src=\"ü.png\"";
        assert_eq!(title(s).as_deref(), Some("Ünïcode ✓"));
        assert_eq!(image_srcs(s), ["ü.png", "ïmages/x.png"]);
    }
}
