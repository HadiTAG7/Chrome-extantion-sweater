// Builds mobile/sweater-bookings.user.js, the phone version of the extension (Tampermonkey in
// Firefox on Android, the Userscripts app for Safari on iPhone), from content.css and content.js.
// Run it after changing either of them:  node tools/build-userscript.js
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPO = 'https://github.com/HadiTAG7/Chrome-extantion-sweater';
const RAW = 'https://raw.githubusercontent.com/HadiTAG7/Chrome-extantion-sweater/HEAD';
const OUT = path.join(ROOT, 'mobile', 'sweater-bookings.user.js');

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const css = read('content.css');
const js = read('content.js');

// Page world (@grant none, @inject-into page) like the tests: the start of a wash is then asked
// from the portal's own origin, which its backend accepts.
const header = [
  '// ==UserScript==',
  `// @name         ${manifest.name}`,
  `// @namespace    ${REPO}`,
  `// @version      ${manifest.version}`,
  `// @description  ${manifest.description}`,
  `// @homepageURL  ${REPO}`,
  `// @icon         ${RAW}/icons/icon48.png`,
  '// @match        https://ssp-portal.sweater.sa/*',
  '// @run-at       document-start',
  '// @grant        none',
  '// @inject-into  page',
  '// @noframes',
  `// @downloadURL  ${RAW}/mobile/sweater-bookings.user.js`,
  `// @updateURL    ${RAW}/mobile/sweater-bookings.user.js`,
  '// ==/UserScript==',
].join('\n');

// What the extension's manifest does for content.css. At document start there can be no <html>
// element yet: then the styles go in as soon as it exists.
const styles = `(() => {
  const add = () => {
    if (document.getElementById('swx-css')) return true;
    const parent = document.head || document.documentElement;
    if (!parent) return false;
    const style = document.createElement('style');
    style.id = 'swx-css';
    style.textContent = ${JSON.stringify(css)};
    parent.appendChild(style);
    return true;
  };
  if (add()) return;
  const watcher = new MutationObserver(() => add() && watcher.disconnect());
  watcher.observe(document, { childList: true, subtree: true });
})();`;

// The extension's sounds, for the page to play (on a computer the extension's background page
// plays them): content.js picks them up as window.__swxSounds.
const sound = (file) =>
  `data:audio/mpeg;base64,${fs.readFileSync(path.join(ROOT, 'sounds', file)).toString('base64')}`;
const sounds = `window.__swxSounds = ${JSON.stringify({
  new: sound('new-booking.mp3'),
  red: sound('red-alert.mp3'),
  cancel: sound('cancelled.mp3'),
})};`;

const note = [
  '// Built by tools/build-userscript.js from content.css and content.js: edit those, not this',
  '// file, then run `node tools/build-userscript.js`.',
].join('\n');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${header}\n\n${note}\n\n${styles}\n\n${sounds}\n\n${js}`);
console.log(`${path.relative(ROOT, OUT)}: version ${manifest.version}`);
