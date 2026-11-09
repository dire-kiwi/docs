//! Images in documents: the formats accepted, image names, inline `data:` URIs
//! and the error messages `publish_document` reports.
//!
//! Every image is converted to AVIF when it is published (by the server; this
//! crate only recognises and extracts images) and only the AVIF is kept. Each
//! image may be at most [`MAX_IMAGE_BYTES`] *after* conversion. Image data
//! doesn't count towards a page's size limit.
//!
//! Huntaway's docs MCP implements the same contract: keep the two in step.

use base64::Engine;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use sha2::{Digest, Sha256};

/// The most an image may be after conversion to AVIF: 500 KB.
pub const MAX_IMAGE_BYTES: usize = 500 * 1024;
/// The most images a version may have (uploaded, inline and kept by a merge together).
pub const MAX_IMAGES: usize = 200;
/// Image names are at most this many characters.
pub const MAX_IMAGE_NAME_CHARS: usize = 200;

const FORMATS: &str = "PNG, JPEG, WebP, GIF or AVIF";

/// The image formats `publish_document` accepts (all are converted to AVIF).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFormat {
    Png,
    Jpeg,
    WebP,
    /// Only the first frame is kept.
    Gif,
    Avif,
}

impl ImageFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            ImageFormat::Png => "png",
            ImageFormat::Jpeg => "jpeg",
            ImageFormat::WebP => "webp",
            ImageFormat::Gif => "gif",
            ImageFormat::Avif => "avif",
        }
    }
}

/// How errors name an image passed in `images`: `image "images/chart.png"`.
pub fn image_label(name: &str) -> String {
    format!("image {name:?}")
}

/// How errors name the `n`th (from 1) inline `data:` image of a page: `inline image 2 on page "plan"`.
pub fn inline_label(page: &str, n: usize) -> String {
    format!("inline image {n} on page {page:?}")
}

/// What the image bytes are, from their first bytes (not the name or the declared type).
/// `Err` is the message `publish_document` reports; `label` is from [`image_label`] or [`inline_label`].
pub fn sniff(label: &str, data: &[u8]) -> Result<ImageFormat, String> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        Ok(ImageFormat::Png)
    } else if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Ok(ImageFormat::Jpeg)
    } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        Ok(ImageFormat::Gif)
    } else if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        Ok(ImageFormat::WebP)
    } else if is_avif(data) {
        Ok(ImageFormat::Avif)
    } else if looks_like_svg(data) {
        Err(format!(
            "{label} is SVG, which isn't supported: images must be {FORMATS}"
        ))
    } else {
        Err(format!("{label} isn't {FORMATS}"))
    }
}

/// An ISO-BMFF `ftyp` box whose major or compatible brands include `avif` or `avis`.
fn is_avif(data: &[u8]) -> bool {
    if data.len() < 16 || &data[4..8] != b"ftyp" {
        return false;
    }
    let size = u32::from_be_bytes([data[0], data[1], data[2], data[3]]) as usize;
    let end = size.clamp(16, data.len().min(256));
    std::iter::once(&data[8..12])
        .chain(data[16..end].as_chunks::<4>().0.iter().map(|c| c.as_slice()))
        .any(|b| b == b"avif" || b == b"avis")
}

fn looks_like_svg(data: &[u8]) -> bool {
    let head = String::from_utf8_lossy(&data[..data.len().min(1024)]).to_ascii_lowercase();
    let t = head.trim_start_matches('\u{feff}').trim_start();
    t.starts_with('<') && (t.contains("<svg") || t.starts_with("<?xml"))
}

/// The error for image bytes that are in an accepted format but can't be decoded.
pub fn unreadable_error(label: &str, detail: &str) -> String {
    format!("{label} couldn't be read: {detail}")
}

/// The error for an image that is too big once converted to AVIF.
pub fn too_large_error(label: &str, avif_bytes: usize) -> String {
    format!(
        "{label} is {avif_bytes} bytes after conversion to AVIF, over the limit of {MAX_IMAGE_BYTES} bytes (500 KB): \
         downscale or crop it and publish again"
    )
}

/// The error for a version with more than [`MAX_IMAGES`] images.
pub fn too_many_error(count: usize) -> String {
    format!("a version can have at most {MAX_IMAGES} images, not {count}")
}

/// The error for a name listed twice in `images`.
pub fn duplicate_error(name: &str) -> String {
    format!("{} is given more than once", image_label(name))
}

/// Normalise an image name (`./images/chart.png` → `images/chart.png`). Names are paths
/// relative to the document; unlike page paths they keep their case and extension.
pub fn normalize_name(raw: &str) -> Result<String, String> {
    let bad = || {
        format!(
            "image name {raw:?} isn't a relative path like \"images/chart.png\" \
             (letters, digits, '.', '_' and '-', separated by '/')"
        )
    };
    let name = raw.strip_prefix("./").or_else(|| raw.strip_prefix('/')).unwrap_or(raw);
    if name.is_empty() || name.chars().count() > MAX_IMAGE_NAME_CHARS {
        return Err(bad());
    }
    for seg in name.split('/') {
        if seg.is_empty()
            || seg == "."
            || seg == ".."
            || !seg.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        {
            return Err(bad());
        }
    }
    Ok(name.to_string())
}

