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
  'swx:action-needed': {
    sound: 'red',
    title: (count) => (count === 1 ? 'يحتاج إجراء' : `تحتاج إجراء (${count})`),
  },
};

const PORTAL = 'https://ssp-portal.sweater.sa';
// The id of a notification: the tab, the sound (two alerts at once don't replace each other), the
// time, and the page clicking it opens (a path of the portal, if the alert came with one).
const NOTIFICATION_ID_RE = /^swx-(\d+)-[a-z]+-\d+(?:-(\/[\w/-]*))?$/;

// The notification and the sound each come only if turned on in the pill's «⚙ الإعدادات» (which
// content.js reads, and says so in the message). ▶ there plays a sound alone.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'swx:preview') {
    if (SOUND_FILES[message.sound]) playChime(message.sound);
    return;
  }
  const alert = ALERTS[message?.type];
  if (!alert || !sender.tab) return;
  const { count, lines, sound } = message;
  if (message.notification !== false) {
    const shown = lines.slice(0, 4);
    const path = /^\/[\w/-]*$/.test(message.path || '') ? `-${message.path}` : '';
    const id = `swx-${sender.tab.id}-${alert.sound}-${Date.now()}${path}`;
    const options = {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: alert.title(count),
      message: shown.join('\n') + (count > shown.length ? `\n+${count - shown.length}` : ''),
      contextMessage: 'مساعد حجوزات سويتر',
      priority: 2,
    };
    // Our sound or none (the settings), never the Windows one too. Firefox refuses the option (the
    // whole notification with it), and its notifications always come with the Windows sound.
    if (!IN_PAGE) options.silent = true;
    Promise.resolve()
      .then(() => chrome.notifications.create(id, options))
      .then(
        () => (self.lastNotification = { id, title: options.title }),
        (error) => {
          self.lastNotification = { id, error: String(error?.message || error) };
          console.warn('[Sweater helper] notification', self.lastNotification);
        },
      );
  }
  if (sound) playChime(alert.sound);
});

// Clicking the notification brings its tab forward, on the alert's page if it came with one (an
// alert from another page: the list, or Daily Operations). The id carries all that, so this works
// even after Chrome restarted the service worker in between.
chrome.notifications.onClicked.addListener((id) => openNotification(id));

function openNotification(id) {
  const [, tab, path] = NOTIFICATION_ID_RE.exec(id) || [];
  chrome.notifications.clear(id);
  const tabId = Number(tab);
  if (!tabId) return;
  chrome.tabs.get(tabId, (current) => {
    if (chrome.runtime.lastError || !current) return;
    const update = { active: true };
    // Already there (when the tab's address can be read): no new load.
    const at = /^https:\/\/[^/]+(\/[^?#]*)/.exec(current.url || '')?.[1]?.replace(/(.)\/$/, '$1');
    if (path && at !== path) update.url = PORTAL + path;
    chrome.tabs.update(tabId, update, (updated) => {
      if (chrome.runtime.lastError || !updated) return;
      chrome.windows.update(updated.windowId, { focused: true });
    });
  });
}

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

// page.js has to be in the bookings page's own JS world before the portal's first request.
// Chrome runs it there, right after content.js, once it's registered here (Chrome 102+; needs the
// host permission). Not from manifest.json: Chrome 109, the last one for Windows 7, would run it
// in the extension's own world there, and a file runs only once in a page. Firefox has it in its
// own manifest.json (tools/build-firefox.js), and no chrome.scripting.
if (chrome.scripting?.registerContentScripts) {
  chrome.scripting
    .getRegisteredContentScripts({ ids: ['page'] })
    .then((registered) => {
      if (registered.length) return;
      const { matches } = chrome.runtime.getManifest().content_scripts[0]; // where content.js runs
      return chrome.scripting.registerContentScripts([
        { id: 'page', matches, js: ['page.js'], runAt: 'document_start', world: 'MAIN' },
      ]);
    })
    .catch((error) => console.warn('[Sweater helper] page.js', error));
}
