(() => {
  'use strict';

  // Loads first in the content_scripts array; exposes shared helpers + UI on
  // window.__YTBU so content.js (upload) and publish.js (publish/sort) can reuse
  // them. All three files run in the same isolated world, in manifest order.
  if (window.__YTBU) return;

  console.log('[YT Bulk Upload] shared helpers loaded:', location.href);

  const NS = {};
  window.__YTBU = NS;

  // Which surface are we on? Upload/publish live on Studio; sort-playlist lives
  // on the main site's playlist pages.
  const isStudio = location.hostname === 'studio.youtube.com';
  const isYouTube = location.hostname === 'www.youtube.com';

  // ── Shadow-DOM-aware querying ──────────────────────────────

  function deepQueryAll(selector, root = document) {
    const out = [];
    const walk = (node) => {
      let matches = [];
      try {
        matches = node.querySelectorAll(selector);
      } catch {
        matches = [];
      }
      out.push(...matches);
      const all = node.querySelectorAll('*');
      for (const el of all) {
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(root);
    return out;
  }

  function findElementByText(selectors, text) {
    const wanted = text.toLowerCase();
    for (const sel of selectors) {
      const els = deepQueryAll(sel);
      for (const el of els) {
        if ((el.textContent || '').trim().toLowerCase().includes(wanted)) {
          return el;
        }
      }
    }
    return null;
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function waitFor(predicate, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return true;
      await sleep(250);
    }
    return predicate();
  }

  // Shadow-DOM-aware element wait: returns the first match or null.
  async function waitForElementDeep(selector, root = document, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = deepQueryAll(selector, root)[0];
      if (el) return el;
      await sleep(50);
    }
    return deepQueryAll(selector, root)[0] || null;
  }

  // Paper buttons / steppers in Studio's draft modal need a real mousedown
  // before the click registers, so use this for the publish/sort flows.
  function fireClick(el) {
    if (!el) return;
    el.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window })
    );
    el.click();
  }

  // ── Settings (persisted via chrome.storage.local) ──────────

  const settings = { visibility: 'Unlisted', madeForKids: false };
  const settingsListeners = [];

  function saveSettings() {
    try {
      chrome.storage.local.set({
        visibility: settings.visibility,
        madeForKids: settings.madeForKids,
      });
    } catch (e) {
      console.warn('[YT Bulk Upload] could not save settings', e);
    }
  }

  function notifySettings() {
    for (const fn of settingsListeners) {
      try {
        fn();
      } catch (e) {
        console.warn('[YT Bulk Upload] settings listener error', e);
      }
    }
  }

  // Register a callback to sync UI controls with `settings`. Fires immediately
  // and again once storage finishes loading.
  function onSettings(fn) {
    settingsListeners.push(fn);
    fn();
  }

  function loadSettings() {
    try {
      chrome.storage.local.get(['visibility', 'madeForKids'], (res) => {
        if (res && typeof res.visibility === 'string') settings.visibility = res.visibility;
        if (res && typeof res.madeForKids === 'boolean') settings.madeForKids = res.madeForKids;
        notifySettings();
      });
    } catch (e) {
      console.warn('[YT Bulk Upload] could not load settings', e);
    }
  }

  // ── Shared UI: a collapsible bottom-right panel ────────────
  //
  // The container passes pointer events through (pointer-events:none) so only
  // the actual controls capture clicks — empty gaps never block Studio's UI.
  // Controls live in a body that is collapsed by default behind a small launcher
  // pill, so the extension never covers YouTube's own buttons until you open it.

  const PANEL_ID = 'yt-bulk-panel';
  const BODY_ID = 'yt-bulk-body';
  const TOGGLE_ID = 'yt-bulk-toggle';
  const STATUS_ID = 'yt-bulk-upload-status';

  let expanded = false;

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (!panel && document.body) {
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      Object.assign(panel.style, {
        position: 'fixed',
        bottom: '20px',
        right: '20px',
        zIndex: '2147483647',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: '8px',
        fontFamily: 'Roboto, Arial, sans-serif',
        pointerEvents: 'none', // let clicks fall through to the page…
      });
      document.body.appendChild(panel);
    }
    return panel;
  }

  // The collapsible body that feature files inject their controls into.
  function ensureControls() {
    let body = document.getElementById(BODY_ID);
    if (!body) {
      const panel = ensurePanel();
      if (!panel) return null;
      body = document.createElement('div');
      body.id = BODY_ID;
      Object.assign(body.style, {
        display: expanded ? 'flex' : 'none',
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: '8px',
      });
      const toggle = document.getElementById(TOGGLE_ID);
      if (toggle) panel.insertBefore(body, toggle);
      else panel.appendChild(body);
    }
    return body;
  }

  function setExpanded(v) {
    expanded = v;
    const body = ensureControls();
    if (body) body.style.display = v ? 'flex' : 'none';
    const toggle = document.getElementById(TOGGLE_ID);
    if (toggle) toggle.textContent = v ? '✕ Close' : '🎬 YT Tools';
  }

  function ensureToggle() {
    let toggle = document.getElementById(TOGGLE_ID);
    if (!toggle) {
      const panel = ensurePanel();
      if (!panel) return null;
      toggle = button(expanded ? '✕ Close' : '🎬 YT Tools', '#065fd4');
      toggle.id = TOGGLE_ID;
      toggle.addEventListener('click', () => setExpanded(!expanded));
      panel.appendChild(toggle); // always last → sits in the corner
    }
    return toggle;
  }

  function ensureStatus() {
    let status = document.getElementById(STATUS_ID);
    if (!status) {
      const panel = ensurePanel();
      if (!panel) return null;
      status = document.createElement('div');
      status.id = STATUS_ID;
      Object.assign(status.style, {
        maxWidth: '320px',
        padding: '10px 14px',
        background: '#222',
        color: '#fff',
        borderRadius: '8px',
        fontSize: '13px',
        fontFamily: 'Roboto, Arial, sans-serif',
        boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
        display: 'none',
        whiteSpace: 'pre-wrap',
        pointerEvents: 'auto',
      });
      panel.insertBefore(status, panel.firstChild); // keep status at the top
    }
    return status;
  }

  function setStatus(msg) {
    const el = ensureStatus();
    if (el) {
      el.style.display = 'block';
      el.textContent = msg;
    }
    console.log('[YT Bulk Upload]', msg);
  }

  // Styled action button used by both feature panels.
  function button(text, bg) {
    const btn = document.createElement('button');
    btn.textContent = text;
    Object.assign(btn.style, {
      padding: '10px 16px',
      background: bg,
      color: '#fff',
      border: 'none',
      borderRadius: '24px',
      fontSize: '14px',
      fontWeight: '600',
      fontFamily: 'Roboto, Arial, sans-serif',
      cursor: 'pointer',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
      whiteSpace: 'nowrap',
      pointerEvents: 'auto', // …but the controls themselves stay clickable
    });
    return btn;
  }

  // Small dark "chip" wrapper for inline controls (select / checkbox).
  function controlChip() {
    const chip = document.createElement('label');
    Object.assign(chip.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '6px 10px',
      background: '#222',
      color: '#fff',
      borderRadius: '8px',
      fontSize: '12px',
      fontFamily: 'Roboto, Arial, sans-serif',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
      cursor: 'pointer',
      pointerEvents: 'auto',
    });
    return chip;
  }

  // ── Mutual exclusion across all actions ────────────────────

  let busy = false;

  function panelButtons() {
    const panel = document.getElementById(PANEL_ID);
    return panel ? [...panel.querySelectorAll('button')] : [];
  }

  // Run an action exclusively: only one of upload/publish/sort at a time.
  async function runExclusive(fn) {
    if (busy) {
      setStatus('Another action is already running — please wait.');
      return;
    }
    busy = true;
    panelButtons().forEach((b) => (b.disabled = true));
    try {
      await fn();
    } catch (e) {
      setStatus('Error: ' + (e && e.message ? e.message : e));
      console.error('[YT Bulk Upload]', e);
    } finally {
      busy = false;
      panelButtons().forEach((b) => (b.disabled = false));
    }
  }

  // ── SPA-resilient injection registry ───────────────────────

  const injectors = [];

  function runInjectors() {
    if (!document.body) return;
    ensurePanel();
    ensureStatus();
    ensureControls();
    ensureToggle();
    setExpanded(expanded); // restore collapse state after a re-inject
    for (const fn of injectors) {
      try {
        fn();
      } catch (e) {
        console.error('[YT Bulk Upload] injector error', e);
      }
    }
  }

  // Feature files register an idempotent injector that (re)adds their controls.
  function registerInjector(fn) {
    injectors.push(fn);
    runInjectors();
  }

  function ensureUI() {
    if (document.body) {
      runInjectors();
    } else {
      setTimeout(ensureUI, 200);
    }
  }

  // Re-inject if Studio's SPA navigation tears down the body, throttled so we
  // don't run on every mutation of a heavy app.
  let scheduled = false;
  const obs = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      if (!document.getElementById(PANEL_ID)) runInjectors();
    }, 500);
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });

  // ── Export ─────────────────────────────────────────────────

  Object.assign(NS, {
    isStudio,
    isYouTube,
    deepQueryAll,
    findElementByText,
    isVisible,
    sleep,
    waitFor,
    waitForElementDeep,
    fireClick,
    settings,
    saveSettings,
    onSettings,
    setStatus,
    ensurePanel,
    ensureControls,
    button,
    controlChip,
    runExclusive,
    registerInjector,
  });

  ensureUI();
  loadSettings();
})();
