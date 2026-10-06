// مساعد حجوزات سويتر: Windows notifications for new bookings (content.js finds them).

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'swx:new-bookings' || !sender.tab) return;
  const { count, lines } = message;
  const shown = lines.slice(0, 4);
  chrome.notifications.create(`swx-${sender.tab.id}-${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: count === 1 ? 'حجز جديد' : `حجوزات جديدة (${count})`,
    message: shown.join('\n') + (count > shown.length ? `\n+${count - shown.length}` : ''),
    contextMessage: 'مساعد حجوزات سويتر',
    priority: 2,
  });
});

// Clicking the notification brings the bookings tab forward. Its id carries the tab id, so this
// works even after Chrome restarted the service worker in between.
chrome.notifications.onClicked.addListener((id) => {
  const tabId = Number(/^swx-(\d+)-/.exec(id)?.[1]);
  chrome.notifications.clear(id);
  if (!tabId) return;
  chrome.tabs.update(tabId, { active: true }, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    chrome.windows.update(tab.windowId, { focused: true });
  });
});
