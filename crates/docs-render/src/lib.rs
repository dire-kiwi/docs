//! The docs renderer: Markdown/MDX → sanitized HTML, page paths and the
//! navigation tree, the MDX component catalogue, and the MCP tool definitions.
//!
//! It has no server dependencies, so it also builds to WebAssembly
//! (`crates/docs-render-wasm`, published as `@dire-kiwi/docs-render`).

pub mod components;
pub mod paths;
pub mod publish;
pub mod render;
pub mod tools;
