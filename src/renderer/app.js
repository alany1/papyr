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
    const imported = result.imported || [];
    const opened = result.opened || []; // duplicates the user chose to open instead
    if (result.errors && result.errors.length > 0) Sidebar.flashFooter(result.errors.join('; '));
    else if (imported.length > 0) Sidebar.flashFooter(`Imported ${imported.length} paper${imported.length > 1 ? 's' : ''}`);
    else if (opened.length > 0) Sidebar.flashFooter('Already in the library — opened the existing paper');
    else if (result.cancelled) Sidebar.flashFooter('Import cancelled');
    const { papers, collections } = await window.papyr.listPapers();
    Sidebar.setData({ papers, collections });
    const first = papers.find((p) => p.relPath === (imported[0] || opened[0]));
    if (first) await selectPaper(first);
  }

  async function renamePaperTo(paper, newBase) {
    const result = await window.papyr.renamePaper(paper.relPath, newBase);
    if (!result.ok) {
      Sidebar.flashFooter(result.error);
      Sidebar.refresh(); // restore the item the rename input replaced
      return;
    }
    if (selected && selected.relPath === paper.relPath) {
      selected = { ...selected, base: result.base, fileName: result.fileName, relPath: result.relPath };
      showPdf(selected);
      Sidebar.setSelected(selected.relPath);
      window.papyr.paperSelected(selected);
      window.papyr.setUi({ lastPaper: selected.relPath });
      Note.rename(result.base);
    }
    // the library watcher delivers the renamed listing
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

  async function toggleStar(paper) {
    const result = await window.papyr.setStarred(paper.base, !paper.starred);
    if (!result.ok) {
      Sidebar.flashFooter(result.error || 'Star failed');
      return;
    }
    Sidebar.setData(await window.papyr.listPapers());
  }

  async function deletePaper(paper) {
    // Clear the selection first so no pending note autosave can recreate the
    // note after it's trashed.
    const wasSelected = selected && selected.relPath === paper.relPath;
    if (wasSelected) clearSelection();
    const result = await window.papyr.deletePaper(paper.relPath);
    if (!result.ok) {
      Sidebar.flashFooter(result.error || 'Delete failed');
      if (wasSelected) selectPaper(paper).catch(console.error);
      return;
    }
    if (result.cancelled) {
      if (wasSelected) selectPaper(paper).catch(console.error);
      return;
    }
    Sidebar.flashFooter(`"${result.base}" moved to Trash`);
    Sidebar.setData(await window.papyr.listPapers());
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

  // ---- Workspace window: a folder of markdown, no paper pane -------------
  // Same panes (note + assistant), same shortcuts; the sidebar is a file tree
  // and the assistant runs in the workspace folder.
  async function initWorkspace(cfg) {
    const ui = cfg.ui || {};
    document.body.classList.add('kind-workspace');
    document.getElementById('sidebar-title').textContent = 'workspace';
    document.getElementById('paper-search').placeholder = 'search files…';
    document.getElementById('new-collection-row').hidden = true;
    document.getElementById('new-entry-row').hidden = false;
    document.getElementById('sidebar-empty-title').textContent = 'No markdown files here yet.';
    document.getElementById('sidebar-empty-hint').textContent = 'Create one in this folder, or ask the assistant to.';
    document.getElementById('change-library').title = 'Change workspace folder…';
    Layout.init(ui, ['note', 'term']);
    Note.init(ui.noteMode, { placeholder: 'Select a file' });

    let selectedDoc = null;
    let collapsed = ui.collapsedCollections || [];
    const labelOf = (d) => d.label || d.rel.split('/').pop().replace(/\.md$/i, '');

    async function selectDoc(doc) {
      if (selectedDoc && selectedDoc.rel === doc.rel) return;
      await Note.flush();
      selectedDoc = doc;
      WorkspaceSidebar.setSelected(doc.rel);
      titlebarPaper.textContent = labelOf(doc);
      window.papyr.docSelected(doc.rel);
      window.papyr.setUi({ lastDoc: doc.rel });
      await Note.openDoc(doc.rel);
    }

    function clearDoc() {
      selectedDoc = null;
      WorkspaceSidebar.setSelected(null);
      titlebarPaper.textContent = '';
      window.papyr.docSelected(null);
      window.papyr.setUi({ lastDoc: null });
      Note.close();
    }

    function handleDocsChanged(docs) {
      WorkspaceSidebar.setDocs(docs);
      if (selectedDoc && !docs.some((d) => d.rel === selectedDoc.rel)) clearDoc();
    }

    // "+ today" (global day file) or a project header's "+" (that project's entry).
    async function newEntry(project) {
      const result = await window.papyr.newEntry({ project });
      if (!result.ok) {
        WorkspaceSidebar.flashFooter(result.error);
        return;
      }
      const docs = await window.papyr.listDocs();
      WorkspaceSidebar.setDocs(docs);
      const doc = docs.find((d) => d.rel === result.rel);
      if (doc) {
        await selectDoc(doc);
        Note.setMode('edit');
      }
    }

    function persistCollapsed() {
      WorkspaceSidebar.setCollapsed(collapsed);
      window.papyr.setUi({ collapsedCollections: collapsed });
    }

    function toggleCollapse(key) {
      const set = new Set(collapsed);
      if (set.has(key)) set.delete(key);
      else set.add(key);
      collapsed = [...set];
      persistCollapsed();
    }

    async function switchFolder(folder) {
      WorkspaceSidebar.setFolder(folder);
      clearDoc();
      WorkspaceSidebar.setDocs(await window.papyr.listDocs());
      await TermPane.restart();
    }

    async function changeFolder() {
      const result = await window.papyr.pickLibrary();
      if (result) await switchFolder(result.folder);
    }

    WorkspaceSidebar.init({
      onSelect: (d) => selectDoc(d).catch(console.error),
      onNewEntry: (project) => newEntry(project).catch(console.error),
      onToggleCollapse: toggleCollapse,
      onChangeFolder: () => changeFolder().catch(console.error),
    });
    WorkspaceSidebar.setCollapsed(collapsed);
    WorkspaceSidebar.setFolder(cfg.folder);

    // The file list is the point of this window: shown unless hidden on purpose.
    setSidebarHidden(ui.sidebarHidden === true);
    document.getElementById('sidebar-toggle').addEventListener('click', () => {
      setSidebarHidden(!appEl.classList.contains('sidebar-hidden'));
    });

    Shortcuts.add('toggle-sidebar', 'toggle file list', 'Mod+B', () => {
      setSidebarHidden(!appEl.classList.contains('sidebar-hidden'));
    });
    Shortcuts.add('toggle-note-mode', 'edit / reading view', 'Mod+E', () => {
      Note.setMode(Note.getMode() === 'read' ? 'edit' : 'read');
    });
    Shortcuts.add('search-papers', 'search files', 'Mod+Shift+F', () => {
      setSidebarHidden(false);
      WorkspaceSidebar.focusSearch();
    });
    Shortcuts.add('fold-all', 'fold / expand all groups', 'Mod+Shift+T', () => {
      const keys = WorkspaceSidebar.groupKeys();
      if (keys.length === 0) return;
      const set = new Set(collapsed);
      if (keys.some((k) => !set.has(k))) for (const k of keys) set.add(k);
      else for (const k of keys) set.delete(k);
      collapsed = [...set];
      persistCollapsed();
    });
    Shortcuts.add('new-entry', "today's journal entry", 'Mod+Shift+J', () => newEntry(null).catch(console.error));
    Shortcuts.add('quote-selection', 'quote selection to assistant', 'Mod+Alt+K', () => {
      const text = window.getSelection()?.toString() || '';
      quoteToAssistant(text, selectedDoc ? labelOf(selectedDoc) : 'file');
    });
    Shortcuts.add('assistant-newline', 'assistant: newline (enter sends)', 'Shift+Enter', null, { fixed: true });
    const syncTitles = () => {
      document.getElementById('sidebar-toggle').title = `Toggle file list (${Shortcuts.displayFor('toggle-sidebar')})`;
      document.getElementById('note-mode').title = `Toggle edit / reading view (${Shortcuts.displayFor('toggle-note-mode')})`;
    };
    Shortcuts.init(ui.shortcuts, syncTitles);
    syncTitles();

    window.papyr.onDocsChanged(handleDocsChanged);
    window.papyr.onDocChangedOnDisk((payload) => Note.handleDocDiskChange(payload));
    window.papyr.onFolderChanged(({ folder }) => switchFolder(folder).catch(console.error));
    window.papyr.onFlushRequest(async () => {
      try {
        await Note.flush();
      } finally {
        window.papyr.flushed();
      }
    });

    const docs = await window.papyr.listDocs();
    WorkspaceSidebar.setDocs(docs);
    const last = docs.find((d) => d.rel === ui.lastDoc);
    if (last) await selectDoc(last);
    await TermPane.init({ assistant: cfg.assistant, assistants: cfg.assistants });
  }

  const cfg = await window.papyr.getConfig();
  if (cfg.kind === 'workspace') {
    await initWorkspace(cfg);
    return;
  }
  const { libraryPath, ui = {}, assistant, assistants } = cfg;

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
    onRenamePaper: renamePaperTo,
    onDelete: (paper) => deletePaper(paper).catch(console.error),
    onToggleStar: (paper) => toggleStar(paper).catch(console.error),
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
  // Capture phase, so the overlay clears on every drop: sidebar drop targets
  // stopPropagation() when they consume one, which would keep a bubbling
  // window handler (and its reset) from ever running. dragend covers drags
  // that end without a drop.
  const resetDropHint = () => {
    dragDepth = 0;
    dropHint.hidden = true;
  };
  window.addEventListener('drop', resetDropHint, true);
  window.addEventListener('dragend', resetDropHint, true);
  window.addEventListener('drop', (e) => {
    if (!isExternalDrag(e.dataTransfer)) return;
    e.preventDefault();
    handleDrop(e.dataTransfer, ''); // drops outside a sidebar group import to the root
  });

  // Paper list is hidden by default; ☰ or ⌘B brings it back.
  setSidebarHidden(ui.sidebarHidden !== false);
  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    setSidebarHidden(!appEl.classList.contains('sidebar-hidden'));
  });
  // Quote the current selection into the assistant input and focus it (⌘⌥K).
  // The PDF viewer forwards its selection via postMessage; a selection in the
  // note pane is quoted directly; with no selection it just jumps focus.
  function quoteToAssistant(text, source) {
    const clean = (text || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    const snippet = clean ? `"${clean}" (${source}) ` : '';
    if (snippet) TermPane.insert(snippet);
    TermPane.focus();
    window.__papyrLastQuote = snippet; // diagnostics / tests
  }
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d && d.type === 'papyr-quote') {
      const source = [selected ? selected.base : 'paper', d.page ? `p.${d.page}` : null]
        .filter(Boolean)
        .join(', ');
      quoteToAssistant(d.text, source);
    }
  });
  Shortcuts.add('toggle-sidebar', 'toggle paper list', 'Mod+B', () => {
    setSidebarHidden(!appEl.classList.contains('sidebar-hidden'));
  });
  Shortcuts.add('toggle-note-mode', 'note: edit / reading view', 'Mod+E', () => {
    Note.setMode(Note.getMode() === 'read' ? 'edit' : 'read');
  });
  Shortcuts.add('search-papers', 'search papers', 'Mod+Shift+F', () => {
    setSidebarHidden(false);
    Sidebar.focusSearch();
  });
  Shortcuts.add('fold-all', 'fold / expand all groups', 'Mod+Shift+T', () => {
    const keys = Sidebar.groupKeys();
    if (keys.length === 0) return;
    const set = new Set(ui.collapsedCollections || []);
    if (keys.some((k) => !set.has(k))) for (const k of keys) set.add(k);
    else for (const k of keys) set.delete(k);
    ui.collapsedCollections = [...set];
    Sidebar.setCollapsed(ui.collapsedCollections);
    window.papyr.setUi({ collapsedCollections: ui.collapsedCollections });
  });
  Shortcuts.add('find-in-paper', 'find in paper', 'Mod+F', () => {
    if (!selected) return;
    pdfFrame.contentWindow?.postMessage({ type: 'papyr-find' }, '*');
  });
  Shortcuts.add('quote-selection', 'quote selection to assistant', 'Mod+Alt+K', () => {
    const text = window.getSelection()?.toString() || '';
    quoteToAssistant(text, selected ? `${selected.base}, note` : 'note');
  });
  Shortcuts.add('assistant-newline', 'assistant: newline (enter sends)', 'Shift+Enter', null, { fixed: true });

  // The PDF viewer lives in its own frame, so it matches the quote and find
  // shortcuts itself — tell it the current combos (and re-tell after any rebind).
  function syncShortcuts() {
    pdfFrame.contentWindow?.postMessage(
      {
        type: 'papyr-shortcuts',
        quote: Shortcuts.comboFor('quote-selection'),
        find: Shortcuts.comboFor('find-in-paper'),
      },
      '*'
    );
    document.getElementById('sidebar-toggle').title =
      `Toggle paper list (${Shortcuts.displayFor('toggle-sidebar')})`;
    document.getElementById('note-mode').title =
      `Toggle edit / reading view (${Shortcuts.displayFor('toggle-note-mode')})`;
  }
  Shortcuts.init(ui.shortcuts, syncShortcuts);
  pdfFrame.addEventListener('load', syncShortcuts);
  syncShortcuts();

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

  await TermPane.init({ assistant, assistants });
})().catch(console.error);
