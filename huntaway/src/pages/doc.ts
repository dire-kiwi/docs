import type { NavNode } from "@dire-kiwi/docs-render"
import type { Comment, Doc, VersionRow } from "../repo.ts"
import type { Publisher, RenderedPage } from "../docs.ts"
import type { SiteStatus } from "../hosted.ts"
import { siteName } from "../hosted.ts"
import type { Published } from "../siteRepo.ts"
import { docPath } from "../rules.ts"
import { at, html, raw, time } from "./html.ts"
import type { Raw } from "./html.ts"
import { attrJson } from "./home.ts"

// A document's page: its menu, the page rendered, the versions, what can be done with it (labels, move, publish to the
// hosted site, delete), and its comments beside the text (the hosted site's reader, DOC-14: select text and comment in
// the popup, saved when you click away; the comments as bubbles beside their quotes). Comments are on the version shown.

export interface DocData {
  readonly doc: Doc
  readonly number: number | null
  readonly version: VersionRow
  readonly versions: ReadonlyArray<VersionRow & { readonly task: Publisher | null }>
  readonly nav: ReadonlyArray<NavNode>
  readonly page: RenderedPage
  readonly comments: ReadonlyArray<Comment>
  readonly commentsTask: Publisher | null
  readonly published: Published | null
  readonly site: SiteStatus
  readonly urlSuffix: (path: string) => string
}

const navList = (d: DocData, nodes: ReadonlyArray<NavNode>): Raw => html`<ul>
  ${nodes.map(
    (n) => html`<li>${
      n.page === null
        ? html`<span class="folder">${n.title}</span>`
        : html`<a class="${n.page === d.page.path ? "on" : ""}" href="${at(docPath(d.doc.profile_id, d.doc.slug, d.number) + d.urlSuffix(n.page))}">${n.title}</a>`
    }${n.children.length > 0 ? navList(d, n.children) : ""}</li>`,
  )}
</ul>`

const bubble = (c: Comment) => html`<div class="comment-bubble${c.comment === "" ? " quote-only" : ""}" data-id="${c.id}" data-quote="${c.quote}" data-prefix="${c.prefix}" data-suffix="${c.suffix}">
  <blockquote>${c.quote}</blockquote><p>${c.comment}</p>
  <footer>${time(c.created_at)}${c.sent_at === null ? "" : html` · <span class="sent" title="Sent ${c.sent_at}">sent</span>`}<span class="grow"></span>
    <button type="button" class="link edit-comment">Edit</button><button type="button" class="link delete-comment">Delete</button></footer>
</div>`

