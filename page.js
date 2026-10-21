/*
 * مساعد حجوزات سويتر: the part that runs in the portal's own JS world, where its requests are
 * made (content.js runs in the extension's own world, or, in the phone version, calls this one).
 * It has to be there before the portal's first request:
 *   - Chrome runs it in the page's world at document start, right after content.js, as registered
 *     by background.js (Chrome 102+): content.js's settings are already on the page then
 *     (<html data-swx-join>),
 *   - Firefox 128+ runs it there from its manifest, before content.js: it waits for the settings
 *     (a "swx:join" event right after),
 *   - older browsers do neither (or not yet, right after the extension is installed or updated),
 *     and content.js loads it into the page as one of the extension's files instead, maybe too
 *     late for the first request: see markNew's `joinedLate` for that,
 *   - the phone version brings it along, and content.js calls it.
 *
 * The portal asks its server for the bookings list a page at a time (axios, over XHR), PAGE_SIZE
 * at most. When a day has more, the first page's answer is held while the others are asked for
 * the same way, then joined into it: the portal shows the whole day as one page, and content.js
 * works on all of it. Only for one day, on the bookings list, up to MAX_JOINED_PAGES pages;
 * anything unexpected leaves the portal's answer as it was.
 */
(() => {
  'use strict';

  // Run as a content script by a Firefox that can't put it in the page's world: nothing to do there.
  if (globalThis.chrome?.runtime?.id || globalThis.browser?.runtime?.id) return;

  function joinBookingPages({ pageSize, maxPages }, how) {
    // Already there: the extension and the phone version both installed, or the file loaded too.
    if (window.__swxJoined) return;
    window.__swxJoined = how; // 'event', 'after', 'file' or 'phone': how it got here, for the tests
    const xhr = XMLHttpRequest.prototype;
    const { open, setRequestHeader, send } = xhr;
    xhr.open = function (method, url, ...rest) {
      this.__swxRequest = { method: String(method).toUpperCase(), url: String(url), headers: {} };
      return open.call(this, method, url, ...rest);
    };
    xhr.setRequestHeader = function (name, value) {
      if (this.__swxRequest) this.__swxRequest.headers[name] = value;
      return setRequestHeader.call(this, name, value);
    };
    xhr.send = function (...args) {
      const request = this.__swxRequest;
      const done = this.onloadend; // axios sets its handler before sending
      if (done && request?.method === 'GET' && isFirstPage(request.url)) {
        request.credentials = this.withCredentials ? 'include' : 'same-origin';
        this.onloadend = (event) => {
          join(this, request)
            .catch(() => null)
            .then((text) => {
              if (text) {
                for (const name of ['responseText', 'response']) {
                  Object.defineProperty(this, name, { configurable: true, value: text });
                }
              }
              done.call(this, event);
            });
        };
      }
      return send.apply(this, args);
    };

    function isFirstPage(url) {
      const { pathname, searchParams } = new URL(url, location.href);
      const day = searchParams.get('FromDate');
      return (
        /\/api\/bookings$/i.test(pathname) &&
        /^\/bookings\/?$/.test(location.pathname) &&
        searchParams.get('PageNumber') === '1' &&
        searchParams.get('PageSize') === String(pageSize) &&
        Boolean(day) &&
        day === searchParams.get('ToDate')
      );
    }

    // The joined answer as text, or null to keep the server's.
    async function join(request, asked) {
      if (request.status !== 200) return null;
      const first = JSON.parse(request.responseText);
      const pages = first?.data?.totalPages;
      if (!Array.isArray(first?.data?.items) || !(pages > 1) || pages > maxPages) return null;
      const numbers = Array.from({ length: pages - 1 }, (_, i) => i + 2);
      const others = await Promise.all(numbers.map((number) => page(asked, number)));
      const seen = new Set();
      const items = [first.data.items, ...others].flat().filter((item) => {
        if (item?.id == null) return true;
        if (seen.has(item.id)) return false; // moved to the next page while the pages were asked
        seen.add(item.id);
        return true;
      });
      return JSON.stringify({
        ...first,
        data: { ...first.data, items, pageNumber: 1, totalPages: 1 },
      });
    }

    async function page(asked, number) {
      const url = new URL(asked.url, location.href);
      url.searchParams.set('PageNumber', String(number));
      const response = await fetch(url, { headers: asked.headers, credentials: asked.credentials });
      const body = response.ok ? await response.json() : null;
      if (!Array.isArray(body?.data?.items)) throw new Error(`page ${number}: ${response.status}`);
      return body.data.items;
    }
  }

  const settings = document.documentElement?.dataset.swxJoin;
  if (settings) {
    // content.js was first: page.js loaded as the extension's file, or started right after it.
    const asFile = /\/page\.js$/.test(document.currentScript?.src || '');
    joinBookingPages(JSON.parse(settings), asFile ? 'file' : 'after');
  } else {
    window.__swxJoinPages = (options) => joinBookingPages(options, 'phone');
    const listen = (event) => {
      event.preventDefault(); // tells content.js it's taken care of
      joinBookingPages(JSON.parse(event.detail), 'event');
    };
    document.addEventListener('swx:join', listen, { once: true });
  }
})();
