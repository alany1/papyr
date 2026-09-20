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

  // What the pane shows: a paper's paired note ({ kind: 'note', base }) or a
  // workspace document ({ kind: 'doc', rel }). Same editor, different file.
  let current = null;
  let dirty = false;
  let saveTimer = null;
  let pendingDiskContent = null; // external change held back while the editor is dirty
  let mode = 'read';
  let placeholder = 'Select a paper to open its note';

  const sameTarget = (a, b) => !!a && !!b && a.kind === b.kind && (a.base ?? a.rel) === (b.base ?? b.rel);

  // YAML frontmatter (---\nkey: value\n---) reads as quiet metadata, not as
  // body text; the editor still shows it verbatim.
  const FRONT = /^---\n([\s\S]*?)\n---\n?/;
  const escapeHtml = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function renderView() {
    if (current === null) {
      view.innerHTML = `<p class="note-placeholder">${placeholder}</p>`;
      return;
    }
    let text = editor.value;
    let front = '';
    const m = text.match(FRONT);
    if (m) {
      text = text.slice(m[0].length);
      const rows = m[1].split('\n').filter((l) => l.includes(':')).map((l) => {
        const i = l.indexOf(':');
        return `<span class="fm-key">${escapeHtml(l.slice(0, i).trim())}</span> ${escapeHtml(l.slice(i + 1).trim())}`;
      });
      front = `<div class="note-front">${rows.join('<span class="fm-sep">·</span>')}</div>`;
    }
    view.innerHTML = front + md.render(text);
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
    if (mode === 'edit' && current !== null) editor.focus();
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!dirty || current === null) return;
    const target = current;
    const value = editor.value;
    if (target.kind === 'note') await window.papyr.saveNote(target.base, value);
    else await window.papyr.saveDoc(target.rel, value);
    if (sameTarget(current, target) && editor.value === value) dirty = false;
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

  // The open note's file was renamed (paper rename); autosaves must follow.
  function rename(base) {
    if (current !== null && current.kind === 'note') current = { kind: 'note', base };
  }

  // Called by app.js before switching files and on window close.
  async function flush() {
    hideBanner();
    await saveNow();
  }

  async function openTarget(target) {
    current = target;
    editor.disabled = false;
    const { content } = target.kind === 'note'
      ? await window.papyr.loadNote(target.base)
      : await window.papyr.loadDoc(target.rel);
    if (!sameTarget(current, target)) return; // user switched again mid-load
    editor.value = content;
    editor.scrollTop = 0;
    dirty = false;
    hideBanner();
    if (mode === 'read') {
      renderView();
      view.scrollTop = 0;
    }
  }

  const open = (base) => openTarget({ kind: 'note', base });
  const openDoc = (rel) => openTarget({ kind: 'doc', rel });

  function close() {
    current = null;
    dirty = false;
    editor.value = '';
    editor.disabled = true;
    hideBanner();
    renderView();
  }

  function applyDiskChange(content) {
    if (!dirty) {
      setContent(content);
    } else if (content !== editor.value) {
      pendingDiskContent = content;
      banner.hidden = false;
    }
  }

  function handleDiskChange({ base, content }) {
    if (current === null || current.kind !== 'note' || base !== current.base) return;
    applyDiskChange(content);
  }

  function handleDocDiskChange({ rel, content }) {
    if (current === null || current.kind !== 'doc' || rel !== current.rel) return;
    applyDiskChange(content);
  }

  function init(initialMode, opts = {}) {
    if (initialMode === 'edit') mode = 'edit';
    if (opts.placeholder) {
      placeholder = opts.placeholder;
      editor.placeholder = opts.placeholder;
    }
    editor.addEventListener('input', () => {
      dirty = true;
      scheduleSave();
    });
    editor.addEventListener('blur', () => saveNow().catch(console.error));
    modeBtn.addEventListener('click', () => setMode(mode === 'read' ? 'edit' : 'read'));
    view.addEventListener('dblclick', () => {
      if (current !== null) setMode('edit');
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

  return {
    init, open, openDoc, close, flush, rename, handleDiskChange, handleDocDiskChange,
    setMode, getMode: () => mode, getCurrent: () => current,
  };
})();
