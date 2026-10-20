// Tiny DOM helpers. User data only ever goes in via textContent (h() strings
// become text nodes), never innerHTML.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

// replaceChildren() that skips null/false and flattens arrays, like h().
export function fill(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

// ---------- bottom sheet ----------

let openSheet = null;

export function isSheetOpen() {
  return !!openSheet;
}

export function closeSheet() {
  if (!openSheet) return;
  const { backdrop, onClose, restoreFocus } = openSheet;
  openSheet = null;
  backdrop.remove();
  document.removeEventListener('keydown', escHandler);
  if (onClose) onClose();
  if (restoreFocus && restoreFocus.focus) restoreFocus.focus();
}

function escHandler(e) {
  if (e.key === 'Escape') closeSheet();
}

// Show a sheet. `content` is a node or a function(close) returning a node.
export function sheet(title, content, { onClose, label } = {}) {
  closeSheet();
  const restoreFocus = document.activeElement;
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': label || title });
  const backdrop = h('div', { class: 'sheet-backdrop' }, panel);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeSheet();
  });
  panel.append(h('h2', {}, title));
  panel.append(typeof content === 'function' ? content(closeSheet) : content);
  document.getElementById('sheet-root').append(backdrop);
  openSheet = { backdrop, onClose, restoreFocus };
  document.addEventListener('keydown', escHandler);
  const first = panel.querySelector('input, textarea, select, button');
  if (first) first.focus();
  return panel;
}

// Ask a question with buttons; resolves with the chosen value (or null).
export function choose(title, message, options) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      closeSheet();
      resolve(v);
    };
    sheet(title, () => h('div', {},
      message ? (message instanceof Node ? message : h('p', {}, message)) : null,
      h('div', { class: 'sheet-actions' }, options.map((o) => h('button', { class: o.primary ? 'primary' : o.danger ? 'danger' : '', onclick: () => finish(o.value) }, o.label))),
    ), { onClose: () => finish(null) });
  });
}

// Ask for one line of text.
export function prompt(title, { label = '', value = '', placeholder = '', ok = 'Save' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { type: 'text', value, placeholder, 'aria-label': label || title });
    const finish = (v) => {
      if (done) return;
      done = true;
      closeSheet();
      resolve(v);
    };
    sheet(title, () => h('form', { onsubmit: (e) => { e.preventDefault(); finish(input.value.trim()); } },
      label ? h('label', {}, label) : null,
      input,
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', onclick: () => finish(null) }, 'Cancel'),
        h('button', { type: 'submit', class: 'primary' }, ok)),
    ), { onClose: () => finish(null) });
  });
}

// ---------- toast and banner ----------

let toastTimer;
export function toast(message, ms = 3200) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

// kind: 'error' | 'offline' | 'signedout'; pass null to hide.
export function banner(kind, message, action) {
  const el = document.getElementById('banner');
  clear(el);
  if (!kind) {
    el.hidden = true;
    el.className = 'banner';
    return;
  }
  el.className = `banner ${kind}`;
  el.dataset.kind = kind;
  el.append(h('span', {}, message));
  if (action) el.append(h('button', { class: 'small-btn', onclick: action.onClick }, action.label));
  el.hidden = false;
}

export function stepper(value, { min = 1, max = 20, label = 'Servings', onChange }) {
  return h('span', { class: 'stepper', role: 'group', 'aria-label': label },
    h('button', { type: 'button', 'aria-label': `Fewer ${label.toLowerCase()}`, disabled: value <= min, onclick: () => onChange(value - 1) }, '−'),
    h('span', { class: 'val', 'aria-live': 'polite' }, String(value)),
    h('button', { type: 'button', 'aria-label': `More ${label.toLowerCase()}`, disabled: value >= max, onclick: () => onChange(value + 1) }, '+'),
  );
}

export function personName(email, me) {
  if (!email) return 'Someone';
  if (me && email === me) return 'You (on another screen)';
  const local = email.split('@')[0];
  return local.charAt(0).toUpperCase() + local.slice(1);
}

export function timeOf(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function dateTimeOf(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
