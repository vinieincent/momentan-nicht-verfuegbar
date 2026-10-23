/**
 * Scuffed Attack 3 – Anmelde-Backend (Google Apps Script)
 *
 * Läuft kostenlos bei Google, schreibt in DIESE Tabelle und prüft serverseitig:
 *  1. Der Minecraft-Account existiert (Mojang, Ersatz: PlayerDB)
 *  2. Der Account ist noch nicht angemeldet (Vergleich über Ingame-Name UND UUID)
 * Die Tabelle bleibt privat. Öffentlich abrufbar sind nur die Ingame-Namen.
 */

const SHEET_NAME = 'Anmeldungen';
const HEADERS = ['Zeitstempel', 'Name', 'Ingame-Name', 'UUID', 'Skill (1-5)'];
const INGAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const REAL_NAME_RE = /^[\p{L}\p{M}0-9 .'’\-]{2,40}$/u;
const MAX_SIGNUPS_PER_MINUTE = 30;
const MAX_CHECKS_PER_MINUTE = 120;

/* ---------- Eingänge ---------- */

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'list')  return json_({ ok: true, names: listNames_() });
  if (p.action === 'check') return json_(check_(String(p.name || '').trim()));
  return json_({ ok: false, error: 'unknown_action' });
}

function doPost(e) {
  try {
    let data;
    try { data = JSON.parse(e.postData.contents); }
    catch (err) { return json_({ ok: false, error: 'bad_request' }); }

    if (data.website) return json_({ ok: true, name: '' });              // Honeypot: Bots täuschen
    if (tooBusy_('signup', MAX_SIGNUPS_PER_MINUTE)) return json_({ ok: false, error: 'busy' });

    const realName = cleanText_(data.name, 40);
    const ingame = String(data.ingame || '').trim();
    const skill = Number(data.skill);

    if (!REAL_NAME_RE.test(realName)) return json_({ ok: false, error: 'invalid_name' });
    if (!INGAME_RE.test(ingame))      return json_({ ok: false, error: 'invalid_ingame' });
    if (!Number.isInteger(skill) || skill < 1 || skill > 5) return json_({ ok: false, error: 'invalid_skill' });

    const acc = lookup_(ingame);                                         // Existiert der Account?
    if (acc.status === 'notfound') return json_({ ok: false, error: 'not_found' });
    if (acc.status !== 'ok')       return json_({ ok: false, error: 'unavailable' });

    const lock = LockService.getScriptLock();                            // verhindert Doppel-Einträge bei gleichzeitigem Absenden
    if (!lock.tryLock(15000)) return json_({ ok: false, error: 'busy' });
    try {
      const sheet = sheet_();
      if (isDuplicate_(sheet, acc)) return json_({ ok: false, error: 'duplicate' });
      sheet.appendRow([new Date(), safeCell_(realName), acc.name, acc.uuid, skill]);
      SpreadsheetApp.flush();
      CacheService.getScriptCache().remove('list');
    } finally {
      lock.releaseLock();
    }
    return json_({ ok: true, name: acc.name, uuid: acc.uuid });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'server_error' });
  }
}

/* ---------- Prüfungen ---------- */

function check_(name) {
  if (!INGAME_RE.test(name)) return { ok: false, error: 'invalid_ingame' };
  if (tooBusy_('check', MAX_CHECKS_PER_MINUTE)) return { ok: false, error: 'busy' };
  const acc = lookup_(name);
  if (acc.status === 'notfound') return { ok: false, error: 'not_found' };
  if (acc.status !== 'ok')       return { ok: false, error: 'unavailable' };
  if (isDuplicate_(sheet_(), acc)) return { ok: false, error: 'duplicate' };
  return { ok: true, name: acc.name, uuid: acc.uuid };
}

function isDuplicate_(sheet, acc) {
  const last = sheet.getLastRow();
  if (last < 2) return false;
  const name = acc.name.toLowerCase();
  return sheet.getRange(2, 3, last - 1, 2).getValues().some(function (r) {
    return String(r[0]).toLowerCase() === name || String(r[1]).toLowerCase() === acc.uuid;
  });
}

/* ---------- Minecraft-Account nachschlagen ---------- */

function lookup_(name) {
  const cache = CacheService.getScriptCache();
  const key = 'mc_' + name.toLowerCase();
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  let result = fromMojang_(name);
  if (result.status === 'unavailable') result = fromPlayerDb_(name);     // nur wenn Mojang nicht antwortet
  if (result.status !== 'unavailable') cache.put(key, JSON.stringify(result), result.status === 'ok' ? 600 : 120);
  return result;
}

function fromMojang_(name) {
  try {
    const r = UrlFetchApp.fetch('https://api.mojang.com/users/profiles/minecraft/' + encodeURIComponent(name), { muteHttpExceptions: true });
    const code = r.getResponseCode();
    if (code === 200) {
      const j = JSON.parse(r.getContentText());
      if (j && j.id && j.name) return { status: 'ok', name: j.name, uuid: normUuid_(j.id) };
    }
    if (code === 404 || code === 204) return { status: 'notfound' };
  } catch (err) { console.warn('Mojang:', err); }
  return { status: 'unavailable' };
}

function fromPlayerDb_(name) {
  try {
    const r = UrlFetchApp.fetch('https://playerdb.co/api/player/minecraft/' + encodeURIComponent(name), {
      muteHttpExceptions: true, headers: { 'User-Agent': 'scuffed-attack-signup' }
    });
    if (r.getResponseCode() === 200) {
      const j = JSON.parse(r.getContentText());
      const p = j && j.success && j.data && j.data.player;
      if (p && p.username && p.raw_id) return { status: 'ok', name: p.username, uuid: normUuid_(p.raw_id) };
    }
  } catch (err) { console.warn('PlayerDB:', err); }
  return { status: 'unavailable' };   // unklar = nicht eintragen (lieber später erneut versuchen)
}

/* ---------- Öffentliche Namensliste (nur Ingame-Namen) ---------- */

function listNames_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('list');
  if (hit) return JSON.parse(hit);
  const sheet = sheet_();
  const last = sheet.getLastRow();
  const names = last < 2 ? [] : sheet.getRange(2, 3, last - 1, 1).getValues()
    .map(function (r) { return String(r[0]).trim(); }).filter(Boolean);
  cache.put('list', JSON.stringify(names), 60);
  return names;
}

/* ---------- Helfer ---------- */

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function normUuid_(id) { return String(id).toLowerCase().replace(/-/g, ''); }

function cleanText_(s, max) {
  return String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Schutz vor Formel-Einschleusung in Google Sheets (=, +, -, @ am Anfang)
function safeCell_(v) { return /^[=+\-@]/.test(v) ? "'" + v : v; }

function tooBusy_(kind, max) {
  const cache = CacheService.getScriptCache();
  const key = 'rate_' + kind + '_' + Math.floor(Date.now() / 60000);
  const n = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(n), 90);
  return n > max;
}
