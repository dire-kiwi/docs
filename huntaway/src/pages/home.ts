import type { PluginProfile } from "@huntaway/plugin"
import type { Doc } from "../repo.ts"
import type { LabelNode, LabelTree } from "../rules.ts"
import type { Publisher } from "../docs.ts"
import type { SiteStatus } from "../hosted.ts"
import { siteName } from "../hosted.ts"
import { at, html, raw, time } from "./html.ts"
import type { Raw } from "./html.ts"
import { docPath } from "../rules.ts"

// A profile's documents: a tree of folders (each document once, however many pages it has), or of labels (a document
// under each of its labels, and an Unlabelled group), with the profile's connection to a hosted docs site above.

export interface HomeData {
  readonly profile: PluginProfile
  readonly profiles: ReadonlyArray<PluginProfile>
  readonly view: "folders" | "labels"
  /** In the labels view: only the documents with this label or one under it. */
  readonly label: string | null
  readonly docs: ReadonlyArray<Doc & { readonly task: Publisher | null }>
  readonly labels: LabelTree
  readonly site: SiteStatus
}

const docRow = (profile: string, d: HomeData["docs"][number]) => html`<li class="doc-row">
  <a class="title" href="${at(docPath(profile, d.slug, null))}">${d.title}</a>
  <span class="muted small">v${d.latest_version} · ${d.page_count === 1 ? "1 page" : `${d.page_count} pages`} · ${time(d.updated_at)}</span>
  ${d.task === null ? "" : html`<a class="small" href="/t/${encodeURIComponent(d.task.id)}">${d.task.key}</a>`}
  ${d.labels.map((l) => html`<a class="chip" href="${at(`${encodeURIComponent(profile)}/labels/${l.split("/").map(encodeURIComponent).join("/")}`)}">${l}</a>`)}
</li>`

interface Folder {
  readonly name: string
  readonly path: string
  readonly folders: Map<string, Folder>
  readonly docs: Array<HomeData["docs"][number]>
}

const folderTree = (docs: HomeData["docs"]): Folder => {
  const root: Folder = { name: "", path: "", folders: new Map(), docs: [] }
  for (const d of docs) {
    let f = root
    for (const seg of d.folder === "" ? [] : d.folder.split("/")) {
      let next = f.folders.get(seg)
      if (next === undefined) {
        next = { name: seg, path: f.path === "" ? seg : `${f.path}/${seg}`, folders: new Map(), docs: [] }
        f.folders.set(seg, next)
      }
      f = next
    }
    f.docs.push(d)
  }
  return root
}

const byName = (a: Folder, b: Folder) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true })
const count = (f: Folder): number => f.docs.length + [...f.folders.values()].reduce((n, c) => n + count(c), 0)

const folderList = (profile: string, f: Folder, top: boolean): Raw => html`<ul class="tree${top ? " top" : ""}">
  ${[...f.folders.values()].toSorted(byName).map(
    (c) => html`<li><details open><summary><span class="folder-name">${c.name}</span> <span class="muted small">${count(c)}</span>
      <button type="button" class="link small" data-toggle="rename-${c.path}">Rename</button></summary>
      <form class="inline" data-call="folder.rename" data-payload='${raw(attrJson({ profile, from: c.path }))}' id="rename-${c.path}" hidden>
        <input name="to" value="${c.path}" size="30" aria-label="New folder path"> <button class="primary">Rename</button>
        <span class="muted small">A path like docs/plans, or nothing for the top level</span><p class="error"></p>
      </form>
      ${folderList(profile, c, false)}</details></li>`,
  )}
  ${f.docs.map((d) => docRow(profile, d))}
</ul>`

/** JSON for a single-quoted attribute. */
export const attrJson = (v: unknown) => JSON.stringify(v).replaceAll("&", "&amp;").replaceAll("'", "&#39;").replaceAll("<", "&lt;")

const labelList = (profile: string, nodes: ReadonlyArray<LabelNode>, docs: HomeData["docs"], top: boolean): Raw => html`<ul class="tree${top ? " top" : ""}">
  ${nodes.map((n) => {
    const own = docs.filter((d) => d.labels.some((l) => l.toLowerCase() === n.path.toLowerCase()))
    return html`<li><details open><summary><a class="folder-name" href="${at(`${encodeURIComponent(profile)}/labels/${n.path.split("/").map(encodeURIComponent).join("/")}`)}">${n.name}</a>
      <span class="muted small">${n.documents}</span></summary>${labelList(profile, n.children, docs, false)}
      <ul class="tree">${own.map((d) => docRow(profile, d))}</ul></details></li>`
  })}
</ul>`

