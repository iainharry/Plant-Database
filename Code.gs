/**
 * PlantDB — Google Apps Script Backend
 * ─────────────────────────────────────────────────────────────────────
 * SETUP:
 *  1. Paste this entire file into a new Apps Script project
 *     (script.google.com → New project → paste → save)
 *  2. Run setupSpreadsheet() once to create the sheet structure
 *  3. Deploy → New deployment → Web App
 *     Execute as: Me  |  Who has access: Anyone
 *  4. Copy the /exec URL into PlantDB → ☁ Sync → URL field
 *
 * OPTIONAL SECURITY:
 *  Project Settings → Script Properties → add key PLANTDB_TOKEN
 *  Set the same value in PlantDB → ☁ Sync → Auth Token field.
 * ─────────────────────────────────────────────────────────────────────
 */

const SHEET_NAME = 'Plants';
const META_SHEET = 'Meta';

const PLANT_COLS = [
  'id','no','family','genus','species','subsp','variety','cultivar','common',
  'h','w','type1','type2','type3','le','climate','aspect','soil','constraints',
  'desc','cultural','refs',
  'leafType','flowerColour','floweringSeason','fruitDesc','fruitingPeriod','nativeRegion',
  'uses','wildlife','ecoRole','indigenousNotes',
  'toxic','toxicNotes','allergen','allergenNotes','weedStatus','healthStatus',
  'gps','mapRef','tags','notes','collection','log','dateAdded','dateModified',
  'photos'
];

// ── Entry points ───────────────────────────────────────────────────────
function doGet(e)  { return handleRequest(e); }
function doPost(e) { return handleRequest(e); }

function handleRequest(e) {
  try {
    // ── Token check ────────────────────────────────────────────────
    var expectedToken = PropertiesService.getScriptProperties()
                          .getProperty('PLANTDB_TOKEN');
    if (expectedToken) {
      var params   = (e && e.parameter) ? e.parameter : {};
      var bodyObj  = {};
      if (e && e.postData) bodyObj = tryParse(e.postData.contents);
      var reqToken = params.token || bodyObj.token || '';
      if (reqToken !== expectedToken) {
        return jsonOut({ error: 'Unauthorized' });
      }
    }

    // ── Resolve action and payload ─────────────────────────────────
    // Supports both GET (?action=ping) and POST (body JSON)
    var params  = (e && e.parameter) ? e.parameter : {};
    var bodyObj = {};
    if (e && e.postData) bodyObj = tryParse(e.postData.contents);

    var action = params.action || bodyObj.action || 'ping';

    // Plants can come from GET param (URL-encoded JSON) or POST body
    var plants = null;
    if (params.plants) {
      try { plants = JSON.parse(decodeURIComponent(params.plants)); } catch(ex) {}
    }
    if (!plants && bodyObj.plants) plants = bodyObj.plants;

    var result;
    switch (action) {
      case 'ping':
        result = handlePing();
        break;
      case 'push':
      case 'replaceAll':
        result = handlePush(plants || bodyObj.plants || []);
        break;
      case 'pull':
      case 'getAll':
        result = handlePull();
        break;
      case 'getSheetUrl':
        result = handleGetSheetUrl();
        break;
      case 'savePlant':
        result = savePlant(bodyObj);
        break;
      case 'deletePlant':
        result = deletePlant(bodyObj);
        break;
      case 'getMeta':
        result = getMeta();
        break;
      case 'saveMeta':
        result = saveMeta(bodyObj);
        break;
      default:
        result = { error: 'Unknown action: ' + action };
    }
    return jsonOut(result);

  } catch (err) {
    console.error(err);
    return jsonOut({ error: 'Internal server error: ' + err.message });
  }
}

// ── Handlers ────────────────────────────────────────────────────────────

function handlePing() {
  var ss   = getOrCreateSpreadsheet();
  var sh   = getOrCreate(SHEET_NAME, PLANT_COLS);
  var rows = Math.max(0, sh.getLastRow() - 1);
  return {
    ok:       true,
    version:  4,
    sheet:    ss.getName(),
    sheetUrl: ss.getUrl(),
    rows:     rows,
    ts:       Date.now()
  };
}

function handlePush(plants) {
  if (!Array.isArray(plants)) {
    return { error: 'plants must be an array' };
  }
  var sh = getOrCreate(SHEET_NAME, PLANT_COLS);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var lr = sh.getLastRow();
    if (lr > 1) sh.deleteRows(2, lr - 1);
    if (plants.length > 0) {
      var rows = plants.map(function(p) {
        return PLANT_COLS.map(function(col) {
          if (col === 'tags')   return (p.tags || []).join('|');
          if (col === 'log')    return JSON.stringify(p.log || []);
          if (col === 'photos') return '';          // photos stored locally only
          if (p[col] === undefined || p[col] === null) return '';
          return p[col];
        });
      });
      sh.getRange(2, 1, rows.length, PLANT_COLS.length).setValues(rows);
    }
    updateMeta('lastPush', new Date().toISOString());
    updateMeta('plantCount', plants.length);
    return { ok: true, written: plants.length };
  } finally {
    lock.releaseLock();
  }
}

