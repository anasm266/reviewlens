// asin → tabId mapping (in-memory; repopulates as tabs are visited)
const tabRegistry = {};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'REGISTER_TAB') {
    if (sender.tab?.id) tabRegistry[msg.asin] = sender.tab.id;
    sendResponse({ ok: true });
    return false;
  }
});

// Toggle sidebar when toolbar icon clicked
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url?.includes('amazon.com')) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR' });
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/scraper.js'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/sidebar.js'] });
      await new Promise(r => setTimeout(r, 150));
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR' });
    } catch (err) {
      console.error('[ReviewLens] Could not inject scripts:', err.message);
    }
  }
});

// Cleanup on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [asin, tid] of Object.entries(tabRegistry)) {
    if (tid === tabId) delete tabRegistry[asin];
  }
});
