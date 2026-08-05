const path = require('path');
const fsp = require('fs/promises');
const crypto = require('crypto');
const chokidar = require('chokidar');
const { papersDir, notesDir, starsPath, TMP_SUFFIX } = require('./library');

let watcher = null;
let papersTimer = null;
const selfWrites = new Map(); // absolute note path -> sha1 of the content we last wrote

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

function recordSelfWrite(absPath, content) {
  selfWrites.set(absPath, sha1(content));
}

// onPapersChanged() and onNoteChanged(base, content) fire on external filesystem changes;
// echoes of our own note saves (identical content) are suppressed.
function start(lib, { onPapersChanged, onNoteChanged }) {
  stop();
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
      clearTimeout(papersTimer);
      papersTimer = setTimeout(onPapersChanged, 250);
    } else if (changedPath.startsWith(papers + path.sep)) {
      // PDFs anywhere under papers/, plus collection dirs appearing/vanishing
      const isDirEvent = event === 'addDir' || event === 'unlinkDir';
      if (isDirEvent || name.toLowerCase().endsWith('.pdf')) {
        clearTimeout(papersTimer);
        papersTimer = setTimeout(onPapersChanged, 250);
      }
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

function stop() {
  clearTimeout(papersTimer);
  papersTimer = null;
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}

module.exports = { start, stop, recordSelfWrite };
