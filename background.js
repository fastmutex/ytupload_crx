chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('upload.html') });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'YT_FETCH') {
    handleYTFetch(msg.args)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === 'GET_YT_CONFIG') {
    handleGetConfig()
      .then(sendResponse)
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }
});

// ── Tab management ───────────────────────────────────────────

async function ensureYouTubeTab() {
  let tabs = await chrome.tabs.query({ url: 'https://studio.youtube.com/*' });
  if (tabs.length > 0) return tabs[0];

  tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
  if (tabs.length > 0) return tabs[0];

  const tab = await chrome.tabs.create({
    url: 'https://www.youtube.com',
    active: false,
  });
  await waitForLoad(tab.id);
  return chrome.tabs.get(tab.id);
}

function waitForLoad(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }, 15000);

    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

// ── Auth ─────────────────────────────────────────────────────

async function getSAPISID() {
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

async function generateAuth(origin) {
  const sapisid = await getSAPISID();
  if (!sapisid) throw new Error('Not logged in (no SAPISID cookie).');
  const ts = Math.floor(Date.now() / 1000);
  const data = new TextEncoder().encode(`${ts} ${sapisid} ${origin}`);
  const buf = await crypto.subtle.digest('SHA-1', data);
  const hash = [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `SAPISIDHASH ${ts}_${hash}`;
}

// ── Fetch proxy ──────────────────────────────────────────────

async function handleYTFetch(args) {
  const tab = await ensureYouTubeTab();
  const origin = new URL(tab.url).origin;
  const auth = await generateAuth(origin);

  const headers = { ...(args.headers || {}), Authorization: auth };

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: async (a) => {
      try {
        const res = await fetch(a.url, {
          method: a.method || 'POST',
          credentials: 'include',
          headers: a.headers || {},
          body: a.body ?? undefined,
        });
        const hdrs = {};
        res.headers.forEach((v, k) => {
          hdrs[k] = v;
        });
        return {
          ok: res.ok,
          status: res.status,
          headers: hdrs,
          body: await res.text(),
        };
      } catch (e) {
        return { error: e.message };
      }
    },
    args: [{ url: args.url, method: args.method, headers, body: args.body }],
  });

  const r = results?.[0]?.result;
  if (!r) throw new Error('Script execution failed in YouTube tab.');
  if (r.error) throw new Error(r.error);
  return r;
}

// ── YouTube config extraction ────────────────────────────────

async function handleGetConfig() {
  const tab = await ensureYouTubeTab();
  const origin = new URL(tab.url).origin;

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: () => {
      const g = window.ytcfg;
      if (!g || typeof g.get !== 'function') return null;
      return {
        apiKey: g.get('INNERTUBE_API_KEY') || '',
        context: g.get('INNERTUBE_CONTEXT') || null,
        delegatedSessionId: g.get('DELEGATED_SESSION_ID') || '',
        datasyncId: g.get('DATASYNC_ID') || '',
        visitorData: g.get('VISITOR_DATA') || '',
      };
    },
    args: [],
  });

  const cfg = results?.[0]?.result;
  return { ...(cfg || {}), origin };
}
