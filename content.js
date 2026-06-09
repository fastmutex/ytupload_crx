(() => {
  'use strict';

  // Bulk-upload feature. Relies on shared helpers loaded by shared.js.
  const NS = window.__YTBU;
  if (!NS) {
    console.error('[YT Bulk Upload] shared.js did not load before content.js');
    return;
  }

  const {
    deepQueryAll,
    findElementByText,
    isVisible,
    sleep,
    waitFor,
    setStatus,
    ensureControls,
    button,
    runExclusive,
    registerInjector,
  } = NS;

  const BATCH_SIZE = 15; // Studio's per-selection cap; used only if feed-all is rejected
  const SETTLE_MS = 1500;
  const SOURCE_INPUT_ID = 'yt-bulk-source-input';

  let pickedFiles = [];

  function findUploadInput() {
    // Exclude our own hidden picker input (it also has accept="video/*").
    const inputs = deepQueryAll('input[type="file"]').filter(
      (i) => i.id !== SOURCE_INPUT_ID
    );
    let best = inputs.find((i) =>
      (i.getAttribute('accept') || '').toLowerCase().includes('video')
    );
    return best || inputs[0] || null;
  }

  // ── Open Studio's upload dialog ────────────────────────────

  async function openUploadDialog() {
    if (findUploadInput()) return true;

    // Click the "Create" button
    const createBtn =
      deepQueryAll('#create-icon')[0] ||
      deepQueryAll('ytcp-button#create-icon')[0] ||
      findElementByText(['ytcp-button', 'button'], 'create');
    if (createBtn) {
      createBtn.click();
      await sleep(400);
    }

    // Click "Upload videos" menu item
    const uploadItem =
      findElementByText(
        ['tp-yt-paper-item', 'ytcp-text-menu-item', 'yt-formatted-string', 'div'],
        'upload video'
      ) || deepQueryAll('#text-item-0')[0];
    if (uploadItem) {
      uploadItem.click();
      await sleep(800);
    }

    // Wait for the file input to appear
    for (let i = 0; i < 20; i++) {
      if (findUploadInput()) return true;
      await sleep(300);
    }
    return !!findUploadInput();
  }

  // ── Feed files into Studio's uploader ──────────────────────

  function buildDataTransfer(files) {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    return dt;
  }

  function feedViaInput(input, files) {
    const dt = buildDataTransfer(files);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.files.length === files.length;
  }

  function feedViaDrop(target, files) {
    const dt = buildDataTransfer(files);
    const opts = { bubbles: true, cancelable: true, composed: true };
    target.dispatchEvent(new DragEvent('dragenter', { ...opts, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent('dragover', { ...opts, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent('drop', { ...opts, dataTransfer: dt }));
  }

  function pickerVisible() {
    return deepQueryAll('ytcp-uploads-file-picker').some(isVisible);
  }

  // Per-file upload status rows in the multi-progress monitor popup.
  function progressStatusRows() {
    return deepQueryAll('.progress-status-text');
  }

  // Header summary text, e.g. "Uploading 8 of 15 · 9 seconds left".
  function uploadStatusText() {
    const count = deepQueryAll('ytcp-multi-progress-monitor .count')[0];
    const eta = deepQueryAll('ytcp-multi-progress-monitor #eta')[0];
    const c = count ? (count.textContent || '').trim() : '';
    const e = eta ? (eta.textContent || '').trim() : '';
    return [c, e].filter(Boolean).join(' · ');
  }

  // True while any file is still transferring bytes (a busy upload slot).
  // Bytes are done when every row reads "100% uploaded"; rows still show
  // "Waiting...", "Starting...", or "N% uploaded" (N<100) while uploading.
  // (Post-upload "Processing" does NOT hold a slot, so it counts as free.)
  function uploadsInProgress() {
    const rows = progressStatusRows();
    if (rows.length > 0) {
      for (const r of rows) {
        const t = (r.textContent || '').trim().toLowerCase();
        if (!t) continue;
        if (t.includes('waiting')) return true;
        if (t.includes('starting')) return true;
        if (t.includes('uploading')) return true;
        const m = t.match(/(\d+)\s*%\s*uploaded/);
        if (m && parseInt(m[1], 10) < 100) return true;
      }
      return false;
    }
    // Fallback to the header count, e.g. "Uploading 8 of 15".
    const header = deepQueryAll('ytcp-multi-progress-monitor .count')[0];
    if (header && /uploading/i.test(header.textContent || '')) return true;
    return false;
  }

  function rowStatuses() {
    return progressStatusRows()
      .map((r) => (r.textContent || '').trim().replace(/\s+/g, ' '))
      .filter(Boolean);
  }

  // Wait until the current batch's uploads finish (slots free up).
  // Requires having SEEN progress, then a sustained idle, so a transient
  // re-render (rows momentarily gone) can't be mistaken for "finished".
  async function waitForBatchToFinish(maxMs = 60 * 60 * 1000) {
    const start = Date.now();
    let lastLog = 0;
    let sawProgress = false;
    let idleSince = 0;

    while (Date.now() - start < maxMs) {
      const inProg = uploadsInProgress();
      if (inProg) {
        sawProgress = true;
        idleSince = 0;
      } else if (sawProgress) {
        if (!idleSince) idleSince = Date.now();
      }

      if (Date.now() - lastLog > 3000) {
        lastLog = Date.now();
        const rows = rowStatuses();
        console.log(
          '[YT Bulk Upload] poll inProgress=', inProg,
          'sawProgress=', sawProgress,
          'rows(' + rows.length + ')=', rows
        );
        setStatus(`Uploading current batch… ${uploadStatusText() || rows.length + ' files'}`);
      }

      // Declare finished only after a sustained idle following real progress.
      if (sawProgress && idleSince && Date.now() - idleSince >= 6000) {
        return true;
      }
      await sleep(1500);
    }
    return sawProgress && !uploadsInProgress();
  }

  async function closeDialog() {
    const closeBtn =
      deepQueryAll('ytcp-uploads-dialog #close-button').find(isVisible) ||
      deepQueryAll('#close-button').find(isVisible) ||
      findElementByText(['ytcp-button', 'button'], 'close');
    if (closeBtn) {
      closeBtn.click();
      await sleep(SETTLE_MS);
      // Dismiss any "save as draft / continue" confirmation.
      const confirm =
        findElementByText(['ytcp-button', 'button', 'tp-yt-paper-button'], 'continue') ||
        findElementByText(['ytcp-button', 'button', 'tp-yt-paper-button'], 'save');
      if (confirm) {
        confirm.click();
        await sleep(SETTLE_MS);
      }
    }
  }

  // Feed one batch (≤15) and confirm the NEW upload actually started.
  // Called only when no upload is currently in progress, so a flip of
  // uploadsInProgress() to true reliably means this batch registered.
  async function feedOneBatch(batch) {
    const opened = await openUploadDialog();
    if (!opened) {
      throw new Error(
        'Could not find/open the Studio upload dialog. Open "Create → Upload videos" first, then click Bulk Upload again.'
      );
    }
    const input = findUploadInput();
    feedViaInput(input, batch);
    if (await waitFor(uploadsInProgress, 15000)) return;

    // Fallback: drag-drop onto the picker (it has on-drop handlers).
    const dropTarget =
      deepQueryAll('ytcp-uploads-file-picker').find(isVisible) ||
      deepQueryAll('ytcp-uploads-file-picker')[0] ||
      input?.closest?.('ytcp-uploads-dialog') ||
      input?.parentElement ||
      document.body;
    feedViaDrop(dropTarget, batch);
    if (await waitFor(uploadsInProgress, 15000)) return;

    throw new Error(
      'Studio did not start uploading this batch (no progress detected). The page DOM may have changed.'
    );
  }

  async function feedAll(files) {
    const batches = [];
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      batches.push(files.slice(i, i + BATCH_SIZE));
    }

    for (let b = 0; b < batches.length; b++) {
      const isLast = b === batches.length - 1;
      setStatus(`Batch ${b + 1}/${batches.length} — feeding ${batches[b].length} files…`);
      await feedOneBatch(batches[b]);

      // Studio caps concurrent uploads at 15, so wait for THIS batch to finish
      // uploading before starting the next one.
      if (!isLast) {
        setStatus(`Batch ${b + 1}/${batches.length} started — waiting for it to finish before the next…`);
        const finished = await waitForBatchToFinish();
        if (!finished) {
          throw new Error(
            `Batch ${b + 1} did not finish uploading within the time limit. Stopping so we don't exceed the 15-upload cap.`
          );
        }
        await closeDialog();
        await sleep(SETTLE_MS);
      }
    }

    setStatus(`Done. Uploaded ${files.length} files in ${batches.length} batch(es) as drafts.`);
  }

  // ── UI ─────────────────────────────────────────────────────

  registerInjector(function injectUpload() {
    if (!NS.isStudio) return; // uploading only happens in Studio
    if (document.getElementById('yt-bulk-upload-btn')) return;
    const body = ensureControls();
    if (!body) return;

    const btn = button('⬆ Bulk Upload', '#065fd4');
    btn.id = 'yt-bulk-upload-btn';

    const input = document.createElement('input');
    input.id = SOURCE_INPUT_ID;
    input.type = 'file';
    input.multiple = true;
    input.accept = 'video/*';
    input.style.display = 'none';

    btn.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      pickedFiles = Array.from(input.files || []);
      input.value = ''; // allow re-pick of same files
      if (pickedFiles.length === 0) return;
      runExclusive(() => feedAll(pickedFiles));
    });

    body.appendChild(btn);
    body.appendChild(input);
    console.log('[YT Bulk Upload] upload button injected');
  });
})();
