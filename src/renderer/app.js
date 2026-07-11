(async () => {
  const pdfFrame = document.getElementById('pdf-frame');
  const appEl = document.getElementById('app');
  const titlebarPaper = document.getElementById('titlebar-paper');
  let selected = null; // { base, fileName, collection, relPath }

  function showPdf(paper) {
    pdfFrame.src = window.papyr.pdfUrl(paper.relPath);
    pdfFrame.classList.add('visible');
    titlebarPaper.textContent = paper.base;
  }

  async function selectPaper(paper) {
    if (selected && selected.relPath === paper.relPath) return;
    await Note.flush();
    selected = paper;
    showPdf(paper);
    Sidebar.setSelected(paper.relPath);
    window.papyr.paperSelected(paper);
    window.papyr.setUi({ lastPaper: paper.relPath });
    await Note.open(paper.base);
  }

  function clearSelection() {
    selected = null;
    pdfFrame.removeAttribute('src');
    pdfFrame.classList.remove('visible');
    titlebarPaper.textContent = '';
    Sidebar.setSelected(null);
    window.papyr.paperSelected(null);
    Note.close();
  }

  function handlePapersChanged({ papers, collections }) {
    Sidebar.setData({ papers, collections });
    if (!selected) return;
    if (papers.some((p) => p.relPath === selected.relPath)) return;
    // Selected paper's path changed (moved between collections) or it was deleted.
    const moved = papers.find((p) => p.fileName === selected.fileName);
    if (moved) {
      selected = moved;
      showPdf(moved);
      Sidebar.setSelected(moved.relPath);
      window.papyr.paperSelected(moved);
      window.papyr.setUi({ lastPaper: moved.relPath });
    } else {
      clearSelection();
    }
  }

  async function movePaper(relPath, targetCollection) {
    const result = await window.papyr.movePaper(relPath, targetCollection);
    if (!result.ok) Sidebar.flashFooter(result.error);
    // success is reflected via the library watcher → handlePapersChanged
  }

  async function createCollection(name) {
    const result = await window.papyr.createCollection(name);
    if (!result.ok) Sidebar.flashFooter(result.error);
  }

  function toggleCollapse(collection) {
    const set = new Set(ui.collapsedCollections || []);
    if (set.has(collection)) set.delete(collection);
    else set.add(collection);
    ui.collapsedCollections = [...set];
    Sidebar.setCollapsed(ui.collapsedCollections);
    window.papyr.setUi({ collapsedCollections: ui.collapsedCollections });
  }

  // One drop handler for both internal paper moves (relPath in text/plain) and
  // external imports (Finder files, browser links).
  function handleDrop(dt, collection) {
    if (dt.files && dt.files.length > 0) {
      importDroppedFiles([...dt.files], collection);
      return;
    }
    const text = (dt.getData('text/uri-list') || dt.getData('text/plain') || '')
      .split('\n')[0]
      .trim();
    if (!text) return;
    if (/^https?:\/\//i.test(text)) importDroppedUrl(text, collection);
    else movePaper(text, collection);
  }

  async function importDroppedFiles(files, collection) {
    const paths = files.map((f) => window.papyr.getFilePath(f)).filter(Boolean);
    if (paths.length === 0) return;
    Sidebar.flashFooter(`Importing ${paths.length} file${paths.length > 1 ? 's' : ''}…`);
    afterImport(await window.papyr.importFiles(paths, collection));
  }

  async function importDroppedUrl(url, collection) {
    Sidebar.flashFooter('Downloading…');
    afterImport(await window.papyr.importUrl(url, collection));
  }

  async function afterImport(result) {
    if (!result.ok) {
      Sidebar.flashFooter(result.error);
      return;
    }
    if (result.errors && result.errors.length > 0) Sidebar.flashFooter(result.errors.join('; '));
    else Sidebar.flashFooter(`Imported ${result.imported.length} paper${result.imported.length > 1 ? 's' : ''}`);
    const { papers, collections } = await window.papyr.listPapers();
    Sidebar.setData({ papers, collections });
    const first = papers.find((p) => p.relPath === result.imported[0]);
    if (first) await selectPaper(first);
  }

  async function renameCollection(oldName, newName) {
    const result = await window.papyr.renameCollection(oldName, newName);
    if (!result.ok) {
      Sidebar.flashFooter(result.error);
      Sidebar.refresh(); // restore the header the rename input replaced
      return;
    }
    if ((ui.collapsedCollections || []).includes(oldName)) {
      ui.collapsedCollections = ui.collapsedCollections.map((c) => (c === oldName ? newName : c));
      Sidebar.setCollapsed(ui.collapsedCollections);
      window.papyr.setUi({ collapsedCollections: ui.collapsedCollections });
    }
    // the library watcher delivers the renamed listing
  }

  async function changeLibrary() {
    const result = await window.papyr.pickLibrary();
    if (!result) return;
    Sidebar.setLibraryPath(result.libraryPath);
    clearSelection();
    Sidebar.setData(await window.papyr.listPapers());
    await TermPane.restart();
  }

  function setSidebarHidden(hidden) {
    appEl.classList.toggle('sidebar-hidden', hidden);
    window.papyr.setUi({ sidebarHidden: hidden });
    TermPane.fit();
  }

  const { libraryPath, ui = {} } = await window.papyr.getConfig();

  Layout.init(ui);
  Note.init(ui.noteMode);

  // Dark pages for the PDF viewer (the viewer applies the filter inside its frame)
  const pdfPane = document.getElementById('pdf-pane');
  const pdfDarkBtn = document.getElementById('pdf-dark');
  function sendPdfDark() {
    pdfFrame.contentWindow?.postMessage(
      { type: 'papyr-dark', on: pdfPane.classList.contains('pdf-dark') },
      '*'
    );
  }
  function setPdfDark(on) {
    pdfPane.classList.toggle('pdf-dark', on);
    pdfDarkBtn.textContent = on ? '☀' : '☾';
    window.papyr.setUi({ pdfDark: on });
    sendPdfDark();
  }
  setPdfDark(ui.pdfDark === true);
  pdfDarkBtn.addEventListener('click', () => setPdfDark(!pdfPane.classList.contains('pdf-dark')));
  pdfFrame.addEventListener('load', sendPdfDark);
  Sidebar.init({
    onSelect: selectPaper,
    onChangeLibrary: changeLibrary,
    onMove: movePaper,
    onDrop: handleDrop,
    onCreateCollection: createCollection,
    onToggleCollapse: toggleCollapse,
    onRenameCollection: renameCollection,
  });
  Sidebar.setCollapsed(ui.collapsedCollections);

  // External drag-and-drop: files from Finder, PDF/arXiv links from the browser.
  const dropHint = document.getElementById('drop-hint');
  const isExternalDrag = (dt) => dt && [...dt.types].some((t) => t === 'Files' || t === 'text/uri-list');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!isExternalDrag(e.dataTransfer)) return;
    dragDepth++;
    const hidden = appEl.classList.contains('sidebar-hidden');
    const sidebarEdge = hidden ? 0 : document.getElementById('sidebar').getBoundingClientRect().right + 6;
    dropHint.style.setProperty('--drop-hint-left', `${sidebarEdge}px`);
    dropHint.hidden = false;
  });
  window.addEventListener('dragleave', () => {
    if (dragDepth > 0 && --dragDepth === 0) dropHint.hidden = true;
  });
  window.addEventListener('dragover', (e) => {
    if (isExternalDrag(e.dataTransfer)) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    dragDepth = 0;
    dropHint.hidden = true;
    if (!isExternalDrag(e.dataTransfer)) return;
    e.preventDefault();
    handleDrop(e.dataTransfer, ''); // drops outside a sidebar group import to the root
  });

  // Paper list is hidden by default; ☰ or ⌘B brings it back.
  setSidebarHidden(ui.sidebarHidden !== false);
  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    setSidebarHidden(!appEl.classList.contains('sidebar-hidden'));
  });
  window.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    if (e.key === 'b') {
      e.preventDefault();
      setSidebarHidden(!appEl.classList.contains('sidebar-hidden'));
    } else if (e.key === 'e') {
      e.preventDefault();
      Note.setMode(Note.getMode() === 'read' ? 'edit' : 'read');
    }
  });

  window.papyr.onLibraryChanged(handlePapersChanged);
  window.papyr.onNoteChangedOnDisk((payload) => Note.handleDiskChange(payload));
  window.papyr.onFlushRequest(async () => {
    try {
      await Note.flush();
    } finally {
      window.papyr.flushed();
    }
  });

  Sidebar.setLibraryPath(libraryPath);

  const { papers, collections } = await window.papyr.listPapers();
  Sidebar.setData({ papers, collections });

  const lastPaper = papers.find((p) => p.relPath === ui.lastPaper);
  if (lastPaper) await selectPaper(lastPaper);

  await TermPane.init();
})().catch(console.error);
