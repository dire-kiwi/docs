//! The checks `publish_document` runs on the pages and images it is given, shared so
//! that other publishers accept and reject exactly what the hosted server does.

use std::collections::HashMap;

use markdown::mdast::Node;
use serde::Deserialize;

use crate::images::{self, ImageFormat};
use crate::mockup;
use crate::paths;
use crate::render::{self, Format, Options};

/// The most a page's source may be, not counting the inline `data:` images taken out of it.
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

/// An entry of `publish_document`'s `images`: `name` is a relative path pages refer to
/// it by (`![chart](images/chart.png)`), and the image is either `data` (base64) or
/// `upload` (the id of an image uploaded on its own, see `create_upload_url`).
#[derive(Debug, Clone, Deserialize)]
pub struct ImageInput {
    pub name: String,
    #[serde(default)]
    pub data: Option<String>,
    #[serde(default)]
    pub upload: Option<String>,
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
    /// The source, with any inline `data:` images replaced by their names.
    pub source: String,
    /// Relative `<img src>`s in the page (see [`images::candidates`]).
    pub image_srcs: Vec<String>,
}

/// An image to convert to AVIF and store, from `images` or a page's inline `data:` URI.
#[derive(Debug, Clone, PartialEq)]
pub struct ImageUpload {
    /// Normalised name pages refer to it by.
    pub name: String,
    /// How errors name it.
    pub label: String,
    pub format: ImageFormat,
    /// The uploaded bytes (drop them once converted).
    pub data: Vec<u8>,
}

/// An entry of `images` that names an image uploaded on its own: converted and stored
/// already, for the server to find by its id.
#[derive(Debug, Clone, PartialEq)]
pub struct UploadedImage {
    /// Normalised name pages refer to it by.
    pub name: String,
    /// How errors name it.
    pub label: String,
    /// The upload's id ([`images::normalize_upload_id`]).
    pub upload: String,
}

/// Everything in a publish that passed validation.
#[derive(Debug, Clone, PartialEq)]
pub struct ValidPublish {
    pub pages: Vec<ValidPage>,
    /// The images whose bytes came with the publish.
    pub images: Vec<ImageUpload>,
    /// The images uploaded on their own before it.
    pub uploaded: Vec<UploadedImage>,
    pub warnings: Vec<PageWarning>,
}

/// A rendering warning for one page (the publish still succeeds).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct PageWarning {
    pub page: String,
    pub warning: String,
}

/// Validate the pages of a publish. `Err` is the message `publish_document` reports.
/// Inline `data:` images are replaced by their names in the pages' sources (and dropped).
pub fn validate_pages(input: Vec<PageInput>) -> Result<(Vec<ValidPage>, Vec<PageWarning>), String> {
    let v = validate_publish(input, Vec::new())?;
    Ok((v.pages, v.warnings))
}

