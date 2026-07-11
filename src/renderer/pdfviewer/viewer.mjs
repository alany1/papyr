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

// Pinch / Ctrl+wheel zoom. Re-rendering on every wheel tick makes the pages
// blink, so during the gesture we preview with a CSS transform on the
// already-rendered pages (anchored at the cursor) and commit the real scale
// once the gesture pauses — a single crisp re-render.
const viewerEl = document.getElementById('viewer');
let pendingZoom = null; // { base, factor, ax, ay, timer }

function commitZoom() {
  if (!pendingZoom) return;
  const { base, factor, ax, ay } = pendingZoom;
  pendingZoom = null;
  // Anchor to a fractional point of the page under the anchor: the gaps
  // between pages don't scale, so plain linear scroll math drifts by a few
  // pixels per page and the view visibly snapped after each gesture.
  // (offsetTop/offsetLeft are layout coords, unaffected by the preview
  // transform; the transform origin sat exactly at the anchor point.)
  const anchorX = container.scrollLeft + ax;
  const anchorY = container.scrollTop + ay;
  let ref = null;
  for (const p of viewerEl.querySelectorAll('.page')) {
    ref = p;
    if (anchorY < p.offsetTop + p.offsetHeight) break;
  }
  const fx = ref ? (anchorX - ref.offsetLeft) / ref.offsetWidth : 0;
  const fy = ref ? (anchorY - ref.offsetTop) / ref.offsetHeight : 0;
  viewerEl.style.transform = '';
  viewerEl.style.transformOrigin = '';
  viewer.currentScale = base * factor;
  if (ref) {
    const apply = () => {
      // The preview's transform-origin lives in the viewer element's local
      // space, offset from content space by the collapsed first-page margin —
      // compensate so the committed position matches the preview exactly.
      container.scrollTop = ref.offsetTop + fy * ref.offsetHeight - ay - viewerEl.offsetTop;
      container.scrollLeft = ref.offsetLeft + fx * ref.offsetWidth - ax - viewerEl.offsetLeft;
    };
    apply();
    requestAnimationFrame(apply); // pdf.js may adjust scroll async after rescale
  }
}

container.addEventListener(
  'wheel',
  (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    fitWidth = false;
    if (!pendingZoom) {
      const rect = container.getBoundingClientRect();
      // Horizontal anchor at the content center, vertical at the cursor.
      const ax = container.clientWidth / 2;
      const ay = e.clientY - rect.top;
      const anchorX = container.scrollLeft + ax;
      const anchorY = container.scrollTop + ay;
      let ref = null;
      for (const p of viewerEl.querySelectorAll('.page')) {
        ref = p;
        if (anchorY < p.offsetTop + p.offsetHeight) break;
      }
      pendingZoom = {
        base: viewer.currentScale,
        factor: 1,
        ax,
        ay,
        timer: null,
        scroll0: container.scrollLeft,
        refL: ref ? ref.offsetLeft : 0,
        refW: ref ? ref.offsetWidth : container.clientWidth,
        fx: ref ? (anchorX - ref.offsetLeft) / ref.offsetWidth : 0.5,
      };
      viewerEl.style.transformOrigin = `${anchorX}px ${anchorY}px`;
    }
    // Steeper curve than the raw delta, clamped per event so trackpad pinches
    // feel responsive without single mouse-wheel notches jumping too far.
    const step = Math.min(1.25, Math.max(0.8, Math.exp(-e.deltaY * 0.008)));
    const z = pendingZoom;
    const target = Math.min(8, Math.max(0.25, z.base * z.factor * step));
    z.factor = target / z.base;
    // Predict where the commit will put the page horizontally — centering
    // (margin auto) and scroll clamping make a pure scale() preview land
    // somewhere else, which showed up as a sideways snap at commit time.
    const clientW = container.clientWidth;
    const pageW = z.refW * z.factor;
    const viewerW = Math.max(clientW, pageW);
    const committedLeft = (viewerW - pageW) / 2;
    const desiredScroll = committedLeft + z.fx * pageW - z.ax;
    const committedScroll = Math.min(Math.max(0, desiredScroll), Math.max(0, viewerW - clientW));
    const committedVisualLeft = committedLeft - committedScroll;
    const previewVisualLeft = z.ax + (z.refL - z.scroll0 - z.ax) * z.factor;
    const tx = committedVisualLeft - previewVisualLeft;
    viewerEl.style.transform = `translateX(${tx}px) scale(${z.factor})`;
    clearTimeout(z.timer);
    z.timer = setTimeout(commitZoom, 180);
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
