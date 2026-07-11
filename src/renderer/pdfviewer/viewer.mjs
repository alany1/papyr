import * as pdfjsLib from '../pdfjs/build/pdf.min.mjs';
import { PDFViewer, EventBus, PDFLinkService, PDFFindController } from '../pdfjs/web/pdf_viewer.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '../pdfjs/build/pdf.worker.min.mjs';

const container = document.getElementById('viewerContainer');
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
  }
});

// ⌘⌥K / Ctrl+Alt+K: send the current selection to the assistant pane
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyK') {
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
