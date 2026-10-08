// Central keyboard-shortcut registry + the ⌨ panel to view and rebind them.
//
// A combo is stored as "Mod+Alt+Shift+<Key>" where Mod means ⌘ on mac / Ctrl
// elsewhere and <Key> is a KeyboardEvent.code with its Key/Digit prefix
// stripped ("B", "K", "Enter"). Overrides persist in config as ui.shortcuts
// ({actionId: combo}); an absent entry means the default, "" means unbound.
// An action may ship with no default combo (null) — it only fires once the
// user assigns one in the panel.
const Shortcuts = (() => {
  const IS_MAC = navigator.platform.startsWith('Mac');
  const actions = []; // {id, label, combo, handler, fixed}
  let overrides = {};
  let onChange = null;
  let capturing = null; // action id currently being rebound

  function eventCombo(ev) {
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(ev.key)) return null;
    let key = ev.code.replace(/^(Key|Digit)/, '');
    // synthetic KeyboardEvents (tests) may carry no code — fall back to key
    if (!key) key = (ev.key || '').length === 1 ? ev.key.toUpperCase() : ev.key || '';
    if (!key) return null;
    const parts = [];
    if (ev.metaKey || ev.ctrlKey) parts.push('Mod');
    if (ev.altKey) parts.push('Alt');
    if (ev.shiftKey) parts.push('Shift');
    parts.push(key);
    return parts.join('+');
  }

  const KEY_GLYPHS = { Enter: '↩', Escape: '⎋', Backspace: '⌫', Space: '␣', Tab: '⇥',
    Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';',
    Quote: "'", BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=',
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' };

  function display(combo) {
    const parts = combo.split('+');
    const key = parts.pop();
    const pretty = KEY_GLYPHS[key] || key;
    if (IS_MAC) {
      return (
        parts.map((m) => ({ Mod: '⌘', Alt: '⌥', Shift: '⇧' })[m]).join('') + pretty
      );
    }
    return [...parts.map((m) => (m === 'Mod' ? 'Ctrl' : m)), pretty].join('+');
  }

  const comboFor = (id) => {
    const a = actions.find((a) => a.id === id);
    if (id in overrides) return overrides[id] || null;
    return a.combo || null;
  };
  const displayFor = (id) => {
    const combo = comboFor(id);
    return combo ? display(combo) : 'unbound';
  };
  // A combo is bindable if it can't fire while typing: needs ⌘/⌥, or is Tab.
  const bindable = (combo) => /\bMod\b|\bAlt\b/.test(combo) || /^(Shift\+)?Tab$/.test(combo);

  function add(id, label, combo, handler, opts = {}) {
    actions.push({ id, label, combo, handler, fixed: !!opts.fixed });
  }

  function init(saved, changed) {
    overrides = saved && typeof saved === 'object' ? { ...saved } : {};
    onChange = changed;

    window.addEventListener('keydown', (ev) => {
      if (capturing) return; // the capture listener owns the keyboard
      const combo = eventCombo(ev);
      if (!combo) return;
      if (trigger(combo)) ev.preventDefault();
    });

    initPanel();
  }

  // Run the action bound to `combo` (if any); true when one fired. Also used
  // for combos relayed from the PDF frame, which has its own keyboard.
  function trigger(combo) {
    const action = actions.find((a) => !a.fixed && a.handler && comboFor(a.id) === combo);
    if (!action) return false;
    action.handler();
    return true;
  }

  // combo: a combo string, "" to unbind, or null to reset to the default.
  function setOverride(id, combo) {
    const a = actions.find((a) => a.id === id);
    if (combo === null || combo === (a.combo || '')) delete overrides[id];
    else overrides[id] = combo;
    window.papyr.setUi({ shortcuts: overrides });
    if (onChange) onChange();
  }

  // ---- panel ----
  const overlay = () => document.getElementById('shortcuts-overlay');

  function renderList() {
    const list = document.getElementById('shortcuts-list');
    list.textContent = '';
    for (const a of actions) {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.className = 'sc-label';
      label.textContent = a.label;
      li.appendChild(label);

      const note = document.createElement('span');
      note.className = 'sc-note';
      li.appendChild(note);

      if (a.fixed) {
        const kbd = document.createElement('kbd');
        kbd.className = 'sc-combo sc-fixed';
        kbd.textContent = display(a.combo);
        li.appendChild(kbd);
      } else {
        if (a.id in overrides) {
          const reset = document.createElement('button');
          reset.className = 'sc-reset';
          reset.title = a.combo ? `Reset to ${display(a.combo)}` : 'Reset (unbound by default)';
          reset.textContent = '↺';
          reset.addEventListener('click', () => {
            setOverride(a.id, null);
            renderList();
          });
          li.appendChild(reset);
        }
        const btn = document.createElement('button');
        btn.className = 'sc-combo';
        btn.classList.toggle('sc-unbound', !comboFor(a.id));
        btn.textContent = displayFor(a.id);
        btn.title = 'Click, then press the new shortcut (⌫ unbinds)';
        btn.addEventListener('click', () => startCapture(a.id, btn, note));
        li.appendChild(btn);
      }
      list.appendChild(li);
    }
  }

  function startCapture(id, btn, note) {
    if (capturing) return;
    capturing = id;
    btn.classList.add('capturing');
    btn.textContent = 'press keys…';
    note.textContent = '';

    const done = () => {
      capturing = null;
      window.removeEventListener('keydown', onKey, true);
      renderList();
    };
    const onKey = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.key === 'Escape') return done();
      if ((ev.key === 'Backspace' || ev.key === 'Delete') && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        setOverride(id, '');
        return done();
      }
      const combo = eventCombo(ev);
      if (!combo) return; // bare modifier — keep waiting
      if (!bindable(combo)) {
        note.textContent = 'use ⌘ or ⌥ (or ⇥)';
        return;
      }
      const clash = actions.find((a) => a.id !== id && comboFor(a.id) === combo);
      if (clash) {
        note.textContent = `in use: ${clash.label}`;
        return;
      }
      setOverride(id, combo);
      done();
    };
    window.addEventListener('keydown', onKey, true);
  }

  function setOpen(open) {
    if (open) renderList();
    overlay().hidden = !open;
  }

  function initPanel() {
    document.getElementById('shortcuts-btn').addEventListener('click', () => setOpen(true));
    document.getElementById('shortcuts-close').addEventListener('click', () => setOpen(false));
    overlay().addEventListener('click', (e) => {
      if (e.target === overlay()) setOpen(false);
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !capturing && !overlay().hidden) setOpen(false);
    });
  }

  return { init, add, comboFor, displayFor, trigger };
})();
