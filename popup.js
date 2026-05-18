document.getElementById('btn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('upload.html') });
  window.close();
});
