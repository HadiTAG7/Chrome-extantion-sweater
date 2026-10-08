/*
 * مساعد حجوزات سويتر (Sweater bookings helper)
 *
 * Runs on https://ssp-portal.sweater.sa/bookings and:
 *   - hides finished washes, and cancelled bookings GRACE_MINUTES after their slot; a wash that
 *     isn't finished stays on screen whatever the time,
 *   - sorts the rows by booking time (default) or by the column picked in a header,
 *   - shows each biker's wash number of the day under the name ("2/4"),
 *   - colours "Initiated" and "On the Way" bookings close to (or past) their time yellow / red,
 *     and "Reached" ones (the biker is there but hasn't started) red once their time comes,
 *   - times the washes in progress (green, then yellow / red when they run long),
 *   - marks bookings that appeared or were cancelled since the last refreshes, with a Windows
 *     notification and a sound, and alerts (once) when a booking turns red; the red count also
 *     shows in the tab's title,
 *   - rounds the portal's service times ("58.46666666666667m" → "58m"),
 *   - reloads the page every few minutes (set from the pill; follows "today" past midnight),
 *   - keeps the whole day on one page (pageSize = PAGE_SIZE),
 *   - shows a status pill at the bottom of the page: countdown (and a refresh-now button), day
 *     summary, a live per-biker panel (what each one is doing now, what's next, a copy-for-WhatsApp
 *     button) and the controls.
 *
 * The portal is a React SPA whose table rows are keyed by index: React rewrites the text of
 * existing <tr>s in place. So every pass re-reads the rows from their text, rows are never
 * removed, and they are only reordered inside their own <tbody>.
 */
