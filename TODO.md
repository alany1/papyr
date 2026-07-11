# Papyr — TODOs

## Chrome extension: add papers from the browser

A browser extension that sends the current page (or a right-clicked link) straight into
the Papyr vault — no drag-and-drop needed.

- **UX**: toolbar button ("Add to Papyr") on any PDF/arXiv page, plus a context-menu item
  for links; optional collection picker in the popup.
- **Transport**: the app already has the whole import pipeline (`src/main/importer.js` —
  arXiv normalization, title lookup, dedup naming). The extension just needs to deliver a
  URL to the running app. Options:
  - Local HTTP endpoint in the main process (e.g. `127.0.0.1:44100/import?url=…`),
    loopback-only, with a shared token in config to keep other local apps out.
  - Custom protocol handler (`papyr-import://…` via `app.setAsDefaultProtocolClient`) —
    works even when the app is closed (launches it), no port squatting, but a browser
    permission prompt on each use unless "always allow" is checked.
- **Reuse**: extension calls the same code path as drops, so imported papers get
  auto-selected and appear in the sidebar via the existing watcher.
- **Nice-to-haves**: badge feedback (added ✓ / already in vault), send to a specific
  collection, capture the abs-page URL into the note's frontmatter as the source link.
