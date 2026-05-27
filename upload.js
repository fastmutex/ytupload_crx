(() => {
  'use strict';

  let selectedFile = null;
  let ytConfig = null;

  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    checkLogin();
    checkCookieStatus();
  });

  // ── Auth check ─────────────────────────────────────────────

  function getSAPISID() {
    return new Promise((resolve) => {
      chrome.cookies.get(
        { url: 'https://www.youtube.com', name: 'SAPISID' },
        (c) => {
          if (c) return resolve(c.value);
          chrome.cookies.get(
            { url: 'https://www.youtube.com', name: '__Secure-3PAPISID' },
            (c2) => resolve(c2?.value || null)
          );
        }
      );
    });
  }

  async function checkLogin() {
    if (!(await getSAPISID())) {
      setStatus(
        'Not logged in to YouTube.\nPlease log in at youtube.com first, then reload this page.',
        'error'
      );
    }
  }

  // ── Cookie status ──────────────────────────────────────────

  async function checkCookieStatus() {
    const el = document.getElementById('cookieStatus');
    const textEl = el.querySelector('.cookie-text');
    const sapisid = await getSAPISID();
    if (sapisid) {
      el.className = 'cookie-status ok';
      textEl.textContent = 'YouTube session active';
    } else {
      el.className = 'cookie-status fail';
      textEl.textContent = 'No YouTube session — log in at youtube.com';
    }
  }

  // ── Background messaging ───────────────────────────────────

  function sendBg(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError)
          return reject(new Error(chrome.runtime.lastError.message));
        if (res?.error) return reject(new Error(res.error));
        resolve(res);
      });
    });
  }

  function ytFetch(url, options) {
    return sendBg({
      type: 'YT_FETCH',
      args: {
        url,
        method: options.method || 'POST',
        headers: options.headers || {},
        body: options.body ?? undefined,
      },
    });
  }

  function getYTConfig() {
    return sendBg({ type: 'GET_YT_CONFIG' });
  }

  // ── Upload API ─────────────────────────────────────────────

  async function startSession(file, uploadId) {
    const res = await ytFetch(
      'https://upload.youtube.com/upload/studio?authuser=0',
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': String(file.size),
          'X-Goog-Upload-Header-Content-Type': file.type || 'video/mp4',
        },
        body: JSON.stringify({ frontendUploadId: uploadId }),
      }
    );

    if (!res.ok)
      throw new Error(
        `Session failed (${res.status}): ${res.body?.substring(0, 500)}`
      );

    const uploadUrl = res.headers['x-goog-upload-url'];
    if (!uploadUrl)
      throw new Error('No upload URL.\n' + res.body?.substring(0, 500));
    return uploadUrl;
  }

  function sendFile(url, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.setRequestHeader('X-Goog-Upload-Command', 'upload, finalize');
      xhr.setRequestHeader('X-Goog-Upload-Offset', '0');

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable)
          onProgress(Math.round((e.loaded / e.total) * 100));
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.responseText);
        } else {
          reject(
            new Error(
              `Upload failed (${xhr.status}):\n` +
                xhr.responseText.substring(0, 500)
            )
          );
        }
      };

      xhr.onerror = () => reject(new Error('Network error during upload.'));
      xhr.send(file);
    });
  }

  function findScottyId(raw) {
    const str = typeof raw === 'string' ? raw : JSON.stringify(raw);

    try {
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;

      if (obj?.scottyResourceId) return obj.scottyResourceId;

      const info = obj?.sessionStatus?.additionalInfo;
      if (info) {
        for (const key of Object.keys(info)) {
          const sid =
            info[key]?.completionInfo?.customerSpecificInfo?.scottyResourceId;
          if (sid) return sid;
        }
      }

      if (obj?.id && typeof obj.id === 'string' && obj.id.length > 10)
        return obj.id;
    } catch {
      // fall through to regex
    }

    const m = str.match(/"scottyResourceId"\s*:\s*"([^"]+)"/);
    if (m) return m[1];

    const m2 = str.match(/"id"\s*:\s*"([A-Za-z0-9_-]{20,})"/);
    if (m2) return m2[1];

    return null;
  }

  function extractVideoId(data) {
    if (!data) return null;
    let obj = data;
    if (typeof data === 'string') {
      try {
        obj = JSON.parse(data);
      } catch {
        return null;
      }
    }

    if (obj.videoId) return obj.videoId;
    if (obj.encryptedVideoId) return obj.encryptedVideoId;

    const s = JSON.stringify(obj);
    const m = s.match(/"(?:videoId|encryptedVideoId)"\s*:\s*"([^"]{6,})"/);
    return m ? m[1] : null;
  }

  async function createVideo(scottyId, uploadId, meta) {
    const cfg = ytConfig || {};
    const apiKey =
      cfg.apiKey || 'AIzaSyBUPetSUmoZL-OhlxA7wSac5XinrygCqMo';

    let context;
    if (cfg.context) {
      context = JSON.parse(JSON.stringify(cfg.context));
      context.client = context.client || {};
      context.client.clientName = 62;
    } else {
      context = {
        client: {
          clientName: 62,
          clientVersion: '1.20250101.01.00',
          hl: navigator.language?.split('-')[0] || 'en',
          gl: 'US',
        },
      };
    }

    // Extract user ID from datasyncId
    const userId = cfg.datasyncId ? cfg.datasyncId.split('||')[0] : '';
    if (userId) {
      context.user = context.user || {};
      context.user.onBehalfOfUser = userId;
    }

    // Extract channel ID from originalUrl if present
    const chanMatch =
      cfg.context?.client?.originalUrl?.match(
        /\/channel\/(UC[A-Za-z0-9_-]+)/
      );

    const body = {
      resourceId: { scottyResourceId: { id: scottyId } },
      frontendUploadId: uploadId,
      initialMetadata: {
        title: { newTitle: meta.title },
        description: { newDescription: meta.description || '' },
        privacy: { newPrivacy: meta.privacy || 'PRIVATE' },
        draftState: { isDraft: false },
      },
      context,
    };

    if (chanMatch) {
      body.channelId = chanMatch[1];
    }

    if (meta.tags?.length) {
      body.initialMetadata.tags = { newTags: meta.tags };
    }

    const headers = {
      'Content-Type': 'application/json',
      'X-Goog-AuthUser': '0',
    };

    if (cfg.datasyncId) {
      headers['X-Goog-PageId'] = cfg.datasyncId;
    }
    if (cfg.visitorData) {
      headers['X-Goog-Visitor-Id'] = cfg.visitorData;
    }

    // Use same-origin endpoint matching the proxy tab
    const origin = cfg.origin || 'https://studio.youtube.com';
    const res = await ytFetch(
      `${origin}/youtubei/v1/upload/createvideo?alt=json&key=${apiKey}`,
      { headers, body: JSON.stringify(body) }
    );

    return res;
  }

  // ── Main upload flow ───────────────────────────────────────

  async function doUpload(file, meta) {
    const uploadId = `innertube_studio:UT${Date.now()}`;

    setStatus('Connecting to YouTube…', 'info');
    try {
      ytConfig = await getYTConfig();
    } catch {
      ytConfig = null;
    }
    addDebug('YouTube config', ytConfig);

    setStatus('Creating upload session…', 'info');
    const url = await startSession(file, uploadId);
    addDebug('Upload URL', url);

    setStatus('Uploading video…', 'info');
    const rawUploadRes = await sendFile(url, file, setProgress);
    addDebug('Scotty response', rawUploadRes);

    const scottyId = findScottyId(rawUploadRes);
    if (!scottyId) {
      throw new Error(
        'Could not extract resource ID from upload response.\n\n' +
          rawUploadRes.substring(0, 800)
      );
    }
    addDebug('Scotty ID', scottyId);

    setStatus('Setting video details…', 'info');
    const createRes = await createVideo(scottyId, uploadId, meta);
    addDebug('createVideo response', createRes.body);

    return createRes;
  }

  // ── Debug log ──────────────────────────────────────────────

  const debugEntries = [];

  function addDebug(label, data) {
    const text =
      typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    debugEntries.push(`── ${label} ──\n${text}`);
    renderDebug();
  }

  function renderDebug() {
    let wrap = document.getElementById('debugWrap');
    if (!wrap) {
      wrap = document.createElement('details');
      wrap.id = 'debugWrap';
      wrap.style.cssText =
        'margin: 12px 0; font-size: 12px; color: #606060;';
      wrap.innerHTML =
        '<summary style="cursor:pointer;user-select:none;">Show debug log</summary>';
      const pre = document.createElement('pre');
      pre.id = 'debugPre';
      pre.style.cssText =
        'max-height:300px;overflow:auto;background:#f5f5f5;padding:8px;border-radius:4px;white-space:pre-wrap;word-break:break-all;margin-top:8px;font-size:11px;';
      wrap.appendChild(pre);
      const statusEl = document.getElementById('status');
      statusEl.parentNode.insertBefore(wrap, statusEl.nextSibling);
    }
    document.getElementById('debugPre').textContent =
      debugEntries.join('\n\n');
  }

  // ── UI events ──────────────────────────────────────────────

  function bindEvents() {
    const dz = document.getElementById('dropzone');
    const fi = document.getElementById('fileInput');

    dz.addEventListener('click', () => fi.click());

    dz.addEventListener('dragover', (e) => {
      e.preventDefault();
      dz.classList.add('dragover');
    });

    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));

    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      dz.classList.remove('dragover');
      const f = e.dataTransfer.files[0];
      if (f?.type.startsWith('video/')) pickFile(f);
      else setStatus('Please select a video file.', 'error');
    });

    fi.addEventListener('change', () => {
      if (fi.files[0]) pickFile(fi.files[0]);
    });

    document.getElementById('uploadBtn').addEventListener('click', onUpload);
  }

  function pickFile(f) {
    selectedFile = f;
    document.getElementById('fileName').textContent = f.name;
    document.getElementById('fileSize').textContent = fmtSz(f.size);
    document.getElementById('fileInfo').classList.remove('hidden');
    document.getElementById('uploadBtn').disabled = false;
    setStatus('', '');

    const dz = document.getElementById('dropzone');
    dz.textContent = '';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '36');
    svg.setAttribute('height', '36');
    const path = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'path'
    );
    path.setAttribute('fill', '#0a7e07');
    path.setAttribute(
      'd',
      'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z'
    );
    svg.appendChild(path);
    dz.appendChild(svg);

    const p1 = document.createElement('p');
    p1.className = 'drop-text';
    p1.textContent = f.name;
    dz.appendChild(p1);

    const p2 = document.createElement('p');
    p2.className = 'drop-hint';
    p2.textContent = 'Click to change file';
    dz.appendChild(p2);

    const titleEl = document.getElementById('title');
    if (!titleEl.value) titleEl.value = f.name.replace(/\.[^.]+$/, '');
  }

  async function onUpload() {
    if (!selectedFile) return;

    const btn = document.getElementById('uploadBtn');
    const title = document.getElementById('title').value.trim();

    if (!title) {
      setStatus('Title is required.', 'error');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Uploading…';
    document.getElementById('progressWrap').classList.remove('hidden');
    debugEntries.length = 0;

    const meta = {
      title,
      description: document.getElementById('description').value.trim(),
      privacy: document.getElementById('privacy').value,
      tags: document.getElementById('tags').value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    };

    try {
      const createRes = await doUpload(selectedFile, meta);

      let resBody;
      try {
        resBody = JSON.parse(createRes.body);
      } catch {
        resBody = createRes.body;
      }

      const vid = extractVideoId(resBody);

      if (vid) {
        setStatus(
          `Done! Video ID: ${vid}\nhttps://www.youtube.com/watch?v=${vid}\nProcessing may take a few minutes.`,
          'success'
        );
      } else {
        const raw =
          typeof resBody === 'string'
            ? resBody
            : JSON.stringify(resBody, null, 2);
        setStatus(
          'Upload sent but no video ID was returned.\nCheck debug log below for the YouTube response.\n\nResponse (status ' +
            createRes.status +
            '):\n' +
            raw.substring(0, 600),
          createRes.ok ? 'info' : 'error'
        );
      }
      btn.textContent = 'Done';
    } catch (err) {
      setStatus(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Retry Upload';
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  function setStatus(msg, cls) {
    const el = document.getElementById('status');
    el.textContent = msg;
    el.className = 'status ' + (cls || '');
  }

  function setProgress(pct) {
    document.getElementById('progressFill').style.width = pct + '%';
    document.getElementById('progressPct').textContent = pct + '%';
  }

  function fmtSz(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }
})();
