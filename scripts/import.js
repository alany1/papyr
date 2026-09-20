#!/usr/bin/env node
// Headless import into the Papyr library, using the app's own importer (arXiv title
// lookup, download, duplicate detection). No Electron needed.
//
//   npm run import -- <arxiv-or-pdf-url | /path/to.pdf> [collection]
//
// Prints the imported paper's path relative to papers/, or the existing one if it was a
// duplicate. The library path is read from the app's config, or PAPYR_LIBRARY if set.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { importUrl, importFiles } = require('../src/main/importer');

function libraryPath() {
  if (process.env.PAPYR_LIBRARY) return process.env.PAPYR_LIBRARY; // override for tests and agents
  const candidates = [
    path.join(os.homedir(), 'Library/Application Support/papyr/config.json'),
    path.join(os.homedir(), 'Library/Application Support/Papyr/config.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      const cfg = JSON.parse(fs.readFileSync(c, 'utf8'));
      if (cfg.libraryPath) return cfg.libraryPath;
    }
  }
  return path.join(os.homedir(), 'Papyr');
}

async function main() {
  const [target, collection = ''] = process.argv.slice(2);
  if (!target) {
    console.error('usage: npm run import -- <url|pdf-path> [collection]');
    process.exit(2);
  }
  const lib = libraryPath();
  if (collection) fs.mkdirSync(path.join(lib, 'papers', collection), { recursive: true });
  const onDuplicate = async () => 'open'; // reuse the existing paper rather than adding a copy
  const result = /^https?:\/\//i.test(target)
    ? await importUrl(lib, target, collection, onDuplicate)
    : await importFiles(lib, [path.resolve(target)], collection, onDuplicate);
  for (const p of result.imported) console.log(`imported  papers/${p}`);
  for (const p of result.opened) console.log(`exists    papers/${p}`);
  for (const e of result.errors || []) console.error(`error     ${e.file || ''} ${e.error || e}`);
  if (result.errors && result.errors.length) process.exit(1);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