function handlePull() {
  var sh      = getOrCreate(SHEET_NAME, PLANT_COLS);
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 1) {
    return { ok: true, plants: [] };
  }
  var all     = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = all[0];
  var plants  = [];
  for (var i = 1; i < all.length; i++) {
    var row = all[i];
    if (row.every(function(c){ return c === '' || c === null; })) continue;
    var plant = {};
    headers.forEach(function(h, idx) {
      var val = row[idx];
      if (h === 'tags') {
        plant[h] = val ? String(val).split('|').filter(Boolean) : [];
        return;
      }
      if (h === 'log') {
        try { plant[h] = val ? JSON.parse(val) : []; } catch(ex) { plant[h] = []; }
        return;
      }
      if (h === 'photos') { plant[h] = []; return; }
      plant[h] = (val === '' || val === null || val === undefined) ? '' : val;
    });
    plants.push(plant);
  }
  return { ok: true, plants: plants };
}

function handleGetSheetUrl() {
  var ss = getOrCreateSpreadsheet();
  return { ok: true, sheetUrl: ss.getUrl() };
}

// ── Legacy per-plant operations (backward compat) ──────────────────────

function savePlant(body) {
  var p = body.plant || body;
  if (!p || (!p.id && !p.common && !p.genus)) return { error: 'Invalid plant data' };
  var sh   = getOrCreate(SHEET_NAME, PLANT_COLS);
  var data = sh.getDataRange().getValues();
  var row  = PLANT_COLS.map(function(col) {
    if (col === 'tags')   return (p.tags || []).join('|');
    if (col === 'log')    return JSON.stringify(p.log || []);
    if (col === 'photos') return '';
    return p[col] === undefined ? '' : p[col];
  });
  var idCol = data[0].indexOf('id');
  var found = -1;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(p.id)) { found = i; break; }
  }
  if (found >= 0) sh.getRange(found + 1, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
  return { ok: true, id: p.id };
}

function deletePlant(body) {
  var sh   = getOrCreate(SHEET_NAME, PLANT_COLS);
  var data = sh.getDataRange().getValues();
  var idCol = data[0].indexOf('id');
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][idCol]) === String(body.id)) {
      sh.deleteRow(i + 1);
      return { ok: true };
    }
  }
  return { ok: false, error: 'Not found' };
}

function getMeta() {
  var sh   = getOrCreate(META_SHEET, ['key', 'value']);
  var data = sh.getDataRange().getValues();
  var meta = {};
  data.slice(1).forEach(function(row) {
    try { meta[row[0]] = JSON.parse(row[1]); } catch(e) { meta[row[0]] = row[1]; }
  });
  return meta;
}

function saveMeta(body) {
  Object.keys(body).forEach(function(key) {
    updateMeta(key, body[key]);
  });
  return { ok: true };
}

// ── Spreadsheet helpers ────────────────────────────────────────────────

function getOrCreateSpreadsheet() {
  var props = PropertiesService.getScriptProperties();
  var id    = props.getProperty('PLANTDB_SPREADSHEET_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch(e) {}
  }
  // Try to use the bound spreadsheet first
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (ss) {
      props.setProperty('PLANTDB_SPREADSHEET_ID', ss.getId());
      return ss;
    }
  } catch(e) {}
  // Search Drive
  var files = DriveApp.getFilesByName('PlantDB');
  if (files.hasNext()) {
    var ss = SpreadsheetApp.open(files.next());
    props.setProperty('PLANTDB_SPREADSHEET_ID', ss.getId());
    return ss;
  }
  // Create new
  var ss = SpreadsheetApp.create('PlantDB');
  props.setProperty('PLANTDB_SPREADSHEET_ID', ss.getId());
  return ss;
}

function getOrCreate(name, headers) {
  var ss = getOrCreateSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (headers) {
      sh.appendRow(headers);
      sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  }
  return sh;
}

function updateMeta(key, value) {
  var sh   = getOrCreate(META_SHEET, ['key', 'value']);
  var data = sh.getDataRange().getValues();
  var stored = typeof value === 'object' ? JSON.stringify(value) : String(value);
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      sh.getRange(i + 1, 2).setValue(stored);
      return;
    }
  }
  sh.appendRow([key, stored]);
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function tryParse(str) {
  try { return JSON.parse(str); } catch(e) { return {}; }
}

// ── One-time setup (run manually in Apps Script editor) ────────────────
function setupSpreadsheet() {
  getOrCreate(SHEET_NAME, PLANT_COLS);
  getOrCreate(META_SHEET, ['key', 'value']);
  try {
    SpreadsheetApp.getActiveSpreadsheet()
      .toast('PlantDB sheets ready!', 'Setup Complete', 5);
  } catch(e) {}
  Logger.log('Setup complete. Sheet URL: ' + getOrCreateSpreadsheet().getUrl());
}
