const Sidebar = (() => {
  const listEl = document.getElementById('paper-list');
  const emptyEl = document.getElementById('sidebar-empty');
  const dirHintEl = document.getElementById('papers-dir-hint');
  const footerEl = document.getElementById('footer-path');
  const newBtn = document.getElementById('new-collection');
  const newInput = document.getElementById('new-collection-input');

  let papers = [];
  let collections = [];
  let selectedRelPath = null;
  let collapsed = new Set();
  let handlers = {};
  let footerTimer = null;

  function makeDropTarget(el, collection) {
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation(); // window-level drop handler must not double-handle
      el.classList.remove('drop-target');
      handlers.onDrop(e.dataTransfer, collection);
    });
  }

  function paperItem(paper) {
    const li = document.createElement('li');
    li.className = 'paper';
    li.textContent = paper.base;
    li.title = paper.relPath;
    li.draggable = true;
    if (paper.relPath === selectedRelPath) li.classList.add('selected');
    li.addEventListener('click', () => handlers.onSelect(paper));
    li.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', paper.relPath);
      e.dataTransfer.effectAllowed = 'move';
    });
    li.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRenameInput(li, paper.base, (name) => handlers.onRenamePaper(paper, name));
    });
    // the glyphs come from CSS content so li.textContent stays the bare name
    if (paper.starred) li.classList.add('starred');
    const star = document.createElement('button');
    star.className = 'paper-star';
    star.title = paper.starred ? 'Unstar' : 'Star — mark to read';
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.onToggleStar(paper);
    });
    star.addEventListener('dblclick', (e) => e.stopPropagation());
    li.appendChild(star);
    const del = document.createElement('button');
    del.className = 'paper-delete';
    del.title = 'Move paper and its note to the Trash';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.onDelete(paper);
    });
    del.addEventListener('dblclick', (e) => e.stopPropagation());
    li.appendChild(del);
    makeDropTarget(li, paper.collection); // dropping on a paper files it into that paper's group
    return li;
  }

  function startRenameInput(li, initialValue, commit) {
    const input = document.createElement('input');
    input.className = 'rename-input';
    input.value = initialValue;
    li.draggable = false;
    li.textContent = '';
    li.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (ok && name && name !== initialValue) commit(name);
      else render();
    };
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(false));
  }

  // Click folds/unfolds a group; double-click renames it (except the root group).
  function groupHeader(label, collection, count) {
    const li = document.createElement('li');
    li.className = 'collection-header';
    const chev = document.createElement('span');
    chev.className = 'chev';
    chev.textContent = collapsed.has(collection) ? '▸' : '▾';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = label;
    const badge = document.createElement('span');
    badge.className = 'count';
    badge.textContent = count;
    li.append(chev, name, badge);
    makeDropTarget(li, collection);
    let clickTimer = null;
    li.addEventListener('click', () => {
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => handlers.onToggleCollapse(collection), 200);
    });
    if (collection !== '') {
      li.addEventListener('dblclick', () => {
        clearTimeout(clickTimer);
        startRenameInput(li, collection, (name) => handlers.onRenameCollection(collection, name));
      });
    }
    return li;
  }

  function render() {
    listEl.textContent = '';
    emptyEl.hidden = papers.length > 0 || collections.length > 0;
    const rootPapers = papers.filter((p) => p.collection === '');
    if (collections.length > 0) {
      listEl.appendChild(groupHeader('Papers', '', rootPapers.length));
      if (!collapsed.has('')) for (const paper of rootPapers) listEl.appendChild(paperItem(paper));
    } else {
      for (const paper of rootPapers) listEl.appendChild(paperItem(paper));
    }
    for (const collection of collections) {
      const inGroup = papers.filter((p) => p.collection === collection);
      listEl.appendChild(groupHeader(collection, collection, inGroup.length));
      if (!collapsed.has(collection)) for (const paper of inGroup) listEl.appendChild(paperItem(paper));
    }
  }

  function setCollapsed(list) {
    collapsed = new Set(list || []);
    render();
  }

  function setData(next) {
    papers = next.papers;
    collections = next.collections;
    render();
  }

  function setSelected(relPath) {
    selectedRelPath = relPath;
    render();
  }

  function setLibraryPath(libraryPath) {
    footerEl.textContent = libraryPath;
    footerEl.title = libraryPath;
    dirHintEl.textContent = `${libraryPath}/papers`;
  }

  // Transient status/error line at the bottom of the sidebar.
  function flashFooter(message) {
    const original = footerEl.title;
    footerEl.textContent = message;
    clearTimeout(footerTimer);
    footerTimer = setTimeout(() => {
      footerEl.textContent = original;
    }, 4000);
  }

  function startNewCollection() {
    newBtn.hidden = true;
    newInput.hidden = false;
    newInput.value = '';
    newInput.focus();
  }

  function endNewCollection(commit) {
    const name = newInput.value.trim();
    newInput.hidden = true;
    newBtn.hidden = false;
    if (commit && name) handlers.onCreateCollection(name);
  }

  function init(h) {
    handlers = h;
    document.getElementById('change-library').addEventListener('click', h.onChangeLibrary);
    newBtn.addEventListener('click', startNewCollection);
    newInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') endNewCollection(true);
      else if (e.key === 'Escape') endNewCollection(false);
    });
    newInput.addEventListener('blur', () => endNewCollection(false));
  }

  return { init, setData, setSelected, setLibraryPath, setCollapsed, refresh: () => render(), flashFooter };
})();
