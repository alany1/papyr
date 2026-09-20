// Inside Electron use its net.fetch (proxy-aware); outside (scripts/import.js) fall back
// to Node's global fetch. `require('electron')` in plain Node returns a path string, so
// destructuring yields undefined rather than throwing.
let electronNet = null;
try { electronNet = require('electron').net || null; } catch (_) { electronNet = null; }
const doFetch = (url) => (electronNet && electronNet.fetch ? electronNet.fetch(url) : fetch(url));
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { papersDir, assertBase, listPapers } = require('./library');

// arXiv abs/pdf URLs, new-style (2301.12345v2) and old-style (cs/0301012) ids.
const ARXIV_RE = /arxiv\.org\/(?:abs|pdf)\/((?:[a-z-]+(?:\.[A-Z]{2})?\/)?\d{4}[.\d]*(?:v\d+)?)/i;

function sanitizeName(name) {
  const clean = name
    .replace(/[/\\:*?"<>|\0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 150)
    .trim();
  return clean || 'paper';
}

function targetDir(lib, collection) {
  if (collection === '') return papersDir(lib);
  assertBase(collection);
  return path.join(papersDir(lib), collection);
}

async function uniqueTarget(dir, base) {
  for (let i = 0; ; i++) {
    const fileName = i === 0 ? `${base}.pdf` : `${base} (${i + 1}).pdf`;
    try {
      await fs.access(path.join(dir, fileName));
    } catch (err) {
      if (err.code === 'ENOENT') return fileName;
      throw err;
    }
  }
}

function relPathOf(collection, fileName) {
  return collection ? `${collection}/${fileName}` : fileName;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Is this paper already in the library? Byte-identical content (anywhere,
// checked first — only same-sized files get hashed) or the same name.
// candidate = { size, hash: async () => hex }
async function findDuplicate(lib, base, candidate) {
  const { papers } = await listPapers(lib);
  let candHash = null;
  for (const p of papers) {
    const abs = path.join(papersDir(lib), ...p.relPath.split('/'));
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      continue;
    }
    if (st.size !== candidate.size) continue;
    if (candHash === null) candHash = await candidate.hash();
    if (sha256(await fs.readFile(abs)) === candHash) return { existing: p, sameContent: true };
  }
  const wanted = base.toLowerCase();
  const byName = papers.find((p) => p.base.toLowerCase() === wanted);
  return byName ? { existing: byName, sameContent: false } : null;
}

// onDuplicate(info) → 'add' | 'open' | 'cancel'; without a callback duplicates
// are simply added (under a "(2)" name when the name is taken).
async function resolveDuplicate(lib, base, candidate, onDuplicate) {
  const dup = await findDuplicate(lib, base, candidate);
  if (!dup) return { decision: 'add' };
  const decision = onDuplicate ? await onDuplicate({ base, ...dup }) : 'add';
  return { decision, existing: dup.existing };
}

// Copy local PDFs (Finder drops) into the library.
async function importFiles(lib, paths, collection, onDuplicate) {
  const dir = targetDir(lib, collection);
  const imported = [];
  const errors = [];
  const opened = []; // existing papers the user chose to open instead
  let cancelled = 0;
  for (const p of paths) {
    try {
      if (typeof p !== 'string' || !p.toLowerCase().endsWith('.pdf')) {
        throw new Error(`${path.basename(String(p))}: not a PDF`);
      }
      const base = sanitizeName(path.basename(p, path.extname(p)));
      const st = await fs.stat(p);
      const { decision, existing } = await resolveDuplicate(
        lib, base, { size: st.size, hash: async () => sha256(await fs.readFile(p)) }, onDuplicate
      );
      if (decision === 'open') {
        opened.push(existing.relPath);
        continue;
      }
      if (decision === 'cancel') {
        cancelled++;
        continue;
      }
      const fileName = await uniqueTarget(dir, base);
      await fs.copyFile(p, path.join(dir, fileName));
      imported.push(relPathOf(collection, fileName));
    } catch (err) {
      errors.push(err.message);
    }
  }
  return { imported, errors, opened, cancelled };
}

async function fetchArxivTitle(id) {
  const bare = id.replace(/v\d+$/, '');
  const res = await doFetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(bare)}`);
  if (!res.ok) return null;
  const entry = (await res.text()).split('<entry>')[1];
  const match = entry && entry.match(/<title>([\s\S]*?)<\/title>/);
  return match ? match[1].replace(/\s+/g, ' ').trim() || null : null;
}

// Download a dropped link. arXiv abs/pdf pages resolve to the PDF and are
// named by paper title; anything else must be a direct PDF link.
async function importUrl(lib, url, collection, onDuplicate) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('Not an http(s) link');
  let downloadUrl = url;
  let base = null;
  const arxiv = url.match(ARXIV_RE);
  if (arxiv) {
    const id = arxiv[1].replace(/\.pdf$/i, '');
    downloadUrl = `https://arxiv.org/pdf/${id}`;
    base = (await fetchArxivTitle(id).catch(() => null)) || `arXiv ${id}`;
  }

  const res = await doFetch(downloadUrl);
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  const body = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('pdf') && body.subarray(0, 5).toString() !== '%PDF-') {
    throw new Error('Link does not point to a PDF');
  }

  if (!base) {
    const dispo = res.headers.get('content-disposition') || '';
    const m = dispo.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
    const raw = m
      ? decodeURIComponent(m[1])
      : decodeURIComponent(new URL(downloadUrl).pathname.split('/').filter(Boolean).pop() || 'paper');
    base = raw.replace(/\.pdf$/i, '');
  }

  const dir = targetDir(lib, collection);
  const clean = sanitizeName(base);
  const { decision, existing } = await resolveDuplicate(
    lib, clean, { size: body.length, hash: async () => sha256(body) }, onDuplicate
  );
  if (decision === 'open') return { imported: [], errors: [], opened: [existing.relPath], cancelled: 0 };
  if (decision === 'cancel') return { imported: [], errors: [], opened: [], cancelled: 1 };
  const fileName = await uniqueTarget(dir, clean);
  await fs.writeFile(path.join(dir, fileName), body);
  return { imported: [relPathOf(collection, fileName)], errors: [], opened: [], cancelled: 0 };
}

module.exports = { importFiles, importUrl };
