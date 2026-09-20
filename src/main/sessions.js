// One session per window: which folder it shows, of which kind, plus the
// process-side state that belongs to that window (assistant pty, file watcher,
// what is on screen). IPC handlers look their session up by the sender.
const sessions = new Map(); // webContents.id -> session

function add(session) {
  sessions.set(session.win.webContents.id, session);
  return session;
}

function remove(session) {
  sessions.delete(session.win.webContents.id);
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
