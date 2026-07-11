const Note = (() => {
  const SAVE_DEBOUNCE_MS = 750;
  const editor = document.getElementById('note-editor');
  const view = document.getElementById('note-view');
  const banner = document.getElementById('note-banner');
  const modeBtn = document.getElementById('note-mode');

  const md = markdownit({ html: false, linkify: true, breaks: true }).use(texmath, {
    engine: katex,
    delimiters: 'dollars',
    katexOptions: { throwOnError: false },
  });

  let currentBase = null;
  let dirty = false;
  let saveTimer = null;
  let pendingDiskContent = null; // external change held back while the editor is dirty
  let mode = 'read';

  function renderView() {
    view.innerHTML = currentBase === null
      ? '<p class="note-placeholder">Select a paper to open its note</p>'
      : md.render(editor.value);
  }

  function applyMode() {
    editor.hidden = mode !== 'edit';
    view.hidden = mode !== 'read';
    modeBtn.textContent = mode === 'read' ? '✎' : '👁';
  }

  function setMode(next) {
    if (next === mode) return;
    mode = next;
    window.papyr.setUi({ noteMode: mode });
    if (mode === 'read') {
      saveNow().catch(console.error);
      renderView();
    }
    applyMode();
    if (mode === 'edit' && currentBase !== null) editor.focus();
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!dirty || currentBase === null) return;
    const base = currentBase;
    const value = editor.value;
    await window.papyr.saveNote(base, value);
    if (currentBase === base && editor.value === value) dirty = false;
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveNow().catch(console.error), SAVE_DEBOUNCE_MS);
  }

  function hideBanner() {
    banner.hidden = true;
    pendingDiskContent = null;
  }

  function setContent(content) {
    const { scrollTop } = editor;
    editor.value = content;
    editor.scrollTop = scrollTop;
    dirty = false;
    if (mode === 'read') renderView();
  }

  // Called by app.js before switching papers and on window close.
  async function flush() {
    hideBanner();
    await saveNow();
  }

  async function open(base) {
    currentBase = base;
    editor.disabled = false;
    const { content } = await window.papyr.loadNote(base);
    if (currentBase !== base) return; // user switched again mid-load
    editor.value = content;
    editor.scrollTop = 0;
    dirty = false;
    hideBanner();
    if (mode === 'read') {
      renderView();
      view.scrollTop = 0;
    }
  }

  function close() {
    currentBase = null;
    dirty = false;
    editor.value = '';
    editor.disabled = true;
    hideBanner();
    renderView();
  }

  function handleDiskChange({ base, content }) {
    if (base !== currentBase) return;
    if (!dirty) {
      setContent(content);
    } else if (content !== editor.value) {
      pendingDiskContent = content;
      banner.hidden = false;
    }
  }

  function init(initialMode) {
    if (initialMode === 'edit') mode = 'edit';
    editor.addEventListener('input', () => {
      dirty = true;
      scheduleSave();
    });
    editor.addEventListener('blur', () => saveNow().catch(console.error));
    modeBtn.addEventListener('click', () => setMode(mode === 'read' ? 'edit' : 'read'));
    view.addEventListener('dblclick', () => {
      if (currentBase !== null) setMode('edit');
    });
    document.getElementById('note-reload').addEventListener('click', () => {
      if (pendingDiskContent !== null) setContent(pendingDiskContent);
      hideBanner();
    });
    document.getElementById('note-keep').addEventListener('click', () => {
      hideBanner();
      scheduleSave(); // our version wins on the next save
    });
    applyMode();
    renderView();
  }

  return { init, open, close, flush, handleDiskChange, setMode, getMode: () => mode };
})();