/// The image names an `<img src>` written in page `page_path` may refer to, in the order to
/// try them: relative to the page's folder (like a file next to it), then to the document root.
/// Empty for absolute URLs (`https:`, `data:`, `//host`) and fragments.
pub fn candidates(page_path: &str, src: &str) -> Vec<String> {
    if src.is_empty()
        || src.starts_with("//")
        || src.starts_with('#')
        || src.starts_with('?')
        || src.split('/').next().is_some_and(|s| s.contains(':'))
    {
        return Vec::new();
    }
    let src = src.split(['?', '#']).next().unwrap_or_default();
    let mut out = Vec::new();
    if !src.starts_with('/') {
        let mut parts: Vec<&str> = page_path.split('/').collect();
        parts.pop();
        let mut ok = true;
        for seg in src.split('/') {
            match seg {
                "" | "." => {}
                ".." => ok &= parts.pop().is_some(),
                s => parts.push(s),
            }
        }
        if ok && let Ok(n) = normalize_name(&parts.join("/")) {
            out.push(n);
        }
    }
    let root: Vec<&str> = src.split('/').filter(|s| !s.is_empty() && *s != ".").collect();
    if let Ok(n) = normalize_name(&root.join("/"))
        && !out.contains(&n)
    {
        out.push(n);
    }
    out
}

/// Decode an image's base64: the standard alphabet, padding optional, whitespace ignored.
pub fn decode_base64(label: &str, data: &str) -> Result<Vec<u8>, String> {
    let engine = GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    let clean: Vec<u8> = data.bytes().filter(|c| !c.is_ascii_whitespace()).collect();
    engine.decode(&clean).map_err(|_| format!("{label} isn't valid base64"))
}

/// An image pulled out of a page's `data:` URI.
#[derive(Debug, Clone, PartialEq)]
pub struct InlineImage {
    /// The name the URI was replaced with ([`inline_name`]).
    pub name: String,
    /// How errors name it ([`inline_label`]).
    pub label: String,
    pub data: Vec<u8>,
}

/// The name an inline image gets, `images/inline-<16 hex digits of the sha256 of its bytes>.avif`,
/// so the same image gets the same name.
pub fn inline_name(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let hex: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    format!("images/inline-{hex}.avif")
}

