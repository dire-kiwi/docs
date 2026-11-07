//! Print what the native renderer produces for test/fixtures, in the shapes the
//! WASM package returns. test/package.test.mjs compares the package against it.
//!
//! cargo run -q -p docs-render-wasm --example native > native.json

use std::collections::HashMap;
use std::path::Path;

use docs_render::publish::{self, PageInput};
use docs_render::render::{self, Format, Options};
use docs_render::{components, paths, tools};
use serde_json::{Value, json};

fn nav(nodes: &[paths::NavNode]) -> Value {
    nodes
        .iter()
        .map(|n| json!({ "segment": n.segment, "title": n.title, "page": n.page, "children": nav(&n.children) }))
        .collect()
}

fn publish(input: Vec<PageInput>) -> Value {
    match publish::validate_pages(input) {
        Ok((pages, warnings)) => json!({
            "pages": pages.iter().map(|p| json!({ "path": p.path, "format": p.format.as_str(), "title": p.title, "position": p.position })).collect::<Vec<_>>(),
            "warnings": warnings,
        }),
        Err(e) => json!({ "error": e }),
    }
}

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("test/fixtures");
    let answers: HashMap<String, Value> =
        serde_json::from_str(&std::fs::read_to_string(dir.join("answers.json")).unwrap()).unwrap();
    let cases: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("cases.json")).unwrap()).unwrap();

    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| matches!(p.extension().and_then(|e| e.to_str()), Some("md" | "mdx")))
        .collect();
    files.sort();
    let mut fixtures = serde_json::Map::new();
    for file in files {
        let name = file.file_name().unwrap().to_str().unwrap().to_string();
        let ext = file.extension().unwrap().to_str().unwrap();
        let format = Format::parse(ext).unwrap();
        let source = std::fs::read_to_string(&file).unwrap();
        let opts = Options {
            page_path: "plan/phase-1",
            base_url: "/d/x/",
            answers: &answers,
        };
        let rendered = match render::render(&source, format, &opts) {
            Ok(r) => json!({
                "html": r.html,
                "toc": r.toc.iter().map(|t| json!({ "depth": t.depth, "id": t.id, "text": t.text })).collect::<Vec<_>>(),
                "hasH1": r.has_h1,
                "fields": r.fields,
                "warnings": r.warnings,
            }),
            Err(e) => json!({ "error": e }),
        };
        let meta = match render::parse(&source, format) {
            Ok(t) => {
                let m = render::meta(&t);
                json!({ "title": m.title, "order": m.order })
            }
            Err(e) => json!({ "error": e }),
        };
        let validated = publish(vec![PageInput {
            path: format!("plan/{name}"),
            content: source,
            format: None,
            title: None,
        }]);
        fixtures.insert(
            name,
            json!({ "format": ext, "render": rendered, "meta": meta, "validate": validated }),
        );
    }

    let strs = |k: &str| {
        cases[k]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect::<Vec<_>>()
    };
    let out = json!({
        "fixtures": fixtures,
        "paths": strs("paths").iter().map(|p| match paths::normalize(p) {
            Ok(v) => json!({ "ok": v }),
            Err(e) => json!({ "error": e }),
        }).collect::<Vec<_>>(),
        "links": cases["links"].as_array().unwrap().iter().map(|l| {
            paths::resolve_link(l[0].as_str().unwrap(), l[1].as_str().unwrap())
                .map(|(path, suffix)| json!({ "path": path, "suffix": suffix }))
        }).collect::<Vec<_>>(),
        "titles": strs("titles").iter().map(|t| paths::title_from_path(t)).collect::<Vec<_>>(),
        "suffixes": strs("titles").iter().map(|t| paths::url_suffix(t)).collect::<Vec<_>>(),
        "candidates": strs("suffixes").iter().map(|s| paths::candidates(s)).collect::<Vec<_>>(),
        "nav": nav(&paths::nav_tree(&serde_json::from_value::<Vec<(String, String)>>(cases["nav"].clone()).unwrap())),
        "sanitize": strs("html").iter().map(|h| render::sanitize(h)).collect::<Vec<_>>(),
        "publish": cases["publish"].as_array().unwrap().iter()
            .map(|p| publish(serde_json::from_value(p.clone()).unwrap()))
            .collect::<Vec<_>>(),
        "componentsReference": components::reference(),
        "toolDefinitions": tools::tool_definitions(),
        "serverInstructions": tools::INSTRUCTIONS,
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
