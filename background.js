// مساعد حجوزات سويتر: the chime and the Windows notification for new bookings (content.js finds
// them).

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'swx:new-bookings' || !sender.tab) return;
  const { count, lines, sound } = message;
  const shown = lines.slice(0, 4);
  chrome.notifications.create(`swx-${sender.tab.id}-${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: count === 1 ? 'حجز جديد' : `حجوزات جديدة (${count})`,
    message: shown.join('\n') + (count > shown.length ? `\n+${count - shown.length}` : ''),
    contextMessage: 'مساعد حجوزات سويتر',
    priority: 2,
    silent: Boolean(sound), // our chime instead of the Windows sound, not both
  });
  if (sound) playChime();
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

// The bookings page can't play sound right after its automatic reload (Chrome's autoplay rule),
// so the chime plays in a hidden extension page. Chrome closes it again after 30 s of silence.
let creating = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creating ||= chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Plays the chime for new bookings',
    })
    .finally(() => (creating = null));
  await creating;
}

async function playChime() {
  try {
    await ensureOffscreen();
    self.lastChime = await chrome.runtime.sendMessage({ type: 'swx:play-chime' });
  } catch (error) {
    self.lastChime = { ok: false, error: String(error?.message || error) };
  }
  if (!self.lastChime?.ok) console.warn('[Sweater helper] chime', self.lastChime);
}
