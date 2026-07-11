// Divider drag-resize. Divider 0 adjusts the sidebar's pixel width; dividers 1 and 2
// adjust the fr weights of the pdf/note/term columns so they keep scaling with the window.
const Split = (() => {
  const MIN_PANE_PX = 160;
  const root = document.documentElement;
  const overlay = document.getElementById('drag-overlay');

  const state = {
    wSidebar: 230,
    frPdf: 5,
    frNote: 3,
    frTerm: 3,
  };

  function apply() {
    root.style.setProperty('--w-sidebar', `${state.wSidebar}px`);
    root.style.setProperty('--fr-pdf', `${state.frPdf}fr`);
    root.style.setProperty('--fr-note', `${state.frNote}fr`);
    root.style.setProperty('--fr-term', `${state.frTerm}fr`);
  }

  function persist() {
    window.papyr.setUi({ layout: { ...state } });
  }

  // Panes flanking each divider, in grid order.
  const FR_PAIRS = {
    1: ['frPdf', 'frNote'],
    2: ['frNote', 'frTerm'],
  };
  const PANE_IDS = {
    1: ['pdf-pane', 'note-pane'],
    2: ['note-pane', 'term-pane'],
  };

  function startDrag(divider, index, event) {
    event.preventDefault();
    divider.classList.add('dragging');
    overlay.hidden = false;
    const startX = event.clientX;

    let onMove;
    if (index === 0) {
      const startW = state.wSidebar;
      onMove = (e) => {
        state.wSidebar = Math.min(500, Math.max(140, startW + e.clientX - startX));
        apply();
      };
    } else {
      const [leftKey, rightKey] = FR_PAIRS[index];
      const [leftId, rightId] = PANE_IDS[index];
      const leftPx = document.getElementById(leftId).getBoundingClientRect().width;
      const rightPx = document.getElementById(rightId).getBoundingClientRect().width;
      const pxPerFr = (leftPx + rightPx) / (state[leftKey] + state[rightKey]);
      const totalFr = state[leftKey] + state[rightKey];
      const minFr = MIN_PANE_PX / pxPerFr;
      onMove = (e) => {
        let leftFr = (leftPx + e.clientX - startX) / pxPerFr;
        leftFr = Math.min(totalFr - minFr, Math.max(minFr, leftFr));
        state[leftKey] = leftFr;
        state[rightKey] = totalFr - leftFr;
        apply();
      };
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      divider.classList.remove('dragging');
      overlay.hidden = true;
      persist();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function init(savedLayout) {
    if (savedLayout && typeof savedLayout === 'object') Object.assign(state, savedLayout);
    apply();
    document.querySelectorAll('.divider').forEach((divider) => {
      const index = Number(divider.dataset.divider);
      divider.addEventListener('pointerdown', (e) => startDrag(divider, index, e));
    });
  }

  return { init };
})();
