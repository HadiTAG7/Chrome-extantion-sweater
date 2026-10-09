// Builds the Firefox version of the extension: dist/firefox/ (load it from about:debugging to try
// it) and dist/sweater-bookings-firefox-<version>.zip, the file to have signed on
// addons.mozilla.org. Same code as for Chrome, with Firefox's own manifest.json:
//   - the background runs as a page (background.scripts): Firefox has no service worker for
//     extensions, and the page plays the sounds itself, so there's no offscreen document,
//   - an add-on id and the data collection statement, which Mozilla needs to sign it.
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
const FILES = ['background.js', 'content.js', 'content.css', 'icons', 'sounds'];

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const firefox = {
  ...manifest,
  permissions: manifest.permissions.filter((permission) => permission !== 'offscreen'),
  background: { scripts: ['background.js'] },
  browser_specific_settings: {
    gecko: {
      id: GECKO_ID,
      strict_min_version: '115.0', // Firefox 115 ESR is the last one for Windows 7
      data_collection_permissions: { required: ['none'] }, // nothing leaves the browser
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
