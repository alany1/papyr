const { net } = require('electron');
const fs = require('fs/promises');
const path = require('path');
const { papersDir, assertBase } = require('./library');

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

// Copy local PDFs (Finder drops) into the library.
async function importFiles(lib, paths, collection) {
  const dir = targetDir(lib, collection);
  const imported = [];
  const errors = [];
  for (const p of paths) {
    try {
      if (typeof p !== 'string' || !p.toLowerCase().endsWith('.pdf')) {
        throw new Error(`${path.basename(String(p))}: not a PDF`);
      }
      const base = sanitizeName(path.basename(p, path.extname(p)));
      const fileName = await uniqueTarget(dir, base);
      await fs.copyFile(p, path.join(dir, fileName));
      imported.push(relPathOf(collection, fileName));
    } catch (err) {
      errors.push(err.message);
    }
  }
  return { imported, errors };
}

async function fetchArxivTitle(id) {
  const bare = id.replace(/v\d+$/, '');
  const res = await net.fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(bare)}`);
  if (!res.ok) return null;
  const entry = (await res.text()).split('<entry>')[1];
  const match = entry && entry.match(/<title>([\s\S]*?)<\/title>/);
  return match ? match[1].replace(/\s+/g, ' ').trim() || null : null;
}

// Download a dropped link. arXiv abs/pdf pages resolve to the PDF and are
// named by paper title; anything else must be a direct PDF link.
async function importUrl(lib, url, collection) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('Not an http(s) link');
  let downloadUrl = url;
  let base = null;
  const arxiv = url.match(ARXIV_RE);
  if (arxiv) {
    const id = arxiv[1].replace(/\.pdf$/i, '');
    downloadUrl = `https://arxiv.org/pdf/${id}`;
    base = (await fetchArxivTitle(id).catch(() => null)) || `arXiv ${id}`;
  }

  const res = await net.fetch(downloadUrl);
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
  const fileName = await uniqueTarget(dir, sanitizeName(base));
  await fs.writeFile(path.join(dir, fileName), body);
  return { imported: [relPathOf(collection, fileName)], errors: [] };
}

module.exports = { importFiles, importUrl };
