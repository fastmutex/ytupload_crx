// On toolbar-icon click, open or focus a YouTube Studio tab.
// All upload work happens in content.js on studio.youtube.com.

chrome.action.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: 'https://studio.youtube.com/*' });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    if (tabs[0].windowId != null) {
      await chrome.windows.update(tabs[0].windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({ url: 'https://studio.youtube.com/' });
});