/** The labels under `path` (case aside), as the tree has them. */
const subtree = (nodes: ReadonlyArray<LabelNode>, path: string): ReadonlyArray<LabelNode> => {
  for (const n of nodes) {
    if (n.path.toLowerCase() === path.toLowerCase()) return [n]
    const inner = subtree(n.children, path)
    if (inner.length > 0) return inner
  }
  return []
}

export const sitePanel = (profile: string, s: SiteStatus): Raw => {
  const name = siteName(s.site_url)
  if (s.connected) {
    return html`<div class="panel row"><span>Publishing to <a href="${s.site_url}">${name}</a>${s.login === null ? "" : html` as <b>${s.login}</b>`}
      <span class="muted small">(${s.kind === "token" ? "access token" : "signed in"} ${time(s.connected_at)})</span></span><span class="grow"></span>
      <form class="inline" data-call="site.disconnect" data-payload='${raw(attrJson({ profile }))}'><button>Disconnect</button><p class="error"></p></form></div>`
  }
  const p = s.pending
  if (p !== null) {
    return html`<div class="panel">
      ${
        p.error === null
          ? html`<p>Open <a href="${p.verification_uri_complete ?? p.verification_uri}">${p.verification_uri_complete ?? p.verification_uri}</a>,
            sign in to ${siteName(p.site_url)}, check that it shows this code, and choose <b>Allow</b>:</p>
            <p class="code">${p.user_code}</p><p class="muted small">The code expires at ${time(p.expires_at)}. This page changes once you've allowed it.</p>`
          : html`<p class="error">${p.error}</p>`
      }
      <form class="inline" data-call="site.cancel" data-payload='${raw(attrJson({ profile }))}'><button>${p.error === null ? "Cancel" : "Close"}</button><p class="error"></p></form>
    </div>`
  }
  return html`<details class="panel"><summary>Connect to hosted docs, to publish documents there to share and collect comments</summary>
    <form data-call="site.start" data-payload='${raw(attrJson({ profile }))}' style="margin-top:10px">
      <div class="row"><label>Site <input name="site" value="${s.site_url}" size="34"></label> <button class="primary">Sign in</button></div><p class="error"></p>
    </form>
    <form data-call="site.token" data-payload='${raw(attrJson({ profile }))}' style="margin-top:8px">
      <div class="row"><span class="muted small">Or paste a personal access token from the site's <b>Access</b> page:</span>
      <input name="site" type="hidden" value="${s.site_url}"><input name="token" type="password" size="30" aria-label="Access token" autocomplete="off"> <button>Connect</button></div><p class="error"></p>
    </form></details>`
}

export const homePage = (d: HomeData): Raw => {
  const p = encodeURIComponent(d.profile.id)
  const shown = d.label === null ? d.docs : d.docs.filter((x) => x.labels.some((l) => l.toLowerCase() === d.label?.toLowerCase() || l.toLowerCase().startsWith(`${d.label?.toLowerCase()}/`)))
  const unlabelled = d.docs.filter((x) => x.labels.length === 0)
  return html`<div class="wrap">
  <div class="bar"><h1>Docs</h1>
    ${d.profiles.length > 1 ? html`<span class="tabs">${d.profiles.map((x) => html`<a class="${x.id === d.profile.id ? "on" : ""}" href="${at(encodeURIComponent(x.id))}">${x.name}</a>`)}</span>` : html`<span class="muted">${d.profile.name}</span>`}
    <span class="grow"></span>
    <span class="tabs"><a class="${d.view === "folders" ? "on" : ""}" href="${at(p)}">Folders</a><a class="${d.view === "labels" ? "on" : ""}" href="${at(`${p}/labels`)}">Labels</a></span>
    <a class="new-doc" href="${at(`${p}/new`)}">New document</a>
  </div>
  ${sitePanel(d.profile.id, d.site)}
  ${
    d.docs.length === 0
      ? html`<p class="muted">No documents yet. Agents publish them with the <code>docs</code> MCP server's <code>publish_document</code>.</p>`
      : d.view === "folders"
        ? folderList(d.profile.id, folderTree(d.docs), true)
        : d.label !== null
          ? html`<p class="row"><a href="${at(`${p}/labels`)}">All labels</a> <span class="muted">›</span> <b>${d.label}</b> <span class="muted small">${shown.length}</span></p>
              ${labelList(d.profile.id, subtree(d.labels.labels, d.label), shown, true)}`
          : html`${labelList(d.profile.id, d.labels.labels, d.docs, true)}
              ${unlabelled.length === 0 ? "" : html`<ul class="tree top"><li><details open><summary><span class="folder-name">Unlabelled</span> <span class="muted small">${unlabelled.length}</span></summary>
                <ul class="tree">${unlabelled.map((x) => docRow(d.profile.id, x))}</ul></details></li></ul>`}`
  }
</div>`
}
