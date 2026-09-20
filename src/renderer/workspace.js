// Sidebar for a workspace window: the folder's markdown files grouped by
// top-level folder (each project under projects/ is its own group), with
// search, folding, newest-first for dated folders, and "+ today" entries.
// Renders into the same list element the library sidebar uses, so it shares
// its styles.
const WorkspaceSidebar = (() => {
  const listEl = document.getElementById('paper-list');
  const emptyEl = document.getElementById('sidebar-empty');
  const footerEl = document.getElementById('footer-path');
  const searchEl = document.getElementById('paper-search');
  const todayBtn = document.getElementById('new-today');

  let docs = []; // { rel, name }
  let selectedRel = null;
  let collapsed = new Set();
  let handlers = {};
  let query = '';
  let firstHit = null; // what Enter in the search box opens
  let footerTimer = null;

  const KEY = 'ws:'; // fold-key prefix
  const SECTION = KEY + '*';
  const DATED = /^\d{4}-\d{2}-\d{2}/;

  function matches(doc) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return true;
    const hay = doc.rel.toLowerCase();
    return terms.every((t) => hay.includes(t));
  }

  // Group order: root files, projects, ideas, journal, meetings, everything else.
  const groupOrder = (g) =>
    g === '' ? 0 : g.startsWith('projects/') ? 1 : g === 'ideas' ? 2 : g === 'journal' ? 3 : g === 'meetings' ? 4 : 5;

  function groupsOf(list) {
    const groups = new Map();
    for (const d of list) {
      const segs = d.rel.split('/');
      let g;
      let label;
      if (segs.length === 1) {
        g = '';
        label = d.name;
      } else if (segs[0] === 'projects' && segs.length >= 3) {
        g = segs.slice(0, 2).join('/');
        label = segs.slice(2).join('/').replace(/\.md$/i, '');
      } else {
        g = segs[0];
        label = segs.slice(1).join('/').replace(/\.md$/i, '');
      }
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push({ ...d, label });
    }
    const keys = [...groups.keys()].sort((a, b) => groupOrder(a) - groupOrder(b) || a.localeCompare(b));
    for (const k of keys) {
      groups.get(k).sort((a, b) => {
        const da = DATED.test(a.label.split('/').pop());
        const db = DATED.test(b.label.split('/').pop());
        if (da && db) return b.label.localeCompare(a.label); // newest first
        if (da !== db) return da ? 1 : -1; // undated (proposal, log) above dated entries
        return a.label.localeCompare(b.label);
      });
    }
    return { groups, keys };
  }

  function item(d) {
    const li = document.createElement('li');
    li.className = 'paper doc';
    li.textContent = d.label;
    li.title = d.rel;
    if (d.rel === selectedRel) li.classList.add('selected');
    li.addEventListener('click', () => handlers.onSelect(d));
    if (!firstHit) firstHit = () => handlers.onSelect(d);
    return li;
  }

  function header(label, key, count, project) {
    const li = document.createElement('li');
    li.className = 'collection-header doc-header';
    const chev = document.createElement('span');
    chev.className = 'chev';
    chev.textContent = collapsed.has(key) ? '▸' : '▾';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = label;
    const badge = document.createElement('span');
    badge.className = 'count';
    badge.textContent = count;
    li.append(chev, name);
    if (project) {
      // "+" on a project header: today's journal entry for that project
      const plus = document.createElement('button');
      plus.className = 'group-add';
      plus.textContent = '+';
      plus.title = `Today's journal entry for ${project}`;
      plus.addEventListener('click', (e) => {
        e.stopPropagation();
        handlers.onNewEntry(project);
      });
      li.appendChild(plus);
    }
    li.appendChild(badge);
    li.addEventListener('click', () => handlers.onToggleCollapse(key));
    return li;
  }

  function render() {
    listEl.textContent = '';
    firstHit = null;
    emptyEl.hidden = docs.length > 0;
    const filtering = query.trim().length > 0;
    const shown = filtering ? docs.filter(matches) : docs;
    const { groups, keys } = groupsOf(shown);
    for (const g of keys) {
      const items = groups.get(g);
      const key = KEY + g;
      if (g !== '') {
        const project = g.startsWith('projects/') ? g.slice('projects/'.length) : null;
        listEl.appendChild(header(project || g, key, items.length, project));
      }
      if (g === '' || filtering || !collapsed.has(key)) for (const d of items) listEl.appendChild(item(d));
    }
    if (filtering && shown.length === 0) {
      const li = document.createElement('li');
      li.className = 'no-results';
      li.textContent = 'nothing matches';
      listEl.appendChild(li);
    }
  }

  function groupKeys() {
    return groupsOf(docs).keys.filter((g) => g !== '').map((g) => KEY + g);
  }

  function setDocs(list) {
    docs = Array.isArray(list) ? list : [];
    render();
  }

  function setSelected(rel) {
    selectedRel = rel;
    render();
  }

  function setCollapsed(list) {
    collapsed = new Set(list || []);
    render();
  }

  function setFolder(folder) {
    footerEl.textContent = folder;
    footerEl.title = folder;
  }

  function flashFooter(message) {
    const original = footerEl.title;
    footerEl.textContent = message;
    clearTimeout(footerTimer);
    footerTimer = setTimeout(() => {
      footerEl.textContent = original;
    }, 4000);
  }

  function focusSearch() {
    searchEl.focus();
    searchEl.select();
  }

  function init(h) {
    handlers = h;
    document.getElementById('change-library').addEventListener('click', h.onChangeFolder);
    todayBtn.addEventListener('click', () => h.onNewEntry(null));
    searchEl.addEventListener('input', () => {
      query = searchEl.value;
      render();
    });
    searchEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (firstHit) firstHit();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        if (searchEl.value) {
          searchEl.value = '';
          query = '';
          render();
        } else {
          searchEl.blur();
        }
      }
    });
  }

  return { init, setDocs, setSelected, setCollapsed, groupKeys, setFolder, flashFooter, focusSearch, refresh: () => render() };
})();
