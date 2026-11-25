// The pages' own styles, over the board's theme (`--color-*`, `--font-*` on the frame's :root); the rendered page's are
// the renderer's (`@dire-kiwi/docs-render/styles.css`), its variables set from the board's.

export const READER_VARS = `.docs-render.docs-render,.editor,.dz{
  --bg:var(--color-bg,#0b0b0e);--bg-soft:var(--color-panel-2,#16161d);--fg:var(--color-fg,#e6e6ec);
  --fg-muted:var(--color-muted,#9a9aab);--border:var(--color-line-strong,#33333f);--accent:var(--color-accent,#7c7cf8);
  --accent-fg:#fff;--bg-mark:color-mix(in srgb,var(--accent) 30%,transparent);--success:var(--color-st-done,#34d399);
  --warning:var(--color-st-attention,#f59e0b);--danger:#fca5a5;--font:var(--font-sans,ui-sans-serif,system-ui,sans-serif);
  --mono:var(--font-mono,ui-monospace,monospace);background:transparent;
  /* The reader's print look, in the board's colours: its lines for the ink line, a faint offset shadow, the board's own
     sans for headings, and code on a panel. The board's theme is light or dark, not the reader's system. */
  color-scheme:inherit;--line:var(--color-line-strong,#33333f);--shadow:color-mix(in srgb,var(--fg) 14%,transparent);
  --mark-fg:var(--fg);--code-bg:var(--color-panel-2,#16161d);--code-fg:var(--fg);--font-display:var(--font)}`

