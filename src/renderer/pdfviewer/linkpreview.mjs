// Text at an internal link's destination — for a citation like [5], the
// reference entry it points to. No DOM here, so it runs under node for tests.
//
// pdf.js gives us the destination as a page + a point (usually the top-left of
// the target line). We find the first text line at that point, then read on in
// content-stream order (which follows columns in LaTeX output) until the next
// entry begins: a line back at the entry's left edge (hanging-indent / [n]
// styles), a new "[n]" / "n." label, a larger-than-usual line gap, or a jump
// up / leftwards into another column.

const MAX_CHARS = 700;
const MAX_LINES = 12;

// → { pageNumber, text } (text may be '' when the dest has no point to read at)
export async function previewDest(doc, dest) {
  const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
  if (!Array.isArray(explicit)) return null;
  const [ref, kind, ...args] = explicit;
  let pageIndex;
  if (ref && typeof ref === 'object') pageIndex = await doc.getPageIndex(ref);
  else if (Number.isInteger(ref)) pageIndex = ref;
  else return null;

  const name = kind?.name;
  let left = null;
  let top = null;
  if (name === 'XYZ') [left, top] = args;
  else if (name === 'FitH' || name === 'FitBH') [top] = args;
  else if (name === 'FitR') [left, , , top] = args;

  const page = await doc.getPage(pageIndex + 1);
  if (top == null) {
    // A page-level dest: no point to read at, so just the page's first line.
    top = page.view[3];
  }
  const { items } = await page.getTextContent();
  return { pageNumber: pageIndex + 1, text: readAt(items, left, top) };
}

function readAt(items, left, top) {
  const its = items
    .map((it, i) => ({
      i,
      str: it.str,
      eol: it.hasEOL,
      x: it.transform[4],
      y: it.transform[5],
      h: it.height || Math.hypot(it.transform[2], it.transform[3]) || 10,
    }));
  const solid = its.filter((it) => it.str.trim());

  // The topmost line below the dest point, then its leftmost item right of the
  // dest's left edge. (hyperref puts the point a hair under the previous
  // line's baseline, so "below" is strict.)
  // Prefer text starting right at the left edge, so a slightly higher line in
  // the neighbouring column doesn't win.
  const inBand = (it) => it.y < top - 1 && it.y >= top - 40;
  let below = left == null ? [] : solid.filter((it) => inBand(it) && Math.abs(it.x - left) <= 12);
  if (!below.length) {
    const minX = left == null ? -Infinity : left - 4;
    below = solid.filter((it) => inBand(it) && it.x >= minX);
  }
  if (!below.length) return '';
  const y0 = Math.max(...below.map((it) => it.y));
  const start = below
    .filter((it) => Math.abs(it.y - y0) < 2)
    .reduce((a, b) => (b.x < a.x ? b : a));
  const startX = start.x;

  const lines = [[]];
  let lineY = start.y;
  let lineStarts = [startX];
  let gaps = [];
  for (let k = start.i; k < its.length; k++) {
    const it = its[k];
    if (!it.str.trim()) {
      lines[lines.length - 1].push(it.str);
      continue;
    }
    if (Math.abs(it.y - lineY) >= 2) {
      // a new line
      if (it.y > lineY) break; // moved up: column or page break
      if (it.x < startX - 20) break; // left of the entry: another column
      const gap = lineY - it.y;
      const firstGap = gaps[0];
      const flush = Math.abs(it.x - startX) <= 1.5;
      const indented = lineStarts.some((x) => x > startX + 1.5);
      if (flush && (indented || gap > start.h * 1.3)) break; // next entry (hanging indent / spaced)
      if (/^(\[\d+\]|\d+\.\s)/.test(it.str.trim()) && Math.abs(it.x - startX) <= 3) break; // next label
      if (firstGap ? gap > firstGap * 1.35 + 0.5 : gap > start.h * 2.2) break; // paragraph spacing
      if (lines.length >= MAX_LINES) break;
      gaps.push(gap);
      lineStarts.push(it.x);
      lineY = it.y;
      lines.push([]);
    }
    lines[lines.length - 1].push(it.str);
    if (lines.reduce((n, l) => n + l.join('').length, 0) > MAX_CHARS) break;
  }

  let text = '';
  for (const parts of lines) {
    const line = parts.join('').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    // re-join words hyphenated across lines
    if (/[a-z]-$/.test(text) && /^[a-z]/.test(line)) text = text.slice(0, -1) + line;
    else text = text ? text + ' ' + line : line;
  }
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS).replace(/\s+\S*$/, '') + '…' : text;
}
