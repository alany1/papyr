// One session per window: which folder it shows, of which kind, plus the
// process-side state that belongs to that window (assistant pty, file watcher,
// what is on screen). IPC handlers look their session up by the sender.
const sessions = new Map(); // webContents.id -> session

function add(session) {
  // Captured now: by the time the window's 'closed' fires, its webContents is
  // destroyed and reading .id throws.
  session.contentsId = session.win.webContents.id;
  sessions.set(session.contentsId, session);
  return session;
}

function remove(session) {
  sessions.delete(session.contentsId);
}

function byContents(webContents) {
  return sessions.get(webContents.id) || null;
}

function byKind(kind) {
  for (const s of sessions.values()) if (s.kind === kind) return s;
  return null;
}

function all() {
  return [...sessions.values()];
}

module.exports = { add, remove, byContents, byKind, all };
