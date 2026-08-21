const { ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const library = require('./library');
const importer = require('./importer');
const ptyManager = require('./ptyManager');
const watcher = require('./watcher');

function startWatching(win) {
  watcher.start(config.get().libraryPath, {
    onPapersChanged: async () => {
      if (win.isDestroyed()) return;
      win.webContents.send('library:changed', await library.listPapers(config.get().libraryPath));
    },
    onNoteChanged: (base, content) => {
      if (win.isDestroyed()) return;
      win.webContents.send('note:changed-on-disk', { base, content });
    },
  });
}

function register(win) {
  ptyManager.setHandlers({
    onData: (data) => {
      if (!win.isDestroyed()) win.webContents.send('pty:data', data);
    },
    onExit: ({ exitCode }) => {
      if (!win.isDestroyed()) win.webContents.send('pty:exit', { exitCode });
    },
  });

  ipcMain.handle('config:get', () => ({
    libraryPath: config.get().libraryPath,
    ui: config.get().ui || {},
    assistant: config.get().assistant,
    assistants: config.ASSISTANTS,
  }));

  ipcMain.handle('assistant:set', (_e, name) => {
    if (!config.setAssistant(name)) return { ok: false, error: 'Unknown assistant' };
    ptyManager.kill(); // renderer restarts the terminal with the new command
    return { ok: true, assistant: name };
  });

  ipcMain.on('ui:set', (_e, partial) => {
    if (partial && typeof partial === 'object' && !Array.isArray(partial)) config.setUi(partial);
  });

  ipcMain.handle('library:pick', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose your Papyr library folder',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: config.get().libraryPath,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    config.setLibraryPath(result.filePaths[0]);
    startWatching(win);
    ptyManager.kill(); // renderer restarts the terminal with the new cwd
    return { libraryPath: config.get().libraryPath };
  });

  ipcMain.handle('library:list', () => library.listPapers(config.get().libraryPath));

  ipcMain.handle('paper:move', async (_e, relPath, targetCollection) => {
    try {
      return { ok: true, ...(await library.movePaper(config.get().libraryPath, relPath, targetCollection)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('collection:create', async (_e, name) => {
    try {
      await library.createCollection(config.get().libraryPath, name);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('paper:rename', async (_e, relPath, newBase) => {
    try {
      const lib = config.get().libraryPath;
      const result = await library.renamePaper(lib, relPath, newBase);
      // the renamed note fires a watcher "add"; suppress it as our own write
      if (result.noteContent !== null) {
        watcher.recordSelfWrite(library.notePath(lib, result.base), result.noteContent);
      }
      delete result.noteContent;
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('paper:star', async (_e, base, starred) => {
    try {
      await library.setStarred(config.get().libraryPath, base, starred === true);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Moves the paper and its paired note to the system Trash (recoverable).
  ipcMain.handle('paper:delete', async (_e, relPath) => {
    try {
      const lib = config.get().libraryPath;
      const pdf = library.paperPath(lib, relPath);
      const base = path.basename(pdf, '.pdf');
      if (!process.env.PAPYR_E2E) {
        const { response } = await dialog.showMessageBox(win, {
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
      const note = library.notePath(lib, base);
      if (fs.existsSync(note)) await shell.trashItem(note);
      const stars = await library.loadStars(lib);
      if (stars.delete(base)) await library.saveStars(lib, stars);
      return { ok: true, base };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Asks before importing a paper that is already in the library (identical
  // bytes, or the same name with different contents — maybe another version).
  async function confirmDuplicate(info) {
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
  }

  ipcMain.handle('import:files', async (_e, paths, collection) => {
    try {
      if (!Array.isArray(paths)) throw new Error('No files');
      return { ok: true, ...(await importer.importFiles(config.get().libraryPath, paths, collection, confirmDuplicate)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('import:url', async (_e, url, collection) => {
    try {
      return { ok: true, ...(await importer.importUrl(config.get().libraryPath, url, collection, confirmDuplicate)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('collection:rename', async (_e, oldName, newName) => {
    try {
      await library.renameCollection(config.get().libraryPath, oldName, newName);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('note:load', (_e, base) => library.loadNote(config.get().libraryPath, base));

  ipcMain.handle('note:save', async (_e, base, content) => {
    if (typeof content !== 'string') throw new Error('Note content must be a string');
    const lib = config.get().libraryPath;
    watcher.recordSelfWrite(library.notePath(lib, base), content);
    await library.saveNote(lib, base, content);
    return { ok: true };
  });

  ipcMain.handle('pty:start', (_e, size) =>
    ptyManager.start({
      cols: size && size.cols,
      rows: size && size.rows,
      cwd: config.get().libraryPath,
      command: config.get().assistant,
    })
  );

  ipcMain.handle('pty:kill', () => {
    ptyManager.kill();
    return { ok: true };
  });

  ipcMain.on('paper:selected', (_e, info) => {
    const selected = info && typeof info.relPath === 'string' && typeof info.base === 'string';
    library
      .writeState(config.get().libraryPath, {
        currentPaper: selected ? `papers/${info.relPath}` : null,
        currentNote: selected ? `notes/${info.base}.md` : null,
        updatedAt: new Date().toISOString(),
      })
      .catch(console.error);
  });

  ipcMain.on('pty:input', (_e, data) => {
    if (typeof data === 'string') ptyManager.write(data);
  });

  ipcMain.on('pty:resize', (_e, size) => {
    if (size && Number.isInteger(size.cols) && Number.isInteger(size.rows)) {
      ptyManager.resize(size);
    }
  });

  startWatching(win);
}

module.exports = { register };
