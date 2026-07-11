const pty = require('node-pty');

// Run claude through a login+interactive shell so the user's PATH (e.g. Homebrew)
// is available even though GUI-launched Electron gets a minimal environment.
const LAUNCH_CMD =
  'if command -v claude >/dev/null 2>&1; then exec claude; ' +
  'else echo "papyr: claude CLI not found on PATH."; ' +
  'echo "Install Claude Code, then press any key here to retry."; exit 127; fi';

let proc = null;
let onData = null;
let onExit = null;

function setHandlers(handlers) {
  onData = handlers.onData;
  onExit = handlers.onExit;
}

function isRunning() {
  return proc !== null;
}

function start({ cols, rows, cwd }) {
  if (proc) return { ok: true, alreadyRunning: true };
  const shell = process.env.SHELL || '/bin/zsh';
  const p = pty.spawn(shell, ['-il', '-c', LAUNCH_CMD], {
    name: 'xterm-256color',
    cols: Math.max(2, cols || 80),
    rows: Math.max(2, rows || 24),
    cwd,
    env: { ...process.env, COLORTERM: 'truecolor' },
  });
  proc = p;
  p.onData((data) => {
    if (proc === p && onData) onData(data);
  });
  p.onExit((info) => {
    if (proc === p) {
      proc = null;
      if (onExit) onExit(info);
    }
  });
  return { ok: true };
}

function write(data) {
  if (proc) proc.write(data);
}

function resize({ cols, rows }) {
  if (!proc) return;
  try {
    proc.resize(Math.max(2, cols), Math.max(2, rows));
  } catch {
    // pty may have just exited; ignore
  }
}

// Silent kill: detaches first so onExit is not reported to the renderer.
function kill() {
  if (!proc) return;
  const p = proc;
  proc = null;
  try {
    p.kill();
  } catch {
    // already dead
  }
}

module.exports = { setHandlers, start, write, resize, kill, isRunning };
