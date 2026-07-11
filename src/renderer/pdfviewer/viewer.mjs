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

// Pinch / Ctrl+wheel zoom
container.addEventListener(
  'wheel',
  (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    fitWidth = false;
    viewer.currentScale = Math.min(8, Math.max(0.25, viewer.currentScale * Math.pow(1.0015, -e.deltaY)));
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
