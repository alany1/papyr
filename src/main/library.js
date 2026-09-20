const fs = require('fs/promises');
const path = require('path');

const TMP_SUFFIX = '.papyr-tmp';

function papersDir(lib) {
  return path.join(lib, 'papers');
}

function notesDir(lib) {
  return path.join(lib, 'notes');
}

// A paper/note base name: no path separators, no leading dot.
function assertBase(base) {
  if (
    typeof base !== 'string' ||
    base.length === 0 ||
    base.startsWith('.') ||
    base.includes('/') ||
    base.includes('\\') ||
    base.includes('\0')
  ) {
    throw new Error(`Invalid name: ${JSON.stringify(base)}`);
  }
}

const byBase = (a, b) => a.base.localeCompare(b.base, undefined, { sensitivity: 'base' });

function isPdf(entry) {
  return entry.isFile() && entry.name.toLowerCase().endsWith('.pdf') && !entry.name.startsWith('.');
}

// Stars are keyed by base name (like notes), so a star survives moves between
// collections. The file lives in the library so stars travel with it and the
// assistant can read (or edit) them.
function starsPath(lib) {
  return path.join(lib, '.papyr', 'stars.json');
}

async function loadStars(lib) {
  try {
    const list = JSON.parse(await fs.readFile(starsPath(lib), 'utf8'));
    return new Set(Array.isArray(list) ? list.filter((s) => typeof s === 'string') : []);
  } catch {
    return new Set();
  }
}

async function saveStars(lib, stars) {
  await writeAtomic(starsPath(lib), JSON.stringify([...stars].sort(), null, 2) + '\n');
}

async function setStarred(lib, base, starred) {
  assertBase(base);
  const stars = await loadStars(lib);
  if (starred) stars.add(base);
  else stars.delete(base);
  await saveStars(lib, stars);
}

// Collections are one-level subdirectories of papers/. Returns every paper with its
// collection ('' = library root) plus all collection names, including empty ones.
async function listPapers(lib) {
  let entries;
  try {
    entries = await fs.readdir(papersDir(lib), { withFileTypes: true });
  } catch {
    return { papers: [], collections: [] };
  }
  const toPaper = (entry, collection) => ({
    base: entry.name.slice(0, -4),
    fileName: entry.name,
    collection,
    relPath: collection ? `${collection}/${entry.name}` : entry.name,
  });
  const papers = entries.filter(isPdf).map((e) => toPaper(e, ''));
  const collections = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  for (const collection of collections) {
    let sub;
    try {
      sub = await fs.readdir(path.join(papersDir(lib), collection), { withFileTypes: true });
    } catch {
      continue;
    }
    papers.push(...sub.filter(isPdf).map((e) => toPaper(e, collection)));
  }
  const stars = await loadStars(lib);
  for (const paper of papers) paper.starred = stars.has(paper.base);
  return { papers: papers.sort(byBase), collections };
}

// Resolves a renderer-supplied paper path (fileName or collection/fileName),
// guaranteed to stay inside papers/.
function paperPath(lib, relPath) {
  if (typeof relPath !== 'string' || relPath.includes('\0')) throw new Error('Invalid paper path');
  const segments = relPath.split('/');
  if (segments.length > 2) throw new Error('Invalid paper path');
  segments.forEach(assertBase);
  return path.join(papersDir(lib), ...segments);
}

