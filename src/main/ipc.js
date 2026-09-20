const { ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const library = require('./library');
const importer = require('./importer');
const sessions = require('./sessions');

// Every handler serves the window that sent the message: its folder, its
// assistant process, its watcher, its on-screen state.
const S = (e) => {
  const s = sessions.byContents(e.sender);
  if (!s) throw new Error('No session for this window');
  return s;
};

function startWatching(s) {
  const win = s.win;
  s.watcher.start(s.folder, {
    kind: s.kind,
    onPapersChanged: async () => {
      if (win.isDestroyed()) return;
      win.webContents.send('library:changed', await library.listPapers(s.folder));
    },
    onNoteChanged: (base, content) => {
      if (win.isDestroyed()) return;
      win.webContents.send('note:changed-on-disk', { base, content });
    },
    onDocsChanged: async () => {
      if (win.isDestroyed()) return;
      win.webContents.send('docs:changed', await library.listDocs(s.folder));
    },
    onDocChanged: (rel, content) => {
      if (win.isDestroyed()) return;
      win.webContents.send('doc:changed-on-disk', { rel, content });
    },
  });
}

// What the window is looking at, for <folder>/.papyr/state.json.
function pushState(s) {
  library
    .writeState(s.folder, { ...s.viewState, updatedAt: new Date().toISOString() })
    .catch(console.error);
}

let registered = false;
let hooks = { openWorkspace: null, chooseWorkspace: null };

function register(h) {
  hooks = { ...hooks, ...h };
  if (registered) return;
  registered = true;

  ipcMain.handle('config:get', (e) => {
    const s = S(e);
    return {
      kind: s.kind,
      folder: s.folder,
      libraryPath: s.folder, // legacy name; the renderer shows it in the sidebar footer
      ui: config.uiFor(s.kind),
      assistant: config.get().assistant,
      assistants: config.ASSISTANTS,
      workspacePath: config.get().workspacePath,
    };
  });

  ipcMain.handle('assistant:set', (e, name) => {
    if (!config.setAssistant(name)) return { ok: false, error: 'Unknown assistant' };
    S(e).pty.kill(); // this window's renderer restarts its terminal with the new command
    return { ok: true, assistant: name };
  });

  ipcMain.on('ui:set', (e, partial) => {
    if (partial && typeof partial === 'object' && !Array.isArray(partial)) config.setUi(partial, S(e).kind);
  });

  // Change this window's folder: a new library for the reader, a new workspace
  // for the workspace window. The renderer restarts the assistant afterwards.
  ipcMain.handle('library:pick', async (e) => {
    const s = S(e);
    const result = await dialog.showOpenDialog(s.win, {
      title: s.kind === 'workspace' ? 'Choose a workspace folder' : 'Choose a library folder',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: s.folder,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const folder = result.filePaths[0];
    if (s.kind === 'workspace') config.setWorkspacePath(folder);
    else config.setLibraryPath(folder);
    s.folder = folder;
    s.viewState = { currentPaper: null, currentNote: null, currentDoc: null };
    startWatching(s);
    s.pty.kill();
    return { libraryPath: folder, folder };
  });

  ipcMain.handle('library:list', (e) => library.listPapers(S(e).folder));

  ipcMain.handle('paper:move', async (e, relPath, targetCollection) => {
    try {
      return { ok: true, ...(await library.movePaper(S(e).folder, relPath, targetCollection)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('collection:create', async (e, name) => {
    try {
      await library.createCollection(S(e).folder, name);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('paper:rename', async (e, relPath, newBase) => {
    const s = S(e);
    try {
      const result = await library.renamePaper(s.folder, relPath, newBase);
      // the renamed note fires a watcher "add"; suppress it as our own write
      if (result.noteContent !== null) {
        s.watcher.recordSelfWrite(library.notePath(s.folder, result.base), result.noteContent);
      }
      delete result.noteContent;
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('paper:star', async (e, base, starred) => {
    try {
      await library.setStarred(S(e).folder, base, starred === true);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Moves the paper and its paired note to the system Trash (recoverable).
  ipcMain.handle('paper:delete', async (e, relPath) => {
    const s = S(e);
    try {
      const pdf = library.paperPath(s.folder, relPath);
      const base = path.basename(pdf, '.pdf');
      if (!process.env.PAPYR_E2E) {
        const { response } = await dialog.showMessageBox(s.win, {
          type: 'warning',
          buttons: ['Move to Trash', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          message: `Move "${base}" to the Trash?`,
          detail: 'Its note goes with it. Both can be restored from the Trash.',
        });
        if (response !== 0) return { ok: true, cancelled: true };
      }
      await shell.trashItem(pdf);
      const note = library.notePath(s.folder, base);
      if (fs.existsSync(note)) await shell.trashItem(note);
      const stars = await library.loadStars(s.folder);
      if (stars.delete(base)) await library.saveStars(s.folder, stars);
      return { ok: true, base };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Asks before importing a paper that is already in the library (identical
  // bytes, or the same name with different contents — maybe another version).
  const confirmDuplicate = (win) => async (info) => {
    if (process.env.PAPYR_E2E) {
      global.__papyrLastDup = info; // the suite inspects what was detected
      return process.env.PAPYR_E2E_DUP || 'add';
    }
    const where = info.existing.collection ? ` (in "${info.existing.collection}")` : '';
    const prompt = info.sameContent
      ? {
          message: `"${info.base}" is already in your library`,
          detail: `An identical PDF exists as "${info.existing.base}"${where}. Add it again anyway?`,
          buttons: ['Open existing', 'Add anyway', 'Cancel'],
          decisions: ['open', 'add', 'cancel'],
        }
      : {
          message: `A paper named "${info.base}" already exists`,
          detail: `The existing one${where} has different contents — it may be another version of the same paper. Add this as a separate paper?`,
          buttons: ['Add as separate paper', 'Open existing', 'Cancel'],
          decisions: ['add', 'open', 'cancel'],
        };
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: prompt.buttons,
      defaultId: 0,
      cancelId: 2,
      message: prompt.message,
      detail: prompt.detail,
    });
    return prompt.decisions[response];
  };

  ipcMain.handle('import:files', async (e, paths, collection) => {
    const s = S(e);
    try {
      if (!Array.isArray(paths)) throw new Error('No files');
      return { ok: true, ...(await importer.importFiles(s.folder, paths, collection, confirmDuplicate(s.win))) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('import:url', async (e, url, collection) => {
    const s = S(e);
    try {
      return { ok: true, ...(await importer.importUrl(s.folder, url, collection, confirmDuplicate(s.win))) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('collection:rename', async (e, oldName, newName) => {
    try {
      await library.renameCollection(S(e).folder, oldName, newName);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('note:load', (e, base) => library.loadNote(S(e).folder, base));

  ipcMain.handle('note:save', async (e, base, content) => {
    if (typeof content !== 'string') throw new Error('Note content must be a string');
    const s = S(e);
    s.watcher.recordSelfWrite(library.notePath(s.folder, base), content);
    await library.saveNote(s.folder, base, content);
    return { ok: true };
  });

  // ---- workspace documents ----
  ipcMain.handle('docs:list', (e) => library.listDocs(S(e).folder));

  ipcMain.handle('doc:load', (e, rel) => library.loadDoc(S(e).folder, rel));

  ipcMain.handle('doc:save', async (e, rel, content) => {
    if (typeof content !== 'string') throw new Error('Document content must be a string');
    const s = S(e);
    s.watcher.recordSelfWrite(library.docPath(s.folder, rel), content);
    await library.saveDoc(s.folder, rel, content);
    return { ok: true };
  });

  ipcMain.handle('entry:new', async (e, opts) => {
    try {
      return { ok: true, rel: await library.newEntry(S(e).folder, opts || {}) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.on('doc:selected', (e, rel) => {
    const s = S(e);
    s.viewState.currentDoc = typeof rel === 'string' ? rel : null;
    pushState(s);
  });

  ipcMain.handle('workspace:open', () => (hooks.openWorkspace ? hooks.openWorkspace() : null));

  // ---- assistant process ----
  ipcMain.handle('pty:start', (e, size) => {
    const s = S(e);
    return s.pty.start({
      cols: size && size.cols,
      rows: size && size.rows,
      cwd: s.folder,
      command: config.get().assistant,
    });
  });

  ipcMain.handle('pty:kill', (e) => {
    S(e).pty.kill();
    return { ok: true };
  });

  ipcMain.on('paper:selected', (e, info) => {
    const s = S(e);
    const selected = info && typeof info.relPath === 'string' && typeof info.base === 'string';
    s.viewState.currentPaper = selected ? `papers/${info.relPath}` : null;
    s.viewState.currentNote = selected ? `notes/${info.base}.md` : null;
    pushState(s);
  });

  ipcMain.on('pty:input', (e, data) => {
    if (typeof data === 'string') S(e).pty.write(data);
  });

  ipcMain.on('pty:resize', (e, size) => {
    if (size && Number.isInteger(size.cols) && Number.isInteger(size.rows)) S(e).pty.resize(size);
  });
}

module.exports = { register, startWatching };
