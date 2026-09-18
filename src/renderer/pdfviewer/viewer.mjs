import * as pdfjsLib from '../pdfjs/build/pdf.min.mjs';
import { PDFViewer, EventBus, PDFLinkService, PDFFindController, FindState } from '../pdfjs/web/pdf_viewer.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '../pdfjs/build/pdf.worker.min.mjs';

const container = document.getElementById('viewerContainer');
container.tabIndex = -1; // focusable, so the find bar can hand focus back to the pages
const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus });
const findController = new PDFFindController({ eventBus, linkService });
const viewer = new PDFViewer({
  container,
  viewer: document.getElementById('viewer'),
  eventBus,
  linkService,
  findController,
});
linkService.setViewer(viewer);

// Fit width until the user zooms manually; re-fit on pane resizes.
let fitWidth = true;
eventBus.on('pagesinit', () => {
  viewer.currentScaleValue = 'page-width';
});
window.addEventListener('resize', () => {
  if (fitWidth && viewer.pdfDocument) viewer.currentScaleValue = 'page-width';
});

// Pinch / Ctrl+wheel zoom. pdf.js's updateScale applies the new layout
// synchronously and defers the crisp re-render (drawingDelay), so there is no
// separate "commit" that could snap — but its own scroll adjustment leans on
// internal location state that can be stale and jump. So after each event we
// re-anchor the scroll ourselves to the page under the cursor.
const viewerEl = document.getElementById('viewer');
window.__papyrViewer = viewer; // for diagnostics / tests
container.addEventListener(
  'wheel',
  (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    if (!viewer.pdfDocument) return;
    fitWidth = false;
    const rect = container.getBoundingClientRect();
    const ax = e.clientX - rect.left;
    const ay = e.clientY - rect.top;
    const anchorX = container.scrollLeft + ax;
    const anchorY = container.scrollTop + ay;
    let ref = null;
    for (const p of viewerEl.querySelectorAll('.page')) {
      ref = p;
      if (anchorY < p.offsetTop + p.offsetHeight) break;
    }
    const fx = ref ? (anchorX - ref.offsetLeft) / ref.offsetWidth : 0.5;
    const fy = ref ? (anchorY - ref.offsetTop) / ref.offsetHeight : 0.5;
    // Steeper curve than the raw delta, clamped per event so trackpad pinches
    // feel responsive without single mouse-wheel notches jumping too far.
    const scaleFactor = Math.min(1.25, Math.max(0.8, Math.exp(-e.deltaY * 0.008)));
    viewer.updateScale({ drawingDelay: 400, scaleFactor });
    if (ref) {
      container.scrollTop = ref.offsetTop + fy * ref.offsetHeight - ay;
      container.scrollLeft = ref.offsetLeft + fx * ref.offsetWidth - ax;
    }
  },
  { passive: false }
);

// Driven by the app shell: dark pages, plus zoom/scroll for tooling
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d) return;
  if (d.type === 'papyr-dark') {
    document.documentElement.classList.toggle('papyr-dark', !!d.on);
  } else if (d.type === 'papyr-zoom' && typeof d.scale === 'number') {
    fitWidth = false;
    viewer.currentScale = d.scale;
  } else if (d.type === 'papyr-scroll' && typeof d.y === 'number') {
    container.scrollTop = d.y;
  } else if (d.type === 'papyr-shortcuts') {
    if (typeof d.quote === 'string') quoteCombo = d.quote;
    if (typeof d.find === 'string') findCombo = d.find;
  } else if (d.type === 'papyr-find') {
    openFind();
  }
});

// Send the current selection to the assistant pane. The combo is pushed in by
// the app (user-rebindable, "Mod+Alt+K" form — see shortcuts.js).
let quoteCombo = 'Mod+Alt+K';
let findCombo = 'Mod+F';
window.addEventListener('keydown', (e) => {
  const parts = [];
  if (e.metaKey || e.ctrlKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(e.code.replace(/^(Key|Digit)/, ''));
  const combo = parts.join('+');
  if (combo === findCombo) {
    e.preventDefault();
    openFind();
  } else if (combo === quoteCombo) {
    e.preventDefault();
    const sel = window.getSelection();
    const text = sel ? sel.toString() : '';
    let page = null;
    if (sel && sel.anchorNode) {
      const el = sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode.parentElement;
      page = Number(el?.closest('.page')?.dataset.pageNumber) || null;
    }
    window.parent.postMessage({ type: 'papyr-quote', text, page }, '*');
  }
});

// ---- find in paper (⌘F) ----
// pdf.js's PDFFindController does the matching + highlighting; this is just
// the bar. Typing searches as you go (the controller debounces), Enter /
// Shift+Enter step through matches, Esc closes and clears the highlights.
const findbar = document.getElementById('findbar');
const findInput = document.getElementById('find-input');
const findCount = document.getElementById('find-count');

function dispatchFind(type, findPrevious = false) {
  eventBus.dispatch('find', {
    source: findbar,
    type,
    query: findInput.value,
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    findPrevious,
    matchDiacritics: false,
  });
}

function openFind() {
  findbar.hidden = false;
  // Like the browser: a current selection seeds the query.
  const sel = (window.getSelection()?.toString() || '').replace(/\s+/g, ' ').trim();
  if (sel && sel.length <= 200 && document.activeElement !== findInput) {
    findInput.value = sel;
    dispatchFind('');
  }
  findInput.focus();
  findInput.select();
}

function closeFind() {
  if (findbar.hidden) return;
  findbar.hidden = true;
  findbar.classList.remove('not-found');
  findCount.textContent = '';
  eventBus.dispatch('findbarclose', { source: findbar });
  container.focus(); // keep arrow / page keys scrolling the paper
}

findInput.addEventListener('input', () => {
  if (!findInput.value) {
    findbar.classList.remove('not-found');
    findCount.textContent = '';
  }
  dispatchFind('');
});
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    dispatchFind('again', e.shiftKey);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeFind();
  }
});
document.getElementById('find-prev').addEventListener('click', () => dispatchFind('again', true));
document.getElementById('find-next').addEventListener('click', () => dispatchFind('again', false));
document.getElementById('find-close').addEventListener('click', closeFind);

function showMatches({ current, total }, notFound) {
  if (!findInput.value) return;
  findbar.classList.toggle('not-found', !!notFound);
  if (notFound) findCount.textContent = 'no match';
  else if (total > 0) findCount.textContent = `${current} of ${total}`;
  else findCount.textContent = '';
}
eventBus.on('updatefindmatchescount', ({ matchesCount }) => showMatches(matchesCount, false));
eventBus.on('updatefindcontrolstate', ({ state, matchesCount }) => {
  if (state === FindState.PENDING) return;
  showMatches(matchesCount, state === FindState.NOT_FOUND);
});
window.__papyrFind = { open: openFind, close: closeFind }; // diagnostics / tests

const fileUrl = new URLSearchParams(location.search).get('file');
if (fileUrl) {
  pdfjsLib
    .getDocument({ url: fileUrl })
    .promise.then((doc) => {
      viewer.setDocument(doc);
      linkService.setDocument(doc, null);
    })
    .catch((err) => console.error('papyr: pdf load failed:', err));
}
