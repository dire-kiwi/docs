//! Converting uploaded images to AVIF: decoded with `image`, encoded with `ravif` (rav1e).
//! Both are pure Rust.
//!
//! PNG, JPEG, WebP and GIF (first frame) are decoded, turned upright by their EXIF
//! orientation and re-encoded, which drops their metadata. AVIF is passed through once
//! its container checks out: there is no pure-Rust AV1 decoder to re-encode it with.
//! The uploaded bytes are dropped as soon as each image is converted.

use std::io::Cursor;

use image::{DynamicImage, ImageDecoder, ImageReader, Limits};
use ravif::{Img, RGB8, RGBA8};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;

use docs_render::images::{self, ImageFormat};
use docs_render::publish::ImageUpload;

/// AVIF quality, 1–100: high enough that screenshots and charts stay crisp.
pub const AVIF_QUALITY: f32 = 70.0;
/// rav1e speed, 1 (slowest, smallest) – 10 (fastest): a server-friendly middle.
pub const AVIF_SPEED: u8 = 6;
/// Images wider or taller than this aren't decoded (they'd never fit in 500 KB anyway).
pub const MAX_DIMENSION: u32 = 8192;
/// Memory the decoder may use for one image.
pub const MAX_DECODE_BYTES: u64 = 512 * 1024 * 1024;
/// Publishes converting images at the same time; each encode already uses every core.
const CONCURRENT_CONVERSIONS: usize = 2;

static CONVERSIONS: Semaphore = Semaphore::const_new(CONCURRENT_CONVERSIONS);

/// An image converted to AVIF, ready to store.
pub struct Converted {
    pub name: String,
    pub sha256: String,
    pub avif: Vec<u8>,
}

/// Convert every upload on a blocking thread, checking each against [`images::MAX_IMAGE_BYTES`].
/// `Err` is the message `publish_document` reports.
pub async fn convert_all(uploads: Vec<ImageUpload>) -> Result<Vec<Converted>, String> {
    if uploads.is_empty() {
        return Ok(Vec::new());
    }
    let _permit = CONVERSIONS.acquire().await.map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || uploads.into_iter().map(convert).collect())
        .await
        .map_err(|e| format!("image conversion failed: {e}"))?
}

/// Convert one upload (consuming, so the original is dropped here).
pub fn convert(upload: ImageUpload) -> Result<Converted, String> {
    let ImageUpload {
        name,
        label,
        format,
        data,
    } = upload;
    let avif = match format {
        ImageFormat::Avif => {
            avif_parse::read_avif(&mut data.as_slice())
                .map_err(|e| images::unreadable_error(&label, &format!("not a valid AVIF file ({e})")))?;
            data
        }
        _ => {
            let img = decode(&label, format, &data)?;
            drop(data);
            encode(&label, img)?
        }
    };
    if avif.len() > images::MAX_IMAGE_BYTES {
        return Err(images::too_large_error(&label, avif.len()));
    }
    Ok(Converted {
        name,
        sha256: Sha256::digest(&avif).iter().map(|b| format!("{b:02x}")).collect(),
        avif,
    })
}

fn decode(label: &str, format: ImageFormat, data: &[u8]) -> Result<DynamicImage, String> {
    let unreadable = |e: &dyn std::fmt::Display| images::unreadable_error(label, &e.to_string());
    let mut reader = ImageReader::new(Cursor::new(data));
    reader.set_format(match format {
        ImageFormat::Png => image::ImageFormat::Png,
        ImageFormat::Jpeg => image::ImageFormat::Jpeg,
        ImageFormat::WebP => image::ImageFormat::WebP,
        ImageFormat::Gif => image::ImageFormat::Gif,
        ImageFormat::Avif => unreachable!("AVIF is passed through"),
    });
    let mut limits = Limits::default();
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|e| unreadable(&e))?;
    let (w, h) = decoder.dimensions();
    if w > MAX_DIMENSION || h > MAX_DIMENSION {
        return Err(images::unreadable_error(
            label,
            &format!("it is {w}×{h} pixels, and images can be at most {MAX_DIMENSION} pixels on a side"),
        ));
    }
    let orientation = decoder.orientation().map_err(|e| unreadable(&e))?;
    let mut img = DynamicImage::from_decoder(decoder).map_err(|e| unreadable(&e))?;
    img.apply_orientation(orientation);
    Ok(img)
}

fn encode(label: &str, img: DynamicImage) -> Result<Vec<u8>, String> {
    let encoder = ravif::Encoder::new()
        .with_quality(AVIF_QUALITY)
        .with_alpha_quality(AVIF_QUALITY)
        .with_speed(AVIF_SPEED);
    let (w, h) = (img.width() as usize, img.height() as usize);
    let result = if img.color().has_alpha() {
        let px: Vec<RGBA8> = img.to_rgba8().pixels().map(|p| RGBA8::from(p.0)).collect();
        drop(img);
        encoder.encode_rgba(Img::new(&px[..], w, h))
    } else {
        let px: Vec<RGB8> = img.to_rgb8().pixels().map(|p| RGB8::from(p.0)).collect();
        drop(img);
        encoder.encode_rgb(Img::new(&px[..], w, h))
    };
    result
        .map(|e| e.avif_file)
        .map_err(|e| images::unreadable_error(label, &format!("converting it to AVIF failed: {e}")))
}