/// Validate the pages and images of a publish. Inline base64 `data:image/...` URIs are taken
/// out of the pages (which then refer to them by name) and returned with the `images`;
/// a page's size limit doesn't count them. Image bytes are recognised here but not
/// converted: the server converts each to AVIF and checks [`images::MAX_IMAGE_BYTES`].
/// Images given by `upload` are returned as they are named, for the server to look up.
pub fn validate_publish(input: Vec<PageInput>, image_input: Vec<ImageInput>) -> Result<ValidPublish, String> {
    if input.len() > MAX_PAGES {
        return Err(format!("at most {MAX_PAGES} pages per document"));
    }
    let mut uploads: Vec<ImageUpload> = Vec::new();
    let mut uploaded: Vec<UploadedImage> = Vec::new();
    for im in image_input {
        let name = images::normalize_name(&im.name)?;
        let label = images::image_label(&name);
        if uploads.iter().any(|u| u.name == name) || uploaded.iter().any(|u| u.name == name) {
            return Err(images::duplicate_error(&name));
        }
        match (im.data, im.upload.as_deref().map(images::normalize_upload_id)) {
            (Some(data), None) => {
                let data = images::decode_base64(&label, &data)?;
                let format = images::sniff(&label, &data)?;
                uploads.push(ImageUpload {
                    name,
                    label,
                    format,
                    data,
                });
            }
            (None, Some(upload)) if !upload.is_empty() => uploaded.push(UploadedImage { name, label, upload }),
            _ => return Err(images::source_error(&label)),
        }
    }
    let mut pages: Vec<ValidPage> = Vec::new();
    let mut warnings = Vec::new();
    let empty = HashMap::new();
    for (i, p) in input.into_iter().enumerate() {
        let path = paths::normalize(&p.path)?;
        if pages.iter().any(|np| np.path == path) {
            return Err(format!("page {path:?} is listed twice"));
        }
        let format = match p.format.as_deref() {
            Some(f) => Format::parse(f).ok_or_else(|| format!("page {path:?}: format must be md, mdx or html"))?,
            None if p.path.trim().ends_with(".mdx") => Format::Mdx,
            None if p.path.trim().ends_with(".md") => Format::Md,
            None if p.path.trim().ends_with(".html") || p.path.trim().ends_with(".htm") => Format::Html,
            None if mockup::looks_like_html(&p.content) => Format::Html,
            None if looks_like_mdx(&p.content) => Format::Mdx,
            None => Format::Md,
        };
        let (content, inline) = extract_page_images(&path, p.content, format)?;
        for im in inline {
            if !uploads.iter().any(|u| u.name == im.name) && !uploaded.iter().any(|u| u.name == im.name) {
                let format = images::sniff(&im.label, &im.data)?;
                uploads.push(ImageUpload {
                    name: im.name,
                    label: im.label,
                    format,
                    data: im.data,
                });
            }
        }
        if content.len() > MAX_PAGE_BYTES {
            return Err(format!(
                "page {path:?} is larger than {MAX_PAGE_BYTES} bytes (not counting its images)"
            ));
        }
        let tree = render::parse(&content, format)
            .map_err(|e| format!("page {path:?} is not valid {}: {e}", format.as_str()))?;
        let meta = match format {
            Format::Html => render::Meta {
                title: mockup::title(&content),
                order: None,
            },
            _ => render::meta(&tree),
        };
        let opts = Options {
            page_path: &path,
            base_url: "/",
            answers: &empty,
            images: &HashMap::new(),
        };
        let rendered = match format {
            Format::Html => mockup::rendered(&content),
            _ => render::render_tree(&tree, &opts),
        };
        for w in rendered.warnings {
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
            source: content,
            image_srcs: rendered.image_srcs,
        });
    }
    if uploads.len() + uploaded.len() > images::MAX_IMAGES {
        return Err(images::too_many_error(uploads.len() + uploaded.len()));
    }
    Ok(ValidPublish {
        pages,
        images: uploads,
        uploaded,
        warnings,
    })
}

/// Take the inline base64 `data:image/...` URIs out of a page (`path` normalised), except
/// in code, replacing each with its image's name ([`images::extract_inline`]).
pub fn extract_page_images(
    path: &str,
    content: String,
    format: Format,
) -> Result<(String, Vec<images::InlineImage>), String> {
    if !content.contains("data:image/") {
        return Ok((content, Vec::new()));
    }
    let tree =
        render::parse(&content, format).map_err(|e| format!("page {path:?} is not valid {}: {e}", format.as_str()))?;
    let mut code = Vec::new();
    code_ranges(&tree, &mut code);
    images::extract_inline(path, &content, &code)
}

