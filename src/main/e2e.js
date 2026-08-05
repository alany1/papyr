// Automated smoke test, enabled with PAPYR_E2E=<results.json>. Drives the real
// renderer via executeJavaScript and verifies effects on disk, then exits 0/1.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const ptyManager = require('./ptyManager');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tiny but structurally valid single-page PDF, used to self-seed an isolated
// test library (run via scripts/e2e.sh so the user's real library is untouched).
function minimalPdf() {
  const stream = 'BT /F1 12 Tf 72 700 Td (Hello Papyr) Tj ET';
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>stream\n${stream}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj${body}endobj\n`;
  });
  const xrefPos = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(out);
}

async function run(win) {
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: String(detail) });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const lib = () => config.get().libraryPath;

  const originalUi = { ...(config.get().ui || {}) };
  let notePath = null;
  let originalNote = null;
  const viewerFrame = () =>
    win.webContents.mainFrame.frames.find((f) => f.url.includes('pdfviewer/viewer.html'));

  try {
    // Seed an empty (isolated) library; the watcher delivers these to the sidebar.
    const papersRoot = path.join(lib(), 'papers');
    if (!fs.readdirSync(papersRoot).some((f) => f.toLowerCase().endsWith('.pdf'))) {
      fs.writeFileSync(path.join(papersRoot, 'Alpha Paper.pdf'), minimalPdf());
      fs.writeFileSync(path.join(papersRoot, 'Beta Paper.pdf'), minimalPdf());
      await sleep(1200);
    }
    await sleep(2500); // let app.js + claude spawn settle

    // 1. Sidebar toggle (hidden is the factory default; a saved preference wins)
    const wasHidden = await js(`document.getElementById('app').classList.contains('sidebar-hidden')`);
    if (originalUi.sidebarHidden === undefined) check('sidebar hidden by default', wasHidden);
    await js(`document.getElementById('sidebar-toggle').click()`);
    const nowHidden = await js(`document.getElementById('app').classList.contains('sidebar-hidden')`);
    check('sidebar toggle flips visibility', nowHidden === !wasHidden, `was=${wasHidden}`);
    if (nowHidden) await js(`document.getElementById('sidebar-toggle').click()`);
    const count = await js(`document.querySelectorAll('#paper-list li.paper').length`);
    check('sidebar lists papers', count >= 1, `count=${count}`);

    // 2. Select the first paper → PDF iframe src + note file created
    const firstBase = await js(`document.querySelector('#paper-list li.paper').textContent`);
    notePath = path.join(lib(), 'notes', firstBase + '.md');
    originalNote = fs.existsSync(notePath) ? fs.readFileSync(notePath, 'utf8') : null;
    await js(`document.querySelector('#paper-list li.paper').click()`);
    await sleep(1200);
    const iframeSrc = await js(`document.getElementById('pdf-frame').src`);
    check('pdf iframe points at bundled viewer',
      iframeSrc.startsWith('papyr://app/pdfviewer/viewer.html?file='), iframeSrc);
    await sleep(2000); // pdf.js worker + render
    const pageCount = await viewerFrame()?.executeJavaScript(
      `document.querySelectorAll('.pdfViewer .page').length`
    );
    check('pdf.js renders pages', pageCount >= 1, `pages=${pageCount}`);

    // A fully occluded window never composites the PDF viewer frame (see the
    // screenshot path in main.js): pdf.js stalls mid-re-render after the zoom
    // below and the text layer stays hidden, breaking the selection tests.
    // Bring the window frontmost right before the render-sensitive section
    // (moveTop alone is not enough when the whole app is in the background).
    win.moveTop();
    require('electron').app.focus({ steal: true });
    await sleep(300);

    // Ctrl+wheel zoom applies scale immediately (native smooth-zoom path)
    const zoom = await viewerFrame()?.executeJavaScript(`
      (async () => {
        const c = document.getElementById('viewerContainer');
        const v = window.__papyrViewer;
        const before = v.currentScale;
        for (let i = 0; i < 4; i++) {
          c.dispatchEvent(new WheelEvent('wheel',
            { deltaY: -120, ctrlKey: true, clientX: 300, clientY: 300, cancelable: true }));
          await new Promise(r => setTimeout(r, 30));
        }
        const during = v.currentScale;
        await new Promise(r => setTimeout(r, 600));
        return { before, during, after: v.currentScale };
      })()
    `);
    check('ctrl+wheel zooms in', !!zoom && zoom.during > zoom.before, JSON.stringify(zoom));
    check('zoom stable after the gesture', !!zoom && Math.abs(zoom.after - zoom.during) < 0.001,
      JSON.stringify(zoom));

    // ⌘⌥K: selection in the PDF is quoted into the assistant input
    const quoted = await viewerFrame()?.executeJavaScript(`
      (async () => {
        // the zoom test's deferred re-render can rebuild the text layer and
        // detach nodes mid-flight — retry until a selection actually sticks
        let selectedText = '';
        for (let i = 0; i < 40 && !selectedText; i++) {
          const el = [...document.querySelectorAll('.textLayer span, .textLayer div')]
            .find(n => n.isConnected && n.textContent.trim().length > 0);
          if (el) {
            const range = document.createRange();
            range.selectNodeContents(el);
            const s = getSelection();
            s.removeAllRanges();
            s.addRange(range);
            selectedText = s.toString();
          }
          if (!selectedText) await new Promise(r => setTimeout(r, 150));
        }
        if (!selectedText) {
          const layer = document.querySelector('.textLayer');
          return { error: 'selection never stuck', layerHidden: layer?.hidden,
                   pageClass: layer?.closest('.page')?.className, hasFocus: document.hasFocus() };
        }
        window.dispatchEvent(new KeyboardEvent('keydown',
          { code: 'KeyK', metaKey: true, altKey: true, cancelable: true }));
        return { selected: selectedText };
      })()
    `);
    await sleep(400);
    const lastQuote = await js(`window.__papyrLastQuote`);
    check('pdf selection quoted to assistant',
      typeof lastQuote === 'string' && lastQuote.includes('Hello Papyr') && /p\.1/.test(lastQuote),
      JSON.stringify({ quoted, lastQuote }));
    check('assistant focused after quote',
      await js(`!!document.activeElement && !!document.activeElement.closest('#term-pane')`));

    check('note auto-created on disk', fs.existsSync(notePath), notePath);

    // 2b. Assistant context: CLAUDE.md present, state.json tracks the selection
    check('CLAUDE.md exists in library', fs.existsSync(path.join(lib(), 'CLAUDE.md')));
    const relPath = await js(`document.querySelector('#paper-list li.selected').title`);
    const state = JSON.parse(fs.readFileSync(path.join(lib(), '.papyr', 'state.json'), 'utf8'));
    check('state.json tracks current paper', state.currentPaper === `papers/${relPath}`,
      JSON.stringify(state));

    // 3. Reading mode renders markdown + KaTeX (and is the factory default)
    const inRead = await js(`!document.getElementById('note-view').hidden`);
    if (originalUi.noteMode === undefined) check('reading mode is the default', inRead);
    if (!inRead) await js(`document.getElementById('note-mode').click()`);
    check('markdown heading rendered', await js(`!!document.querySelector('#note-view h1')`));
    fs.writeFileSync(notePath, `# ${firstBase}\n\nexternal-edit-e2e with math $E_i = mc^2$\n`);
    await sleep(1500);
    check('clean editor reloads external change',
      (await js(`document.getElementById('note-editor').value`)).includes('external-edit-e2e'));
    check('latex rendered via katex', await js(`!!document.querySelector('#note-view .katex')`));
    check('no conflict banner when clean', await js(`document.getElementById('note-banner').hidden`));

    // 4. ⌘E switches to edit mode → type → autosave persists to disk
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', metaKey: true }))`);
    check('cmd+E switches to edit mode', await js(`!document.getElementById('note-editor').hidden`));
    const marker = 'autosave-marker-e2e';
    await js(`
      (() => { const ed = document.getElementById('note-editor');
        ed.value = ed.value + '${marker}\\n';
        ed.dispatchEvent(new Event('input', { bubbles: true })); })()
    `);
    await sleep(1500);
    check('autosave wrote to disk', fs.readFileSync(notePath, 'utf8').includes(marker));

    // 4b. External write while the editor is dirty → conflict banner, user text kept
    await js(`
      (() => { const ed = document.getElementById('note-editor');
        window.__e2eTyper = setInterval(() => {
          ed.value += 'x';
          ed.dispatchEvent(new Event('input', { bubbles: true }));
        }, 300); })()
    `);
    await sleep(600);
    fs.writeFileSync(notePath, `# ${firstBase}\n\nexternal-conflict-e2e\n`);
    await sleep(1800);
    await js(`clearInterval(window.__e2eTyper)`);
    check('conflict banner when dirty', await js(`!document.getElementById('note-banner').hidden`));
    const keptValue = await js(`document.getElementById('note-editor').value`);
    check('user text kept on conflict', keptValue.includes('xxx'),
      `editor=${JSON.stringify(keptValue.slice(-150))} file=${JSON.stringify(fs.readFileSync(notePath, 'utf8').slice(-150))} focus=${await js('document.hasFocus()')} active=${await js('document.activeElement && document.activeElement.id')}`);
    await js(`document.getElementById('note-keep').click()`);
    await sleep(1200);
    check('keep-mine autosaves user text', fs.readFileSync(notePath, 'utf8').includes('xxx'),
      JSON.stringify(fs.readFileSync(notePath, 'utf8').slice(-150)));

    // 5. New PDF appears in papers/ → sidebar updates
    const srcPdf = path.join(lib(), 'papers', relPath);
    const addedName = 'E2E Added Paper.pdf';
    fs.copyFileSync(srcPdf, path.join(lib(), 'papers', addedName));
    await sleep(1500);
    const count2 = await js(`document.querySelectorAll('#paper-list li.paper').length`);
    check('sidebar picks up new pdf', count2 === count + 1, `count=${count2}`);
    fs.unlinkSync(path.join(lib(), 'papers', addedName));
    await sleep(1500);
    const count3 = await js(`document.querySelectorAll('#paper-list li.paper').length`);
    check('sidebar picks up removed pdf', count3 === count, `count=${count3}`);

    // 5b. Collections: create one, move the selected paper into it and back
    await js(`window.papyr.createCollection('e2e-collection')`);
    await sleep(1500);
    check('collection appears in sidebar', await js(`
      [...document.querySelectorAll('#paper-list li.collection-header .name')].some(n => n.textContent === 'e2e-collection')
    `));
    await js(`window.papyr.movePaper(${JSON.stringify(relPath)}, 'e2e-collection')`);
    await sleep(1500);
    const movedRel = `e2e-collection/${relPath}`;
    check('paper moved on disk', fs.existsSync(path.join(lib(), 'papers', 'e2e-collection', relPath)));
    check('selection follows moved paper',
      (await js(`document.querySelector('#paper-list li.selected')?.title`)) === movedRel);
    const movedSrc = await js(`document.getElementById('pdf-frame').src`);
    check('pdf url follows moved paper', movedSrc.includes('e2e-collection'), movedSrc);
    const state2 = JSON.parse(fs.readFileSync(path.join(lib(), '.papyr', 'state.json'), 'utf8'));
    check('state.json follows moved paper', state2.currentPaper === `papers/${movedRel}`,
      JSON.stringify(state2));

    // 5b-ii. Collection header shows a paper count
    const headerFor = (name) => `
      [...document.querySelectorAll('#paper-list li.collection-header')]
        .find(h => h.querySelector('.name')?.textContent === ${JSON.stringify(name)})`;
    check('header shows paper count',
      (await js(`${headerFor('e2e-collection')}?.querySelector('.count')?.textContent`)) === '1');

    // 5b-iii. Click folds the group (hides its papers), second click unfolds
    const visibleBefore = await js(`document.querySelectorAll('#paper-list li.paper').length`);
    await js(`${headerFor('e2e-collection')}.click()`);
    await sleep(500); // fold fires after the 200ms single-click debounce
    const visibleFolded = await js(`document.querySelectorAll('#paper-list li.paper').length`);
    check('folding hides the group papers', visibleFolded === visibleBefore - 1,
      `${visibleBefore} -> ${visibleFolded}`);
    check('fold state persisted', JSON.parse(fs.readFileSync(
      path.join(require('electron').app.getPath('userData'), 'config.json'), 'utf8'
    )).ui.collapsedCollections.includes('e2e-collection'));
    await js(`${headerFor('e2e-collection')}.click()`);
    await sleep(500);
    check('unfolding shows the group papers',
      (await js(`document.querySelectorAll('#paper-list li.paper').length`)) === visibleBefore);

    // 5b-iv. Rename the collection; disk, sidebar, and selection all follow
    await js(`window.papyr.renameCollection('e2e-collection', 'e2e-renamed')`);
    await sleep(1500);
    check('collection renamed on disk', fs.existsSync(path.join(lib(), 'papers', 'e2e-renamed', relPath)));
    check('renamed header in sidebar', await js(`!!${headerFor('e2e-renamed')}`));
    check('selection follows renamed collection',
      (await js(`document.querySelector('#paper-list li.selected')?.title`)) === `e2e-renamed/${relPath}`);

    await js(`window.papyr.movePaper(${JSON.stringify(`e2e-renamed/${relPath}`)}, '')`);
    await sleep(1500);
    check('paper moved back to root', fs.existsSync(srcPdf));

    // 5c. Divider drag resizes panes and persists
    const noteWidthBefore = await js(`document.getElementById('note-pane').getBoundingClientRect().width`);
    await js(`
      (() => { const d = document.querySelectorAll('#columns .vdivider')[0];
        const r = d.getBoundingClientRect();
        d.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.x + 3, clientY: 300, bubbles: true }));
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: r.x + 123, clientY: 300 }));
        window.dispatchEvent(new PointerEvent('pointerup', { clientX: r.x + 123, clientY: 300 })); })()
    `);
    const noteWidthAfter = await js(`document.getElementById('note-pane').getBoundingClientRect().width`);
    check('divider drag resizes panes', noteWidthBefore - noteWidthAfter > 60,
      `${noteWidthBefore} -> ${noteWidthAfter}`);
    await sleep(300);
    const { app } = require('electron');
    const configOnDisk = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8'));
    check('layout persisted to config.json', Array.isArray(configOnDisk.ui && configOnDisk.ui.layout && configOnDisk.ui.layout.columns),
      JSON.stringify(configOnDisk.ui && configOnDisk.ui.layout));
    check('last paper persisted to config.json', typeof (configOnDisk.ui && configOnDisk.ui.lastPaper) === 'string',
      JSON.stringify(configOnDisk.ui && configOnDisk.ui.lastPaper));

    // 5c-ii. Drag the note pane onto the assistant's bottom half → vertical split
    await js(`
      (() => { const h = document.querySelector('#note-pane .pane-header');
        const hr = h.getBoundingClientRect();
        h.dispatchEvent(new PointerEvent('pointerdown', { clientX: hr.x + 40, clientY: hr.y + 8, bubbles: true }));
        const tr = document.getElementById('term-pane').getBoundingClientRect();
        const x = tr.x + tr.width / 2, y = tr.y + tr.height * 0.8;
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: x - 30, clientY: y }));
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y }));
        window.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: y })); })()
    `);
    await sleep(400);
    check('pane docked below assistant', await js(`
      (() => { const n = document.getElementById('note-pane').getBoundingClientRect();
        const t = document.getElementById('term-pane').getBoundingClientRect();
        return Math.abs(n.left - t.left) < 2 && n.top > t.bottom; })()
    `));
    const layoutAfterDock = JSON.parse(
      fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8')
    ).ui.layout;
    check('docked layout persisted', layoutAfterDock.columns.some(
      (c) => c.panes.length === 2 && c.panes[0].id === 'term' && c.panes[1].id === 'note'
    ), JSON.stringify(layoutAfterDock));

    // 5c-ii-b. Second rearrange leaves a lone pane in a column — it must fill
    // the full height (regression: flex-grow sums < 1 left dead space)
    await js(`
      (() => { const h = document.querySelector('#term-pane .pane-header');
        const hr = h.getBoundingClientRect();
        h.dispatchEvent(new PointerEvent('pointerdown', { clientX: hr.x + 40, clientY: hr.y + 8, bubbles: true }));
        const pr = document.getElementById('pdf-pane').getBoundingClientRect();
        const x = pr.x + pr.width / 2, y = pr.y + pr.height * 0.25;
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: x - 30, clientY: y }));
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y }));
        window.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: y })); })()
    `);
    await sleep(400);
    const fills = await js(`
      (() => { const note = document.getElementById('note-pane').getBoundingClientRect();
        const cols = document.getElementById('columns').getBoundingClientRect();
        return { pane: note.height, col: cols.height }; })()
    `);
    check('lone pane fills its column (no dead space)',
      Math.abs(fills.pane - fills.col) < 2, JSON.stringify(fills));

    // 5c-iii. PDF dark pages toggle (applied inside the viewer frame)
    await js(`document.getElementById('pdf-dark').click()`);
    await sleep(300);
    check('pdf dark mode applied in viewer', await viewerFrame()?.executeJavaScript(
      `document.documentElement.classList.contains('papyr-dark')`
    ));
    check('pdf dark persisted', JSON.parse(
      fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8')
    ).ui.pdfDark === true);
    await js(`document.getElementById('pdf-dark').click()`);
    await sleep(300);
    check('pdf dark toggles off', (await viewerFrame()?.executeJavaScript(
      `document.documentElement.classList.contains('papyr-dark')`
    )) === false);

    // 5c-iv. Minimize / restore panes — the PDF must NOT reload through any of it
    await js(`
      (() => { window.__pdfLoads = 0;
        document.getElementById('pdf-frame').addEventListener('load', () => window.__pdfLoads++); })()
    `);
    await js(`document.querySelector('#note-pane .pane-min').click()`);
    await sleep(300);
    check('minimized pane hidden', await js(`document.getElementById('note-pane').clientWidth === 0`));
    check('restore chip appears', await js(`
      [...document.querySelectorAll('#minimized-dock .dock-chip')].some(c => c.textContent.includes('note'))
    `));
    check('minimized state persisted',
      (config.get().ui.layout.minimized || []).includes('note'),
      JSON.stringify(config.get().ui.layout));
    await js(`
      [...document.querySelectorAll('#minimized-dock .dock-chip')].find(c => c.textContent.includes('note')).click()
    `);
    await sleep(300);
    check('restored pane visible', await js(`document.getElementById('note-pane').clientWidth > 0`));
    await js(`document.querySelector('#pdf-pane .pane-min').click()`);
    await js(`document.querySelector('#note-pane .pane-min').click()`);
    await sleep(300);
    await js(`document.querySelector('#term-pane .pane-min').click()`);
    await sleep(200);
    check('last pane cannot be minimized', await js(`document.getElementById('term-pane').clientWidth > 0`));
    await js(`[...document.querySelectorAll('#minimized-dock .dock-chip')].forEach(c => c.click())`);
    await sleep(300);
    check('all panes restored', await js(`
      ['pdf', 'note', 'term'].every(id => document.getElementById(id + '-pane').clientWidth > 0)
    `));
    check('pdf did not reload during minimize/restore', (await js(`window.__pdfLoads`)) === 0,
      `loads=${await js(`window.__pdfLoads`)}`);

    // 5d. Close-flush: an unsaved edit is written before the window would close
    await js(`
      (() => { const ed = document.getElementById('note-editor');
        ed.value += 'flush-marker-e2e';
        ed.dispatchEvent(new Event('input', { bubbles: true })); })()
    `);
    const flushed = await new Promise((resolve) => {
      const { ipcMain } = require('electron');
      const timer = setTimeout(() => resolve(false), 1500);
      ipcMain.once('app:flushed', () => { clearTimeout(timer); resolve(true); });
      win.webContents.send('app:flush-request');
    });
    check('renderer acks flush request', flushed);
    check('flush saved the unsaved edit', fs.readFileSync(notePath, 'utf8').includes('flush-marker-e2e'));

    // 5e. Import: local file copy and URL download (served locally)
    const os = require('os');
    const tmpPdf = path.join(os.tmpdir(), 'papyr-e2e-import.pdf');
    fs.copyFileSync(srcPdf, tmpPdf);
    const impFile = await js(`window.papyr.importFiles([${JSON.stringify(tmpPdf)}], '')`);
    check('file import copies into library',
      impFile.ok && fs.existsSync(path.join(lib(), 'papers', 'papyr-e2e-import.pdf')),
      JSON.stringify(impFile));
    fs.rmSync(tmpPdf, { force: true });

    const http = require('http');
    const server = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/pdf');
      fs.createReadStream(srcPdf).pipe(res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    // Dropped link exercises the real path: drop → download → refresh → auto-select
    await js(`
      (() => { const dt = new DataTransfer();
        dt.setData('text/uri-list', 'http://127.0.0.1:${server.address().port}/E2E%20Fetched%20Paper.pdf');
        window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt })); })()
    `);
    await sleep(2000);
    server.close();
    check('dropped link downloads into library',
      fs.existsSync(path.join(lib(), 'papers', 'E2E Fetched Paper.pdf')));
    check('imported paper auto-selected',
      (await js(`document.querySelector('#paper-list li.selected')?.title`)) === 'E2E Fetched Paper.pdf');

    // 5f. Star the selected paper: sidebar marks it, .papyr/stars.json records it
    const starsFile = path.join(lib(), '.papyr', 'stars.json');
    await js(`document.querySelector('#paper-list li.selected .paper-star').click()`);
    await sleep(600);
    check('star marks the sidebar item',
      await js(`document.querySelector('#paper-list li.selected').classList.contains('starred')`));
    check('star visible without hover', (await js(
      `getComputedStyle(document.querySelector('#paper-list li.selected .paper-star')).display`
    )) === 'block');
    check('star persisted to stars.json',
      JSON.parse(fs.readFileSync(starsFile, 'utf8')).includes('E2E Fetched Paper'));
    // The assistant stars/unstars by editing stars.json directly; the watcher
    // must reflect that in the sidebar without any app interaction.
    fs.writeFileSync(starsFile, '[]\n');
    await sleep(1200);
    check('external stars.json edit unstars in sidebar',
      !(await js(`document.querySelector('#paper-list li.selected').classList.contains('starred')`)));
    fs.writeFileSync(starsFile, JSON.stringify(['E2E Fetched Paper']) + '\n');
    await sleep(1200);
    check('external stars.json edit stars in sidebar',
      await js(`document.querySelector('#paper-list li.selected').classList.contains('starred')`));

    // 5g. Rename a paper: the PDF and its note rename together, selection follows
    await js(`
      (() => { const li = document.querySelector('#paper-list li.selected');
        li.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); })()
    `);
    await js(`
      (() => { const input = document.querySelector('#paper-list .rename-input');
        input.value = 'E2E Renamed Paper';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()
    `);
    await sleep(1200);
    check('paper renamed on disk', fs.existsSync(path.join(lib(), 'papers', 'E2E Renamed Paper.pdf')));
    check('note renamed with paper', fs.existsSync(path.join(lib(), 'notes', 'E2E Renamed Paper.md')));
    check('old note gone after rename', !fs.existsSync(path.join(lib(), 'notes', 'E2E Fetched Paper.md')));
    check('selection follows renamed paper',
      (await js(`document.querySelector('#paper-list li.selected')?.title`)) === 'E2E Renamed Paper.pdf');
    check('no conflict banner after rename', await js(`document.getElementById('note-banner').hidden`));
    check('star follows renamed paper',
      JSON.parse(fs.readFileSync(starsFile, 'utf8')).includes('E2E Renamed Paper'));
    check('renamed paper still starred in sidebar',
      await js(`document.querySelector('#paper-list li.selected').classList.contains('starred')`));
    await js(`
      (() => { const ed = document.getElementById('note-editor');
        ed.value += 'renamed-note-marker';
        ed.dispatchEvent(new Event('input', { bubbles: true })); })()
    `);
    await sleep(1400);
    check('autosave targets the renamed note',
      fs.readFileSync(path.join(lib(), 'notes', 'E2E Renamed Paper.md'), 'utf8').includes('renamed-note-marker'));

    // 5h. Delete the selected paper: PDF and note leave the library (to Trash;
    // the confirm dialog is bypassed under PAPYR_E2E), selection clears
    await js(`document.querySelector('#paper-list li.selected .paper-delete').click()`);
    await sleep(1200);
    check('deleted pdf gone from library', !fs.existsSync(path.join(lib(), 'papers', 'E2E Renamed Paper.pdf')));
    check('deleted note gone from library', !fs.existsSync(path.join(lib(), 'notes', 'E2E Renamed Paper.md')));
    check('selection cleared after delete', await js(`!document.querySelector('#paper-list li.selected')`));
    check('note pane closed after delete', await js(`document.getElementById('note-editor').disabled`));
    check('deleted paper out of sidebar', !(await js(
      `[...document.querySelectorAll('#paper-list li.paper')].some(li => li.title === 'E2E Renamed Paper.pdf')`
    )));
    check('deleted paper unstarred',
      !JSON.parse(fs.readFileSync(starsFile, 'utf8')).includes('E2E Renamed Paper'));

    // 6. Terminal: pty running and xterm received output
    check('pty running', ptyManager.isRunning());
    const termText = await js(`
      (() => { const t = document.querySelector('#term .xterm'); return t ? t.textContent.length : 0; })()
    `);
    check('xterm rendered output', termText > 0, `chars=${termText}`);

    // 7. papyr:// traversal is rejected
    const status = await js(`
      fetch('papyr://app/papers/..%2F..%2Fconfig.json').then(r => r.status).catch(() => 'network-error')
    `);
    check('traversal rejected', status === 403 || status === 404 || status === 'network-error', `status=${status}`);
  } catch (err) {
    check('e2e crashed', false, err.stack || String(err));
  }

  // Undo test side effects: UI prefs back to pre-test values, the touched note
  // restored (or removed if the test created it), the test collection deleted.
  try {
    config.setUi({
      layout: originalUi.layout ?? null,
      sidebarHidden: originalUi.sidebarHidden ?? null,
      noteMode: originalUi.noteMode ?? null,
    });
    config.setUi({
      collapsedCollections: originalUi.collapsedCollections ?? null,
      lastPaper: originalUi.lastPaper ?? null,
      pdfDark: originalUi.pdfDark ?? null,
    });
    fs.rmSync(path.join(lib(), 'papers', 'e2e-collection'), { recursive: true, force: true });
    fs.rmSync(path.join(lib(), 'papers', 'e2e-renamed'), { recursive: true, force: true });
    for (const base of ['papyr-e2e-import', 'E2E Fetched Paper', 'E2E Renamed Paper']) {
      fs.rmSync(path.join(lib(), 'papers', `${base}.pdf`), { force: true });
      fs.rmSync(path.join(lib(), 'notes', `${base}.md`), { force: true });
    }
    if (notePath) {
      if (originalNote === null) fs.rmSync(notePath, { force: true });
      else fs.writeFileSync(notePath, originalNote);
    }
  } catch {
    // cleanup is best-effort
  }

  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(process.env.PAPYR_E2E, JSON.stringify(results, null, 2));
  const { app } = require('electron');
  app.once('quit', () => process.exit(failed.length === 0 ? 0 : 1));
  win.close(); // graceful close so localStorage reaches disk
}

module.exports = { run };
