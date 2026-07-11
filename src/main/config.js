const fs = require('fs');
const path = require('path');
const os = require('os');

let configPath = null;
let config = null;

function init(userDataDir) {
  configPath = path.join(userDataDir, 'config.json');
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    config = {};
  }
  if (process.env.PAPYR_LIBRARY) {
    config.libraryPath = process.env.PAPYR_LIBRARY; // test isolation
  } else if (!config.libraryPath || typeof config.libraryPath !== 'string') {
    config.libraryPath = path.join(os.homedir(), 'Papyr');
    save();
  }
  ensureLibrary();
  return config;
}

const CLAUDE_MD = `# Papyr Library

This folder is a Papyr library — a research workspace the user drives from a
three-pane app: the selected paper (PDF), its markdown note, and you (this
Claude Code session running in the library root).

## Layout

- \`papers/\` — the papers, as PDFs. One-level subfolders of \`papers/\` are
  "collections" the user organizes papers into (e.g.
  \`papers/world-models/Foo.pdf\`). You may create collections (mkdir) or move
  PDFs between them if asked.
- \`notes/\` — one markdown note per paper, paired by shared file name
  regardless of collection: \`papers/<any collection>/Foo.pdf\` ↔
  \`notes/Foo.md\`. A note is created automatically the first time its paper is
  opened. Notes are always flat in \`notes/\` and may use LaTeX math
  (\`$...$\`, \`$$...$$\`) — the user's note pane renders markdown + KaTeX.
- \`.papyr/state.json\` — maintained by the app. Its \`currentPaper\` and
  \`currentNote\` fields tell you which paper the user is looking at right now.
  Read it whenever the user says "this paper", "the current paper", or refers
  to what they're reading without naming it. Never edit this file.

## How to work here

- To answer questions about a paper, read its PDF in \`papers/\`.
- Write summaries and analysis directly into the paper's paired note in
  \`notes/\` — the user's note editor picks up your edits live.
- Cross-paper syntheses can be new standalone markdown files in \`notes/\`
  (they don't need a paired PDF).
- Never modify or delete the PDFs in \`papers/\`.
`;

function ensureLibrary() {
  fs.mkdirSync(path.join(config.libraryPath, 'papers'), { recursive: true });
  fs.mkdirSync(path.join(config.libraryPath, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(config.libraryPath, '.papyr'), { recursive: true });
  const claudeMd = path.join(config.libraryPath, 'CLAUDE.md');
  if (!fs.existsSync(claudeMd)) fs.writeFileSync(claudeMd, CLAUDE_MD);
}

function save() {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

function setLibraryPath(libraryPath) {
  config.libraryPath = libraryPath;
  save();
  ensureLibrary();
}

// UI state (layout, last paper, …) lives here rather than in localStorage:
// Chromium only commits DOMStorage to disk every ~5s, so writes shortly
// before quit are silently lost.
const UI_KEYS = new Set([
  'layout',
  'sidebarHidden',
  'sidebarWidth',
  'noteMode',
  'lastPaper',
  'collapsedCollections',
  'pdfDark',
]);

function setUi(partial) {
  config.ui = { ...(config.ui || {}) };
  for (const [key, value] of Object.entries(partial)) {
    if (!UI_KEYS.has(key)) continue;
    if (value === undefined || value === null) delete config.ui[key];
    else config.ui[key] = value;
  }
  save();
}

function get() {
  return config;
}

module.exports = { init, get, setLibraryPath, setUi };