export const STYLES = `
*{box-sizing:border-box}
body{margin:0;background:var(--color-bg,#0b0b0e);color:var(--color-fg,#e6e6ec);font:14px/1.5 var(--font-sans,ui-sans-serif,system-ui,sans-serif)}
a{color:var(--color-accent,#7c7cf8);text-decoration:none} a:hover{text-decoration:underline}
h1{font-size:20px;margin:0} h2{font-size:15px;margin:0 0 8px}
button,input,textarea,select{font:inherit;color:inherit}
button{cursor:pointer;border:1px solid var(--color-line-strong,#33333f);background:var(--color-panel-2,#16161d);border-radius:6px;padding:4px 10px}
button:hover{border-color:var(--color-accent,#7c7cf8)} button:disabled{opacity:.5;cursor:default}
button.primary{background:var(--color-accent,#7c7cf8);border-color:var(--color-accent,#7c7cf8);color:#fff}
button.danger{color:#fca5a5} button.link{border:0;background:none;padding:0;color:var(--color-accent,#7c7cf8)}
input,textarea{background:var(--color-bg,#0b0b0e);border:1px solid var(--color-line-strong,#33333f);border-radius:6px;padding:4px 8px}
input:focus,textarea:focus{outline:none;border-color:var(--color-accent,#7c7cf8)}
.muted{color:var(--color-muted,#9a9aab)} .small{font-size:12px}
.error{color:#fca5a5;margin:4px 0 0} .error:empty{display:none}
.wrap{padding:20px 24px;max-width:1100px}
.bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:0 0 16px}
.grow{flex:1}
.tabs{display:flex;gap:4px} .tabs a{padding:3px 10px;border-radius:6px;color:var(--color-muted,#9a9aab)}
.tabs a.on{background:var(--color-panel-2,#16161d);color:var(--color-fg,#e6e6ec)}
.panel{border:1px solid var(--color-line-strong,#33333f);border-radius:8px;padding:12px 14px;margin:0 0 16px;background:var(--color-panel-2,#16161d)}
.row{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
form.inline{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap}
.chip{display:inline-block;font-size:11.5px;padding:0 7px;border-radius:999px;border:1px solid var(--color-line-strong,#33333f);color:var(--color-muted,#9a9aab)}
a.chip:hover{text-decoration:none;border-color:var(--color-accent,#7c7cf8)}
.code{font:600 20px var(--font-mono,ui-monospace,monospace);letter-spacing:2px}
ul.tree{list-style:none;margin:0;padding:0 0 0 14px} ul.tree.top{padding:0}
.tree details>summary{cursor:pointer;padding:3px 0;list-style:none} .tree details>summary::before{content:"▸ ";color:var(--color-muted,#9a9aab)}
.tree details[open]>summary::before{content:"▾ "}
.doc-row{padding:4px 0;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.doc-row .title{font-weight:500}
.folder-name{font-weight:500}
[hidden]{display:none!important}
a.new-doc{padding:3px 10px;border-radius:6px;background:var(--color-accent,#7c7cf8);color:#fff} a.new-doc:hover{text-decoration:none}
/* A document */
.doc{display:grid;grid-template-columns:220px minmax(0,1fr);gap:0;min-height:100vh}
.doc-nav{border-right:1px solid var(--color-line-strong,#33333f);padding:16px 14px;font-size:13.5px}
.doc-nav ul{list-style:none;margin:0;padding:0 0 0 12px} .doc-nav>ul{padding:0}
.doc-nav li{margin:2px 0} .doc-nav a.on{color:var(--color-fg,#e6e6ec);font-weight:600}
.doc-nav .folder{color:var(--color-muted,#9a9aab)}
.doc-main{padding:16px 24px 80px;min-width:0}
.doc-head{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;margin:0 0 6px}
.doc-meta{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;margin:0 0 14px;font-size:12.5px}
.versions{position:relative} .versions>summary{cursor:pointer;list-style:none}
.versions ol{position:absolute;z-index:5;margin:4px 0 0;padding:6px 0;list-style:none;min-width:280px;max-height:320px;overflow:auto;
  background:var(--color-panel-2,#16161d);border:1px solid var(--color-line-strong,#33333f);border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.35)}
.versions li a{display:block;padding:4px 12px;color:var(--color-fg,#e6e6ec)} .versions li a:hover{background:var(--color-bg,#0b0b0e);text-decoration:none}
.versions li a.on{font-weight:600}
.notice{border:1px solid var(--color-st-attention,#f59e0b);border-radius:8px;padding:6px 12px;margin:0 0 12px;font-size:13px}
.doc-body{display:grid;grid-template-columns:minmax(0,860px);gap:24px}
.doc-body.has-comments{grid-template-columns:minmax(0,860px) 260px}
.comment-rail{position:relative}
.doc-body:not(.has-comments) .comment-rail{display:none}
.comment-bubble{position:absolute;left:0;right:0;border:1px solid var(--color-line-strong,#33333f);border-radius:8px;padding:8px 10px;
  background:var(--color-panel-2,#16161d);font-size:13px;transition:top .15s}
.comment-bubble.active{border-color:var(--color-st-attention,#f59e0b)}
.comment-bubble p{margin:0 0 6px;white-space:pre-wrap;overflow-wrap:anywhere}
.comment-bubble blockquote{display:none;margin:0 0 6px;padding-left:8px;border-left:2px solid var(--color-line-strong,#33333f);color:var(--color-muted,#9a9aab);
  max-height:4.5em;overflow:hidden}
.comment-bubble.quote-only blockquote,.comment-bubble.orphaned blockquote{display:block}
.comment-bubble.orphaned{opacity:.75}
.comment-bubble footer{display:flex;gap:8px;align-items:center;font-size:11.5px;color:var(--color-muted,#9a9aab)}
.comment-bubble textarea{width:100%;min-height:4em;margin:0 0 4px}
.comment-bubble .sent{color:var(--color-st-done,#34d399)}
.send-bar{display:flex;gap:10px;align-items:center;margin:0 0 12px;font-size:13px}
.comment-popup{position:absolute;z-index:20;width:300px}
.comment-start{box-shadow:0 4px 14px rgba(0,0,0,.35)}
.comment-editor{background:var(--color-panel-2,#16161d);border:1px solid var(--color-line-strong,#33333f);border-radius:8px;padding:8px;box-shadow:0 6px 20px rgba(0,0,0,.35)}
.comment-editor textarea{width:100%;resize:vertical}
.comment-hint{margin:4px 0 0;font-size:11.5px;color:var(--color-muted,#9a9aab)}
::highlight(doc-comment){background-color:color-mix(in srgb,#f59e0b 28%,transparent)}
::highlight(doc-comment-active),::highlight(doc-comment-draft){background-color:color-mix(in srgb,#f59e0b 55%,transparent)}
@media (max-width:900px){
  .doc{grid-template-columns:1fr} .doc-nav{border-right:0;border-bottom:1px solid var(--color-line-strong,#33333f)}
  .doc-body.has-comments{grid-template-columns:minmax(0,1fr)}
  .comment-bubble{position:static;margin:0 0 8px}
}
`
