//! Document labels: `/`-separated paths (`research/ai/llms`) whose nesting is
//! implied by the path. Labels match case-insensitively; a label set keeps the
//! case it was first written in.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

/// A label is at most this many characters.
pub const MAX_LABEL_CHARS: usize = 100;
/// A document has at most this many labels.
pub const MAX_LABELS: usize = 20;

/// Normalise one label (` Research // AI ` → `Research/AI`): segments are trimmed and
/// empty ones dropped. Case is kept. Empty labels and control characters are rejected.
pub fn normalize_label(raw: &str) -> Result<String, String> {
    let label = raw
        .split('/')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    if label.is_empty() {
        return Err(format!("invalid label {raw:?}: a label can't be empty"));
    }
    if label.chars().any(char::is_control) {
        return Err(format!("invalid label {raw:?}: no control characters"));
    }
    if label.chars().count() > MAX_LABEL_CHARS {
        return Err(format!("invalid label {raw:?}: at most {MAX_LABEL_CHARS} characters"));
    }
    Ok(label)
}

/// Normalise a document's labels: each with [`normalize_label`], without duplicates
/// (ignoring case, the first spelling wins), at most [`MAX_LABELS`].
pub fn normalize_labels<S: AsRef<str>>(raw: &[S]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for r in raw {
        let label = normalize_label(r.as_ref())?;
        if !out.iter().any(|l| label_key(l) == label_key(&label)) {
            out.push(label);
        }
    }
    if out.len() > MAX_LABELS {
        return Err(format!("at most {MAX_LABELS} labels per document"));
    }
    Ok(out)
}

/// What labels are matched by: the normalised label, lowercased.
pub fn label_key(label: &str) -> String {
    label.to_lowercase()
}

/// Whether `label` is `filter` or nested under it (`research/ai` is under `research`,
/// `researchers` is not). Both are normalised labels.
pub fn label_matches(label: &str, filter: &str) -> bool {
    let (label, filter) = (label_key(label), label_key(filter));
    label == filter || label.strip_prefix(&filter).is_some_and(|rest| rest.starts_with('/'))
}

/// Spell `label` the way the label set already does: the longest prefix it shares
/// (ignoring case) with one of `known` takes that spelling, the rest stays as written.
/// `RESEARCH/llms` with `Research/AI` known → `Research/llms`.
pub fn with_known_case<S: AsRef<str>>(label: &str, known: &[S]) -> String {
    let segments: Vec<&str> = label.split('/').collect();
    let mut best: Option<Vec<&str>> = None;
    for k in known {
        let k: Vec<&str> = k.as_ref().split('/').collect();
        let shared = segments
            .iter()
            .zip(&k)
            .take_while(|(a, b)| label_key(a) == label_key(b))
            .count();
        if shared > best.as_ref().map_or(0, Vec::len) {
            best = Some(k[..shared].to_vec());
        }
    }
    match best {
        Some(prefix) => {
            let n = prefix.len();
            prefix
                .into_iter()
                .chain(segments[n..].iter().copied())
                .collect::<Vec<_>>()
                .join("/")
        }
        None => label.to_string(),
    }
}

/// A label in a [`label_tree`].
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LabelNode {
    /// The last segment.
    pub name: String,
    /// The whole label, e.g. `research/ai`.
    pub path: String,
    /// How many documents have this label or one nested under it.
    pub documents: usize,
    /// Indexes (into the input) of the documents with exactly this label.
    #[serde(skip)]
    pub docs: Vec<usize>,
    pub children: Vec<LabelNode>,
}

#[derive(Default)]
struct Builder {
    name: String,
    path: String,
    all: BTreeSet<usize>,
    docs: Vec<usize>,
    children: BTreeMap<String, Builder>,
}

impl Builder {
    fn finish(self) -> LabelNode {
        LabelNode {
            name: self.name,
            path: self.path,
            documents: self.all.len(),
            docs: self.docs,
            children: finish(self.children),
        }
    }
}

fn finish(children: BTreeMap<String, Builder>) -> Vec<LabelNode> {
    children.into_values().map(Builder::finish).collect()
}

/// The labels of some documents (one list of normalised labels per document) as a
/// tree, sorted by name ignoring case. Parent labels exist when any label under them does.
pub fn label_tree<D: AsRef<[S]>, S: AsRef<str>>(docs: &[D]) -> Vec<LabelNode> {
    let mut root: BTreeMap<String, Builder> = BTreeMap::new();
    for (i, labels) in docs.iter().enumerate() {
        for label in labels.as_ref() {
            let label = label.as_ref();
            let mut children = &mut root;
            let mut end = 0;
            let segments: Vec<&str> = label.split('/').collect();
            for (depth, seg) in segments.iter().enumerate() {
                end += seg.len() + usize::from(depth > 0);
                let node = children.entry(label_key(seg)).or_insert_with(|| Builder {
                    name: seg.to_string(),
                    path: label[..end].to_string(),
                    ..Builder::default()
                });
                node.all.insert(i);
                if depth + 1 == segments.len() && !node.docs.contains(&i) {
                    node.docs.push(i);
                }
                children = &mut node.children;
            }
        }
    }
    finish(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_labels() {
        assert_eq!(normalize_label(" Research // AI /").unwrap(), "Research/AI");
        assert_eq!(normalize_label("needs review").unwrap(), "needs review");
        assert!(normalize_label(" / ").is_err());
        assert!(normalize_label("").is_err());
        assert!(normalize_label("a\nb").is_err());
        assert!(normalize_label(&"x".repeat(MAX_LABEL_CHARS + 1)).is_err());
        assert_eq!(
            normalize_labels(&["Research", "research ", "RESEARCH/ai", "x"]).unwrap(),
            ["Research", "RESEARCH/ai", "x"]
        );
        assert!(normalize_labels(&(0..=MAX_LABELS).map(|i| i.to_string()).collect::<Vec<_>>()).is_err());
        assert!(normalize_labels::<&str>(&[]).unwrap().is_empty());
    }

    #[test]
    fn matches_nested_labels() {
        assert!(label_matches("research", "research"));
        assert!(label_matches("Research/AI/llms", "research/ai"));
        assert!(!label_matches("researchers", "research"));
        assert!(!label_matches("research", "research/ai"));
    }

    #[test]
    fn keeps_the_known_case() {
        let known = ["Research/AI", "ops"];
        assert_eq!(with_known_case("research/ai/LLMs", &known), "Research/AI/LLMs");
        assert_eq!(with_known_case("RESEARCH/x", &known), "Research/x");
        assert_eq!(with_known_case("OPS", &known), "ops");
        assert_eq!(with_known_case("New", &known), "New");
    }

    #[test]
    fn builds_the_tree() {
        let docs = vec![
            vec!["Research/AI", "ops"],
            vec!["research/ai/llms"],
            vec!["research"],
            vec![],
        ];
        let tree = label_tree(&docs);
        assert_eq!(tree.len(), 2);
        let research = &tree[1];
        assert_eq!(
            (research.name.as_str(), research.path.as_str()),
            ("Research", "Research")
        );
        assert_eq!(research.documents, 3);
        assert_eq!(research.docs, [2]);
        let ai = &research.children[0];
        assert_eq!(
            (ai.path.as_str(), ai.documents, ai.docs.clone()),
            ("Research/AI", 2, vec![0])
        );
        assert_eq!(ai.children[0].path, "research/ai/llms");
        assert_eq!(tree[0].path, "ops");
        assert_eq!(
            serde_json::to_value(&tree[0]).unwrap(),
            serde_json::json!({ "name": "ops", "path": "ops", "documents": 1, "children": [] })
        );
    }
}
