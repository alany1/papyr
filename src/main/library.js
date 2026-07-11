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

// Tells the claude session which paper the user is viewing (see CLAUDE.md).
async function writeState(lib, state) {
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
  papersDir,
  notesDir,
  notePath,
  TMP_SUFFIX,
};
