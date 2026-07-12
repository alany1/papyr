# Papyr

A local, single-window research workspace with three panes: the paper, its note, and a
Claude Code assistant that can see every paper and note.

- **Paper pane** — the selected PDF, rendered by a bundled pdf.js viewer styled to match
  the app: no toolbar, seamless page gaps, themed scrollbars, pinch / Ctrl+scroll zoom,
  and a dark-pages mode that inverts only the page content.
- **Note pane** — the markdown note paired with that paper (`papers/foo.pdf` ↔ `notes/foo.md`).
  Notes are created on first selection and autosaved as you type. Reading mode renders
  markdown + LaTeX (KaTeX, `$…$` and `$$…$$`) Obsidian-style; toggle edit/reading with the
  corner button, ⌘E, or double-click the rendered view to edit.
- **Assistant pane** — a real Claude Code session whose working directory is your library,
  so it can read and write across all papers and notes, and use its own web access.

## Setup

### As a normal Mac app (no npm after the first build)

Whoever builds needs Node ≥ 20 and Xcode Command Line Tools; after that Papyr is
a regular double-clickable app. The machine running it just needs the `claude`
(or `codex`) CLI on its PATH.

```sh
npm install     # also rebuilds node-pty for Electron via postinstall
npm run dist    # → dist/mac-arm64/Papyr.app and dist/Papyr-<version>-arm64.dmg
```

Drag `Papyr.app` into `/Applications` (or hand someone the `.dmg` along with
[GETTING_STARTED.md](GETTING_STARTED.md)) and launch it from Spotlight like any
other app. The app is unsigned, so a *downloaded* copy is quarantined and
macOS calls it "damaged"; the recipient clears that once with
`xattr -d com.apple.quarantine /Applications/Papyr.app` (a copy built on the
same machine launches without any of this).

### From source

```sh
npm install
npm start
```

## Usage

**Adding papers:** drag a PDF file (from Finder or a browser download), a direct PDF link,
or an **arXiv abs/pdf link** straight into the window — links are downloaded in the app,
arXiv papers are named by their actual title, and the imported paper opens immediately.
Drop onto a collection header to file it there; anywhere else imports to the library root.
You can also just drop PDFs into `~/Papyr/papers/` in Finder — they appear in the sidebar immediately (☰ or ⌘B toggles
the sidebar; it starts hidden). Click a paper to read it; its note opens beside it.
**Collections** are one-level subfolders of `papers/`: create one with "+ New collection"
and drag papers between group headers to move them (notes stay flat in `notes/`, so moving
a paper never orphans its note). Each header shows its paper count; click a header to
fold/unfold the group (fold state persists), double-click one to rename the collection.
**Double-click a paper to rename it** — its note renames with it, so the pairing never
breaks (the assistant is told to rename in pairs too). **Hover a paper and click ✕ to
delete it** — the paper and its note move to the system Trash together (recoverable). Ask the assistant about the current paper or to
synthesize across notes (e.g. "read papers/X.pdf and draft its note", "compare the three
world-models notes and write notes/synthesis.md") — external edits to the open note flow
into the editor live, and never clobber unsaved typing (you get a Reload / Keep mine choice).

- The assistant is Papyr-aware: the app maintains a `CLAUDE.md` in the library root
  (structure + conventions, loaded automatically at session start) and `.papyr/state.json`,
  which always names the currently open paper — so "summarize this paper" just works.
- The library location is stored in `~/Library/Application Support/papyr/config.json`
  (`…/Papyr/config.json` for the packaged app); change it from the ⚙ button in the
  sidebar (the assistant restarts in the new folder).
- **Rearrange panes** by dragging their headers: drop on another pane's left/right edge
  to make a new column, or on its top/bottom half to stack them vertically in one column.
  Dividers resize columns and stacked panes. ☾ in the paper header inverts PDF pages for
  comfortable dark reading. The – button minimizes a pane out of the layout; a chip in
  the title bar brings it back.
- Layout, sidebar visibility/width, note mode, dark pages, and last-opened paper persist
  across launches (stored in config.json, not localStorage — Chromium's DOMStorage only
  flushes every ~5s and loses writes made just before quit).
- **⌘⌥K** quotes the current selection (PDF or note) into the assistant input as
  `"…" (paper, p.N)` and focuses it — select a passage, hit the shortcut, ask away.
  With nothing selected it just jumps focus to the assistant.
- The ⌘ button in the title bar opens the **shortcuts panel**: every keyboard
  shortcut, click one to rebind it (persisted in config as `ui.shortcuts`).
- The button in the assistant pane's header switches between the `claude` and `codex`
  CLIs (the session restarts with the new one; the choice persists).
- If the assistant exits, press any key in the terminal pane to restart it.

## Development

- No bundler: plain scripts; xterm.js is loaded from `node_modules` via script tags.
- `PAPYR_SCREENSHOT=out.png npm start` — captures the window after load and exits.
- `npm test` — runs the automated E2E suite against throwaway config + library dirs
  (safe while a real Papyr instance is running); exits nonzero on failure.
- If node-pty complains about `NODE_MODULE_VERSION`, run `npm run rebuild`.