/// Replace every `data:image/<subtype>;base64,<payload>` URI in `source` with the name of
/// the image it holds ([`inline_name`]), except in the byte ranges in `skip` (code, which
/// shows text as written). Returns the new source and its images, each once.
/// `Err` is the message for invalid base64 (the format is checked by [`sniff`] later).
pub fn extract_inline(
    page: &str,
    source: &str,
    skip: &[std::ops::Range<usize>],
) -> Result<(String, Vec<InlineImage>), String> {
    const PREFIX: &str = "data:image/";
    let mut out = String::new();
    let mut images: Vec<InlineImage> = Vec::new();
    let (mut last, mut from, mut n) = (0, 0, 0);
    while let Some(i) = source[from..].find(PREFIX).map(|i| i + from) {
        from = i + PREFIX.len();
        if skip.iter().any(|r| r.contains(&i)) {
            continue;
        }
        let subtype_len = source[from..]
            .find(|c: char| !(c.is_ascii_alphanumeric() || "+.-".contains(c)))
            .unwrap_or(source.len() - from);
        let start = from + subtype_len + ";base64,".len();
        if subtype_len == 0 || !source[from + subtype_len..].starts_with(";base64,") {
            continue;
        }
        let end = source[start..]
            .find(|c: char| !(c.is_ascii_alphanumeric() || "+/=".contains(c)))
            .map_or(source.len(), |e| e + start);
        if end == start {
            continue;
        }
        n += 1;
        let label = inline_label(page, n);
        let data = decode_base64(&label, &source[start..end])?;
        let name = inline_name(&data);
        out.push_str(&source[last..i]);
        out.push_str(&name);
        last = end;
        from = end;
        if !images.iter().any(|im| im.name == name) {
            images.push(InlineImage { name, label, data });
        }
    }
    if n == 0 {
        return Ok((source.to_string(), images));
    }
    out.push_str(&source[last..]);
    Ok((out, images))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    #[test]
    fn sniffs_formats() {
        assert_eq!(sniff("a", PNG), Ok(ImageFormat::Png));
        assert_eq!(sniff("a", &[0xFF, 0xD8, 0xFF, 0xE0]), Ok(ImageFormat::Jpeg));
        assert_eq!(sniff("a", b"GIF89a...."), Ok(ImageFormat::Gif));
        assert_eq!(sniff("a", b"RIFF\0\0\0\0WEBPVP8 "), Ok(ImageFormat::WebP));
        assert_eq!(
            sniff("a", b"\0\0\0\x1cftypmif1\0\0\0\0mif1avifmiaf"),
            Ok(ImageFormat::Avif)
        );
        assert_eq!(sniff("a", b"\0\0\0\x18ftypavif\0\0\0\0avifmif1"), Ok(ImageFormat::Avif));
        let label = image_label("x.heic");
        assert_eq!(
            sniff(&label, b"\0\0\0\x18ftypheic\0\0\0\0heicmif1").unwrap_err(),
            "image \"x.heic\" isn't PNG, JPEG, WebP, GIF or AVIF"
        );
        assert_eq!(
            sniff(&image_label("chart.svg"), b"<?xml version=\"1.0\"?>\n<svg/>").unwrap_err(),
            "image \"chart.svg\" is SVG, which isn't supported: images must be PNG, JPEG, WebP, GIF or AVIF"
        );
        assert!(sniff("x", b"  <svg></svg>").unwrap_err().contains("is SVG"));
        assert!(
            sniff("x", b"")
                .unwrap_err()
                .ends_with("isn't PNG, JPEG, WebP, GIF or AVIF")
        );
    }

    #[test]
    fn names_and_candidates() {
        assert_eq!(normalize_name("./images/Chart.PNG").unwrap(), "images/Chart.PNG");
        assert_eq!(normalize_name("/a.png").unwrap(), "a.png");
        let long = "a".repeat(201);
        for bad in ["../x.png", "a b.png", "", "a//b.png", "a/./b", "./", &long] {
            assert!(normalize_name(bad).is_err(), "{bad}");
        }
        assert_eq!(
            normalize_name("a b").unwrap_err(),
            "image name \"a b\" isn't a relative path like \"images/chart.png\" (letters, digits, '.', '_' and '-', separated by '/')"
        );
        assert_eq!(candidates("index", "images/a.png"), vec!["images/a.png"]);
        assert_eq!(
            candidates("plan/phase-1", "images/a.png?x#y"),
            vec!["plan/images/a.png", "images/a.png"]
        );
        assert_eq!(candidates("plan/phase-1", "../images/a.png"), vec!["images/a.png"]);
        assert_eq!(candidates("plan/phase-1", "/images/a.png"), vec!["images/a.png"]);
        assert_eq!(candidates("index", "./a.png"), vec!["a.png"]);
        assert!(candidates("index", "https://x/a.png").is_empty());
        assert!(candidates("index", "data:image/png;base64,AA").is_empty());
        assert!(candidates("index", "//cdn/a.png").is_empty());
    }

    #[test]
    fn decodes_base64() {
        assert_eq!(decode_base64("a", "aGk=").unwrap(), b"hi");
        assert_eq!(decode_base64("a", "aG\nk").unwrap(), b"hi");
        assert_eq!(
            decode_base64("image \"a\"", "!!").unwrap_err(),
            "image \"a\" isn't valid base64"
        );
        assert!(decode_base64("a", "data:image/png;base64,aGk=").is_err());
    }

    #[test]
    fn extracts_inline_images() {
        use base64::engine::general_purpose::STANDARD;
        let b64 = STANDARD.encode(PNG);
        let src = format!(
            "![one](data:image/png;base64,{b64})\n\n<img src=\"data:image/png;base64,{b64}\">\n\n`data:image/png;base64,{b64}`\n"
        );
        let code = src.find('`').unwrap();
        let code = code..src.len();
        let (out, images) = extract_inline("p", &src, std::slice::from_ref(&code)).unwrap();
        let name = inline_name(PNG);
        assert_eq!(name.len(), "images/inline-.avif".len() + 16);
        assert_eq!(
            images,
            vec![InlineImage {
                name: name.clone(),
                label: "inline image 1 on page \"p\"".into(),
                data: PNG.to_vec()
            }]
        );
        assert_eq!(
            out,
            format!("![one]({name})\n\n<img src=\"{name}\">\n\n`data:image/png;base64,{b64}`\n")
        );
        // Not base64: left alone.
        let plain =
            "data:image/svg+xml,<svg/> and data:image/png;charset=x;base64,aGk= and data:text/plain;base64,aGk=";
        assert_eq!(extract_inline("p", plain, &[]).unwrap(), (plain.to_string(), vec![]));
        let (_, svg) = extract_inline("p", "![](data:image/svg+xml;base64,PHN2Zy8+)", &[]).unwrap();
        assert_eq!(svg[0].data, b"<svg/>");
        assert_eq!(
            extract_inline(
                "p",
                "![](data:image/png;base64,aGk) ![](data:image/png;base64,=a=)",
                &[]
            )
            .unwrap_err(),
            "inline image 2 on page \"p\" isn't valid base64"
        );
    }
}