(() => {
  'use strict';

  // ===== الإعدادات: عدّلها هنا ثم اضغط زر التحديث ↻ على الإضافة في chrome://extensions =====
  const REFRESH_MINUTES = 5; // كل كم دقيقة تتحدّث الصفحة (افتراضياً، وتقدر تغيّره من الشريط)
  const GRACE_MINUTES = 30; // الغسلة الملغية تختفي بعد موعدها بكم دقيقة (اللي خلصت تختفي على طول)
  const PAGE_SIZE = 50; // عدد الصفوف في الصفحة (50 أكبر خيار يعرضه الموقع)
  const LATE_YELLOW_MINUTES = 20; // غسلة لسا Initiated وباقي على موعدها هالكم دقيقة أو أقل: أصفر
  const LATE_RED_MINUTES = 10; // وباقي هالكم دقيقة أو أقل، أو عدى موعدها: أحمر (وما تختفي)
  const ONWAY_YELLOW_MINUTES = 10; // غسلة لسا في الطريق (On the Way) وباقي هالكم دقيقة أو أقل: أصفر
  const ONWAY_RED_MINUTES = 5; // وباقي هالكم دقيقة أو أقل، أو عدى موعدها: أحمر (وما تختفي)
  const REACHED_RED_MINUTES = 0; // البايكر وصل وما بدأ الغسيل: أحمر لما يبقى على موعدها هالكم دقيقة أو أقل (0: أول ما يجي موعدها)
  const WASH_YELLOW_MINUTES = 60; // غسلة بدأ غسيلها: خضراء، ولما يصير له يغسل هالكم دقيقة: صفراء
  const WASH_RED_MINUTES = 70; // ولما يصير له يغسل هالكم دقيقة: حمراء
  const NEW_BADGE_MINUTES = 10; // علامة «جديد» على الحجز الجديد تبقى هالكم دقيقة
  const NEW_BOOKING_SOUND = true; // صوت تنبيه الإضافة مع الحجز الجديد (false: صوت إشعار ويندوز بداله)
  const RED_ALERTS = true; // تنبيه (إشعار وصوت) لما غسلة تصير حمراء، مرة وحدة لكل غسلة
  const RED_ALERT_SOUND = true; // صوت «بيب بيب» مع التنبيه الأحمر (false: صوت إشعار ويندوز بداله)
  const CANCEL_ALERT_SOUND = true; // صوت الإضافة مع إشعار الحجز الملغي (false: صوت إشعار ويندوز بداله)

  const VERSION = '1.11.0';
  const MINUTE = 60 * 1000;
  const REFRESH_RANGE = [1, 240]; // minutes the user can pick from the pill
  const REFRESH_PRESETS = [5, 10, 15, 30];
  const GRACE_MS = GRACE_MINUTES * MINUTE;
  const NEW_BADGE_MS = NEW_BADGE_MINUTES * MINUTE;
  // The portal's own backend: a booking's details say when its wash started.
  const API_BASE = 'https://ssp-portal-backend.sweater.sa/api';
  const API_TIMEOUT_MS = 10 * 1000;
  const API_RETRY_MS = 2 * MINUTE; // a booking whose start time couldn't be read is asked again
  const WASH_KEEP_MS = 24 * 60 * MINUTE; // wash start times are forgotten after a day
  const ALERT_KEEP_MS = 24 * 60 * MINUTE; // and so are the red alerts already given
  const REAPPLY_MS = 15 * 1000; // re-check the times so rows disappear as the clock moves
  const ACTIVITY_GRACE_MS = MINUTE; // no reload within a minute of a click, key or scroll...
  const MAX_ACTIVITY_POSTPONE_MS = 2 * MINUTE; // ...unless the reload is already this late
  const OVERLAY_IDLE_LIMIT_MS = 10 * MINUTE; // an open dialog holds the reload unless left idle
  const OFFLINE_RETRY_MS = 30 * 1000;
  const PROBE_TIMEOUT_MS = 8 * 1000;
  const SPA_FIX_GUARD_MS = 30 * 1000;
  const RIYADH_TZ_OFFSET = -180; // Date#getTimezoneOffset() in Saudi Arabia (UTC+3, no DST)
  const TITLE_PREFIX_RE = /^🔴 \d+ · /; // the red count this script puts before the tab's title

  const LIST_PATH_RE = /^\/bookings\/?$/;
  const HEADERS = {
    date: ['booking date', 'تاريخ الحجز'],
    time: ['booking time', 'وقت الحجز'],
    id: ['id', 'الرقم'],
    biker: ['biker', 'السائق'],
    zone: ['zone', 'المنطقة'],
    service: ['service time', 'وقت الخدمة'],
    status: ['status', 'الحالة'],
  };
  // Bookings that are not (or will not be) washed: left out of the bikers' wash numbers.
  const CANCELLED_RE = /cancel|ألغيت|failed|فشلت|rescheduled|معاد جدولتها/i;
  // Washed: Collecting Payment, or Visit Completed (shown as the raw code end_visit).
  const DONE_RE = /collect|تحصيل|end_visit|completed|اكتملت/i;
  // Confirmed but the biker hasn't set off yet.
  const INITIATED_RE = /^(initiated|معتمدة)$/i;
  // The biker has set off but hasn't reached the customer yet.
  const ON_WAY_RE = /^(on the way|on_way|في الطريق)$/i;
  // At the customer, the wash not started yet.
  const REACHED_RE = /^(reached|وصل)$/i;
  // Washing now: the timer runs from the start of the service.
  const WASHING_RE = /^(washing started|start_wash|بدأ الغسيل)$/i;
  // The portal's empty table (as opposed to its loading or error row).
  const EMPTY_RE = /no bookings found|لم يتم العثور على حجوزات/i;
  const SORT_KEYS = ['time', 'biker', 'zone', 'id', 'service'];
  const DEFAULT_SORT = { key: 'time', dir: 'asc' };
  // Columns the portal can't sort: their headers become clickable.
  const OWN_SORT_COLUMNS = ['time', 'biker'];
  // Columns with the portal's own Asc/Desc menu, and the order each choice maps to.
  const MENU_SORT_KEYS = { id: 'id', zone: 'zone', date: 'time', service: 'service' };
  const COLLATOR = new Intl.Collator(['ar', 'en'], { numeric: true, sensitivity: 'base' });
  const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';
  const PAGER_LABEL_RE = /^(go to (next|previous) page|الانتقال إلى الصفحة (التالية|السابقة))$/i;
  const MONTHS = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');
  const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

  const ATTR_PAST = 'data-swx-past';
  const ATTR_SHOW_PAST = 'data-swx-show-past';
  const ATTR_EMPTY = 'data-swx-empty';
  const ATTR_SEQ = 'data-swx-seq';
  const ATTR_SORTABLE = 'data-swx-sortable';
  const ATTR_TONE = 'data-swx-tone'; // row colour: green, yellow or red
  const ATTR_NOTE = 'data-swx-note'; // the line under the booking time
  const ATTR_NEW = 'data-swx-new';
  const ATTR_CANCELLED = 'data-swx-cancelled';
  const ATTR_SERVICE = 'data-swx-service';

  const TXT = {
    refreshIn: 'التحديث بعد',
    busyOverlay: 'التحديث مؤجل — نافذة مفتوحة',
    busyActivity: 'التحديث مؤجل — استخدام حالي',
    refreshing: 'جارٍ التحديث…',
    refreshNow: '↻ حدّث الحين',
    refreshNowTitle: 'حدّث الصفحة الحين بدون ما تنتظر العد',
    soundOn: '🔊 تشغيل الصوت',
    soundOnTitle:
      'المتصفح يمنع الصوت لين تضغط هنا. عشان يشتغل دايماً اسمح بالتشغيل التلقائي للموقع (شوف «على الجوال» في README)',
    // The notifications without the extension (the extension's own are in background.js).
    alertTitles: {
      'swx:new-bookings': (n) => (n === 1 ? 'حجز جديد' : `حجوزات جديدة (${n})`),
      'swx:red-alert': (n) => (n === 1 ? 'تنبيه تأخير' : `تنبيهات تأخير (${n})`),
      'swx:cancelled': (n) => (n === 1 ? 'حجز ملغي' : `حجوزات ملغية (${n})`),
    },
    offline: 'لا يوجد اتصال — إعادة المحاولة بعد قليل',
    pastCount: 'الغسلات المخفية:',
    show: 'إظهار',
    hide: 'إخفاء',
    toggleTitle: `إظهار أو إخفاء الغسلات اللي خلصت، والملغية اللي عدى موعدها أكثر من ${GRACE_MINUTES} دقيقة`,
    noUpcoming: 'لا توجد غسلات باقية',
    sortedBy: 'الترتيب:',
    resetSort: 'رجوع للوقت',
    sortNames: {
      time: 'الوقت',
      biker: 'البايكر',
      zone: 'المنطقة',
      id: 'رقم الحجز',
      service: 'وقت الخدمة',
    },
    seqTitle: (n, total) => `الغسلة ${n} من ${total} لهذا البايكر اليوم`,
    summary: (s) =>
      `الغسلات: ${s.total} · خلصت ${s.done} · باقي ${s.remaining} · ملغية ${s.cancelled}`,
    lateTitle:
      `غسلات لسا Initiated: 🔴 باقي ${LATE_RED_MINUTES} دقائق أو أقل أو عدى موعدها،` +
      ` 🟡 باقي ${LATE_YELLOW_MINUTES} دقيقة أو أقل.\n` +
      `غسلات لسا في الطريق: 🔴 باقي ${ONWAY_RED_MINUTES} دقائق أو أقل أو عدى موعدها،` +
      ` 🟡 باقي ${ONWAY_YELLOW_MINUTES} دقائق أو أقل.\n` +
      `غسلات بدأ غسيلها: 🟢 من البداية، 🟡 بعد ${duration(WASH_YELLOW_MINUTES)}،` +
      ` 🔴 بعد ${duration(WASH_RED_MINUTES)}.\n` +
      `البايكر وصل وما بدأ الغسيل: 🔴 ${
        REACHED_RED_MINUTES > 0 ? `باقي ${REACHED_RED_MINUTES} دقائق أو أقل` : 'لما يجي موعدها'
      }`,
    freshCount: (n) => `جديدة ${n}`,
    minutesLeft: (n) => `باقي ${duration(n)}`,
    minutesLate: (n) => `متأخرة ${duration(n)}`,
    dueNow: 'حان موعدها',
    washing: (clock, exact) => `يغسل ${exact ? '' : '≈'}${clock}`,
    washTitle: (time, exact) =>
      exact
        ? `بدأ الغسيل ${time}`
        : `بدأ الغسيل تقريباً ${time} (أول ما شافته الإضافة، لأن تفاصيل الحجز ما انقرت)`,
    washingFor: (minutes) => `يغسل من ${duration(minutes)}`,
    reachedNow: 'وصل',
    onWayNow: 'في الطريق',
    idle: 'فاضي',
    bikers: 'البايكرية',
    close: 'إغلاق',
    bikerCounts: (done, left) => `خلّص ${done} · باقي ${left}`,
    nextWash: 'الجاية',
    allDone: 'خلّص كل غسلاته',
    noBikers: 'ما فيه غسلات',
    copy: 'نسخ',
    copied: 'انتسخ ✓',
    copyFailed: 'ما انتسخ',
    copyTitle: 'نسخ غسلاته الباقية كنص للواتساب',
    copyHeader: (name) => `غسلات ${name} الباقية:`,
    refreshTitle: (n) => `تتحدّث كل ${n} دقيقة، اضغط لتغيير الوقت`,
    refreshHeading: 'وقت التحديث',
    every: 'كل',
    minutesUnit: 'دقيقة',
    save: 'حفظ',
    presets: 'اختيار سريع:',
    refreshHint: `من ${REFRESH_RANGE[0]} إلى ${REFRESH_RANGE[1]} دقيقة، وينحفظ لكل تبويبات البوابة`,
    refreshError: `اكتب رقم صحيح من ${REFRESH_RANGE[0]} إلى ${REFRESH_RANGE[1]}`,
    unreadable: '⚠ ما قدرت أقرأ أوقات الغسلات',
    morePages: '⚠ فيه صفحات ثانية',
    timezone: '⚠ توقيت الجهاز مو توقيت السعودية',
  };

  // Already running in this page: injected twice, or both the extension (its own JS world) and
  // the phone userscript (the page's) are installed. The attribute is what both of them see.
  if (window.__swx || document.documentElement?.hasAttribute('data-swx-version')) return;
  window.__swx = VERSION;
  document.documentElement?.setAttribute('data-swx-version', VERSION);

  function makeStore(area) {
    // Even reaching the storage object can throw (blocked site data), so it is fetched per call.
    const storage = () => (area === 'local' ? localStorage : sessionStorage);
    return {
      get(key) {
        try {
          return storage().getItem(`swx:${key}`);
        } catch {
          return null;
        }
      },
      set(key, value) {
        try {
          storage().setItem(`swx:${key}`, String(value));
        } catch {}
      },
      del(key) {
        try {
          storage().removeItem(`swx:${key}`);
        } catch {}
      },
    };
  }
  const store = makeStore('session'); // this tab: survives its automatic reloads
  const prefs = makeStore('local'); // the user's settings: every tab of the portal, kept for good

  let refreshMinutes = loadRefreshMinutes();
  let nextRefreshAt = Date.now() + refreshMinutes * MINUTE;
  let lastApplyAt = 0;
  let lastActivityAt = 0;
  let phase = 'idle'; // idle | overlay | activity | probing | offline
  let reloading = false;
  let showPast = store.get('showPast') === '1';
  let sort = loadSort();
  let stats = emptyStats();
  let bikers = []; // per-biker summaries for the panel
  let washingRows = []; // the rows being washed at the last pass, for the timers' ticks
  // The phone userscript brings the sounds along and plays them in the page; the extension plays
  // its own from background.js.
  const PAGE_SOUNDS = window.__swxSounds || null;
  let soundState = PAGE_SOUNDS ? autoplayState() : 'on'; // on | blocked | unknown
  let washStarts = null; // see washStart(); loaded on first use
  const startRequests = new Map(); // booking → when its start time was last asked for
  let panelOpen = false; // the bikers panel
  let editorOpen = false; // the refresh interval editor
  let lastHref = '';
  let wasOnList = false;
  let lastDates = null;
  let pill = null;
  let observer = null;

  // ---------- helpers ----------

  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const onList = () => LIST_PATH_RE.test(location.pathname);

  function markError(error) {
    console.warn('[Sweater helper]', error);
    try {
      document.documentElement.setAttribute('data-swx-error', String(error?.message || error));
    } catch {}
  }

  function safe(fn) {
    try {
      fn();
    } catch (error) {
      markError(error);
    }
  }

  // Attribute writers that only touch the DOM when the value actually changes.
  function setFlag(el, name, on) {
    if (on !== el.hasAttribute(name)) el.toggleAttribute(name, on);
  }

  function setValue(el, name, value) {
    if (value == null) {
      if (el.hasAttribute(name)) el.removeAttribute(name);
    } else if (el.getAttribute(name) !== value) {
      el.setAttribute(name, value);
    }
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // The element holding a cell's value: td > div.flex > div in the portal's markup.
  const inner = (cell) =>
    cell && (cell.firstElementChild?.firstElementChild || cell.firstElementChild || cell);

  // "3:15 PM", like the portal.
  function fmtTime(ms) {
    const d = new Date(ms);
    return `${d.getHours() % 12 || 12}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
  }

  // The portal's service time format, rounded: "58m", "1h 9m", "2h".
  function fmtMinutes(minutes) {
    const total = Math.round(minutes);
    const h = Math.floor(total / 60);
    const m = total % 60;
    return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
  }

  // "25 د" or "1 س 20 د", for the late labels.
  function duration(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h ? `${h} س${m ? ` ${m} د` : ''}` : `${m} د`;
  }

  // "7:05" or "1:02:09", like a stopwatch: how long a wash has been going.
  function stopwatch(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const rest = `${pad(m)}:${pad(seconds % 60)}`;
    return h ? `${h}:${rest}` : rest.replace(/^0/, '');
  }

  // A cookie as the portal writes and reads it (raw, not URI-encoded).
  function cookie(name) {
    const entry = document.cookie.split('; ').find((part) => part.startsWith(`${name}=`));
    return entry ? entry.slice(name.length + 1) : null;
  }

  function emptyStats() {
    return {
      rows: 0,
      parsed: 0,
      past: 0,
      total: 0,
      done: 0,
      remaining: 0,
      cancelled: 0,
      red: 0,
      yellow: 0,
      green: 0,
      fresh: 0,
    };
  }

  // ---------- URL: page size and dates ----------

  function param(name) {
    const value = new URLSearchParams(location.search).get(name);
    return value == null ? null : value.replace(/^"(.*)"$/, '$1');
  }

  // The current URL with some params replaced (null removes one). The other params are kept
  // byte for byte, since the portal stores its filters in them as URL-encoded JSON.
  function withParams(updates) {
    const keys = Object.keys(updates);
    const parts = location.search
      .slice(1)
      .split('&')
      .filter((part) => part && !keys.includes(part.split('=')[0]));
    for (const key of keys) {
      if (updates[key] != null) parts.push(`${key}=${encodeURIComponent(updates[key])}`);
    }
    return location.pathname + (parts.length ? `?${parts.join('&')}` : '') + location.hash;
  }

  const needsPageSize = () => !(Number(param('pageSize')) >= PAGE_SIZE);
  const pageSizeUrl = () => withParams({ pageSize: PAGE_SIZE, page: null });

  // Runs at document_start, before the portal's router reads the URL, so no reload is needed.
  function fixPageSizeEarly() {
    if (onList() && needsPageSize()) history.replaceState(history.state, '', pageSizeUrl());
  }

  // Entering the list through in-app navigation (the sidebar link carries no pageSize).
  function fixPageSizeOnSpaEntry() {
    if (!needsPageSize()) return false;
    if (Date.now() - (Number(store.get('psFixAt')) || 0) < SPA_FIX_GUARD_MS) return false;
    store.set('psFixAt', Date.now());
    location.replace(pageSizeUrl());
    return true;
  }

  // The day the board follows: set while the URL shows exactly today, cleared when the dates
  // change to anything else. Lives in sessionStorage so it survives reloads of this tab.
  function noteTrackedDay() {
    const from = param('fromDate');
    const to = param('toDate');
    const dates = `${from}|${to}`;
    const changed = lastDates !== null && dates !== lastDates;
    lastDates = dates;
    const today = ymd(Date.now());
    if (from && from === to && from === today) store.set('trackedDay', today);
    else if (changed) store.del('trackedDay');
  }

  // After midnight, move a board that was following "today" to the new day. The switch waits
  // for the grace period so last night's late slots still expire on screen.
  function rolloverUrl() {
    const tracked = store.get('trackedDay');
    if (!tracked || param('fromDate') !== tracked || param('toDate') !== tracked) return null;
    const day = ymd(Date.now() - GRACE_MS);
    return day > tracked ? withParams({ fromDate: day, toDate: day, page: null }) : null;
  }

  function checkRoute() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    const nowOnList = onList();
    const entered = nowOnList && !wasOnList;
    wasOnList = nowOnList;
    if (!nowOnList) {
      panelOpen = editorOpen = false;
      return;
    }
    if (entered) {
      if (fixPageSizeOnSpaEntry()) return;
      nextRefreshAt = Date.now() + refreshMinutes * MINUTE;
      phase = 'idle';
    }
    noteTrackedDay();
  }

  // ---------- refresh interval (chosen from the pill) ----------

  function validMinutes(value) {
    const minutes = Number(value);
    return Number.isInteger(minutes) && minutes >= REFRESH_RANGE[0] && minutes <= REFRESH_RANGE[1]
      ? minutes
      : null;
  }

  function loadRefreshMinutes() {
    return validMinutes(prefs.get('refreshMinutes')) ?? REFRESH_MINUTES;
  }

  // The countdown restarts from the new interval, here and (through the storage event) in the
  // portal's other tabs.
  function setRefreshMinutes(minutes) {
    refreshMinutes = minutes;
    if (minutes === REFRESH_MINUTES) prefs.del('refreshMinutes');
    else prefs.set('refreshMinutes', minutes);
    nextRefreshAt = Date.now() + minutes * MINUTE;
    if (phase !== 'offline') phase = 'idle';
    editorOpen = false;
    renderPill();
  }

  function onStorage(event) {
    if (event.key !== 'swx:refreshMinutes') return;
    refreshMinutes = loadRefreshMinutes();
    nextRefreshAt = Date.now() + refreshMinutes * MINUTE;
    renderPill();
  }

  // ---------- reading the table ----------

  function norm(text) {
    return String(text ?? '')
      .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '') // bidi marks
      .replace(/[٠-٩]/g, (digit) => ARABIC_DIGITS.indexOf(digit))
      .replace(/\s+/g, ' ') // also NBSP and U+202F
      .trim();
  }

  const validDate = (y, m, d) => (m >= 0 && m <= 11 && d >= 1 && d <= 31 ? { y, m, d } : null);

  // "Oct 6, 2026" as rendered by the portal, or a raw "2026-10-06..." if its formatting failed.
  function parseDate(text) {
    const s = norm(text);
    let m = /^([a-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/i.exec(s);
    if (m) {
      const month = MONTHS.indexOf(m[1].toLowerCase());
      return month < 0 ? null : validDate(+m[3], month, +m[2]);
    }
    m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(s);
    return m ? validDate(+m[1], +m[2] - 1, +m[3]) : null;
  }

  // "9:00 AM" as rendered by the portal, or a raw "14:30[:00]" if its formatting failed.
  function parseTime(text) {
    const m = /^(\d{1,2}):(\d{2})(?::\d{2})?(?: ?([ap])\.?m\.?| ?([صم]))?$/i.exec(norm(text));
    if (!m) return null;
    let h = +m[1];
    const mi = +m[2];
    const meridiem = m[3] ? m[3].toLowerCase() : { ص: 'a', م: 'p' }[m[4]];
    if (mi > 59) return null;
    if (meridiem) {
      if (h < 1 || h > 12) return null;
      h = (h % 12) + (meridiem === 'p' ? 12 : 0);
    } else if (h > 23) {
      return null;
    }
    return { h, mi };
  }

  // Column positions from the header labels (English or Arabic UI). Users can hide columns,
  // so positions are looked up on every pass.
  function columnsOf(table) {
    const cols = Object.fromEntries(Object.keys(HEADERS).map((key) => [key, -1]));
    const head = table.tHead?.rows[0];
    if (!head) return cols;
    Array.from(head.cells).forEach((cell, index) => {
      const label = norm(cell.textContent).toLowerCase();
      for (const key of Object.keys(HEADERS)) {
        if (cols[key] < 0 && HEADERS[key].includes(label)) cols[key] = index;
      }
    });
    return cols;
  }

  function idNumber(cell) {
    const m = cell && /\d+/.exec(norm(cell.textContent));
    return m ? Number(m[0]) : null;
  }

  // "58m", "1h 8.5m" or "58.46666666666667m" as rendered by the portal; "N/A" has no value.
  function serviceMinutes(text) {
    const m = /^(?:(\d+(?:\.\d+)?)h)? ?(?:(\d+(?:\.\d+)?)m)?$/i.exec(text || '');
    return m && (m[1] || m[2]) ? (+m[1] || 0) * 60 + (+m[2] || 0) : null;
  }

  function rowInfo(tr, cols, urlDay) {
    const cells = tr.cells;
    // Loading, "No bookings found." and error rows are a single wide cell: leave them alone.
    if (cells.length < 2) {
      return { tr, data: false, ts: null, id: null, text: norm(tr.textContent) };
    }
    let date = cols.date >= 0 ? parseDate(cells[cols.date]?.textContent) : null;
    let time = cols.time >= 0 ? parseTime(cells[cols.time]?.textContent) : null;
    // A column whose header wasn't found: recognise the value by its shape instead.
    if (cols.date < 0 || cols.time < 0) {
      for (const cell of cells) {
        if (!date && cols.date < 0) date = parseDate(cell.textContent);
        if (!time && cols.time < 0) time = parseTime(cell.textContent);
      }
    }
    if (!date) date = urlDay; // date column hidden while viewing a single day
    const ts = date && time ? new Date(date.y, date.m, date.d, time.h, time.mi).getTime() : null;
    const cell = (key) => (cols[key] >= 0 ? cells[cols[key]] || null : null);
    const text = (key) => norm(cell(key)?.textContent) || null;
    const idCell = cells[cols.id >= 0 ? cols.id : 0];
    const bikerCell = cell('biker');
    const status = text('status') || '';
    return {
      tr,
      data: true,
      ts,
      id: idNumber(idCell),
      idCell,
      idText: norm(idCell.textContent),
      bikerCell,
      biker: text('biker'), // name and mobile number: tells two bikers with the same name apart
      bikerName: norm(bikerCell?.querySelector('span')?.textContent) || text('biker'),
      timeCell: cell('time'),
      serviceCell: cell('service'),
      statusText: status,
      cancelled: CANCELLED_RE.test(status),
      done: DONE_RE.test(status),
      initiated: INITIATED_RE.test(status),
      onWay: ON_WAY_RE.test(status),
      reached: REACHED_RE.test(status),
      washing: WASHING_RE.test(status),
      zone: text('zone'),
      serviceText: text('service'),
      service: serviceMinutes(text('service')),
    };
  }

  function bookingTables() {
    const root = document.getElementById('root');
    const tables = Array.from((root || document).querySelectorAll('table'));
    return root ? tables : tables.filter((table) => !table.closest(OVERLAY_SELECTOR));
  }

  const sortValue = (item) => (sort.key === 'time' ? item.ts : item[sort.key]);

  // The chosen column first (rows without a value last, in both directions), then time, then
  // booking number: sorted by biker, each biker's washes follow each other in time order.
  function compareRows(a, b) {
    const va = sortValue(a);
    const vb = sortValue(b);
    if ((va == null) !== (vb == null)) return va == null ? 1 : -1;
    if (va != null) {
      const primary = typeof va === 'string' ? COLLATOR.compare(va, vb) : va - vb;
      if (primary) return sort.dir === 'desc' ? -primary : primary;
    }
    return (
      (a.ts == null) - (b.ts == null) ||
      (a.ts || 0) - (b.ts || 0) ||
      (a.id == null) - (b.id == null) ||
      (a.id || 0) - (b.id || 0) ||
      a.index - b.index
    );
  }

  // Rows only move inside their own <tbody> and are never removed, so React's later
  // insertBefore/removeChild calls still find them where it expects: inside that <tbody>.
  function sortRows(tbody, items) {
    const wanted = items.map((item, index) => ({ ...item, index })).sort(compareRows);
    wanted.forEach((item, position) => {
      const current = tbody.rows[position];
      if (current !== item.tr) tbody.insertBefore(item.tr, current || null);
    });
  }

  // "2/4" next to the biker: the booking's place among that biker's washes of the day, counting
  // every row of the table (hidden ones too) except cancelled ones.
  function markSequence(items) {
    const groups = new Map();
    for (const item of items) {
      if (item.ts == null || !item.biker || item.cancelled) continue;
      const key = `${item.biker}|${ymd(item.ts)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    const places = new Map();
    for (const list of groups.values()) {
      list.sort((a, b) => a.ts - b.ts || (a.id || 0) - (b.id || 0));
      list.forEach((item, index) => places.set(item, [index + 1, list.length]));
    }
    for (const item of items) {
      if (!item.bikerCell) continue;
      // The mobile number under the name: shorter than the name, so the badge after it doesn't
      // widen the column (and the name itself is truncated by the portal when long).
      const spans = item.bikerCell.querySelectorAll('span');
      const target = spans[spans.length - 1] || item.bikerCell;
      const place = places.get(item);
      setValue(target, ATTR_SEQ, place ? place.join('/') : null);
      setValue(target, 'title', place ? TXT.seqTitle(...place) : null);
    }
  }

  // Booking Time and Biker headers sort on click; aria-sort marks the active column.
  function markHeaders(table, cols) {
    const head = table.tHead?.rows[0];
    if (!head) return;
    Array.from(head.cells).forEach((th, index) => {
      const own = OWN_SORT_COLUMNS.find((key) => cols[key] === index) || null;
      setValue(th, ATTR_SORTABLE, own);
      setValue(th, 'tabindex', own ? '0' : null);
      const active = cols[sort.key] === index;
      setValue(th, 'aria-sort', active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : null);
    });
  }

  // [yellow, red] minutes before the booking time, for the statuses whose wash hasn't started:
  // "Initiated" (the biker hasn't set off), "On the Way" and "Reached" (red only).
  function lateLimits(item) {
    if (item.initiated) return [LATE_YELLOW_MINUTES, LATE_RED_MINUTES];
    if (item.onWay) return [ONWAY_YELLOW_MINUTES, ONWAY_RED_MINUTES];
    if (item.reached) return [REACHED_RED_MINUTES, REACHED_RED_MINUTES];
    return null;
  }

  // Off the screen: a finished wash right away, a cancelled one GRACE_MINUTES after its slot.
  // A wash that isn't finished (on the way, washing...) stays, however late. Without a Status
  // column only the time is known, so then it's GRACE_MINUTES after the slot for every row.
  function isHidden(item, now, hasStatus) {
    if (!item.data) return false;
    if (item.done) return true;
    const past = item.ts != null && now - item.ts > GRACE_MS;
    return past && (item.cancelled || !hasStatus);
  }

  // Close to or past the booking time and the wash hasn't started: yellow, then red.
  function lateLevel(item, now) {
    const limits = lateLimits(item);
    if (!limits || item.ts == null) return null;
    const left = (item.ts - now) / MINUTE;
    if (left <= limits[1]) return 'red';
    return left <= limits[0] ? 'yellow' : null;
  }

  // The colour of a row (for the bikers panel): its wash timer, or how late it is.
  function rowTone(item, now) {
    if (!item.washing) return lateLevel(item, now);
    return item.start ? washTone(item.start, now) : 'green';
  }

  function lateLabel(item, now) {
    const left = Math.ceil((item.ts - now) / MINUTE);
    if (left > 0) return TXT.minutesLeft(left);
    const late = Math.floor((now - item.ts) / MINUTE);
    return late > 0 ? TXT.minutesLate(late) : TXT.dueNow;
  }

  // ---------- washes in progress ----------

  // When each wash started, by booking number: { at, exact, saved }. Exact is the start of the
  // service from the booking's details; until those are read it's when this browser first saw
  // the booking washing. Kept in memory (the storage can be blocked) and in the storage for the
  // other tabs and the next loads; an entry is forgotten a day after it was saved.
  function loadWashStarts() {
    try {
      const starts = JSON.parse(prefs.get('washStarts') || '{}');
      return starts && typeof starts === 'object' ? starts : {};
    } catch {
      return {};
    }
  }

  function setWashStart(id, start, now) {
    washStarts[id] = start;
    const all = loadWashStarts(); // what the other tabs saved meanwhile
    for (const [key, mine] of Object.entries(washStarts)) {
      const theirs = all[key];
      if (!theirs?.exact && (mine.exact || !(theirs?.at <= mine.at))) all[key] = mine;
    }
    for (const [key, entry] of Object.entries(all)) {
      if (!(now - entry?.saved < WASH_KEEP_MS)) delete all[key];
    }
    washStarts = all;
    prefs.set('washStarts', JSON.stringify(all));
  }

  function washStart(item, now) {
    washStarts ??= loadWashStarts();
    let start = washStarts[item.id];
    if (!start) {
      start = { at: now, exact: false, saved: now };
      setWashStart(item.id, start, now);
    }
    if (!start.exact) requestStart(item.id);
    return start;
  }

  // Reads the exact start in the background, then redraws. Asked at most every API_RETRY_MS per
  // booking: a failure keeps the first-seen time until the next try.
  function requestStart(id) {
    const last = startRequests.get(id);
    if (last != null && Date.now() - last < API_RETRY_MS) return;
    startRequests.set(id, Date.now());
    fetchStart(id)
      .then((at) => {
        if (at == null) return;
        const now = Date.now();
        setWashStart(id, { at, exact: true, saved: now }, now);
        if (onList()) safe(applyAll);
      })
      .catch(() => {});
  }

  // The request the portal's "View Details" makes, with its login (its cookies): only the start
  // of the service is kept from the answer.
  async function fetchStart(id) {
    const token = cookie('access_token');
    if (!token) return null;
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'Accept-Language': cookie('lang') || 'en',
    };
    const provider = cookie('selected_service_provider');
    if (provider) headers['X-Service-Provider-Id'] = provider;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_BASE}/Bookings/${id}`, {
        headers,
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const body = await response.json();
      const value = body?.data?.timeline?.startServiceTime;
      const at = value ? new Date(value).getTime() : NaN; // parsed like the portal shows it
      return Number.isFinite(at) && at <= Date.now() + MINUTE ? at : null;
    } finally {
      clearTimeout(timer);
    }
  }

  // Green while washing, yellow after WASH_YELLOW_MINUTES, red after WASH_RED_MINUTES.
  function washTone(start, now) {
    const minutes = (now - start.at) / MINUTE;
    if (minutes >= WASH_RED_MINUTES) return 'red';
    return minutes >= WASH_YELLOW_MINUTES ? 'yellow' : 'green';
  }

  // The washing row's colour and timer, also run every second between the passes.
  function markWashing(item, start, now) {
    setValue(item.tr, ATTR_TONE, washTone(start, now));
    const time = inner(item.timeCell);
    if (!time) return;
    setValue(time, ATTR_NOTE, TXT.washing(stopwatch(now - start.at), start.exact));
    setValue(time, 'title', TXT.washTitle(fmtTime(start.at), start.exact));
  }

  function tickWashing(now) {
    for (const { item, start } of washingRows) {
      if (item.tr.isConnected) markWashing(item, start, now);
    }
  }

  // Per row: day summary counts, colour and the line under the time, rounded service time.
  function markRow(item, now, counts, washing) {
    if (!item.data) return;
    counts.total++;
    if (item.cancelled) counts.cancelled++;
    else if (item.done) counts.done++;
    else counts.remaining++;
    const time = inner(item.timeCell);
    if (item.washing && item.id != null) {
      const start = washStart(item, now);
      item.start = start;
      washing.push({ item, start });
      markWashing(item, start, now);
      item.tone = washTone(start, now);
    } else {
      item.tone = lateLevel(item, now);
      setValue(item.tr, ATTR_TONE, item.tone);
      if (time) {
        setValue(time, ATTR_NOTE, item.tone ? lateLabel(item, now) : null);
        setValue(time, 'title', null);
      }
    }
    if (item.tone) counts[item.tone]++;
    const service = inner(item.serviceCell);
    if (service) {
      const rounded = item.service == null ? null : fmtMinutes(item.service);
      setValue(service, ATTR_SERVICE, rounded && rounded !== item.serviceText ? rounded : null);
    }
  }

  // The filters (URL params) the table was loaded with: a booking is only "new" compared with
  // earlier loads of the same view, never because a date, filter or page changed.
  function viewKey() {
    const params = new URLSearchParams(location.search);
    if (!params.has('page')) params.set('page', '1');
    return [...params]
      .map(([key, value]) => `${key}=${value}`)
      .sort()
      .join('&');
  }

  // Bookings that weren't in this view at its earlier loads (this tab): "new" for
  // NEW_BADGE_MINUTES, plus one Windows notification per batch. The first table seen for a view
  // (or its "No bookings found." row) is only recorded. Returns how many rows are new.
  function markNew(items, now) {
    const bookings = items.filter((item) => item.data && item.id != null);
    const storeKey = `seen:${viewKey()}`;
    let seen = null;
    try {
      seen = JSON.parse(store.get(storeKey) || 'null');
    } catch {}
    if (!seen) {
      const empty = items.length === 1 && EMPTY_RE.test(items[0].text || '');
      if (!bookings.length && !empty) return 0; // loading or error row: nothing to record yet
      seen = Object.fromEntries(bookings.map((item) => [item.id, 0]));
      store.set(storeKey, JSON.stringify(seen));
    }
    const fresh = bookings.filter((item) => !(item.id in seen));
    if (fresh.length) {
      for (const item of fresh) seen[item.id] = now;
      store.set(storeKey, JSON.stringify(seen));
      notify('swx:new-bookings', fresh, bookingLine, NEW_BOOKING_SOUND);
    }
    let count = 0;
    for (const item of bookings) {
      const isNew = seen[item.id] > 0 && now - seen[item.id] < NEW_BADGE_MS;
      if (isNew) count++;
      setFlag(inner(item.idCell), ATTR_NEW, isNew);
    }
    return count;
  }

  // Bookings that were cancelled since the earlier loads of this view (this tab): "ألغي" for
  // NEW_BADGE_MINUTES, plus one Windows notification per batch, like the new ones. A booking seen
  // for the first time (the first table of a view, or a new booking) is only recorded.
  function markCancelled(items, now) {
    const bookings = items.filter((item) => item.data && item.id != null);
    if (!bookings.length) return; // loading or error row: nothing to compare yet
    const storeKey = `cancel:${viewKey()}`;
    let known = null;
    try {
      known = JSON.parse(store.get(storeKey) || 'null');
    } catch {}
    known ||= {};
    const fresh = [];
    let changed = false;
    for (const item of bookings) {
      const was = known[item.id];
      const cancelled = item.cancelled ? 1 : 0;
      if (was && was.c === cancelled) continue;
      known[item.id] = was && cancelled ? { c: 1, at: now } : { c: cancelled };
      if (was && cancelled) fresh.push(item);
      changed = true;
    }
    if (changed) store.set(storeKey, JSON.stringify(known));
    if (fresh.length) {
      const line = (item) => `${bookingLine(item)} — ${item.statusText}`;
      notify('swx:cancelled', fresh, line, CANCEL_ALERT_SOUND);
    }
    for (const item of bookings) {
      const at = known[item.id]?.at;
      setFlag(inner(item.idCell), ATTR_CANCELLED, at > 0 && now - at < NEW_BADGE_MS);
    }
  }

  // Bookings that turned red (late, or washing too long): one notification with the beep per
  // batch, once per booking for being late and once for a long wash. Today's bookings only. The
  // ones already told are kept for this tab, so the automatic reloads don't repeat them.
  function alertRed(items, now) {
    if (!RED_ALERTS) return;
    const today = ymd(now);
    const red = items.filter(
      (item) => item.tone === 'red' && item.id != null && item.ts != null && ymd(item.ts) === today,
    );
    if (!red.length) return;
    let told = {};
    try {
      told = JSON.parse(store.get('redAlerts') || '{}') || {};
    } catch {}
    const key = (item) => `${item.id}:${item.washing ? 'wash' : 'late'}`;
    const fresh = red.filter((item) => !(key(item) in told));
    if (!fresh.length) return;
    for (const item of fresh) told[key(item)] = now;
    for (const [entry, at] of Object.entries(told)) {
      if (!(now - at < ALERT_KEEP_MS)) delete told[entry];
    }
    store.set('redAlerts', JSON.stringify(told));
    const reason = (item) =>
      item.washing
        ? TXT.washing(stopwatch(now - item.start.at), item.start.exact)
        : `${item.statusText} · ${lateLabel(item, now)}`;
    const line = (item) => `${bookingLine(item, false)} — ${reason(item)}`;
    notify('swx:red-alert', fresh, line, RED_ALERT_SOUND);
  }

  // "3:15 PM · Kawsar Hosain (1986) · Wurood · B-5583962"
  function bookingLine(item, withId = true) {
    const time = item.ts == null ? null : fmtTime(item.ts);
    return [time, item.bikerName, item.zone, withId ? item.idText : null]
      .filter(Boolean)
      .join(' · ');
  }

  // background.js turns this into the sound and the Windows notification. Without the extension
  // (the phone userscript, or after the extension was reloaded) the page does what it can.
  function notify(type, items, lineOf, sound) {
    const lines = [...items]
      .sort((a, b) => (a.ts ?? Infinity) - (b.ts ?? Infinity))
      .map((item) => lineOf(item)); // map(lineOf) would pass the index as bookingLine's withId
    try {
      if (globalThis.chrome?.runtime?.id) {
        const sent = chrome.runtime.sendMessage({ type, count: items.length, lines, sound });
        sent?.catch?.(() => {});
        return;
      }
    } catch {}
    pageAlert(type, items.length, lines, sound).catch(markError);
  }

  // ---------- sounds and notifications without the extension (phones) ----------

  const ALERT_SOUNDS = {
    'swx:new-bookings': 'new',
    'swx:red-alert': 'red',
    'swx:cancelled': 'cancel',
  };

  // The sound plays when the browser lets the page play one (on Android: autoplay allowed for the
  // site in Firefox, or a tap since the page loaded), and the notification shows in the phone's
  // bar if the site may send them.
  async function pageAlert(type, count, lines, sound) {
    if (!PAGE_SOUNDS) return;
    const played = sound ? await playSound(PAGE_SOUNDS[ALERT_SOUNDS[type]]) : false;
    if (globalThis.Notification?.permission !== 'granted') return;
    const shown = lines.slice(0, 4);
    try {
      new Notification(TXT.alertTitles[type](count), {
        body: shown.join('\n') + (count > shown.length ? `\n+${count - shown.length}` : ''),
        lang: 'ar',
        dir: 'rtl',
        silent: played, // our sound instead of the phone's, not both
      });
    } catch {} // some phone browsers only take notifications from a service worker
  }

  function playSound(src) {
    return new Audio(src).play().then(
      () => (setSoundState('on'), true),
      () => (setSoundState('blocked'), false),
    );
  }

  // What the browser says before anything plays (Firefox can tell; the others can't).
  function autoplayState() {
    try {
      const policy = navigator.getAutoplayPolicy?.('mediaelement');
      if (policy === 'allowed') return 'on';
      if (policy) return 'blocked';
    } catch {}
    return 'unknown';
  }

  function setSoundState(state) {
    if (soundState === state) return;
    soundState = state;
    renderPill();
  }

  // The pill's 🔊 button: the tap lets this page play sound (until it reloads, unless autoplay is
  // allowed for the site) and is the moment to ask for notifications.
  function enableSound() {
    playSound(PAGE_SOUNDS.new);
    if (globalThis.Notification?.permission === 'default') {
      Notification.requestPermission()?.catch?.(() => {});
    }
  }

  // "🔴 2 · " before the tab's title while red bookings are on the list, so they show from the
  // other tabs too.
  function markTitle(red) {
    const base = document.title.replace(TITLE_PREFIX_RE, '');
    const title = red ? `🔴 ${red} · ${base}` : base;
    if (document.title !== title) document.title = title;
  }

  // What a biker is busy with: the wash being washed, else the customer reached, else the one on
  // the way to. Free otherwise.
  const ACTIVE = [(item) => item.washing, (item) => item.reached, (item) => item.onWay];

  function activity(item, now) {
    const tone = rowTone(item, now);
    if (item.washing) {
      const minutes = item.start ? Math.floor((now - item.start.at) / MINUTE) : 0;
      return { text: TXT.washingFor(minutes), zone: item.zone, note: null, tone };
    }
    const text = item.reached ? TXT.reachedNow : TXT.onWayNow;
    const note = item.ts == null ? null : lateLabel(item, now);
    return { text, zone: item.zone, note, tone };
  }

  // The bikers panel: per biker, washes done and left (cancelled ones don't count), what they're
  // doing now and their next wash, and the remaining list as text to copy. Bikers with a wash
  // coming up first.
  function summarizeBikers(items, now) {
    const byBiker = new Map();
    for (const item of items) {
      if (!item.data || !item.biker || item.cancelled) continue;
      const biker = byBiker.get(item.biker) || { name: item.bikerName, done: 0, left: [] };
      byBiker.set(item.biker, biker);
      if (item.done) biker.done++;
      else biker.left.push(item);
    }
    return [...byBiker.values()]
      .map(({ name, done, left }) => {
        left.sort((a, b) => (a.ts ?? Infinity) - (b.ts ?? Infinity) || (a.id || 0) - (b.id || 0));
        const when = (item) => (item.ts == null ? '—' : fmtTime(item.ts));
        const active = ACTIVE.reduce((found, test) => found || left.find(test), null);
        const upcoming = left.find((item) => item !== active);
        return {
          name,
          done,
          left: left.length,
          nextAt: left[0]?.ts ?? null,
          doing: active
            ? activity(active, now)
            : { text: left.length ? TXT.idle : TXT.allDone, tone: 'idle' },
          upcoming: upcoming && {
            detail: [when(upcoming), upcoming.zone].filter(Boolean).join(' · '),
            tone: rowTone(upcoming, now),
          },
          copy: [
            TXT.copyHeader(name),
            ...left.map(
              (item, i) =>
                `${i + 1}) ${[when(item), item.zone, item.idText].filter(Boolean).join(' - ')}`,
            ),
          ].join('\n'),
        };
      })
      .sort(
        (a, b) =>
          (a.left ? 0 : 1) - (b.left ? 0 : 1) ||
          (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity) ||
          COLLATOR.compare(a.name, b.name),
      );
  }

  function applyAll() {
    const now = Date.now();
    lastApplyAt = now;
    const from = param('fromDate');
    const urlDay = from && from === param('toDate') ? parseDate(from) : null;
    const next = emptyStats();
    const nextWashing = [];
    let nextBikers = [];
    for (const table of bookingTables()) {
      const tbody = table.tBodies[0];
      if (!tbody) continue;
      const cols = columnsOf(table);
      markHeaders(table, cols);
      const items = Array.from(tbody.rows, (tr) => rowInfo(tr, cols, urlDay));
      markSequence(items);
      const hasStatus = cols.status >= 0;
      let rows = 0;
      let parsed = 0;
      let past = 0;
      for (const item of items) {
        const hidden = isHidden(item, now, hasStatus);
        setFlag(item.tr, ATTR_PAST, hidden);
        markRow(item, now, next, nextWashing);
        if (item.data) rows++;
        if (item.ts != null) parsed++;
        if (hidden) past++;
      }
      next.fresh += markNew(items, now);
      markCancelled(items, now);
      alertRed(items, now);
      if (parsed) sortRows(tbody, items);
      if (table.parentElement) {
        const allHidden = rows > 0 && past === rows;
        setValue(table.parentElement, ATTR_EMPTY, allHidden ? TXT.noUpcoming : null);
      }
      next.rows += rows;
      next.parsed += parsed;
      next.past += past;
      nextBikers = nextBikers.concat(summarizeBikers(items, now));
    }
    stats = next;
    bikers = nextBikers;
    washingRows = nextWashing;
    markTitle(next.red);
    observer?.takeRecords(); // our own writes must not trigger another pass
    renderPill();
  }

  // ---------- sorting ----------

  // The chosen order lives in sessionStorage so it survives the automatic reloads of this tab.
  function loadSort() {
    const [key, dir] = (store.get('sort') || '').split(':');
    return SORT_KEYS.includes(key) && (dir === 'asc' || dir === 'desc')
      ? { key, dir }
      : { ...DEFAULT_SORT };
  }

  const isDefaultSort = () => sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir;

  function setSort(key, dir) {
    sort = { key, dir };
    if (isDefaultSort()) store.del('sort');
    else store.set('sort', `${key}:${dir}`);
    applyAll();
  }

  // Same column again flips the direction; another column starts ascending.
  function toggleSort(key) {
    setSort(key, sort.key === key && sort.dir === 'asc' ? 'desc' : 'asc');
  }

  const sortableHeader = (target) =>
    target instanceof Element ? target.closest(`#root thead th[${ATTR_SORTABLE}]`) : null;

  // The portal's own Asc/Desc column menu: its result would be undone by the next pass, so the
  // choice becomes the extension's order instead. "Hide" is left to the portal.
  function sortFromMenu(item) {
    const dir = { asc: 'asc', desc: 'desc' }[norm(item.textContent).toLowerCase()];
    const th = document.querySelector('#root thead button[aria-expanded="true"]')?.closest('th');
    if (!dir || !th) return;
    const label = norm(th.textContent).toLowerCase();
    const column = Object.keys(MENU_SORT_KEYS).find((key) => HEADERS[key].includes(label));
    if (column) setSort(MENU_SORT_KEYS[column], dir);
  }

  function onClick(event) {
    if (!onList()) return;
    // A click anywhere outside the pill closes its panels.
    const outside = pill && !event.composedPath().includes(pill.host);
    if ((panelOpen || editorOpen) && outside) setPanel(null);
    const th = sortableHeader(event.target);
    if (th) return toggleSort(th.getAttribute(ATTR_SORTABLE));
    const item = event.target instanceof Element && event.target.closest('[role="menuitem"]');
    if (item) sortFromMenu(item);
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && (panelOpen || editorOpen)) return setPanel(null);
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const th = onList() && sortableHeader(event.target);
    if (!th) return;
    event.preventDefault();
    toggleSort(th.getAttribute(ATTR_SORTABLE));
  }

  // ---------- auto refresh ----------

  function overlayOpen() {
    return Array.from(document.querySelectorAll(OVERLAY_SELECTOR)).some(
      (el) => el.getClientRects().length > 0,
    );
  }

  function busyReason(now) {
    const idle = now - lastActivityAt;
    const open = panelOpen || editorOpen || overlayOpen();
    if (idle < OVERLAY_IDLE_LIMIT_MS && open) return 'overlay';
    if (idle < ACTIVITY_GRACE_MS && now - nextRefreshAt < MAX_ACTIVITY_POSTPONE_MS) {
      return 'activity';
    }
    return null;
  }

  // Reloading while offline would leave Chrome's error page, without this script, on screen.
  async function isOnline() {
    if (navigator.onLine === false) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      await fetch('/', { method: 'HEAD', cache: 'no-store', signal: controller.signal });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  // `force`: the refresh-now button, which doesn't wait for an open dialog or recent activity.
  async function startReload(force = false) {
    reloading = true;
    phase = 'probing';
    renderPill();
    const online = await isOnline();
    const reason = online && !force ? busyReason(Date.now()) : null;
    if (!online || reason || !onList()) {
      reloading = false;
      phase = online ? reason || 'idle' : 'offline';
      if (!online) nextRefreshAt = Date.now() + OFFLINE_RETRY_MS;
      renderPill();
      return;
    }
    const url = rolloverUrl();
    if (url) location.replace(url);
    else location.reload();
  }

  function tick() {
    safe(() => {
      checkRoute();
      if (onList()) {
        const now = Date.now();
        if (now - lastApplyAt >= REAPPLY_MS) applyAll();
        else tickWashing(now);
        if (!reloading && now >= nextRefreshAt) {
          const reason = busyReason(now);
          if (reason) phase = reason;
          else startReload().catch(markError);
        } else if (!reloading && phase !== 'offline') {
          phase = 'idle';
        }
      }
      renderPill();
    });
  }

  // ---------- status pill ----------

  const PILL_CSS = `
    .pill, .panel {
      background: var(--popover, #18181b); color: var(--popover-foreground, #fafafa);
      border: 1px solid var(--border, rgba(127, 127, 127, 0.35));
      font: 500 13px/1.5 Tajawal, system-ui, sans-serif;
      box-sizing: border-box;
    }
    /* Two rows: the day at a glance on top, the controls below. */
    .pill {
      display: flex; flex-direction: column; align-items: center; gap: 4px;
      padding: 6px 14px; border-radius: 18px;
      max-width: calc(100vw - 32px);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
      white-space: nowrap; user-select: none;
    }
    .row {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 4px 8px;
    }
    .part { display: inline-flex; align-items: center; gap: 8px; }
    .sep { opacity: 0.5; }
    button {
      font: inherit; color: inherit; cursor: pointer;
      background: transparent; border: 1px solid var(--border, rgba(127, 127, 127, 0.35));
      border-radius: 999px; padding: 1px 10px;
    }
    button:hover { background: var(--accent, rgba(127, 127, 127, 0.15)); }
    button:focus-visible { outline: 2px solid var(--ring, #f97316); outline-offset: 2px; }
    button:disabled { opacity: 0.4; cursor: default; }
    .fresh-text { color: #22c55e; }
    .sound-on { color: #f59e0b; border-color: #f59e0b; }
    .warn { color: #f59e0b; }
    .panel {
      position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%);
      width: min(600px, calc(100vw - 32px)); max-height: 55vh; overflow: auto;
      padding: 8px 14px; border-radius: 14px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    }
    .panel-head {
      display: flex; align-items: center; justify-content: space-between;
      padding-bottom: 6px; font-weight: 700;
    }
    .biker {
      display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto;
      align-items: center; gap: 12px; padding: 6px 0;
      border-top: 1px solid var(--border, rgba(127, 127, 127, 0.25));
    }
    .biker .name { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .biker .counts, .biker .now { white-space: nowrap; }
    .biker .counts { opacity: 0.85; }
    .doing { font-weight: 700; }
    .doing.idle { font-weight: 400; opacity: 0.7; }
    .upcoming { font-size: 12px; opacity: 0.75; }
    .doing.green, .upcoming.green { color: #16a34a; opacity: 1; }
    .doing.yellow, .upcoming.yellow { color: #f59e0b; opacity: 1; }
    .doing.red, .upcoming.red { color: #ef4444; opacity: 1; }
    .empty { padding: 8px 0; opacity: 0.7; }
    /* The countdown doubles as the button that opens the refresh editor. */
    .status { border: 0; padding: 0; border-radius: 4px; }
    .status:hover { background: none; text-decoration: underline; }
    .panel.refresh { width: min(360px, calc(100vw - 32px)); }
    .refresh-form { display: flex; align-items: center; gap: 8px; padding: 4px 0 8px; }
    .refresh-form input {
      width: 5em; font: inherit; color: inherit; text-align: center;
      background: transparent; border: 1px solid var(--border, rgba(127, 127, 127, 0.35));
      border-radius: 8px; padding: 2px 6px;
    }
    .presets { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .hint { padding-top: 6px; font-size: 12px; opacity: 0.7; white-space: normal; }
    .error { padding-top: 6px; font-size: 12px; color: #ef4444; white-space: normal; }
    [hidden] { display: none !important; }
    /* Phones: each biker on three lines (name and copy, counts, what's going on). */
    @media (max-width: 560px) {
      .biker { grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; }
      .biker .name { grid-column: 1; grid-row: 1; }
      .biker .counts { grid-column: 1; grid-row: 2; }
      .biker .copy { grid-column: 2; grid-row: 1 / span 2; }
      .biker .now { grid-column: 1 / -1; grid-row: 3; white-space: normal; }
    }
    /* Touch screens: bigger buttons. */
    @media (pointer: coarse) {
      button { padding: 4px 12px; }
    }
  `;

  function ensurePill() {
    if (pill?.host.isConnected) return pill;
    if (!document.body) return null;
    const host = document.createElement('swx-pill');
    // Centred with the whole screen width to grow into (left: 50% would cap it at half, which
    // squeezes it on a phone).
    host.style.cssText =
      'position: fixed !important; bottom: 12px !important; left: 0 !important;' +
      'right: 0 !important; margin: 0 auto !important; width: fit-content !important;' +
      'max-width: calc(100vw - 16px) !important; z-index: 49 !important; display: block !important;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${PILL_CSS}</style>
      <div class="panel" role="dialog" aria-label="${TXT.bikers}" dir="rtl" lang="ar" hidden>
        <div class="panel-head">
          <span>${TXT.bikers}</span>
          <button type="button" class="close" aria-label="${TXT.close}">×</button>
        </div>
        <div class="panel-list"></div>
      </div>
      <div class="panel refresh" role="dialog" aria-label="${TXT.refreshHeading}" dir="rtl" lang="ar" hidden>
        <div class="panel-head">
          <span>${TXT.refreshHeading}</span>
          <button type="button" class="close-refresh" aria-label="${TXT.close}">×</button>
        </div>
        <form class="refresh-form" novalidate>
          <label>${TXT.every}
            <input class="minutes" type="number" inputmode="numeric" step="1"
              min="${REFRESH_RANGE[0]}" max="${REFRESH_RANGE[1]}">
            ${TXT.minutesUnit}</label>
          <button type="submit">${TXT.save}</button>
        </form>
        <div class="presets">
          <span>${TXT.presets}</span>
          ${REFRESH_PRESETS.map((n) => `<button type="button" data-minutes="${n}">${n}</button>`).join('')}
        </div>
        <div class="hint">${TXT.refreshHint}</div>
        <div class="error" hidden>${TXT.refreshError}</div>
      </div>
      <div class="pill" dir="rtl" lang="ar">
        <div class="row">
          <span class="part">
            <button type="button" class="status" aria-expanded="false"></button>
            <button type="button" class="refresh-now">${TXT.refreshNow}</button>
          </span>
          <span class="part summary" hidden><span class="sep">·</span><span class="summary-text"></span></span>
          <span class="part late" hidden><span class="sep">·</span><span class="late-text"></span></span>
          <span class="part fresh" hidden><span class="sep">·</span><span class="fresh-text"></span></span>
        </div>
        <div class="row">
          <span class="part">
            <button type="button" class="bikers" aria-expanded="false">${TXT.bikers}</button>
          </span>
          <span class="part sound" hidden>
            <span class="sep">·</span>
            <button type="button" class="sound-on">${TXT.soundOn}</button>
          </span>
          <span class="part past" hidden>
            <span class="sep">·</span><span class="count"></span>
            <button type="button" class="toggle" aria-pressed="false"></button>
          </span>
          <span class="part sort" hidden>
            <span class="sep">·</span><span class="sort-text"></span>
            <button type="button" class="reset">${TXT.resetSort}</button>
          </span>
          <span class="part warn" hidden><span class="sep">·</span><span class="warn-text"></span></span>
        </div>
      </div>`;
    const find = (selector) => shadow.querySelector(selector);
    pill = {
      host,
      shadow,
      status: find('.status'),
      refreshNow: find('.refresh-now'),
      summary: find('.summary'),
      summaryText: find('.summary-text'),
      late: find('.late'),
      lateText: find('.late-text'),
      fresh: find('.fresh'),
      freshText: find('.fresh-text'),
      past: find('.past'),
      count: find('.count'),
      toggle: find('.toggle'),
      bikersButton: find('.bikers'),
      sound: find('.sound'),
      soundOn: find('.sound-on'),
      sort: find('.sort'),
      sortText: find('.sort-text'),
      warn: find('.warn'),
      warnText: find('.warn-text'),
      panel: find('.panel'),
      list: find('.panel-list'),
      panelSignature: null,
      editor: find('.panel.refresh'),
      minutes: find('.minutes'),
      error: find('.error'),
    };
    pill.late.title = TXT.lateTitle;
    pill.toggle.title = TXT.toggleTitle;
    pill.toggle.addEventListener('click', toggleShowPast);
    pill.bikersButton.addEventListener('click', () => setPanel(panelOpen ? null : 'bikers'));
    pill.soundOn.title = TXT.soundOnTitle;
    pill.soundOn.addEventListener('click', enableSound);
    pill.status.addEventListener('click', () => setPanel(editorOpen ? null : 'refresh'));
    pill.refreshNow.title = TXT.refreshNowTitle;
    pill.refreshNow.addEventListener('click', () => {
      if (!reloading) startReload(true).catch(markError);
    });
    find('.close').addEventListener('click', () => setPanel(null));
    find('.close-refresh').addEventListener('click', () => setPanel(null));
    find('.reset').addEventListener('click', () => setSort(DEFAULT_SORT.key, DEFAULT_SORT.dir));
    find('.refresh-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const minutes = validMinutes(pill.minutes.value);
      if (minutes == null) pill.error.hidden = false;
      else setRefreshMinutes(minutes);
    });
    for (const preset of shadow.querySelectorAll('[data-minutes]')) {
      preset.addEventListener('click', () => setRefreshMinutes(Number(preset.dataset.minutes)));
    }
    document.body.appendChild(host);
    return pill;
  }

  // One panel at a time above the pill: 'bikers', 'refresh' or null (closed).
  function setPanel(which) {
    panelOpen = which === 'bikers';
    editorOpen = which === 'refresh';
    renderPill();
    if (editorOpen && pill) {
      pill.minutes.value = refreshMinutes;
      pill.error.hidden = true;
      pill.minutes.focus();
      pill.minutes.select();
    }
  }

  // Rebuilt only when its content changes, so a "copied" confirmation isn't wiped by the ticks.
  function renderPanel(p) {
    p.panel.hidden = !panelOpen;
    if (!panelOpen) {
      p.panelSignature = null;
      return;
    }
    const signature = JSON.stringify(bikers);
    if (signature === p.panelSignature) return;
    p.panelSignature = signature;
    p.list.textContent = '';
    if (!bikers.length) {
      p.list.append(make('div', 'empty', TXT.noBikers));
      return;
    }
    for (const biker of bikers) {
      const copy = make('button', 'copy', TXT.copy);
      copy.type = 'button';
      copy.title = TXT.copyTitle;
      copy.disabled = biker.left === 0;
      copy.addEventListener('click', () => copyText(biker.copy, copy));
      // Now: "يغسل من 25 د · Wurood", "في الطريق · Wurood · باقي 8 د" or "فاضي"; under it the
      // next wash. <bdi> keeps "3:15 PM · Wurood" in its own order inside the Arabic line.
      const { doing, upcoming } = biker;
      const current = make('div', 'now');
      const line = make('div', `doing ${doing.tone || ''}`.trim(), doing.text);
      if (doing.zone) line.append(' · ', make('bdi', null, doing.zone));
      if (doing.note) line.append(` · ${doing.note}`);
      current.append(line);
      if (upcoming) {
        const next = make('div', `upcoming ${upcoming.tone || ''}`.trim(), `${TXT.nextWash} `);
        next.append(make('bdi', null, upcoming.detail));
        current.append(next);
      }
      const row = make('div', 'biker');
      row.append(
        make('div', 'name', biker.name),
        make('div', 'counts', TXT.bikerCounts(biker.done, biker.left)),
        current,
        copy,
      );
      p.list.append(row);
    }
  }

  async function copyText(text, button) {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // The Clipboard API can refuse (page not focused); the older execCommand route still works.
      const area = make('textarea');
      area.value = text;
      area.style.cssText = 'position: fixed; opacity: 0;';
      pill.shadow.append(area);
      area.select();
      try {
        ok = document.execCommand('copy');
      } catch {}
      area.remove();
    }
    button.textContent = ok ? TXT.copied : TXT.copyFailed;
    setTimeout(() => (button.textContent = TXT.copy), 2000);
  }

  function statusText() {
    if (phase === 'overlay') return TXT.busyOverlay;
    if (phase === 'activity') return TXT.busyActivity;
    if (phase === 'probing') return TXT.refreshing;
    if (phase === 'offline') return TXT.offline;
    const seconds = Math.ceil(Math.max(0, nextRefreshAt - Date.now()) / 1000);
    return `${TXT.refreshIn} ${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;
  }

  function hasOtherPages() {
    return Array.from(document.querySelectorAll('button .sr-only')).some(
      (label) => PAGER_LABEL_RE.test(norm(label.textContent)) && !label.closest('button').disabled,
    );
  }

  function warnings() {
    const list = [];
    if (stats.rows > 0 && stats.parsed === 0) list.push(TXT.unreadable);
    if (hasOtherPages()) list.push(TXT.morePages);
    if (new Date().getTimezoneOffset() !== RIYADH_TZ_OFFSET) list.push(TXT.timezone);
    return list;
  }

  function renderPill() {
    const p = ensurePill();
    if (!p) return;
    const visible = onList();
    p.host.style.setProperty('display', visible ? 'block' : 'none', 'important');
    if (!visible) {
      markTitle(0);
      return;
    }
    setText(p.status, statusText());
    p.refreshNow.disabled = reloading;
    setValue(p.status, 'title', TXT.refreshTitle(refreshMinutes));
    p.status.setAttribute('aria-expanded', String(editorOpen));
    p.editor.hidden = !editorOpen;
    p.summary.hidden = stats.total === 0;
    setText(p.summaryText, TXT.summary(stats));
    const late = [
      stats.red && `🔴 ${stats.red}`,
      stats.yellow && `🟡 ${stats.yellow}`,
      stats.green && `🟢 ${stats.green}`,
    ];
    p.late.hidden = !stats.red && !stats.yellow && !stats.green;
    setText(p.lateText, late.filter(Boolean).join(' · '));
    p.fresh.hidden = stats.fresh === 0;
    setText(p.freshText, TXT.freshCount(stats.fresh));
    p.bikersButton.setAttribute('aria-expanded', String(panelOpen));
    p.sound.hidden = !PAGE_SOUNDS || soundState === 'on';
    p.past.hidden = stats.past === 0;
    setText(p.count, `${TXT.pastCount} ${stats.past}`);
    setText(p.toggle, showPast ? TXT.hide : TXT.show);
    p.toggle.setAttribute('aria-pressed', String(showPast));
    p.sort.hidden = isDefaultSort();
    const arrow = sort.dir === 'asc' ? '↑' : '↓';
    setText(p.sortText, `${TXT.sortedBy} ${TXT.sortNames[sort.key]} ${arrow}`);
    const list = warnings();
    p.warn.hidden = list.length === 0;
    setText(p.warnText, list.join(' · '));
    renderPanel(p);
  }

  function toggleShowPast() {
    showPast = !showPast;
    if (showPast) store.set('showPast', '1');
    else store.del('showPast');
    setFlag(document.documentElement, ATTR_SHOW_PAST, showPast);
    renderPill();
  }

  // ---------- boot ----------

  function start() {
    safe(() => {
      document.documentElement.setAttribute('data-swx-version', VERSION); // if it wasn't there yet
      setFlag(document.documentElement, ATTR_SHOW_PAST, showPast);
      const markActivity = () => {
        lastActivityAt = Date.now();
      };
      for (const type of ['pointerdown', 'keydown', 'wheel', 'input']) {
        window.addEventListener(type, markActivity, { capture: true, passive: true });
      }
      // Capture phase: runs before the portal's own handlers (the Asc/Desc menu among them).
      window.addEventListener('click', (event) => safe(() => onClick(event)), true);
      window.addEventListener('keydown', (event) => safe(() => onKeyDown(event)), true);
      window.addEventListener('storage', (event) => safe(() => onStorage(event)));
      window.addEventListener('online', tick);
      window.addEventListener('pageshow', tick);
      document.addEventListener('visibilitychange', tick);
      setInterval(tick, 1000);
      if (onList()) applyAll();
      tick();
    });
  }

  safe(fixPageSizeEarly);
  lastHref = location.href;
  wasOnList = onList();
  if (wasOnList) noteTrackedDay();

  // Rows arrive and change long after load (the table is fetched and re-rendered by React).
  // Handling mutations synchronously hides rows before they are ever painted.
  observer = new MutationObserver(() => {
    safe(() => {
      checkRoute();
      if (onList()) applyAll();
    });
    observer.takeRecords();
  });
  observer.observe(document, { childList: true, subtree: true, characterData: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
