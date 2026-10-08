import * as pdfjsLib from '../pdfjs/build/pdf.min.mjs';
import { PDFViewer, EventBus, PDFLinkService, PDFFindController, FindState } from '../pdfjs/web/pdf_viewer.mjs';
import { previewDest } from './linkpreview.mjs';

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
    if (Array.isArray(d.relay)) relayCombos = d.relay.filter((c) => typeof c === 'string');
  } else if (d.type === 'papyr-find') {
    openFind();
  }
});

// Send the current selection to the assistant pane. The combo is pushed in by
// the app (user-rebindable, "Mod+Alt+K" form — see shortcuts.js).
let quoteCombo = 'Mod+Alt+K';
let findCombo = 'Mod+F';
// Combos the app handles (sidebar / pane toggles): matched here, run there.
let relayCombos = ['Shift+Tab', 'Tab'];
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !peek.hidden) {
    e.preventDefault();
    hidePeek();
    return;
  }
  const parts = [];
  if (e.metaKey || e.ctrlKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(e.code.replace(/^(Key|Digit)/, ''));
  const combo = parts.join('+');
  if (combo === findCombo) {
    e.preventDefault();
    openFind();
  } else if (relayCombos.includes(combo)) {
    e.preventDefault();
    window.parent.postMessage({ type: 'papyr-shortcut', combo }, '*');
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

// ---- link peek ----
// Hovering an in-document link (a citation like [5], a figure / section ref)
// shows what it points to in a small card instead of making you go there.
// Clicking pins the card rather than jumping; "go to" (or ⌘-click) jumps.
const peek = document.getElementById('peek');
const peekText = document.getElementById('peek-text');
const peekPage = document.getElementById('peek-page');
const LINK = '.annotationLayer [data-internal-link] a';
const peeks = new Map(); // href -> Promise<{ pageNumber, text } | null>
let peekLink = null;
let peekPinned = false;
let showTimer = 0;
let hideTimer = 0;

// pdf.js encodes the dest into the href (see PDFLinkService.getDestinationHash)
function destOf(a) {
  const href = a.getAttribute('href') || '';
  if (!href.startsWith('#') || href.length < 2) return null;
  const raw = unescape(href.slice(1));
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v;
  } catch {}
  return raw;
}

function resolvePeek(a) {
  const href = a.getAttribute('href');
  if (!peeks.has(href)) {
    const dest = destOf(a);
    peeks.set(
      href,
      dest == null || !viewer.pdfDocument
        ? Promise.resolve(null)
        : previewDest(viewer.pdfDocument, dest).catch((err) => {
            console.error('papyr: link peek failed:', err);
            return null;
          })
    );
  }
  return peeks.get(href);
}

function placePeek() {
  if (!peekLink) return;
  const r = peekLink.getBoundingClientRect();
  const w = peek.offsetWidth;
  const h = peek.offsetHeight;
  peek.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
  const below = r.bottom + 6;
  peek.style.top = (below + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : below) + 'px';
}

async function showPeek(a, pin = false) {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  peekLink = a;
  peekPinned = pin || (peekPinned && !peek.hidden);
  a.removeAttribute('title'); // no native tooltip on top of ours
  const pending = resolvePeek(a);
  if (peek.hidden) {
    peekText.textContent = '…';
    peekPage.textContent = '';
    peek.hidden = false;
    placePeek();
  }
  const res = await pending;
  if (peekLink !== a || peek.hidden) return;
  if (!res) {
    peekText.textContent = 'Can’t preview this link.';
    peekPage.textContent = '';
  } else {
    // Short scraps (a figure's dest lands on the image, not text) aren't worth showing.
    const t = res.text.length >= 12 ? res.text : '';
    peekText.textContent = t || `Page ${res.pageNumber}`;
    peekText.classList.toggle('dim', !t);
    peekPage.textContent = t ? `p. ${res.pageNumber}` : '';
  }
  peekText.scrollTop = 0;
  placePeek();
}

function hidePeek() {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  peek.hidden = true;
  peekLink = null;
  peekPinned = false;
}

function hidePeekSoon() {
  clearTimeout(showTimer);
  if (peekPinned) return;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hidePeek, 250);
}

function goToPeek(a) {
  const dest = destOf(a);
  hidePeek();
  if (dest != null) linkService.goToDestination(dest);
}

container.addEventListener('mouseover', (e) => {
  const a = e.target.closest(LINK);
  if (!a) return;
  clearTimeout(hideTimer);
  if (a === peekLink && !peek.hidden) return;
  resolvePeek(a); // start reading while the hover delay runs
  clearTimeout(showTimer);
  showTimer = setTimeout(() => showPeek(a), peek.hidden ? 200 : 0);
});
container.addEventListener('mouseout', (e) => {
  const a = e.target.closest(LINK);
  if (!a || a.contains(e.relatedTarget) || peek.contains(e.relatedTarget)) return;
  hidePeekSoon();
});
peek.addEventListener('mouseenter', () => clearTimeout(hideTimer));
peek.addEventListener('mouseleave', (e) => {
  if (!e.relatedTarget?.closest?.(LINK)) hidePeekSoon();
});
// Capture phase, so pdf.js's own onclick (which jumps) never runs.
container.addEventListener(
  'click',
  (e) => {
    const a = e.target.closest(LINK);
    if (!a) {
      if (!peek.hidden) hidePeek();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.metaKey || e.ctrlKey) goToPeek(a);
    else showPeek(a, true);
  },
  true
);
document.getElementById('peek-go').addEventListener('click', () => peekLink && goToPeek(peekLink));
container.addEventListener('scroll', () => !peek.hidden && hidePeek(), { passive: true });
window.addEventListener('resize', () => !peek.hidden && hidePeek());
window.__papyrPeek = { show: showPeek, hide: hidePeek, resolve: resolvePeek }; // diagnostics / tests

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