async function assertAbsent(p, message) {
  try {
    await fs.access(p);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  throw new Error(message);
}

// Renames the PDF and its paired note together so the pairing never breaks.
async function renamePaper(lib, relPath, newBase) {
  assertBase(newBase);
  const from = paperPath(lib, relPath);
  const collection = relPath.includes('/') ? relPath.split('/')[0] : '';
  const oldBase = path.basename(from, '.pdf');
  const newFileName = `${newBase}.pdf`;
  if (newBase === oldBase) return { relPath, base: oldBase, fileName: newFileName, noteContent: null };
  const to = path.join(path.dirname(from), newFileName);
  await assertAbsent(to, `"${newFileName}" already exists`);
  const oldNote = notePath(lib, oldBase);
  const newNote = notePath(lib, newBase);
  let noteContent = null;
  try {
    noteContent = await fs.readFile(oldNote, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (noteContent !== null) await assertAbsent(newNote, `note "${newBase}.md" already exists`);
  await fs.rename(from, to);
  if (noteContent !== null) await fs.rename(oldNote, newNote);
  const stars = await loadStars(lib);
  if (stars.delete(oldBase)) {
    stars.add(newBase);
    await saveStars(lib, stars);
  }
  return {
    relPath: collection ? `${collection}/${newFileName}` : newFileName,
    base: newBase,
    fileName: newFileName,
    noteContent,
  };
}

async function movePaper(lib, relPath, targetCollection) {
  if (targetCollection !== '') assertBase(targetCollection);
  const from = paperPath(lib, relPath);
  const fileName = path.basename(from);
  const toRel = targetCollection ? `${targetCollection}/${fileName}` : fileName;
  const to = paperPath(lib, toRel);
  if (from === to) return { relPath: toRel };
  try {
    await fs.access(to);
    throw new Error(`"${fileName}" already exists in ${targetCollection || 'the library root'}`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await fs.rename(from, to);
  return { relPath: toRel };
}

async function createCollection(lib, name) {
  assertBase(name);
  await fs.mkdir(path.join(papersDir(lib), name), { recursive: true });
}

async function renameCollection(lib, oldName, newName) {
  assertBase(oldName);
  assertBase(newName);
  const from = path.join(papersDir(lib), oldName);
  const to = path.join(papersDir(lib), newName);
  try {
    await fs.access(to);
    throw new Error(`"${newName}" already exists`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await fs.rename(from, to);
}

function notePath(lib, base) {
  assertBase(base);
  return path.join(notesDir(lib), base + '.md');
}

async function loadNote(lib, base) {
  const p = notePath(lib, base);
  try {
    return { content: await fs.readFile(p, 'utf8'), path: p };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const content = `# ${base}\n\n`;
    await writeAtomic(p, content);
    return { content, path: p, created: true };
  }
}

async function saveNote(lib, base, content) {
  const p = notePath(lib, base);
  await writeAtomic(p, content);
  return { path: p };
}

async function readNote(lib, base) {
  return fs.readFile(notePath(lib, base), 'utf8');
}

// ---- Workspace documents ---------------------------------------------------
// A workspace is a folder of markdown (proposals, journal, ideas...) with no
// papers/ tree. Documents are addressed by path relative to the folder.
const DOC_IGNORE = new Set(['papers', 'notes', 'node_modules', 'site', 'reading-notes', 'dist', 'build']);
const DOC_MAX_DEPTH = 4;

function isDocIgnoredTop(name) {
  return name.startsWith('.') || DOC_IGNORE.has(name);
}

async function listDocs(folder) {
  const docs = [];
  async function walk(dir, rel, depth) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
      if (e.isSymbolicLink()) continue; // never follow links out of the folder
      if (depth === 0 && isDocIgnoredTop(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < DOC_MAX_DEPTH) await walk(path.join(dir, e.name), r, depth + 1);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        docs.push({ rel: r, name: e.name.slice(0, -3) });
      }
    }
  }
  await walk(folder, '', 0);
  docs.sort((a, b) => a.rel.localeCompare(b.rel, undefined, { sensitivity: 'base' }));
  return docs;
}

// A document path: relative, .md, no dot segments, inside the folder.
function docPath(folder, rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\0') || path.isAbsolute(rel)) {
    throw new Error(`Invalid document path: ${JSON.stringify(rel)}`);
  }
  const segments = rel.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.') || s.includes('\\'))) {
    throw new Error(`Invalid document path: ${JSON.stringify(rel)}`);
  }
  if (!rel.toLowerCase().endsWith('.md') || isDocIgnoredTop(segments[0])) {
    throw new Error(`Not a workspace document: ${JSON.stringify(rel)}`);
  }
  const abs = path.resolve(folder, ...segments);
  if (!abs.startsWith(path.resolve(folder) + path.sep)) throw new Error('Path escapes the folder');
  return abs;
}

async function loadDoc(folder, rel) {
  const p = docPath(folder, rel);
  return { content: await fs.readFile(p, 'utf8'), path: p };
}

async function saveDoc(folder, rel, content) {
  const p = docPath(folder, rel);
  await writeAtomic(p, content);
  return { path: p };
}

// A dated entry, following the journal convention: the global day file
// journal/<date>.md holds one line per project entry; a project entry
// projects/<slug>/journal/<date>.md links back to its day. Existing files are
// left alone; a missing day line is added. Returns the entry's rel path.
async function newEntry(folder, { project = null, date = null } = {}) {
  const d = date || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('Bad date');
  const dayRel = `journal/${d}.md`;
  const dayAbs = docPath(folder, dayRel);
  const exists = async (p) => fs.access(p).then(() => true, () => false);
  const dayHeader = `---\ndate: ${d}\n---\n\n## Projects\n\n## Other\n- \n`;
  if (!(await exists(dayAbs))) {
    await fs.mkdir(path.dirname(dayAbs), { recursive: true });
    await writeAtomic(dayAbs, dayHeader);
  }
  if (!project) return dayRel;
  if (!/^[A-Za-z0-9._-]+$/.test(project)) throw new Error('Bad project slug');
  const entryRel = `projects/${project}/journal/${d}.md`;
  const entryAbs = docPath(folder, entryRel);
  if (!(await exists(entryAbs))) {
    await fs.mkdir(path.dirname(entryAbs), { recursive: true });
    await writeAtomic(entryAbs, `---\ndate: ${d}\nproject: ${project}\nday: ../../../journal/${d}.md\n---\n\n`);
  }
  const line = `- [${project}](../projects/${project}/journal/${d}.md): `;
  let day = await fs.readFile(dayAbs, 'utf8');
  if (!day.includes(`](../projects/${project}/journal/${d}.md)`)) {
    day = day.includes('## Projects\n')
      ? day.replace('## Projects\n', `## Projects\n${line}\n`)
      : `${day.replace(/\n*$/, '\n')}\n## Projects\n${line}\n`;
    await writeAtomic(dayAbs, day);
  }
  return entryRel;
}

// Tells the claude session which paper the user is viewing (see CLAUDE.md).
async function writeState(lib, state) {
  // A workspace folder has no .papyr/ until the first selection; create it.
  await fs.mkdir(path.join(lib, '.papyr'), { recursive: true });
  await writeAtomic(path.join(lib, '.papyr', 'state.json'), JSON.stringify(state, null, 2) + '\n');
}

async function writeAtomic(p, content) {
  const tmp = p + TMP_SUFFIX;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, p);
}

module.exports = {
  assertBase,
  listPapers,
  movePaper,
  renamePaper,
  createCollection,
  renameCollection,
  paperPath,
  loadNote,
  saveNote,
  readNote,
  writeState,
  listDocs,
  docPath,
  loadDoc,
  saveDoc,
  newEntry,
  isDocIgnoredTop,
  papersDir,
  notesDir,
  notePath,
  starsPath,
  loadStars,
  saveStars,
  setStarred,
  TMP_SUFFIX,
};
