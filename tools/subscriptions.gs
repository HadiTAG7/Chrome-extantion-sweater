// مساعد حجوزات سويتر: الاشتراكات. سكربت Apps Script على جدول Google حق صاحب الإضافة.
//
// The extension asks this script (deployed as a web app) whether a subscription code is valid,
// and the first device that uses a code is registered on it. One row per customer in the sheet
// «الاشتراكات»: typing a name in a new row fills in a code and an end date. To end a subscription,
// set its end date in the past or delete the row; to renew it, move the date; to let a customer
// move to another device, empty their «الأجهزة» cell.
// Setup, once and from a computer: README, «الاشتراك (لصاحب الإضافة)».

// ===== الإعدادات =====
const DAYS = 30; // الاشتراك الجديد ينتهي بعد كم يوم (وتقدر تغيّر تاريخه بعدين)

const SHEET = 'الاشتراكات';
const TZ = 'Asia/Riyadh'; // the end date is a day in Saudi Arabia, and still valid on that day
const COLUMNS = {
  name: 'الاسم',
  code: 'الكود',
  until: 'ينتهي',
  allowed: 'عدد الأجهزة', // empty: 1
  devices: 'الأجهزة', // filled in by this script, one device per line
  checked: 'آخر تشييك', // filled in by this script
  notes: 'ملاحظات', // the owner's own
};
// No 0/O or 1/I/L: the codes are read out and typed by people.
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const DEVICE_RE = /^[a-f0-9]{24}$/; // made by the extension, see deviceId() in content.js
const DAY_MS = 24 * 60 * 60 * 1000;
// The helpers' names end in "_": Apps Script keeps those out of the editor's Run menu.

// The extension's question: ?code=SWX-7K4P-2Q9M&device=<id>. The answer is JSON:
//   { ok: true, until: '2026-11-30' }
//   { ok: false, reason: 'unknown' | 'expired' | 'device' }, with `until` for 'expired'
//   { ok: false, reason: 'error' } when the sheet is broken (the extension then tries again later)
function doGet(e) {
  let result;
  try {
    const params = (e && e.parameter) || {};
    result = check_(String(params.code || ''), String(params.device || ''));
  } catch (error) {
    console.error(error);
    result = { ok: false, reason: 'error' };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

function check_(code, device) {
  const key = codeKey_(code);
  if (!key) return { ok: false, reason: 'unknown' };
  if (!DEVICE_RE.test(device)) return { ok: false, reason: 'error' };
  // Two devices asking at the same moment must not both take the last free place.
  const lock = LockService.getScriptLock();
  lock.waitLock(20 * 1000);
  try {
    const sheet = subscriptionsSheet_();
    const rows = sheet.getDataRange().getValues();
    const col = columnsOf_(rows[0]);
    const index = rows.findIndex((row, i) => i > 0 && codeKey_(row[col.code]) === key);
    if (index < 0) return { ok: false, reason: 'unknown' };
    const row = rows[index];
    const until = dayOf_(row[col.until]);
    if (!until || until < today_()) return { ok: false, reason: 'expired', until };
    const devices = String(row[col.devices]).split(/\s+/).filter(Boolean);
    if (!devices.includes(device)) {
      const allowed = Number(digits_(String(row[col.allowed]))) || 1;
      if (devices.length >= allowed) return { ok: false, reason: 'device' };
      devices.push(device);
      sheet.getRange(index + 1, col.devices + 1).setValue(devices.join('\n'));
    }
    sheet.getRange(index + 1, col.checked + 1).setValue(new Date());
    return { ok: true, until };
  } finally {
    lock.releaseLock();
  }
}

// A name typed (or pasted) in a row without a code: the row gets a new code, and an end date
// DAYS from today if it has none.
function onEdit(e) {
  const sheet = e.range.getSheet();
  if (sheet.getName() !== SHEET || e.range.getLastRow() < 2) return;
  const rows = sheet.getDataRange().getValues();
  const col = columnsOf_(rows[0]);
  const nameColumn = col.name + 1;
  if (e.range.getColumn() > nameColumn || e.range.getLastColumn() < nameColumn) return;
  const taken = new Set(rows.map((row) => codeKey_(row[col.code])));
  const last = Math.min(e.range.getLastRow(), rows.length);
  for (let r = Math.max(e.range.getRow(), 2); r <= last; r++) {
    const row = rows[r - 1];
    if (!String(row[col.name]).trim() || String(row[col.code]).trim()) continue;
    sheet.getRange(r, col.code + 1).setValue(newCode_(taken));
    if (row[col.until] === '') sheet.getRange(r, col.until + 1).setValue(endDate_());
  }
}

// Run once from the editor: makes the sheet (or names the empty first one) with its headers,
// and sets the spreadsheet's time zone to Saudi Arabia's.
function setup() {
  const book = SpreadsheetApp.getActive();
  book.setSpreadsheetTimeZone(TZ);
  let sheet = book.getSheetByName(SHEET);
  if (!sheet) {
    const sheets = book.getSheets();
    const empty = sheets.length === 1 && sheets[0].getLastRow() === 0;
    sheet = empty ? sheets[0].setName(SHEET) : book.insertSheet(SHEET);
  }
  const titles = Object.values(COLUMNS);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, titles.length).setValues([titles]).setFontWeight('bold');
  }
  const col = columnsOf_(sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]);
  sheet.setFrozenRows(1);
  sheet.setRightToLeft(true);
  const below = (column) => sheet.getRange(2, column + 1, sheet.getMaxRows() - 1);
  below(col.code).setNumberFormat('@'); // text: a code is never read as a number
  below(col.until).setNumberFormat('yyyy-mm-dd');
  below(col.checked).setNumberFormat('yyyy-mm-dd hh:mm');
}

