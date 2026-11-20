---
title: Mockups and the design editor
order: 3
---

# Mockups and the design editor

A page can be a mockup: an HTML document instead of Markdown. People don't read a mockup as a page. They open it in the **design editor**, where every mockup of the document is a frame on a canvas. There they look at the design at different widths, change it, comment on its elements and save what they changed as the document's next version.

It works the same on the Huntaway board and on a hosted docs site.

## For agents: publishing mockups

Publish a mockup as a page with `"format": "html"`, or a path ending in `.html`. A page whose content starts with `<!doctype html>` or `<html>` is taken as one too.

```json
{
  "title": "Sign-up flow: two options",
  "pages": [
    { "path": "index", "content": "# Sign-up flow\n\nTwo options for the first screen. Comment on either, or change them." },
    { "path": "screens/option-a.html", "content": "<!doctype html><html>…</html>" },
    { "path": "screens/option-b.html", "content": "<!doctype html><html>…</html>" }
  ],
  "images": [{ "name": "images/logo.png", "data": "<base64>" }]
}
```

Write each mockup as a complete, self-contained HTML document:

- **One page per screen, state or variant.** They sit side by side on the canvas, so two options, or the empty and the filled state of a form, are easy to compare.
- **CSS in a `<style>` element** (or `style=""` attributes). Stylesheets from other sites may not load.
- **No scripts.** A mockup's scripts never run, and `publish_document` warns when it has any. Show a menu's open state as its own page.
- **Define the design's colours, fonts and sizes as CSS custom properties** on `:root`. The editor lists them, so the reader can try another accent colour or corner radius and see everything that uses it follow.
- **Images** come from the publish's `images`, by name, as on other pages (`<img src="../images/logo.png">` or `url(../images/logo.png)`, resolved against the page's folder, then the document's root). `data:` images are taken out and stored the same way.
- **The title** is the page's `title`, else its `<title>`, else its path.

A mockup is laid out at the frame's width, so media queries and viewport units behave as they would in a window that wide.

What comes back:

- `get_feedback` returns comments on a mockup with `element`, a CSS selector for the element in the page's HTML, and `quote`, its tag and text.
- When someone saves their changes, that is a new version. Changed styles are in the elements' `style` attributes, and a changed custom property is in the `<style>` element that defines it. Read the page (`read_page`) before publishing over it.

## For people: the design editor

Open a mockup from the document's menu. Its other mockups are on the same canvas.

| To | Do this |
|----|---------|
| Move around | Scroll, or hold Space and drag. **Hand** (H) drags with a plain click. |
| Zoom | Ctrl + scroll or pinch; `+` and `-`; `0` for 100%, `1` to see every mockup, `2` for the one you're on. |
| See another width | Choose Desktop, Laptop, Tablet or Phone for the mockup you're on. |
| Inspect an element | **Select** (V) and click it, or choose it under **Layers**. Esc selects the element around it. |
| Change it | Use the **Design** tab: text, link, layout, size, padding, margin, type, colours, border and shadow. A changed property is marked, and × takes the change out. Any other CSS property can be set under **Style attribute**. |
| Edit text in place | Double-click it (or select it and press Enter). Enter or Esc finishes. |
| Copy, move or remove an element | **Duplicate** (Ctrl+D), **←** and **→**, **Delete**. |
| Tune the design's variables | The **Tokens** tab lists the CSS custom properties the mockup defines. |
| Edit the HTML | The **Code** tab. The frame follows as you type. |
| Use the page | **Interact** (I): hover, scroll and type in the mockup. Its links and forms go nowhere. |
| Comment on an element | **Comment** (C) and click it. On the board, **Send** in the Comments tab passes the comments to the task. |
| Undo and redo | Ctrl+Z and Ctrl+Shift+Z. |
| Save | **Save…** (Ctrl+S) publishes the changed mockups as the next version. The document's other pages stay as they are. |

Changes that aren't saved are kept as a draft and come back when the page is opened again. **Discard** puts every mockup back as it was published.

A mockup whose layout fills the window's height (`100vh`) keeps the device's height and scrolls inside its frame. Other mockups are as tall as their content.

**Document details…** opens the document's own page, with its labels, versions and the rest. **Edit as text…** opens the document editor, where a mockup is a page like the others.

Who can do what follows the document: anyone who can read it can look and try changes; the people it is shared with can comment; its owner, or its organization's members, can save. Only the latest version can be saved over.
