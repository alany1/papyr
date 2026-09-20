const path = require('path');
const fsp = require('fs/promises');
const crypto = require('crypto');
const chokidar = require('chokidar');
const { papersDir, notesDir, starsPath, TMP_SUFFIX, isDocIgnoredTop } = require('./library');

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

// Each window owns one watcher over its folder. A library folder watches
// papers/, notes/ and the stars file; a workspace folder watches its markdown
// tree. Echoes of the window's own saves (identical content) are suppressed.
function create() {
  let watcher = null;
  let timer = null;
  const selfWrites = new Map(); // absolute path -> sha1 of the content we last wrote

  function recordSelfWrite(absPath, content) {
    selfWrites.set(absPath, sha1(content));
  }

  function debounce(fn) {
    clearTimeout(timer);
    timer = setTimeout(fn, 250);
  }

  // onPapersChanged() and onNoteChanged(base, content) fire on external changes.
  function startLibrary(lib, { onPapersChanged, onNoteChanged }) {
    const papers = papersDir(lib);
    const notes = notesDir(lib);
    const stars = starsPath(lib);
    watcher = chokidar.watch([papers, notes, stars], {
      ignoreInitial: true,
      depth: 1, // papers/<collection>/<file>
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    watcher.on('all', async (event, changedPath) => {
      const name = path.basename(changedPath);
      if (name.startsWith('.') || name.endsWith(TMP_SUFFIX)) return;
      const dir = path.dirname(changedPath);
      if (changedPath === stars) {
        // Stars decorate the paper listing, so any change (ours or the
        // assistant's) refreshes it the same way a papers/ change does.
        debounce(onPapersChanged);
      } else if (changedPath.startsWith(papers + path.sep)) {
        // PDFs anywhere under papers/, plus collection dirs appearing/vanishing
        const isDirEvent = event === 'addDir' || event === 'unlinkDir';
        if (isDirEvent || name.toLowerCase().endsWith('.pdf')) debounce(onPapersChanged);
      } else if (dir === notes && name.endsWith('.md') && (event === 'add' || event === 'change')) {
        let content;
        try {
          content = await fsp.readFile(changedPath, 'utf8');
        } catch {
          return; // vanished between event and read
        }
        if (selfWrites.get(changedPath) === sha1(content)) return;
        onNoteChanged(name.slice(0, -3), content);
      }
    });
  }

  // onDocsChanged() on files/folders appearing or vanishing (the sidebar
  // re-lists); onDocChanged(rel, content) on edits to a document.
  function startWorkspace(folder, { onDocsChanged, onDocChanged }) {
    const root = path.resolve(folder);
    watcher = chokidar.watch(root, {
      ignoreInitial: true,
      depth: 4,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      ignored: (p) => {
        const rel = path.relative(root, p);
        if (!rel || rel.startsWith('..')) return false;
        if (isDocIgnoredTop(rel.split(path.sep)[0])) return true;
        const base = path.basename(p);
        return base.startsWith('.') || base.endsWith(TMP_SUFFIX);
      },
    });
    watcher.on('all', async (event, changedPath) => {
      const name = path.basename(changedPath);
      if (event === 'addDir' || event === 'unlinkDir') {
        debounce(onDocsChanged);
        return;
      }
      if (!name.toLowerCase().endsWith('.md')) return;
      if (event === 'add' || event === 'unlink') debounce(onDocsChanged);
      if (event === 'add' || event === 'change') {
        let content;
        try {
          content = await fsp.readFile(changedPath, 'utf8');
        } catch {
          return;
        }
        if (selfWrites.get(changedPath) === sha1(content)) return;
        onDocChanged(path.relative(root, changedPath).split(path.sep).join('/'), content);
      }
    });
  }

  function start(folder, handlers) {
    stop();
    if (handlers.kind === 'workspace') startWorkspace(folder, handlers);
    else startLibrary(folder, handlers);
  }

  function stop() {
    clearTimeout(timer);
    timer = null;
    if (watcher) {
      watcher.close();
      watcher = null;
    }
  }

  return { start, stop, recordSelfWrite };
}

module.exports = { create };
