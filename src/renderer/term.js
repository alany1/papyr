const TermPane = (() => {
  let term = null;
  let fitAddon = null;
  let restartArmed = false;

  function fit() {
    if (!fitAddon) return;
    const pane = document.getElementById('term-pane');
    if (pane.clientWidth === 0 || pane.clientHeight === 0) return; // minimized
    fitAddon.fit();
    window.papyr.term.resize({ cols: term.cols, rows: term.rows });
  }

  async function start() {
    fitAddon.fit();
    await window.papyr.term.start({ cols: term.cols, rows: term.rows });
  }

  // Kill any running session and start a fresh one (used after a library change).
  async function restart() {
    restartArmed = false;
    await window.papyr.term.kill?.();
    term.reset();
    await start();
  }

  function init() {
    term = new Terminal({
      fontSize: 12.5,
      fontFamily: '"SF Mono", Menlo, Monaco, monospace',
      lineHeight: 1.15,
      scrollback: 5000,
      macOptionIsMeta: true,
      cursorBlink: true,
      // warm lofi palette to match the app chrome
      theme: {
        background: '#241f1a',
        foreground: '#eadfcd',
        cursor: '#e0a370',
        cursorAccent: '#241f1a',
        selectionBackground: 'rgba(224, 163, 112, 0.25)',
        black: '#3b332a',
        red: '#d98177',
        green: '#a8b87c',
        yellow: '#e0c07c',
        blue: '#9db1c7',
        magenta: '#c39ab4',
        cyan: '#93bfb4',
        white: '#eadfcd',
        brightBlack: '#6d6153',
        brightRed: '#e89d94',
        brightGreen: '#bccf90',
        brightYellow: '#efd396',
        brightBlue: '#b5c8de',
        brightMagenta: '#d7b2c9',
        brightCyan: '#abd6cb',
        brightWhite: '#f6eee0',
      },
    });
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('term'));

    // Shift+Enter sends the same \r as Enter in a plain terminal, so claude
    // submits instead of inserting a newline. Send ESC+CR (what claude's
    // /terminal-setup configures in iTerm/VS Code) to mean "newline".
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type === 'keydown' && ev.key === 'Enter' && ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        window.papyr.term.input('\x1b\r');
        return false;
      }
      return true;
    });

    term.onData((data) => {
      if (restartArmed) {
        restartArmed = false;
        term.reset();
        start().catch(console.error);
        return;
      }
      window.papyr.term.input(data);
    });

    window.papyr.term.onData((data) => term.write(data));
    window.papyr.term.onExit(({ exitCode }) => {
      term.write(`\r\n\x1b[2m[claude exited (code ${exitCode}) — press any key to restart]\x1b[0m\r\n`);
      restartArmed = true;
    });

    new ResizeObserver(() => fit()).observe(document.getElementById('term-pane'));

    return start();
  }

  function focus() {
    term?.focus();
  }

  // Insert text into the assistant's input line (single line, as if typed)
  function insert(text) {
    window.papyr.term.input(text);
  }

  return { init, restart, fit, focus, insert };
})();
