const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('papyr', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setUi: (partial) => ipcRenderer.send('ui:set', partial),
  setAssistant: (name) => ipcRenderer.invoke('assistant:set', name),
  pickLibrary: () => ipcRenderer.invoke('library:pick'),
  listPapers: () => ipcRenderer.invoke('library:list'),
  loadNote: (base) => ipcRenderer.invoke('note:load', base),
  saveNote: (base, content) => ipcRenderer.invoke('note:save', base, content),
  // Workspace documents (a folder of markdown opened in its own window)
  listDocs: () => ipcRenderer.invoke('docs:list'),
  loadDoc: (rel) => ipcRenderer.invoke('doc:load', rel),
  saveDoc: (rel, content) => ipcRenderer.invoke('doc:save', rel, content),
  newEntry: (opts) => ipcRenderer.invoke('entry:new', opts),
  docSelected: (rel) => ipcRenderer.send('doc:selected', rel),
  openWorkspace: () => ipcRenderer.invoke('workspace:open'),
  onDocsChanged: (cb) => ipcRenderer.on('docs:changed', (_e, docs) => cb(docs)),
  onDocChangedOnDisk: (cb) => ipcRenderer.on('doc:changed-on-disk', (_e, payload) => cb(payload)),
  onFolderChanged: (cb) => ipcRenderer.on('folder:changed', (_e, payload) => cb(payload)),
  // Our bundled pdf.js viewer, loading the paper same-origin over papyr://
  pdfUrl: (relPath) => {
    const fileUrl = `papyr://app/papers/${relPath.split('/').map(encodeURIComponent).join('/')}`;
    return `papyr://app/pdfviewer/viewer.html?file=${encodeURIComponent(fileUrl)}`;
  },
  movePaper: (relPath, targetCollection) => ipcRenderer.invoke('paper:move', relPath, targetCollection),
  renamePaper: (relPath, newBase) => ipcRenderer.invoke('paper:rename', relPath, newBase),
  deletePaper: (relPath) => ipcRenderer.invoke('paper:delete', relPath),
  setStarred: (base, starred) => ipcRenderer.invoke('paper:star', base, starred),
  createCollection: (name) => ipcRenderer.invoke('collection:create', name),
  renameCollection: (oldName, newName) => ipcRenderer.invoke('collection:rename', oldName, newName),
  importFiles: (paths, collection) => ipcRenderer.invoke('import:files', paths, collection),
  importUrl: (url, collection) => ipcRenderer.invoke('import:url', url, collection),
  getFilePath: (file) => webUtils.getPathForFile(file),
  paperSelected: (info) => ipcRenderer.send('paper:selected', info),
  term: {
    start: (size) => ipcRenderer.invoke('pty:start', size),
    kill: () => ipcRenderer.invoke('pty:kill'),
    input: (data) => ipcRenderer.send('pty:input', data),
    resize: (size) => ipcRenderer.send('pty:resize', size),
    onData: (cb) => ipcRenderer.on('pty:data', (_e, data) => cb(data)),
    onExit: (cb) => ipcRenderer.on('pty:exit', (_e, info) => cb(info)),
  },
  onLibraryChanged: (cb) => ipcRenderer.on('library:changed', (_e, payload) => cb(payload)),
  onNoteChangedOnDisk: (cb) => ipcRenderer.on('note:changed-on-disk', (_e, payload) => cb(payload)),
  onFlushRequest: (cb) => ipcRenderer.on('app:flush-request', () => cb()),
  flushed: () => ipcRenderer.send('app:flushed'),
});