/// Byte ranges of code in a page: text there is shown as written, so `data:` URIs stay.
fn code_ranges(node: &Node, out: &mut Vec<std::ops::Range<usize>>) {
    match node {
        Node::Code(_) | Node::InlineCode(_) | Node::Math(_) | Node::InlineMath(_) => {
            if let Some(p) = node.position() {
                out.push(p.start.offset..p.end.offset);
            }
        }
        _ => {
            for c in node.children().into_iter().flatten() {
                code_ranges(c, out);
            }
        }
    }
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
        bad.format = Some("rst".into());
        assert_eq!(err(vec![bad]), "page \"a\": format must be md, mdx or html");
    }

    #[test]
    fn mockups_are_html_pages() {
        let mockup = "<!doctype html>\n<html><head><title>Sign in</title></head>\n<body><img src=\"images/logo.png\"><Button>not a component</Button></body></html>";
        let mut named = page("Screens/Home", "<main><h1>Home</h1><script>x()</script></main>");
        named.format = Some("html".into());
        let (pages, warnings) = validate_pages(vec![
            page("index.md", "# Notes"),
            page("screens/sign-in.html", mockup),
            page("screens/detected", mockup),
            named,
        ])
        .unwrap();
        assert_eq!(pages[0].format, Format::Md);
        // By its extension (which isn't part of its path), by what it starts with, and as asked.
        assert_eq!(
            (pages[1].path.as_str(), pages[1].format),
            ("screens/sign-in", Format::Html)
        );
        assert_eq!(pages[2].format, Format::Html);
        assert_eq!(pages[3].format, Format::Html);
        assert_eq!(pages[1].title, "Sign in");
        assert_eq!(pages[3].title, "Home");
        assert_eq!(pages[1].source, mockup, "kept as written");
        assert_eq!(pages[1].image_srcs, ["images/logo.png"]);
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].page, "screens/home");
        assert!(warnings[0].warning.contains("scripts"));

        // Its inline images are taken out, as a Markdown page's are.
        let inline = "<img src=\"data:image/gif;base64,R0lGODlh\"><style>a{background:url(data:image/gif;base64,R0lGODlh)}</style>";
        let v = validate_publish(vec![page("a.html", inline)], Vec::new()).unwrap();
        let name = images::inline_name(b"GIF89a");
        assert_eq!(
            v.pages[0].source,
            format!("<img src=\"{name}\"><style>a{{background:url({name})}}</style>")
        );
        assert_eq!(v.pages[0].image_srcs, std::slice::from_ref(&name));
        assert_eq!(v.images.len(), 1);
        assert_eq!(
            validate_pages(vec![page("a.html", ""), page("a.md", "")]).unwrap_err(),
            "page \"a\" is listed twice"
        );
    }

    #[test]
    fn inline_images_dont_count_towards_the_page_size() {
        use base64::Engine;
        let png = [b"\x89PNG\r\n\x1a\n".as_slice(), &[7u8; 900_000]].concat();
        let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
        let content = format!("# Big\n\n![chart](data:image/png;base64,{b64})\n");
        assert!(content.len() > MAX_PAGE_BYTES);
        let v = validate_publish(
            vec![page("big.md", &content)],
            vec![ImageInput {
                name: "./images/x.gif".into(),
                data: Some(base64::engine::general_purpose::STANDARD.encode(b"GIF89a")),
                upload: None,
            }],
        )
        .unwrap();
        let name = images::inline_name(&png);
        assert_eq!(v.pages[0].source, format!("# Big\n\n![chart]({name})\n"));
        assert_eq!(v.pages[0].image_srcs, std::slice::from_ref(&name));
        let got: Vec<_> = v
            .images
            .iter()
            .map(|i| (i.name.as_str(), i.format, i.data.len()))
            .collect();
        assert_eq!(
            got,
            [
                ("images/x.gif", ImageFormat::Gif, 6),
                (name.as_str(), ImageFormat::Png, png.len())
            ]
        );
        // validate_pages takes them out too.
        let (pages, _) = validate_pages(vec![page("big.md", &content)]).unwrap();
        assert!(pages[0].source.len() < 100);

        let many: Vec<ImageInput> = (0..=images::MAX_IMAGES)
            .map(|i| ImageInput {
                name: format!("{i}.gif"),
                data: Some("R0lGODlh".into()),
                upload: None,
            })
            .collect();
        assert_eq!(
            validate_publish(vec![page("a", "")], many).unwrap_err(),
            "a version can have at most 200 images, not 201"
        );
    }

    #[test]
    fn images_are_given_as_data_or_as_an_upload() {
        let image = |name: &str, data: Option<&str>, upload: Option<&str>| ImageInput {
            name: name.into(),
            data: data.map(str::to_string),
            upload: upload.map(str::to_string),
        };
        let id = "3F2A9C1E-0000-4000-8000-000000000001";
        let v = validate_publish(
            vec![page("a", "![x](images/x.png) ![y](y.gif)")],
            vec![
                image("images/x.png", None, Some(&format!(" {id}\n"))),
                image("y.gif", Some("R0lGODlh"), None),
            ],
        )
        .unwrap();
        assert_eq!(
            v.uploaded,
            [UploadedImage {
                name: "images/x.png".into(),
                label: "image \"images/x.png\"".into(),
                upload: id.to_lowercase(),
            }]
        );
        assert_eq!(v.images.len(), 1);

        let err = |images| validate_publish(vec![page("a", "")], images).unwrap_err();
        let needs = "image \"x.png\" needs either `data` (its bytes in base64) or `upload` \
                     (the id of an image uploaded with create_upload_url), and not both";
        assert_eq!(err(vec![image("x.png", None, None)]), needs);
        assert_eq!(err(vec![image("x.png", Some("R0lGODlh"), Some(id))]), needs);
        assert_eq!(err(vec![image("x.png", None, Some(" "))]), needs);
        assert_eq!(
            err(vec![
                image("x.png", None, Some(id)),
                image("./x.png", Some("R0lGODlh"), None)
            ]),
            "image \"x.png\" is given more than once"
        );
        let many: Vec<ImageInput> = (0..=images::MAX_IMAGES)
            .map(|i| image(&format!("{i}.gif"), None, Some(id)))
            .collect();
        assert_eq!(err(many), "a version can have at most 200 images, not 201");
    }
}
