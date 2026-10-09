// مساعد حجوزات سويتر: the sounds and the Windows notifications for new bookings, red (late)
// bookings and cancelled ones (content.js finds them).

// Firefox runs this as a hidden background page, Chrome as a service worker (no page, no sound).
const IN_PAGE = typeof document !== 'undefined';

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
  const id = `swx-${sender.tab.id}-${alert.sound}-${Date.now()}`;
  const options = {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: alert.title(count),
    message: shown.join('\n') + (count > shown.length ? `\n+${count - shown.length}` : ''),
    contextMessage: 'مساعد حجوزات سويتر',
    priority: 2,
  };
  // Our sound instead of the Windows one, not both. Firefox refuses the option (the whole
  // notification with it), and its notifications always come with the Windows sound.
  if (!IN_PAGE) options.silent = Boolean(sound);
  Promise.resolve()
    .then(() => chrome.notifications.create(id, options))
    .then(
      () => (self.lastNotification = { id, title: options.title }),
      (error) => {
        self.lastNotification = { id, error: String(error?.message || error) };
        console.warn('[Sweater helper] notification', self.lastNotification);
      },
    );
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

// The sounds' files, for Firefox, whose background page plays them itself (the same as in
// offscreen.js, which plays them for Chrome).
const SOUND_FILES = {
  new: 'sounds/new-booking.mp3',
  red: 'sounds/red-alert.mp3',
  cancel: 'sounds/cancelled.mp3',
};

async function playChime(sound) {
  try {
    if (IN_PAGE) {
      await new Audio(SOUND_FILES[sound]).play();
      self.lastChime = { ok: true, sound };
    } else {
      await ensureOffscreen();
      self.lastChime = await chrome.runtime.sendMessage({ type: 'swx:play-chime', sound });
    }
  } catch (error) {
    self.lastChime = { ok: false, error: String(error?.message || error) };
  }
  if (!self.lastChime?.ok) console.warn('[Sweater helper] chime', self.lastChime);
}
