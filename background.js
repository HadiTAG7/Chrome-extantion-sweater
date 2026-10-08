// مساعد حجوزات سويتر: the sounds and the Windows notifications for new bookings, red (late)
// bookings and cancelled ones (content.js finds them).

// Per message type: the notification's title and the sound that plays with it (offscreen.js).
const ALERTS = {
  'swx:new-bookings': {
    sound: 'new',
    title: (count) => (count === 1 ? 'حجز جديد' : `حجوزات جديدة (${count})`),
  },
  'swx:red-alert': {
    sound: 'red',
    title: (count) => (count === 1 ? 'تنبيه تأخير' : `تنبيهات تأخير (${count})`),
  },
  'swx:cancelled': {
    sound: 'cancel',
    title: (count) => (count === 1 ? 'حجز ملغي' : `حجوزات ملغية (${count})`),
  },
};

chrome.runtime.onMessage.addListener((message, sender) => {
  const alert = ALERTS[message?.type];
  if (!alert || !sender.tab) return;
  const { count, lines, sound } = message;
  const shown = lines.slice(0, 4);
  // The sound's name keeps two alerts of the same moment apart (the same id would replace one).
  chrome.notifications.create(`swx-${sender.tab.id}-${alert.sound}-${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: alert.title(count),
    message: shown.join('\n') + (count > shown.length ? `\n+${count - shown.length}` : ''),
    contextMessage: 'مساعد حجوزات سويتر',
    priority: 2,
    silent: Boolean(sound), // our sound instead of the Windows one, not both
  });
  if (sound) playChime(alert.sound);
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
// so the sounds play in a hidden extension page. Chrome closes it again after 30 s of silence.
let creating = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creating ||= chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Plays the alert sounds for new, late and cancelled bookings',
    })
    .finally(() => (creating = null));
  await creating;
}

async function playChime(sound) {
  try {
    await ensureOffscreen();
    self.lastChime = await chrome.runtime.sendMessage({ type: 'swx:play-chime', sound });
  } catch (error) {
    self.lastChime = { ok: false, error: String(error?.message || error) };
  }
  if (!self.lastChime?.ok) console.warn('[Sweater helper] chime', self.lastChime);
}
