(() => {
  'use strict';

  // Publish-drafts + sort-playlist features. Ported from the user's console
  // script; relies on shared helpers loaded by shared.js.
  const NS = window.__YTBU;
  if (!NS) {
    console.error('[YT Bulk Upload] shared.js did not load before publish.js');
    return;
  }

  const {
    deepQueryAll,
    isVisible,
    sleep,
    waitForElementDeep,
    fireClick,
    settings,
    saveSettings,
    onSettings,
    setStatus,
    ensureControls,
    button,
    controlChip,
    runExclusive,
    registerInjector,
  } = NS;

  // ── Publish: selectors (verbatim from the console script) ──

  const VISIBILITY_PUBLISH_ORDER = { Private: 0, Unlisted: 1, Public: 2 };

  const VIDEO_ROW_SELECTOR = 'ytcp-video-row';
  const DRAFT_BUTTON_SELECTOR = '.edit-draft-button';
  const DRAFT_MODAL_SELECTOR = '.style-scope.ytcp-uploads-dialog';
  const RADIO_BUTTON_SELECTOR = 'tp-yt-paper-radio-button';
  const VISIBILITY_STEPPER_SELECTOR = '#step-badge-3';
  const VISIBILITY_PAPER_BUTTONS_SELECTOR = 'tp-yt-paper-radio-group';
  const SAVE_BUTTON_SELECTOR = '#done-button';

  // If the video is still in the "Checking" phase, clicking Done pops a
  // pre-checks warning ("We're still checking your content") with
  // "Publish anyway" / "Go back". Click "Publish anyway" to proceed; returns
  // true if such a dialog was found and dismissed.
  async function confirmPublishAnyway(timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const btn = deepQueryAll('button').find((el) => {
        const label = (el.getAttribute('aria-label') || '').trim().toLowerCase();
        const text = (el.textContent || '').trim().toLowerCase();
        return label === 'publish anyway' || text === 'publish anyway';
      });
      if (btn) {
        fireClick(btn);
        await sleep(100);
        return true;
      }
      await sleep(100);
    }
    return false;
  }

  // Find a currently-visible dialog "close" control (the share screen, plus any
  // follow-up confirmation). Matches Studio's #close-button and generic
  // Close/Dismiss buttons, but never our own toggle (it has no such id/label).
  function findVisibleCloseButton() {
    const candidates = [
      ...deepQueryAll('#close-button'),
      ...deepQueryAll('button[aria-label="Close"]'),
      ...deepQueryAll('button[aria-label="Dismiss"]'),
    ];
    return candidates.find(isVisible) || null;
  }

  // Publishing can surface more than one dialog in sequence (share screen, then
  // an extra confirmation). Close each visible one for a few rounds.
  async function closeAfterPublish(rounds = 3) {
    for (let i = 0; i < rounds; i++) {
      let btn = null;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        btn = findVisibleCloseButton();
        if (btn) break;
        await sleep(150);
      }
      if (!btn) break; // nothing left to close
      fireClick(btn);
      await sleep(400);
    }
  }

  // Publish a single draft row through Studio's draft modal. This mirrors the
  // console script step-for-step: open the draft, pick the audience, jump to the
  // visibility step, choose the visibility, save, then close the share dialog.
  // All sub-queries are scoped to the modal element, exactly like the script.
  async function publishOne(row) {
    const editBtn = deepQueryAll(DRAFT_BUTTON_SELECTOR, row)[0];
    if (!editBtn) throw new Error('edit-draft button not found on row');
    fireClick(editBtn);

    const modal = await waitForElementDeep(DRAFT_MODAL_SELECTOR, document, 10000);
    if (!modal) throw new Error('draft modal did not open');

    // "Made for kids" is mandatory before you can advance. The script selects it
    // by sibling position within the modal: nth-child(1) = yes, nth-child(2) = no.
    await sleep(50);
    const nth = settings.madeForKids ? 1 : 2;
    const mfkRadio = await waitForElementDeep(
      `${RADIO_BUTTON_SELECTOR}:nth-child(${nth})`,
      modal,
      10000
    );
    if (!mfkRadio) throw new Error('made-for-kids radio not found');
    fireClick(mfkRadio);
    await sleep(50);

    // Jump to the visibility step.
    await sleep(50);
    const stepper = await waitForElementDeep(VISIBILITY_STEPPER_SELECTOR, modal, 10000);
    if (!stepper) throw new Error('visibility stepper not found');
    fireClick(stepper);
    await sleep(50);

    // The first (and only) paper-radio-group in the modal is the visibility one.
    const group = await waitForElementDeep(VISIBILITY_PAPER_BUTTONS_SELECTOR, modal, 10000);
    if (!group) throw new Error('visibility radio group not found');

    const idx = VISIBILITY_PUBLISH_ORDER[settings.visibility];
    const visRadio = deepQueryAll(RADIO_BUTTON_SELECTOR, group)[idx];
    if (!visRadio) throw new Error(`visibility radio for "${settings.visibility}" not found`);
    fireClick(visRadio);
    await sleep(50);

    const saveBtn = await waitForElementDeep(SAVE_BUTTON_SELECTOR, modal, 10000);
    if (!saveBtn) throw new Error('save (done) button not found');
    fireClick(saveBtn);

    // The video may still be in the "Checking" phase — if Studio warns, publish anyway.
    await confirmPublishAnyway();

    // Dismiss the share screen and any follow-up confirmation dialog(s).
    await closeAfterPublish();
    await sleep(100);
  }

  async function publishDrafts() {
    const drafts = deepQueryAll(VIDEO_ROW_SELECTOR).filter(
      (row) => deepQueryAll(DRAFT_BUTTON_SELECTOR, row)[0]
    );
    if (drafts.length === 0) {
      setStatus('No draft videos found on this page.');
      return;
    }
    setStatus(`Found ${drafts.length} draft(s). Publishing as ${settings.visibility}…`);
    await sleep(500);

    let ok = 0;
    let fail = 0;
    for (let i = 0; i < drafts.length; i++) {
      try {
        await publishOne(drafts[i]);
        ok++;
      } catch (e) {
        fail++;
        console.error('[YT Bulk Upload] publish failed for draft', i + 1, e);
      }
      setStatus(`Published ${ok}/${drafts.length}${fail ? ` (${fail} failed)` : ''}…`);
      await sleep(300);
    }
    setStatus(
      `Done. Published ${ok} of ${drafts.length} draft(s)` +
        (fail ? `, ${fail} failed.` : '.')
    );
  }

  // ── Sort: selectors (verbatim from the console script) ─────
  // These are ytd-* components on www.youtube.com playlist pages (not Studio),
  // which is why the sort button only injects on the main site.

  const PLAYLIST_VIDEO_SELECTOR = 'ytd-playlist-video-renderer';
  const PLAYLIST_TITLE_SELECTOR = '#video-title';
  const SORTING_MENU_BUTTON_SELECTOR = 'button';
  const SORTING_ITEM_MENU_SELECTOR = 'tp-yt-paper-listbox#items';
  const SORTING_ITEM_MENU_ITEM_SELECTOR = 'ytd-menu-service-item-renderer';
  const MOVE_TO_BOTTOM_INDEX = 5; // fallback if the label can't be matched

  // Titles are prefixed with an order number, e.g. "01 abc", "02 def". Sort by
  // that leading number ascending; titles without one fall back to natural
  // (numeric-aware) name order and sort after the numbered ones.
  function orderNumber(name) {
    const m = name.match(/^\s*(\d+)/);
    return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
  }

  function compareNames(a, b) {
    const na = orderNumber(a);
    const nb = orderNumber(b);
    if (na !== nb) return na - nb;
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  }

  function rowName(row) {
    return (deepQueryAll(PLAYLIST_TITLE_SELECTOR, row)[0]?.textContent || '').trim();
  }

  // Re-read the live rows each time — every "move to bottom" re-renders the list,
  // so cached element references go stale.
  function currentRows() {
    return deepQueryAll(PLAYLIST_VIDEO_SELECTOR);
  }

  async function moveRowToBottom(row) {
    const menuBtn = deepQueryAll(SORTING_MENU_BUTTON_SELECTOR, row)[0];
    if (!menuBtn) throw new Error('row menu button not found');
    fireClick(menuBtn);

    const listbox = await waitForElementDeep(SORTING_ITEM_MENU_SELECTOR, document, 10000);
    if (!listbox) throw new Error('sort menu did not open');
    await waitForElementDeep(SORTING_ITEM_MENU_ITEM_SELECTOR, listbox, 5000);

    const items = deepQueryAll(SORTING_ITEM_MENU_ITEM_SELECTOR, listbox);
    const moveBottom =
      items.find((it) => (it.textContent || '').trim().toLowerCase().includes('move to bottom')) ||
      items[MOVE_TO_BOTTOM_INDEX];
    if (!moveBottom) throw new Error('"move to bottom" menu item not found');
    fireClick(moveBottom);
  }

  async function sortPlaylist() {
    const names = currentRows().map(rowName).filter(Boolean);
    if (names.length === 0) {
      setStatus('No playlist videos found on this page.');
      return;
    }
    const order = [...names].sort(compareNames);
    setStatus(`Sorting ${order.length} playlist video(s) by order number…`);

    // Walk the desired order and push each title to the bottom in turn. Doing it
    // in ascending order leaves the playlist ascending. Re-find the row by title
    // every step so we never act on a stale (re-rendered) element.
    let done = 0;
    for (const name of order) {
      try {
        const row = currentRows().find((r) => rowName(r) === name);
        if (!row) {
          console.warn('[YT Bulk Upload] row not found (off-screen?):', name);
        } else {
          await moveRowToBottom(row);
        }
      } catch (e) {
        console.error('[YT Bulk Upload] sort move failed for', name, e);
      }
      done++;
      setStatus(`Sorting… ${done}/${order.length}`);
      await sleep(1000);
    }
    setStatus(`Done. Sorted ${order.length} playlist video(s).`);
  }

  // ── UI ─────────────────────────────────────────────────────

  registerInjector(function injectPublish() {
    const body = ensureControls();
    if (!body) return;

    // Publish drafts + its settings live in Studio.
    if (NS.isStudio && !document.getElementById('yt-publish-btn')) {
      // Visibility selector
      const visChip = controlChip();
      visChip.appendChild(document.createTextNode('Visibility'));
      const sel = document.createElement('select');
      sel.id = 'yt-visibility-select';
      Object.assign(sel.style, { fontSize: '12px', cursor: 'pointer' });
      for (const v of ['Public', 'Unlisted', 'Private']) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        sel.appendChild(opt);
      }
      sel.value = settings.visibility;
      sel.addEventListener('change', () => {
        settings.visibility = sel.value;
        saveSettings();
      });
      visChip.appendChild(sel);

      // Made-for-kids toggle
      const mfkChip = controlChip();
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = 'yt-mfk-checkbox';
      cb.checked = settings.madeForKids;
      cb.style.cursor = 'pointer';
      cb.addEventListener('change', () => {
        settings.madeForKids = cb.checked;
        saveSettings();
      });
      mfkChip.appendChild(cb);
      mfkChip.appendChild(document.createTextNode('Made for kids'));

      const pubBtn = button('📢 Publish Drafts', '#9147ff');
      pubBtn.id = 'yt-publish-btn';
      pubBtn.addEventListener('click', () => runExclusive(publishDrafts));

      body.appendChild(visChip);
      body.appendChild(mfkChip);
      body.appendChild(pubBtn);
      console.log('[YT Bulk Upload] publish controls injected');
    }

    // Sort playlist lives on the main site's playlist pages.
    if (NS.isYouTube && !document.getElementById('yt-sort-btn')) {
      const sortBtn = button('↕ Sort Playlist', '#0a8f57');
      sortBtn.id = 'yt-sort-btn';
      sortBtn.addEventListener('click', () => runExclusive(sortPlaylist));
      body.appendChild(sortBtn);
      console.log('[YT Bulk Upload] sort control injected');
    }
  });

  // Keep the controls in sync with stored settings once they load.
  onSettings(() => {
    const sel = document.getElementById('yt-visibility-select');
    if (sel) sel.value = settings.visibility;
    const cb = document.getElementById('yt-mfk-checkbox');
    if (cb) cb.checked = settings.madeForKids;
  });
})();
