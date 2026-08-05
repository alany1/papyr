# Getting started with Papyr

Papyr is a reading workspace with three panes: the **paper** (PDF), its
**note** (markdown, autosaved), and an **assistant** (a real Claude Code or
Codex session that can see every paper and note in your library).

## 1. Install the app

Open the `.dmg` and drag **Papyr** into `Applications`.

Because the app is unsigned, macOS will claim the downloaded copy is
**"damaged and can't be opened"** — it isn't; that's Gatekeeper's wording for
"not signed by a paid Apple developer account". Fix it once in Terminal:

```sh
xattr -d com.apple.quarantine /Applications/Papyr.app
```

After that it opens normally, forever.

## 2. Install the assistant CLI

The assistant pane runs a command-line agent that you install separately —
this is the only prerequisite.

**Claude Code** (default):

```sh
curl -fsSL https://claude.ai/install.sh | bash
```

or `brew install --cask claude-code`. You'll need an Anthropic account with
Claude access.

**Codex** (optional alternative): install the `codex` CLI from OpenAI and use
the switch button in the assistant pane's header to select it.

Until a CLI is installed, the assistant pane tells you exactly that and waits;
after installing, press any key in the pane to retry.

## 3. First launch

- If you've never used the CLI before, its **login flow appears right in the
  assistant pane** (it opens a browser to authenticate). One-time.
- The first time the assistant starts in your library it asks **"do you trust
  this folder?"** — say yes; the folder is your own library.
- Papyr creates its library at `~/Papyr` automatically (`papers/` and
  `notes/`). You can move it later with the ⚙ button in the sidebar.

## 4. Daily use

- **Add papers** by dragging in a PDF file, a direct PDF link, or an arXiv
  link — arXiv papers are named by their actual title. You can also drop PDFs
  straight into `~/Papyr/papers/` in Finder.
- **⌘B** toggles the paper list; click a paper to read it — its note opens
  beside it and autosaves as you type. Hover a paper and click **✕** to delete
  it (paper + note go to the Trash, so it's recoverable), or click **☆** to star
  it — e.g. to mark papers you still want to read. Starred papers gather in a
  **Starred** group at the top of the list (you can also drag a paper onto that
  header to star it). **⌘E** flips the note between editing
  and rendered reading view (markdown + LaTeX).
- **Ask the assistant** about what you're reading: it always knows which paper
  is open, so "summarize this paper" or "draft this paper's note" just works.
  Select a passage in the PDF or note and hit **⌘⌥K** to quote it into the
  assistant input. **Shift+Enter** makes a newline; **Enter** sends.
- The **⌘ button in the title bar** lists all shortcuts and lets you rebind
  them (click a shortcut, press the new keys).
- Drag pane headers to rearrange the layout; **–** minimizes a pane (a chip in
  the title bar brings it back); **☾** in the paper header inverts PDF pages
  for dark reading.

## If something looks stuck

- *"claude CLI not found on PATH"* in the assistant pane → do step 2, then
  press any key in the pane.
- *"[claude exited]"* → press any key in the pane to restart the session.
- The assistant switch button (header of the assistant pane) restarts the
  session with the other CLI — current conversation is discarded.
