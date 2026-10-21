// Builds the Firefox version of the extension: dist/firefox/ (load it from about:debugging to try
// it) and dist/sweater-bookings-firefox-<version>.zip, the file to have signed on
// addons.mozilla.org. Same code as for Chrome, with Firefox's own manifest.json:
//   - the background runs as a page (background.scripts): Firefox has no service worker for
//     extensions, and the page plays the sounds itself, so there's no offscreen document,
//   - page.js is a content script in the page's own world (Chrome's background.js registers it),
//   - an add-on id and the data collection statement, which Mozilla needs to sign it: with
//     subscriptions set up (LICENSE_URL in content.js), the code typed is sent to the owner's
//     Google Sheet, with a random id for the device. That's "authentication information" by
//     Mozilla's definitions (an account's registration data); nothing else leaves the browser.
// Run it after changing the extension:  node tools/build-firefox.js   (needs the zip command)
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, 'firefox');
// Signed versions are tied to this id: it never changes.
const GECKO_ID = 'sweater-bookings@haditag7';
const FILES = ['background.js', 'content.js', 'page.js', 'content.css', 'icons', 'sounds'];

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const firefox = {
  ...manifest,
  // No offscreen document (above), and page.js runs from the manifest (below), not registered by
  // background.js (that's what "scripting" and the host permission are for).
  permissions: manifest.permissions.filter((name) => !['offscreen', 'scripting'].includes(name)),
  host_permissions: undefined,
  // page.js in the page's own JS world, before content.js (Firefox 128+; older ones ignore that,
  // and content.js loads it as a file, see page.js).
  content_scripts: [
    {
      matches: manifest.content_scripts[0].matches,
      js: ['page.js'],
      run_at: 'document_start',
      world: 'MAIN',
    },
    ...manifest.content_scripts,
  ],
  background: { scripts: ['background.js'] },
  browser_specific_settings: {
    gecko: {
      id: GECKO_ID,
      strict_min_version: '115.0', // Firefox 115 ESR is the last one for Windows 7
      data_collection_permissions: { required: ['authenticationInfo'] }, // the subscription code
    },
  },
};

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
for (const file of FILES) {
  fs.cpSync(path.join(ROOT, file), path.join(STAGE, file), { recursive: true });
}
fs.writeFileSync(path.join(STAGE, 'manifest.json'), `${JSON.stringify(firefox, null, 2)}\n`);

const zip = path.join(DIST, `sweater-bookings-firefox-${manifest.version}.zip`);
fs.rmSync(zip, { force: true });
// -X: no extra file attributes, so the same files give the same zip.
execFileSync('zip', ['-q', '-r', '-X', zip, '.'], { cwd: STAGE });
console.log(`${path.relative(ROOT, zip)}: version ${manifest.version}`);
