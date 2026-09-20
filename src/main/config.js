const fs = require('fs');
const path = require('path');
const os = require('os');

let configPath = null;
let config = null;

// Assistant CLIs the terminal pane can run. The chosen key is interpolated
// into a shell command, so only values from this list are ever accepted.
const ASSISTANTS = ['claude', 'codex'];

function init(userDataDir) {
  configPath = path.join(userDataDir, 'config.json');
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    config = {};
  }
  if (!ASSISTANTS.includes(config.assistant)) config.assistant = ASSISTANTS[0];
  if (process.env.PAPYR_LIBRARY) {
    config.libraryPath = process.env.PAPYR_LIBRARY; // test isolation
  } else if (!config.libraryPath || typeof config.libraryPath !== 'string') {
    config.libraryPath = path.join(os.homedir(), 'Papyr');
    save();
  }
  // The workspace: a second, optional folder of markdown opened in its own
  // window (PAPYR_WORKSPACE points tests at a temp dir and opens it at launch).
  if (process.env.PAPYR_WORKSPACE) {
    config.workspacePath = process.env.PAPYR_WORKSPACE;
    config.workspaceOpen = true;
  }
  if (typeof config.workspacePath !== 'string') config.workspacePath = null;
  if (!config.workspaceUi || typeof config.workspaceUi !== 'object') config.workspaceUi = {};
  ensureLibrary();
  return config;
}

const INSTRUCTIONS_MD = `# Papyr Library

This folder is a Papyr library — a research workspace the user drives from a
three-pane app: the selected paper (PDF), its markdown note, and you (an
assistant CLI session running in the library root).

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
- \`.papyr/stars.json\` — a JSON array of paper names (without \`.pdf\`) the
  user has starred as to-read. If asked to star or unstar a paper, edit this
  file (rewrite the whole array); the app's sidebar picks it up live.

## How to work here

- To answer questions about a paper, read its PDF in \`papers/\`.
- Write summaries and analysis directly into the paper's paired note in
  \`notes/\` — the user's note editor picks up your edits live.
- Cross-paper syntheses can be new standalone markdown files in \`notes/\`
  (they don't need a paired PDF).
- To rename a paper, rename BOTH files together so the pairing survives:
  \`papers/<collection>/Old.pdf\` → \`New.pdf\` and \`notes/Old.md\` → \`notes/New.md\`.
- Never modify or delete the PDFs in \`papers/\` (renaming as above is fine).
`;

function ensureLibrary() {
  fs.mkdirSync(path.join(config.libraryPath, 'papers'), { recursive: true });
  fs.mkdirSync(path.join(config.libraryPath, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(config.libraryPath, '.papyr'), { recursive: true });
  // Same workspace instructions for either assistant: claude reads CLAUDE.md,
  // codex reads AGENTS.md.
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const file = path.join(config.libraryPath, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, INSTRUCTIONS_MD);
  }
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
  'lastDoc',
  'collapsedCollections',
  'pdfDark',
  'shortcuts',
]);

// UI state is kept per window kind: the library window and the workspace
// window each remember their own layout, sidebar, last-open file.
function uiFor(kind) {
  return (kind === 'workspace' ? config.workspaceUi : config.ui) || {};
}

function setUi(partial, kind = 'library') {
  const slot = kind === 'workspace' ? 'workspaceUi' : 'ui';
  config[slot] = { ...(config[slot] || {}) };
  for (const [key, value] of Object.entries(partial)) {
    if (!UI_KEYS.has(key)) continue;
    if (value === undefined || value === null) delete config[slot][key];
    else config[slot][key] = value;
  }
  save();
}

function setWorkspacePath(folder) {
  config.workspacePath = folder;
  save();
}

function setWorkspaceOpen(open) {
  config.workspaceOpen = !!open;
  save();
}

function setAssistant(name) {
  if (!ASSISTANTS.includes(name)) return false;
  config.assistant = name;
  save();
  return true;
}

function get() {
  return config;
}

module.exports = { init, get, setLibraryPath, setUi, uiFor, setWorkspacePath, setWorkspaceOpen, setAssistant, ASSISTANTS };
