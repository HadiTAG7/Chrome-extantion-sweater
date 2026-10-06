/*
 * مساعد حجوزات سويتر (Sweater bookings helper)
 *
 * Runs on https://ssp-portal.sweater.sa/bookings and:
 *   - hides bookings whose slot started more than GRACE_MINUTES ago,
 *   - sorts the rows by booking date and time,
 *   - reloads the page every REFRESH_MINUTES (and follows "today" past midnight),
 *   - keeps the whole day on one page (pageSize = PAGE_SIZE),
 *   - shows a small status pill at the bottom of the page.
 *
 * The portal is a React SPA whose table rows are keyed by index: React rewrites the text of
 * existing <tr>s in place. So every pass re-reads the rows from their text, rows are never
 * removed, and they are only reordered inside their own <tbody>.
 */
(() => {
  'use strict';

  // ===== الإعدادات: عدّلها هنا ثم اضغط زر التحديث ↻ على الإضافة في chrome://extensions =====
  const REFRESH_MINUTES = 10; // كل كم دقيقة تتحدّث الصفحة
  const GRACE_MINUTES = 30; // الغسلة تختفي بعد موعدها بكم دقيقة
  const PAGE_SIZE = 50; // عدد الصفوف في الصفحة (50 أكبر خيار يعرضه الموقع)

  const VERSION = '1.0.0';
  const MINUTE = 60 * 1000;
  const REFRESH_MS = REFRESH_MINUTES * MINUTE;
  const GRACE_MS = GRACE_MINUTES * MINUTE;
  const REAPPLY_MS = 15 * 1000; // re-check the times so rows disappear as the clock moves
  const ACTIVITY_GRACE_MS = MINUTE; // no reload within a minute of a click, key or scroll...
  const MAX_ACTIVITY_POSTPONE_MS = 2 * MINUTE; // ...unless the reload is already this late
  const OVERLAY_IDLE_LIMIT_MS = 10 * MINUTE; // an open dialog holds the reload unless left idle
  const OFFLINE_RETRY_MS = 30 * 1000;
  const PROBE_TIMEOUT_MS = 8 * 1000;
  const SPA_FIX_GUARD_MS = 30 * 1000;
  const RIYADH_TZ_OFFSET = -180; // Date#getTimezoneOffset() in Saudi Arabia (UTC+3, no DST)

  const LIST_PATH_RE = /^\/bookings\/?$/;
  const HEADERS = {
    date: ['booking date', 'تاريخ الحجز'],
    time: ['booking time', 'وقت الحجز'],
    id: ['id', 'الرقم'],
  };
  const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';
  const PAGER_LABEL_RE = /^(go to (next|previous) page|الانتقال إلى الصفحة (التالية|السابقة))$/i;
  const MONTHS = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');
  const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

  const ATTR_PAST = 'data-swx-past';
  const ATTR_SHOW_PAST = 'data-swx-show-past';
  const ATTR_EMPTY = 'data-swx-empty';

  const TXT = {
    refreshIn: 'التحديث بعد',
    busyOverlay: 'التحديث مؤجل — نافذة مفتوحة',
    busyActivity: 'التحديث مؤجل — استخدام حالي',
    refreshing: 'جارٍ التحديث…',
    offline: 'لا يوجد اتصال — إعادة المحاولة بعد قليل',
    pastCount: 'الغسلات السابقة:',
    show: 'إظهار',
    hide: 'إخفاء',
    toggleTitle: `إظهار أو إخفاء الغسلات اللي عدى على موعدها أكثر من ${GRACE_MINUTES} دقيقة`,
    noUpcoming: 'لا توجد غسلات قادمة',
    unreadable: '⚠ ما قدرت أقرأ أوقات الغسلات',
    morePages: '⚠ فيه صفحات ثانية',
    timezone: '⚠ توقيت الجهاز مو توقيت السعودية',
  };

  if (window.__swx) return; // already injected into this page
  window.__swx = VERSION;

  const store = {
    get(key) {
      try {
        return sessionStorage.getItem(`swx:${key}`);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        sessionStorage.setItem(`swx:${key}`, String(value));
      } catch {}
    },
    del(key) {
      try {
        sessionStorage.removeItem(`swx:${key}`);
      } catch {}
    },
  };

  let nextRefreshAt = Date.now() + REFRESH_MS;
  let lastApplyAt = 0;
  let lastActivityAt = 0;
  let phase = 'idle'; // idle | overlay | activity | probing | offline
  let reloading = false;
  let showPast = store.get('showPast') === '1';
  let stats = { rows: 0, parsed: 0, past: 0 };
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
    if (!nowOnList) return;
    if (entered) {
      if (fixPageSizeOnSpaEntry()) return;
      nextRefreshAt = Date.now() + REFRESH_MS;
      phase = 'idle';
    }
    noteTrackedDay();
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
    const cols = { date: -1, time: -1, id: -1 };
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

  function rowInfo(tr, cols, urlDay) {
    const cells = tr.cells;
    // Loading, "No bookings found." and error rows are a single wide cell: leave them alone.
    if (cells.length < 2) return { tr, data: false, ts: null, id: null };
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
    return { tr, data: true, ts, id: idNumber(cells[cols.id >= 0 ? cols.id : 0]) };
  }

  function bookingTables() {
    const root = document.getElementById('root');
    const tables = Array.from((root || document).querySelectorAll('table'));
    return root ? tables : tables.filter((table) => !table.closest(OVERLAY_SELECTOR));
  }

  // Stable order: by time, then booking number; unreadable rows go last. Rows only move inside
  // their own <tbody> and are never removed, so React's later insertBefore/removeChild calls
  // still find them where it expects: inside that <tbody>.
  function sortRows(tbody, items) {
    const wanted = items
      .map((item, index) => ({ ...item, index }))
      .sort(
        (a, b) =>
          (a.ts == null) - (b.ts == null) ||
          (a.ts || 0) - (b.ts || 0) ||
          (a.id == null) - (b.id == null) ||
          (a.id || 0) - (b.id || 0) ||
          a.index - b.index,
      );
    wanted.forEach((item, position) => {
      const current = tbody.rows[position];
      if (current !== item.tr) tbody.insertBefore(item.tr, current || null);
    });
  }

  function applyAll() {
    const now = Date.now();
    lastApplyAt = now;
    const from = param('fromDate');
    const urlDay = from && from === param('toDate') ? parseDate(from) : null;
    const next = { rows: 0, parsed: 0, past: 0 };
    for (const table of bookingTables()) {
      const tbody = table.tBodies[0];
      if (!tbody) continue;
      const cols = columnsOf(table);
      const items = Array.from(tbody.rows, (tr) => rowInfo(tr, cols, urlDay));
      let rows = 0;
      let parsed = 0;
      let past = 0;
      for (const item of items) {
        const isPast = item.ts != null && now - item.ts > GRACE_MS;
        setFlag(item.tr, ATTR_PAST, isPast);
        if (item.data) rows++;
        if (item.ts != null) parsed++;
        if (isPast) past++;
      }
      if (parsed) sortRows(tbody, items);
      if (table.parentElement) {
        const allPast = parsed > 0 && past === rows;
        setValue(table.parentElement, ATTR_EMPTY, allPast ? TXT.noUpcoming : null);
      }
      next.rows += rows;
      next.parsed += parsed;
      next.past += past;
    }
    stats = next;
    observer?.takeRecords(); // our own writes must not trigger another pass
    renderPill();
  }

  // ---------- auto refresh ----------

  function overlayOpen() {
    return Array.from(document.querySelectorAll(OVERLAY_SELECTOR)).some(
      (el) => el.getClientRects().length > 0,
    );
  }

  function busyReason(now) {
    const idle = now - lastActivityAt;
    if (idle < OVERLAY_IDLE_LIMIT_MS && overlayOpen()) return 'overlay';
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

  async function startReload() {
    reloading = true;
    phase = 'probing';
    renderPill();
    const online = await isOnline();
    const reason = online ? busyReason(Date.now()) : null;
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
    .pill {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 14px; border-radius: 999px;
      background: var(--popover, #18181b); color: var(--popover-foreground, #fafafa);
      border: 1px solid var(--border, rgba(127, 127, 127, 0.35));
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
      font: 500 13px/1.5 Tajawal, system-ui, sans-serif;
      white-space: nowrap; user-select: none;
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
    .warn { color: #f59e0b; }
    [hidden] { display: none !important; }
  `;

  function ensurePill() {
    if (pill?.host.isConnected) return pill;
    if (!document.body) return null;
    const host = document.createElement('swx-pill');
    host.style.cssText =
      'position: fixed !important; bottom: 12px !important; left: 50% !important;' +
      'transform: translateX(-50%) !important; z-index: 49 !important; display: block !important;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${PILL_CSS}</style>
      <div class="pill" dir="rtl" lang="ar">
        <span class="status"></span>
        <span class="part past" hidden>
          <span class="sep">·</span><span class="count"></span>
          <button type="button" class="toggle" aria-pressed="false"></button>
        </span>
        <span class="part warn" hidden><span class="sep">·</span><span class="warn-text"></span></span>
      </div>`;
    const find = (selector) => shadow.querySelector(selector);
    pill = {
      host,
      status: find('.status'),
      past: find('.past'),
      count: find('.count'),
      toggle: find('.toggle'),
      warn: find('.warn'),
      warnText: find('.warn-text'),
    };
    pill.toggle.title = TXT.toggleTitle;
    pill.toggle.addEventListener('click', toggleShowPast);
    document.body.appendChild(host);
    return pill;
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
    if (!visible) return;
    setText(p.status, statusText());
    p.past.hidden = stats.past === 0;
    setText(p.count, `${TXT.pastCount} ${stats.past}`);
    setText(p.toggle, showPast ? TXT.hide : TXT.show);
    p.toggle.setAttribute('aria-pressed', String(showPast));
    const list = warnings();
    p.warn.hidden = list.length === 0;
    setText(p.warnText, list.join(' · '));
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
      document.documentElement.setAttribute('data-swx-version', VERSION);
      setFlag(document.documentElement, ATTR_SHOW_PAST, showPast);
      const markActivity = () => {
        lastActivityAt = Date.now();
      };
      for (const type of ['pointerdown', 'keydown', 'wheel', 'input']) {
        window.addEventListener(type, markActivity, { capture: true, passive: true });
      }
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
  // Handling mutations synchronously hides past rows before they are ever painted.
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
