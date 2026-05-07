// ==UserScript==
// @name         Vimium-lite
// @namespace    local.vimium.lite
// @version      0.1.1
// @description  Vim-style keyboard navigation in the spirit of the Vimium extension, packed into a single userscript. Implements link hints, scroll, find, history, marks, copy, and count prefixes. Tab/bookmark/vomnibar commands are intentionally omitted — they need extension APIs a userscript can't reach.
// @match        *://*/*
// @exclude      https://x.com/*
// @exclude      https://*.x.com/*
// @grant        GM_setClipboard
// @grant        GM_openInTab
// @run-at       document-end
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ---------- Configuration ----------

  // Home-row letters used for link hint codes. Order matters: leading chars
  // are preferred for shorter hints, so put the easiest-to-reach keys first.
  const HINT_CHARS = 'sadfjklewcmpgh';
  const SCROLL_STEP = 60;
  const STYLE_ID = 'tm-vimium-lite-style';
  const HUD_ID = 'tm-vimium-lite-hud';
  const HINT_LAYER_ID = 'tm-vimium-lite-hints';
  const HELP_ID = 'tm-vimium-lite-help';
  const FIND_ID = 'tm-vimium-lite-find';

  // Sequences that wait for a follow-up key. Anything starting with these is
  // buffered until either a known binding matches or the sequence is aborted.
  const PREFIX_KEYS = new Set(['g', 'y', 'z', '[', ']']);

  // ---------- Mode state ----------

  const state = {
    mode: 'normal',      // normal | insert | find | hints
    cmd: '',             // pending key sequence (e.g. "g" waiting for "g")
    count: '',           // digit prefix buffer ("5" before "j")
    awaitingMark: null,  // 'set' after `m`, 'jump' after `\``
    marks: new Map(),    // letter -> {x, y, url}
    lastFind: '',
    hudTimer: 0
  };

  // ---------- Style ----------

  const css = `
    #${HUD_ID} {
      position: fixed; left: 0; bottom: 0; z-index: 2147483646;
      background: #2a2a2a; color: #fff; font: 12px/1.4 system-ui, sans-serif;
      padding: 4px 10px; border-top-right-radius: 4px;
      pointer-events: none; max-width: 60vw;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #${HINT_LAYER_ID} {
      position: fixed; inset: 0; z-index: 2147483646; pointer-events: none;
    }
    .tm-vl-hint {
      position: absolute; background: #ffd76b; color: #000;
      font: bold 11px/1 ui-monospace, Menlo, monospace;
      padding: 2px 4px; border: 1px solid #b59300; border-radius: 3px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.4);
      text-transform: uppercase;
    }
    .tm-vl-hint .tm-vl-typed { color: #888; }
    #${FIND_ID} {
      position: fixed; left: 0; bottom: 0; z-index: 2147483647;
      background: #1c1c1c; color: #fff; font: 14px/1.4 system-ui, sans-serif;
      padding: 6px 10px; border-top-right-radius: 4px;
      display: flex; gap: 6px; align-items: center; min-width: 320px;
    }
    #${FIND_ID} input {
      flex: 1; background: transparent; border: none; outline: none;
      color: #fff; font: inherit;
    }
    #${HELP_ID} {
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(0,0,0,0.55); display: flex;
      align-items: center; justify-content: center;
    }
    #${HELP_ID} .tm-vl-help-card {
      background: #fafafa; color: #111; max-width: 720px; width: 90vw;
      max-height: 80vh; overflow: auto; padding: 18px 24px;
      border-radius: 6px; font: 13px/1.5 system-ui, sans-serif;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    #${HELP_ID} h2 { margin: 0 0 12px; font-size: 16px; }
    #${HELP_ID} h3 { margin: 14px 0 4px; font-size: 13px; color: #555; }
    #${HELP_ID} table { border-collapse: collapse; width: 100%; }
    #${HELP_ID} td { padding: 2px 8px; vertical-align: top; }
    #${HELP_ID} td:first-child {
      font-family: ui-monospace, Menlo, monospace; color: #b34;
      width: 80px; white-space: nowrap;
    }
    #${HELP_ID} .tm-vl-note { color: #888; font-size: 12px; margin-top: 14px; }
  `;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  // ---------- HUD ----------

  function hud(msg, ttl = 1500) {
    let el = document.getElementById(HUD_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = HUD_ID;
      document.documentElement.appendChild(el);
    }
    el.textContent = msg;
    el.style.display = msg ? '' : 'none';
    clearTimeout(state.hudTimer);
    if (ttl) state.hudTimer = setTimeout(() => { el.style.display = 'none'; }, ttl);
  }

  // ---------- Editable / mode helpers ----------

  function isEditable(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const t = (el.type || '').toLowerCase();
      // Don't treat checkboxes/buttons/etc. as text-entry; they shouldn't
      // disable Vimium bindings just because they're focused.
      return !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image'].includes(t);
    }
    return tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function inPassThrough() {
    return state.mode === 'insert' || isEditable(document.activeElement);
  }

  function exitMode() {
    state.cmd = '';
    state.count = '';
    state.awaitingMark = null;
    if (state.mode === 'hints') hideHints();
    if (state.mode === 'find') hideFindBar(false);
    if (state.mode === 'insert') hud('');
    state.mode = 'normal';
  }

  // ---------- Scrolling ----------

  function scrollTarget() {
    let el = document.activeElement;
    while (el && el !== document.body) {
      const cs = getComputedStyle(el);
      if (/(auto|scroll|overlay)/.test(cs.overflowY)
          && el.scrollHeight > el.clientHeight) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function scrollBy(dx, dy) { scrollTarget().scrollBy({ top: dy, left: dx }); }

  function scrollToY(y) {
    const t = scrollTarget();
    t.scrollTo({ top: y, left: t.scrollLeft });
  }

  function scrollToX(x) {
    const t = scrollTarget();
    t.scrollTo({ top: t.scrollTop, left: x });
  }

  // ---------- Clipboard ----------

  function copyText(text) {
    if (typeof GM_setClipboard === 'function') {
      GM_setClipboard(text);
      return true;
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
      return true;
    }
    return false;
  }

  // ---------- Open URL in new tab ----------

  function openInNewTab(url) {
    if (typeof GM_openInTab === 'function') {
      GM_openInTab(url, { active: false, insert: true });
    } else {
      window.open(url, '_blank', 'noopener');
    }
  }

  // ---------- Link hints ----------

  const HINT_SELECTOR = [
    'a[href]', 'button', 'input:not([type="hidden"]):not([disabled])',
    'textarea:not([disabled])', 'select:not([disabled])', 'summary',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="menuitem"]',
    '[role="radio"]', '[role="tab"]', '[role="option"]',
    '[onclick]', '[tabindex]:not([tabindex="-1"])',
    '[contenteditable=""]', '[contenteditable="true"]'
  ].join(',');

  function visibleClickables() {
    const out = [];
    const seen = new Set();
    const els = document.querySelectorAll(HINT_SELECTOR);
    const vw = innerWidth, vh = innerHeight;
    for (const el of els) {
      if (seen.has(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      if (parseFloat(cs.opacity) === 0) continue;
      const rects = el.getClientRects();
      if (!rects.length) continue;
      // Use the first rect that's actually inside the viewport.
      let rect = null;
      for (const r of rects) {
        if (r.width < 3 || r.height < 3) continue;
        if (r.bottom < 0 || r.top > vh) continue;
        if (r.right < 0 || r.left > vw) continue;
        rect = r; break;
      }
      if (!rect) continue;
      seen.add(el);
      out.push({ el, rect });
    }
    return out;
  }

  // Generate hint codes such that no code is a prefix of another. With L
  // characters in the alphabet and N targets, prefixCount of those characters
  // become 2-letter prefixes; the rest stay as 1-letter hints. This keeps
  // common targets reachable in a single keypress.
  function generateCodes(n, alphabet = HINT_CHARS) {
    const L = alphabet.length;
    if (n === 0) return [];
    if (n <= L) return alphabet.slice(0, n).split('');
    const prefixCount = Math.min(L, Math.ceil((n - L) / (L - 1)));
    const codes = [];
    // Single-letter hints come from the END so the popular early letters
    // become prefixes and yield shorter overall codes for clusters.
    const singles = alphabet.slice(prefixCount).split('');
    const prefixes = alphabet.slice(0, prefixCount).split('');
    for (const p of prefixes) {
      for (const c of alphabet) {
        codes.push(p + c);
        if (codes.length + singles.length >= n) break;
      }
      if (codes.length + singles.length >= n) break;
    }
    for (const s of singles) {
      if (codes.length >= n) break;
      codes.push(s);
    }
    return codes.slice(0, n);
  }

  let hintCtx = null;

  function showHints({ openIn = 'self' } = {}) {
    const targets = visibleClickables();
    if (!targets.length) { hud('No hintable elements'); return; }

    const codes = generateCodes(targets.length);
    // Sort hints so closest-to-viewport-center elements get the shorter codes.
    const cx = innerWidth / 2, cy = innerHeight / 2;
    targets.sort((a, b) => {
      const da = Math.hypot(a.rect.left + a.rect.width / 2 - cx,
                            a.rect.top + a.rect.height / 2 - cy);
      const db = Math.hypot(b.rect.left + b.rect.width / 2 - cx,
                            b.rect.top + b.rect.height / 2 - cy);
      return da - db;
    });
    // Match codes (shorter first) to closest targets.
    codes.sort((a, b) => a.length - b.length || a.localeCompare(b));

    const layer = document.createElement('div');
    layer.id = HINT_LAYER_ID;
    document.documentElement.appendChild(layer);

    const items = targets.map((t, i) => {
      const code = codes[i];
      const tag = document.createElement('span');
      tag.className = 'tm-vl-hint';
      tag.dataset.code = code;
      tag.textContent = code;
      tag.style.left = `${Math.max(0, t.rect.left)}px`;
      tag.style.top = `${Math.max(0, t.rect.top)}px`;
      layer.appendChild(tag);
      return { code, el: t.el, tag };
    });

    state.mode = 'hints';
    hintCtx = { items, typed: '', openIn, layer };
    hud(`Hints: type code (Esc to cancel) — ${openIn === 'tab' ? 'opens in new tab' : openIn === 'copy' ? 'copies link URL' : 'activates'}`);
  }

  function hideHints() {
    if (hintCtx?.layer) hintCtx.layer.remove();
    hintCtx = null;
    state.mode = 'normal';
    hud('');
  }

  function refilterHints() {
    if (!hintCtx) return;
    const typed = hintCtx.typed;
    let remaining = 0;
    let last = null;
    for (const it of hintCtx.items) {
      if (it.code === typed) {
        last = it;
        it.tag.style.display = '';
      } else if (it.code.startsWith(typed)) {
        remaining++;
        it.tag.innerHTML = `<span class="tm-vl-typed">${typed}</span>${it.code.slice(typed.length)}`;
        it.tag.style.display = '';
      } else {
        it.tag.style.display = 'none';
      }
    }
    if (last && remaining === 0) activateHint(last);
  }

  function activateHint(item) {
    const { el } = item;
    const mode = hintCtx.openIn;
    hideHints();

    if (mode === 'copy') {
      const url = el.href || el.getAttribute('href');
      if (url) { copyText(new URL(url, location.href).href); hud('Copied link URL'); }
      else hud('No URL to copy');
      return;
    }

    if (mode === 'tab' && el.tagName === 'A' && el.href) {
      openInNewTab(el.href);
      return;
    }

    // Default: focus + click. Inputs/textareas just need focus.
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) {
      el.focus();
      return;
    }
    el.focus();
    el.click();
  }

  // ---------- Find ----------

  function showFindBar() {
    let bar = document.getElementById(FIND_ID);
    if (!bar) {
      bar = document.createElement('div');
      bar.id = FIND_ID;
      bar.innerHTML = `<span>/</span><input type="text" autocomplete="off" />`;
      document.documentElement.appendChild(bar);
      const input = bar.querySelector('input');
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          state.lastFind = input.value;
          hideFindBar(true);
          findNext(1);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          hideFindBar(false);
        }
        e.stopPropagation();
      });
      input.addEventListener('keyup', (e) => e.stopPropagation());
      input.addEventListener('keypress', (e) => e.stopPropagation());
    }
    bar.style.display = '';
    state.mode = 'find';
    const input = bar.querySelector('input');
    input.value = '';
    setTimeout(() => input.focus(), 0);
  }

  function hideFindBar(keepMode) {
    const bar = document.getElementById(FIND_ID);
    if (bar) bar.style.display = 'none';
    if (!keepMode) state.mode = 'normal';
  }

  // window.find() is non-standard but works in Chrome/Safari/Edge — exactly
  // the engines a userscript user is likely on. It scrolls to and selects
  // the next match, which is all we need.
  function findNext(direction) {
    if (!state.lastFind) { hud('No previous search'); return; }
    if (typeof window.find !== 'function') { hud('Find unsupported here'); return; }
    const found = window.find(state.lastFind, false, direction < 0, true, false, false, false);
    if (!found) hud(`Not found: ${state.lastFind}`);
  }

  // ---------- Help ----------

  const HELP_SECTIONS = [
    ['Movement', [
      ['h / j / k / l', 'scroll left / down / up / right'],
      ['d / u', 'scroll half page down / up'],
      ['gg / G', 'top / bottom (use NG to go to N% of page)'],
      ['zH / zL', 'scroll all the way left / right'],
    ]],
    ['Page', [
      ['r / R', 'reload / hard reload (cache-bypass)'],
      ['gs', 'view source'],
      ['yy', 'copy current URL'],
      ['gu / gU', 'go up one URL level / to root'],
      ['gi', 'focus first text input'],
      ['H / L', 'history back / forward'],
      [']] / [[', 'follow "next" / "prev" link'],
    ]],
    ['Links', [
      ['f / F', 'open link (current / new tab)'],
      ['yf', 'copy a link URL'],
    ]],
    ['Find', [
      ['/', 'open find bar'],
      ['n / N', 'next / previous match'],
    ]],
    ['Marks (local)', [
      ['m{a-z}', 'set mark on this page'],
      ['`{a-z}', 'jump to mark'],
    ]],
    ['Modes', [
      ['i', 'enter insert mode (Vimium ignores keys)'],
      ['Esc', 'exit any mode / clear pending command'],
      ['?', 'toggle this help'],
    ]],
    ['Counts', [
      ['N then cmd', 'repeat command N times (e.g. 5j, 10gg)'],
    ]]
  ];

  function toggleHelp() {
    const existing = document.getElementById(HELP_ID);
    if (existing) { existing.remove(); return; }
    const overlay = document.createElement('div');
    overlay.id = HELP_ID;
    let html = '<div class="tm-vl-help-card"><h2>Vimium-lite key bindings</h2>';
    for (const [section, rows] of HELP_SECTIONS) {
      html += `<h3>${section}</h3><table>`;
      for (const [k, d] of rows) html += `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(d)}</td></tr>`;
      html += '</table>';
    }
    html += '<p class="tm-vl-note">Tab and bookmark commands (t, x, T, o, b, etc.) require browser-extension APIs and are not implemented in this single-file userscript.</p>';
    html += '</div>';
    overlay.innerHTML = html;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.documentElement.appendChild(overlay);
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- "Next/prev" link heuristic for ]] / [[ ----------

  function followRel(direction) {
    const wantNext = direction > 0;
    const relName = wantNext ? 'next' : 'prev';
    const relLink = document.querySelector(`a[rel~="${relName}"]`);
    if (relLink) { relLink.click(); return; }
    const patterns = wantNext
      ? [/^\s*next\b/i, /^\s*more\b/i, /^\s*older\b/i, /^\s*>\s*$/, /^\s*»\s*$/]
      : [/^\s*prev(ious)?\b/i, /^\s*newer\b/i, /^\s*<\s*$/, /^\s*«\s*$/];
    const links = [...document.querySelectorAll('a, button')];
    for (const a of links) {
      const txt = (a.textContent || '').trim();
      if (patterns.some((re) => re.test(txt))) { a.click(); return; }
    }
    hud(`No "${relName}" link found`);
  }

  // ---------- URL hierarchy ----------

  function urlUp() {
    const u = new URL(location.href);
    if (u.pathname && u.pathname !== '/') {
      const parts = u.pathname.replace(/\/+$/, '').split('/');
      parts.pop();
      u.pathname = parts.join('/') || '/';
      u.search = ''; u.hash = '';
      location.href = u.toString();
    } else if (u.search || u.hash) {
      u.search = ''; u.hash = '';
      location.href = u.toString();
    }
  }

  function urlRoot() {
    const u = new URL(location.href);
    u.pathname = '/'; u.search = ''; u.hash = '';
    location.href = u.toString();
  }

  // ---------- Command dispatcher ----------

  function setMark(letter) {
    state.marks.set(letter, {
      x: scrollTarget().scrollLeft,
      y: scrollTarget().scrollTop,
      url: location.href
    });
    hud(`Mark "${letter}" set`);
  }

  function jumpMark(letter) {
    const m = state.marks.get(letter);
    if (!m) { hud(`Mark "${letter}" not set`); return; }
    if (m.url !== location.href) { hud('Mark on different page'); return; }
    const t = scrollTarget();
    t.scrollTo({ top: m.y, left: m.x });
  }

  function focusFirstInput() {
    const inputs = [...document.querySelectorAll('input, textarea, [contenteditable=""], [contenteditable="true"]')]
      .filter((el) => {
        if (el.disabled) return false;
        const t = (el.type || '').toLowerCase();
        if (t === 'hidden' || t === 'submit' || t === 'button') return false;
        return el.getClientRects().length > 0;
      });
    if (!inputs.length) { hud('No input found'); return; }
    inputs[0].focus();
  }

  // bindings: each value is (count) => void
  const bindings = {
    'h': (n) => scrollBy(-SCROLL_STEP * n, 0),
    'l': (n) => scrollBy(SCROLL_STEP * n, 0),
    'j': (n) => scrollBy(0, SCROLL_STEP * n),
    'k': (n) => scrollBy(0, -SCROLL_STEP * n),
    'd': (n) => scrollBy(0, (innerHeight / 2) * n),
    'u': (n) => scrollBy(0, -(innerHeight / 2) * n),
    'gg': (n, hadCount) => {
      // 5gg → scroll to 5% of page (vimium semantics).
      const t = scrollTarget();
      const max = t.scrollHeight - t.clientHeight;
      scrollToY(hadCount ? Math.min(max, max * (n / 100)) : 0);
    },
    'G': (_n, hadCount) => {
      const t = scrollTarget();
      const max = t.scrollHeight - t.clientHeight;
      scrollToY(hadCount ? Math.min(max, max * (_n / 100)) : max);
    },
    'zH': () => scrollToX(0),
    'zL': () => scrollToX(scrollTarget().scrollWidth),
    'r': () => location.reload(),
    'R': () => location.reload(true),
    'gs': () => { location.href = 'view-source:' + location.href; },
    'yy': () => { copyText(location.href); hud('Copied URL'); },
    'gu': () => urlUp(),
    'gU': () => urlRoot(),
    'gi': () => focusFirstInput(),
    'H': (n) => history.go(-n),
    'L': (n) => history.go(n),
    ']]': () => followRel(1),
    '[[': () => followRel(-1),
    'f': () => showHints({ openIn: 'self' }),
    'F': () => showHints({ openIn: 'tab' }),
    'yf': () => showHints({ openIn: 'copy' }),
    '/': () => showFindBar(),
    'n': (n) => { for (let i = 0; i < n; i++) findNext(1); },
    'N': (n) => { for (let i = 0; i < n; i++) findNext(-1); },
    'i': () => { state.mode = 'insert'; hud('-- INSERT -- (Esc to exit)', 0); },
    '?': () => toggleHelp()
  };

  function dispatch(seq, count, hadCount) {
    const fn = bindings[seq];
    if (!fn) return false;
    fn(count, hadCount);
    return true;
  }

  // ---------- Key event handling ----------

  function eventKeyToken(e) {
    // Bail on modifier-only events.
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null;
    // ctrl+[ is the conventional Vim "Esc".
    if (e.ctrlKey && e.key === '[') return 'Escape';
    if (e.key === 'Escape') return 'Escape';
    // Ignore other modified key combos — Vimium-lite doesn't bind them, and
    // we don't want to swallow browser shortcuts like ctrl+t.
    if (e.ctrlKey || e.altKey || e.metaKey) return null;
    if (e.key.length !== 1) return null;
    return e.key;
  }

  function onKeyDown(e) {
    // Hint-mode swallows everything aimed at hint codes.
    if (state.mode === 'hints') {
      const tok = eventKeyToken(e);
      if (tok === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); hideHints(); return; }
      if (!tok) return;
      const ch = tok.toLowerCase();
      if (!HINT_CHARS.includes(ch)) {
        e.preventDefault(); e.stopImmediatePropagation();
        hideHints();
        return;
      }
      e.preventDefault(); e.stopImmediatePropagation();
      hintCtx.typed += ch;
      refilterHints();
      return;
    }

    // Find mode is handled by the input's own listeners; just intercept Esc
    // at the document level so it bubbles even if input lost focus.
    if (state.mode === 'find') {
      if (e.key === 'Escape') { e.preventDefault(); hideFindBar(false); }
      return;
    }

    // Help dialog: Esc closes.
    if (document.getElementById(HELP_ID) && e.key === 'Escape') {
      e.preventDefault();
      document.getElementById(HELP_ID).remove();
      return;
    }

    const tok = eventKeyToken(e);
    if (!tok) return;

    // Esc always exits whatever mode you're in and clears buffers.
    if (tok === 'Escape') {
      if (state.mode === 'insert' || state.cmd || state.count || state.awaitingMark) {
        e.preventDefault(); e.stopImmediatePropagation();
        exitMode();
        return;
      }
      // Otherwise let the page handle Esc.
      return;
    }

    // In insert mode (manual or implicit), don't intercept anything except Esc.
    if (inPassThrough()) return;

    // Mark prefixes — m{a-z} sets, `{a-z} jumps.
    if (state.awaitingMark) {
      e.preventDefault(); e.stopImmediatePropagation();
      const ch = tok.toLowerCase();
      if (/^[a-z]$/.test(ch)) {
        if (state.awaitingMark === 'set') setMark(ch);
        else jumpMark(ch);
      } else {
        hud('Cancelled');
      }
      state.awaitingMark = null;
      return;
    }
    if (tok === 'm' && !state.cmd) {
      e.preventDefault(); e.stopImmediatePropagation();
      state.awaitingMark = 'set'; hud('m_ (set mark)'); return;
    }
    if (tok === '`' && !state.cmd) {
      e.preventDefault(); e.stopImmediatePropagation();
      state.awaitingMark = 'jump'; hud('`_ (jump to mark)'); return;
    }

    // Digit prefix — buffer count. A leading "0" is reserved for go-to-first-tab
    // in real vimium, but we only treat 1-9 as count starters; "0" is only a
    // count digit when one's already in progress.
    if (/^[0-9]$/.test(tok) && !state.cmd && (state.count || tok !== '0')) {
      e.preventDefault(); e.stopImmediatePropagation();
      state.count += tok;
      return;
    }

    // Build the candidate sequence.
    const seq = state.cmd + tok;

    if (bindings[seq]) {
      e.preventDefault(); e.stopImmediatePropagation();
      const hadCount = state.count.length > 0;
      const count = Math.min(parseInt(state.count, 10) || 1, 100);
      state.cmd = '';
      state.count = '';
      dispatch(seq, count, hadCount);
      return;
    }

    if (PREFIX_KEYS.has(seq)) {
      e.preventDefault(); e.stopImmediatePropagation();
      state.cmd = seq;
      hud(seq, 1200);
      return;
    }

    // Sequence didn't match — abort and let the page see the key... unless we
    // were in the middle of a sequence, in which case we already ate keys and
    // should keep eating this one to avoid sending half a binding to the page.
    if (state.cmd) {
      e.preventDefault(); e.stopImmediatePropagation();
      state.cmd = '';
      state.count = '';
    }
  }

  // ---------- Bootstrap ----------

  injectStyle();
  // Capture phase so we see keys before the page's own handlers can block us.
  window.addEventListener('keydown', onKeyDown, true);
})();
