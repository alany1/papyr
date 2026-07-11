// Dockable pane layout: columns of vertically stacked panes. Panes are dragged
// by their headers; dropping on a pane's left/right edge makes a new column,
// dropping on its top/bottom half splits that column vertically.
//
// Panes are absolutely positioned and NEVER reparented — reparenting an
// <iframe> forces Chromium to reload it, which made rearranging/minimizing
// reload the PDF. Structure changes only rebuild the cheap divider elements.
const Layout = (() => {
  const PANE_IDS = ['pdf', 'note', 'term'];
  const LABELS = { pdf: 'paper', note: 'note', term: 'assistant' };
  const GAP = 8;
  const MIN_COL_PX = 150;
  const MIN_PANE_PX = 110;

  const columnsEl = document.getElementById('columns');
  const sidebarEl = document.getElementById('sidebar');
  const sidebarDivider = document.getElementById('sidebar-divider');
  const overlay = document.getElementById('drag-overlay');
  const ghost = document.getElementById('pane-ghost');
  const indicator = document.getElementById('drop-indicator');
  const dockEl = document.getElementById('minimized-dock');
  const root = document.documentElement;

  const paneEls = Object.fromEntries(PANE_IDS.map((id) => [id, document.getElementById(`${id}-pane`)]));

  const DEFAULT = () => ({
    columns: [
      { size: 5, panes: [{ id: 'pdf', size: 1 }] },
      { size: 3, panes: [{ id: 'note', size: 1 }] },
      { size: 3, panes: [{ id: 'term', size: 1 }] },
    ],
    minimized: [],
  });

  let state = DEFAULT();
  let vDividers = []; // index i sits between column i and i+1
  let hDividers = new Map(); // "ci:pi" -> divider between pane pi and pi+1 of column ci

  function validate(s) {
    if (!s || !Array.isArray(s.columns) || s.columns.length === 0) return null;
    const seen = new Set();
    for (const col of s.columns) {
      if (typeof col.size !== 'number' || col.size <= 0) return null;
      if (!Array.isArray(col.panes) || col.panes.length === 0) return null;
      for (const p of col.panes) {
        if (!PANE_IDS.includes(p.id) || seen.has(p.id)) return null;
        if (typeof p.size !== 'number' || p.size <= 0) return null;
        seen.add(p.id);
      }
    }
    const minimized = Array.isArray(s.minimized) ? s.minimized : [];
    for (const id of minimized) {
      if (!PANE_IDS.includes(id) || seen.has(id)) return null;
      seen.add(id);
    }
    s.minimized = minimized;
    return seen.size === PANE_IDS.length ? s : null;
  }

  // flex-style grow units; keep sums stable so proportions can't collapse
  function normalize(s) {
    const colSum = s.columns.reduce((a, c) => a + c.size, 0);
    for (const col of s.columns) {
      col.size = (col.size / colSum) * 12;
      const paneSum = col.panes.reduce((a, p) => a + p.size, 0);
      for (const p of col.panes) p.size = (p.size / paneSum) * col.panes.length;
    }
  }

  function persist() {
    window.papyr.setUi({ layout: JSON.parse(JSON.stringify(state)) });
  }

  // ---- Geometry ----

  function layoutRects() {
    const W = columnsEl.clientWidth;
    const H = columnsEl.clientHeight;
    if (W <= 0 || H <= 0) return;
    const cols = state.columns;
    const colUnits = cols.reduce((a, c) => a + c.size, 0);
    const usableW = W - GAP * (cols.length - 1);
    let x = 0;
    cols.forEach((col, ci) => {
      const w = (usableW * col.size) / colUnits;
      const paneUnits = col.panes.reduce((a, p) => a + p.size, 0);
      const usableH = H - GAP * (col.panes.length - 1);
      let y = 0;
      col.panes.forEach((pane, pi) => {
        const h = (usableH * pane.size) / paneUnits;
        Object.assign(paneEls[pane.id].style, {
          left: `${x}px`,
          top: `${y}px`,
          width: `${w}px`,
          height: `${h}px`,
        });
        if (pi < col.panes.length - 1) {
          Object.assign(hDividers.get(`${ci}:${pi}`).style, {
            left: `${x}px`,
            top: `${y + h}px`,
            width: `${w}px`,
            height: `${GAP}px`,
          });
        }
        y += h + GAP;
      });
      if (ci < cols.length - 1) {
        Object.assign(vDividers[ci].style, {
          left: `${x + w}px`,
          top: '0px',
          width: `${GAP}px`,
          height: `${H}px`,
        });
      }
      x += w + GAP;
    });
  }

  function render() {
    for (const d of vDividers) d.remove();
    for (const d of hDividers.values()) d.remove();
    vDividers = [];
    hDividers = new Map();
    state.columns.forEach((col, ci) => {
      if (ci < state.columns.length - 1) {
        const d = makeVDivider(ci);
        vDividers.push(d);
        columnsEl.appendChild(d);
      }
      col.panes.forEach((_p, pi) => {
        if (pi < col.panes.length - 1) {
          const d = makeHDivider(ci, pi);
          hDividers.set(`${ci}:${pi}`, d);
          columnsEl.appendChild(d);
        }
      });
    });
    for (const id of PANE_IDS) {
      paneEls[id].classList.toggle('minimized', state.minimized.includes(id));
    }
    renderDock();
    layoutRects();
  }

  function renderDock() {
    dockEl.textContent = '';
    for (const id of state.minimized) {
      const chip = document.createElement('button');
      chip.className = 'dock-chip';
      const dot = document.createElement('span');
      dot.className = `pane-dot dot-${id}`;
      chip.append(dot, LABELS[id]);
      chip.title = `Restore ${LABELS[id]} pane`;
      chip.addEventListener('click', () => restore(id));
      dockEl.appendChild(chip);
    }
  }

  // ---- Resize dividers ----

  function trackDrag(divider, onMove) {
    divider.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      divider.classList.add('dragging');
      overlay.hidden = false;
      const startX = e.clientX;
      const startY = e.clientY;
      const move = (ev) => onMove(ev.clientX - startX, ev.clientY - startY);
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        divider.classList.remove('dragging');
        overlay.hidden = true;
        persist();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  function makeVDivider(leftIndex) {
    const div = document.createElement('div');
    div.className = 'vdivider';
    div.addEventListener('pointerdown', () => {
      const cols = state.columns;
      const colUnits = cols.reduce((a, c) => a + c.size, 0);
      const usableW = columnsEl.clientWidth - GAP * (cols.length - 1);
      div._drag = {
        left: cols[leftIndex],
        right: cols[leftIndex + 1],
        origLeft: cols[leftIndex].size,
        unitsPerPx: colUnits / usableW,
        total: cols[leftIndex].size + cols[leftIndex + 1].size,
        minUnits: MIN_COL_PX * (colUnits / usableW),
      };
    }, { capture: true });
    trackDrag(div, (dx) => {
      const d = div._drag;
      const leftSize = Math.min(d.total - d.minUnits, Math.max(d.minUnits, d.origLeft + dx * d.unitsPerPx));
      d.left.size = leftSize;
      d.right.size = d.total - leftSize;
      layoutRects();
    });
    return div;
  }

  function makeHDivider(colIndex, topIndex) {
    const div = document.createElement('div');
    div.className = 'hdivider';
    div.addEventListener('pointerdown', () => {
      const col = state.columns[colIndex];
      const paneUnits = col.panes.reduce((a, p) => a + p.size, 0);
      const usableH = columnsEl.clientHeight - GAP * (col.panes.length - 1);
      div._drag = {
        top: col.panes[topIndex],
        bottom: col.panes[topIndex + 1],
        origTop: col.panes[topIndex].size,
        unitsPerPx: paneUnits / usableH,
        total: col.panes[topIndex].size + col.panes[topIndex + 1].size,
        minUnits: MIN_PANE_PX * (paneUnits / usableH),
      };
    }, { capture: true });
    trackDrag(div, (_dx, dy) => {
      const d = div._drag;
      const topSize = Math.min(d.total - d.minUnits, Math.max(d.minUnits, d.origTop + dy * d.unitsPerPx));
      d.top.size = topSize;
      d.bottom.size = d.total - topSize;
      layoutRects();
    });
    return div;
  }

  // ---- Sidebar width ----

  function initSidebar(savedWidth) {
    if (typeof savedWidth === 'number') root.style.setProperty('--w-sidebar', `${savedWidth}px`);
    sidebarDivider.addEventListener('pointerdown', () => {
      sidebarDivider._start = sidebarEl.getBoundingClientRect().width;
    }, { capture: true });
    trackDrag(sidebarDivider, (dx) => {
      const w = Math.min(500, Math.max(150, sidebarDivider._start + dx));
      root.style.setProperty('--w-sidebar', `${w}px`);
      window.papyr.setUi({ sidebarWidth: w });
    });
  }

  // ---- Pane rearranging ----

  function hitTest(x, y) {
    for (const id of PANE_IDS) {
      const r = paneEls[id].getBoundingClientRect();
      if (r.width === 0 || x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const relX = (x - r.left) / r.width;
      if (relX < 0.22) return { target: id, zone: 'left', rect: r };
      if (relX > 0.78) return { target: id, zone: 'right', rect: r };
      return { target: id, zone: (y - r.top) / r.height < 0.5 ? 'top' : 'bottom', rect: r };
    }
    return null;
  }

  function showIndicator(hit) {
    if (!hit) {
      indicator.hidden = true;
      return;
    }
    const { rect, zone } = hit;
    const half = { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    if (zone === 'left') half.w /= 2;
    if (zone === 'right') { half.w /= 2; half.x += half.w; }
    if (zone === 'top') half.h /= 2;
    if (zone === 'bottom') { half.h /= 2; half.y += half.h; }
    Object.assign(indicator.style, {
      left: `${half.x}px`, top: `${half.y}px`, width: `${half.w}px`, height: `${half.h}px`,
    });
    indicator.hidden = false;
  }

  function removePane(s, id) {
    let removed = null;
    for (const col of s.columns) {
      const i = col.panes.findIndex((p) => p.id === id);
      if (i >= 0) removed = col.panes.splice(i, 1)[0];
    }
    s.columns = s.columns.filter((c) => c.panes.length > 0);
    return removed;
  }

  function applyMove(id, target, zone) {
    const next = JSON.parse(JSON.stringify(state));
    const dragged = removePane(next, id);
    const tci = next.columns.findIndex((c) => c.panes.some((p) => p.id === target));
    if (!dragged || tci < 0) return; // dropped onto itself
    const tcol = next.columns[tci];
    if (zone === 'left' || zone === 'right') {
      const newCol = { size: tcol.size / 2, panes: [{ id, size: 1 }] };
      tcol.size /= 2;
      next.columns.splice(zone === 'left' ? tci : tci + 1, 0, newCol);
    } else {
      const tpi = tcol.panes.findIndex((p) => p.id === target);
      const tp = tcol.panes[tpi];
      const newPane = { id, size: tp.size / 2 };
      tp.size /= 2;
      tcol.panes.splice(zone === 'top' ? tpi : tpi + 1, 0, newPane);
    }
    normalize(next);
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    render();
    persist();
  }

  // ---- Minimize / restore ----

  function minimize(id) {
    if (state.minimized.includes(id)) return;
    const visible = state.columns.reduce((a, c) => a + c.panes.length, 0);
    if (visible <= 1) return; // never minimize the last pane
    const next = JSON.parse(JSON.stringify(state));
    if (!removePane(next, id)) return;
    next.minimized.push(id);
    normalize(next);
    state = next;
    render();
    persist();
  }

  function restore(id) {
    if (!state.minimized.includes(id)) return;
    const next = JSON.parse(JSON.stringify(state));
    next.minimized = next.minimized.filter((m) => m !== id);
    next.columns.push({ size: 4, panes: [{ id, size: 1 }] });
    normalize(next);
    state = next;
    render();
    persist();
  }

  function initHeaderDrag(id) {
    const header = paneEls[id].querySelector('.pane-header');
    header.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      let dragging = false;
      let hit = null;
      const move = (ev) => {
        if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 6) {
          dragging = true;
          overlay.hidden = false;
          ghost.textContent = LABELS[id];
          ghost.hidden = false;
          document.body.classList.add('pane-dragging');
        }
        if (!dragging) return;
        ghost.style.left = `${ev.clientX + 14}px`;
        ghost.style.top = `${ev.clientY + 10}px`;
        hit = hitTest(ev.clientX, ev.clientY);
        if (hit && hit.target === id && (hit.zone === 'top' || hit.zone === 'bottom')) hit = null;
        showIndicator(hit);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        overlay.hidden = true;
        ghost.hidden = true;
        indicator.hidden = true;
        document.body.classList.remove('pane-dragging');
        if (dragging && hit) applyMove(id, hit.target, hit.zone);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  function init(ui) {
    state = validate(ui.layout) || DEFAULT();
    normalize(state);
    initSidebar(ui.sidebarWidth);
    render();
    new ResizeObserver(() => layoutRects()).observe(columnsEl);
    PANE_IDS.forEach(initHeaderDrag);
    document.querySelectorAll('.pane-min').forEach((btn) => {
      btn.addEventListener('click', () => minimize(btn.dataset.pane));
    });
  }

  return { init };
})();
