import type { PluginProfile } from "@huntaway/plugin"
import type { SiteStatus } from "../hosted.ts"
import { siteName } from "../hosted.ts"
import { docPath } from "../rules.ts"
import { at, html, time } from "./html.ts"
import type { Raw } from "./html.ts"

// The task panel (the documents a task published, on its page) and the plugin's section of Settings.

export const taskPanel = (profile: string, docs: ReadonlyArray<{ readonly slug: string; readonly title: string; readonly number: number; readonly created_at: string }>): Raw => html`<div class="wrap" style="padding:10px 12px">
  <h2>Documents</h2>
  <ul class="tree top">${docs.map(
    (d) => html`<li class="doc-row"><a class="title" href="${at(docPath(profile, d.slug, null))}">${d.title}</a>
      <span class="muted small">v${d.number} · ${time(d.created_at)}</span></li>`,
  )}</ul>
</div>`

export const settingsPanel = (rows: ReadonlyArray<{ readonly profile: PluginProfile; readonly documents: number; readonly site: SiteStatus }>): Raw => html`<div class="wrap" style="padding:10px 12px">
  <p class="muted">Documents agents publish with the <code>docs</code> MCP server, kept in the plugin's own database on this host.</p>
  <ul class="tree top">${rows.map(
    (r) => html`<li class="doc-row"><a class="title" href="${at(encodeURIComponent(r.profile.id))}">${r.profile.name}</a>
      <span class="muted small">${r.documents === 1 ? "1 document" : `${r.documents} documents`} ·
      ${r.site.connected ? html`publishing to ${siteName(r.site.site_url)}${r.site.login === null ? "" : ` as ${r.site.login}`}` : "not connected to a hosted docs site"}</span></li>`,
  )}</ul>
</div>`