function subscriptionsSheet_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET);
  if (!sheet) throw new Error(`No sheet named «${SHEET}»: run setup`);
  return sheet;
}

// Column numbers (from 0) by their header, so the owner can move columns around.
function columnsOf_(header) {
  const col = {};
  for (const [key, title] of Object.entries(COLUMNS)) {
    col[key] = header.findIndex((cell) => String(cell).trim() === title);
    if (col[key] < 0 && key !== 'notes') throw new Error(`No «${title}» column: run setup`);
  }
  return col;
}

// "swx 7k4p 2q9m", "SWX-7K4P-2Q9M" and "SWX7K4P2Q9M" are the same code.
function codeKey_(value) {
  return digits_(String(value))
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

// Arabic-Indic digits (and the Persian/Urdu ones), as a phone keyboard may type them, to 0-9.
function digits_(text) {
  return text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0));
}

function newCode_(taken) {
  for (;;) {
    let code = 'SWX';
    for (let i = 0; i < 8; i++) code += (i % 4 ? '' : '-') + randomLetter_();
    if (!taken.has(codeKey_(code))) {
      taken.add(codeKey_(code));
      return code;
    }
  }
}

function randomLetter_() {
  const random = parseInt(Utilities.getUuid().slice(0, 8), 16);
  return CODE_LETTERS[random % CODE_LETTERS.length];
}

// The end date cell as "2026-11-30": a date (the day it shows, in the spreadsheet's time zone) or
// text typed like "2026-11-30". Anything else is no date.
function dayOf_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    if (isNaN(value)) return '';
    return Utilities.formatDate(value, sheetZone_(), 'yyyy-MM-dd');
  }
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(digits_(String(value)).trim());
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
}

function today_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

// DAYS from today, as a date the sheet shows as that day.
function endDate_() {
  const day = Utilities.formatDate(new Date(Date.now() + DAYS * DAY_MS), TZ, 'yyyy-MM-dd');
  return Utilities.parseDate(day, sheetZone_(), 'yyyy-MM-dd');
}

// The spreadsheet's time zone (setup sets it to TZ): its date cells are days in that zone.
function sheetZone_() {
  return SpreadsheetApp.getActive().getSpreadsheetTimeZone();
}