export const docPage = (d: DocData): Raw => {
  const { doc } = d
  const profile = doc.profile_id
  const home = at(encodeURIComponent(profile))
  const latest = doc.latest_version
  const shownLatest = d.version.number === latest
  const here = { profile, slug: doc.slug }
  const site = siteName(d.site.site_url)
  const folderLink = doc.folder === "" ? html`<span class="muted">Top level</span>` : html`<span class="muted">${doc.folder}</span>`
  const pageUrl = (n: number | null) => at(docPath(profile, doc.slug, n) + d.urlSuffix(d.page.path))
  return html`<div class="doc">
  <nav class="doc-nav"><p><a href="${home}">‹ All documents</a></p>${navList(d, d.nav)}</nav>
  <main class="doc-main">
    <div class="doc-head"><h1>${doc.title}</h1>
      <details class="versions"><summary class="chip">Version ${d.version.number}${shownLatest ? " (latest)" : ""} ▾</summary><ol>
        ${d.versions.map(
          (v) => html`<li><a class="${v.number === d.version.number ? "on" : ""}" href="${pageUrl(v.number === latest ? null : v.number)}">v${v.number}${v.message === null ? "" : ` · ${v.message}`}
            <span class="muted small"> · ${time(v.created_at)}${v.task === null ? "" : ` · ${v.task.key}`}</span></a></li>`,
        )}</ol></details>
    </div>
    <div class="doc-meta">
      ${folderLink}
      ${doc.labels.map((l) => html`<a class="chip" href="${at(`${encodeURIComponent(profile)}/labels/${l.split("/").map(encodeURIComponent).join("/")}`)}">${l}</a>`)}
      ${d.versions[0]?.task == null ? "" : html`<span class="muted">by <a href="/t/${encodeURIComponent(d.versions[0]?.task?.id ?? "")}">${d.versions[0]?.task?.key}</a></span>`}
      <span class="grow"></span>
      <button type="button" class="link" data-toggle="labels-form">Labels</button>
      <button type="button" class="link" data-toggle="move-form">Move</button>
      ${d.site.connected ? html`<button type="button" class="link" data-toggle="publish-form">Publish to ${site}</button>` : ""}
      ${d.published === null ? "" : html`<a href="${d.published.url}">On ${siteName(d.published.site_url)} (v${d.published.remote_version}, from v${d.published.local_version})</a>`}
      <button type="button" class="link danger" data-toggle="delete-form">Delete</button>
    </div>
    <form class="panel" id="labels-form" data-call="doc.labels" data-payload='${raw(attrJson(here))}' hidden>
      <div class="row"><input name="labels" value="${doc.labels.join(", ")}" size="50" aria-label="Labels"> <button class="primary">Save</button></div>
      <p class="muted small">Comma-separated; nest with / (research/ai). Labels belong to the document, not a version.</p><p class="error"></p>
    </form>
    <form class="panel" id="move-form" data-call="doc.move" data-payload='${raw(attrJson(here))}' hidden>
      <div class="row"><input name="folder" value="${doc.folder}" size="40" aria-label="Folder"> <button class="primary">Move</button></div>
      <p class="muted small">A folder like docs/plans, or nothing for the top level. Its URL stays the same.</p><p class="error"></p>
    </form>
    ${
      d.site.connected
        ? html`<form class="panel" id="publish-form" data-call="site.publish" data-payload='${raw(attrJson({ ...here, version: d.version.number }))}' hidden>
            <p>Publish version ${d.version.number}, with all its pages, to <a href="${d.site.site_url}">${site}</a>${d.site.login === null ? "" : ` as ${d.site.login}`}.</p>
            <div class="row"><label>Slug there <input name="remote_slug" value="${d.published?.remote_slug ?? doc.slug}" size="30"></label>
              <button class="primary">Publish</button></div>
            <p class="publish-result small"></p><p class="error"></p>
          </form>`
        : ""
    }
    <form class="panel" id="delete-form" data-call="doc.delete" data-payload='${raw(attrJson(here))}' data-then="${home}" hidden>
      <div class="row">Delete “${doc.title}” with all its versions and comments? <button class="danger">Delete it</button></div><p class="error"></p>
    </form>
    ${shownLatest ? "" : html`<p class="notice">This is version ${d.version.number}. <a href="${pageUrl(null)}">Read the latest (v${latest})</a>.</p>`}
    <div class="send-bar" id="send-bar"></div>
    ${d.page.warnings.length === 0 ? "" : html`<p class="notice">${d.page.warnings.join(" · ")}</p>`}
    <div class="doc-body">
      <div class="docs-render">${
        d.page.html === null
          ? html`<p class="error">This page can't be shown: ${d.page.error ?? "it doesn't render"}.</p>`
          : html`${d.page.has_h1 ? "" : html`<h1 class="page-title">${d.page.title}</h1>`}<article class="doc-content" data-version="${d.version.number}" data-page="${d.page.path}">${raw(d.page.html)}</article>`
      }</div>
      <aside class="comment-rail" id="comments">${d.comments.filter((c) => c.version === d.version.number && c.page === d.page.path).map(bubble)}</aside>
    </div>
  </main>
</div>`
}
