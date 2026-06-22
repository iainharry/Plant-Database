/**
 * PlantDB — Google Apps Script Backend (Code.gs)
 * ─────────────────────────────────────────────────────────────────────
 * SETUP:
 *  1. Paste this entire file into a new Apps Script project
 *     (script.google.com → New project)
 *  2. Run setupSheet() once to create the spreadsheet structure
 *  3. Deploy → New deployment → Web App
 *     Execute as: Me | Who has access: Anyone
 *  4. Copy the /exec URL into PlantDB → ☁ Sync → URL field
 *
 * OPTIONAL SECURITY:
 *  Add a Script Property named PLANTDB_TOKEN with any secret value.
 *  Set the same value in PlantDB → ☁ Sync → Auth Token field.
 *  All requests without the correct token will be rejected.
 * ─────────────────────────────────────────────────────────────────────
 */

// ── Config ─────────────────────────────────────────────────────────────
var SHEET_NAME   = 'Plants';
var META_SHEET   = 'Meta';
var SPREADSHEET_NAME = 'PlantDB';

// ── Entry point ────────────────────────────────────────────────────────
function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);

    // Auth check
    var token = PropertiesService.getScriptProperties().getProperty('PLANTDB_TOKEN');
    if (token && payload.token !== token) {
      return jsonResponse({ error: 'Unauthorized' }, 403);
    }

    var action = payload.action;

    if (action === 'ping')        return handlePing();
    if (action === 'push')        return handlePush(payload.plants);
    if (action === 'pull')        return handlePull();
    if (action === 'getSheetUrl') return handleGetSheetUrl();

    return jsonResponse({ error: 'Unknown action: ' + action }, 400);

  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// Also support GET for simple ping testing from browser
function doGet(e) {
  var token = PropertiesService.getScriptProperties().getProperty('PLANTDB_TOKEN');
  var provided = e && e.parameter && e.parameter.token;
  if (token && provided !== token) {
    return jsonResponse({ error: 'Unauthorized' }, 403);
  }
  return handlePing();
}

// ── Handlers ────────────────────────────────────────────────────────────

function handlePing() {
  var ss = getOrCreateSpreadsheet();
  return jsonResponse({
    ok: true,
    sheet: ss.getName(),
    sheetUrl: ss.getUrl(),
    rows: getPlantSheet(ss).getLastRow() - 1,
    timestamp: new Date().toISOString()
  });
}

function handlePush(plants) {
  if (!Array.isArray(plants)) {
    return jsonResponse({ error: 'plants must be an array' }, 400);
  }

  var ss   = getOrCreateSpreadsheet();
  var sh   = getPlantSheet(ss);
  var meta = getMetaSheet(ss);

  // Get headers from row 1
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];

  // Clear all data rows (keep header)
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();
  }

  // Write plants
  if (plants.length > 0) {
    var rows = plants.map(function(p) {
      return headers.map(function(h) {
        var val = p[h];
        if (val === undefined || val === null) return '';
        if (typeof val === 'object') return JSON.stringify(val);
        return val;
      });
    });
    sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }

  // Update meta
  setMeta(meta, 'lastPush', new Date().toISOString());
  setMeta(meta, 'plantCount', plants.length);

  return jsonResponse({ ok: true, written: plants.length });
}

function handlePull() {
  var ss   = getOrCreateSpreadsheet();
  var sh   = getPlantSheet(ss);

  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();

  if (lastRow < 2 || lastCol < 1) {
    return jsonResponse({ ok: true, plants: [] });
  }

  var all     = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = all[0];
  var plants  = [];

  for (var i = 1; i < all.length; i++) {
    var row = all[i];
    // Skip completely empty rows
    if (row.every(function(c){ return c === '' || c === null; })) continue;

    var plant = {};
    headers.forEach(function(h, idx) {
      var val = row[idx];
      if (val === '' || val === null || val === undefined) {
        plant[h] = '';
        return;
      }
      // Try to parse JSON arrays/objects (photos, tags)
      if (typeof val === 'string' && (val.charAt(0) === '[' || val.charAt(0) === '{')) {
        try { val = JSON.parse(val); } catch(e) {}
      }
      plant[h] = val;
    });
    plants.push(plant);
  }

  return jsonResponse({ ok: true, plants: plants });
}

function handleGetSheetUrl() {
  var ss = getOrCreateSpreadsheet();
  return jsonResponse({ ok: true, sheetUrl: ss.getUrl() });
}

// ── Spreadsheet setup ───────────────────────────────────────────────────

/**
 * Run this once manually to create the sheet structure.
 * Accessible via Apps Script editor: select setupSheet → Run.
 */
function setupSheet() {
  var ss = getOrCreateSpreadsheet();

  // Plant sheet
  var sh = getOrCreateSheet(ss, SHEET_NAME);
  var headers = getPlantHeaders();
  if (sh.getLastColumn() < headers.length) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.setColumnWidths(1, headers.length, 120);
  }

  // Meta sheet
  var meta = getOrCreateSheet(ss, META_SHEET);
  if (meta.getLastRow() === 0) {
    meta.getRange(1, 1, 1, 2).setValues([['Key', 'Value']]);
    meta.getRange(1, 1, 1, 2).setFontWeight('bold');
  }
  setMeta(meta, 'created', new Date().toISOString());
  setMeta(meta, 'version', '1.0');

  Logger.log('PlantDB sheet setup complete: ' + ss.getUrl());
  return ss.getUrl();
}

// ── Helpers ─────────────────────────────────────────────────────────────

function getOrCreateSpreadsheet() {
  // Check if we already saved the spreadsheet ID
  var props = PropertiesService.getScriptProperties();
  var id    = props.getProperty('PLANTDB_SPREADSHEET_ID');

  if (id) {
    try { return SpreadsheetApp.openById(id); } catch(e) {}
  }

  // Search Drive for existing sheet
  var files = DriveApp.getFilesByName(SPREADSHEET_NAME);
  if (files.hasNext()) {
    var ss = SpreadsheetApp.open(files.next());
    props.setProperty('PLANTDB_SPREADSHEET_ID', ss.getId());
    return ss;
  }

  // Create new
  var ss = SpreadsheetApp.create(SPREADSHEET_NAME);
  props.setProperty('PLANTDB_SPREADSHEET_ID', ss.getId());
  return ss;
}

function getOrCreateSheet(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

function getPlantSheet(ss) {
  return getOrCreateSheet(ss, SHEET_NAME);
}

function getMetaSheet(ss) {
  return getOrCreateSheet(ss, META_SHEET);
}

function setMeta(metaSheet, key, value) {
  var data = metaSheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      metaSheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  // Not found — append
  metaSheet.appendRow([key, value]);
}

function jsonResponse(data, statusCode) {
  var output = ContentService.createTextOutput(JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

/**
 * All plant fields — must match the keys used by the PlantDB app.
 * These become the column headers in the Google Sheet.
 */
function getPlantHeaders() {
  return [
    'id', 'no', 'common', 'genus', 'species', 'subsp', 'variety', 'cultivar',
    'family', 'type1', 'type2', 'type3',
    'h', 'w', 'le', 'climate', 'aspect', 'soil', 'constraints',
    'leafType', 'nativeRegion', 'flowerColour', 'floweringSeason',
    'fruitDesc', 'fruitingPeriod',
    'uses', 'wildlife', 'ecoRole', 'indigenousNotes',
    'desc', 'cultural', 'notes',
    'toxic', 'toxicNotes', 'allergen', 'allergenNotes',
    'weedStatus', 'healthStatus',
    'collection', 'tags', 'photos',
    'gps', 'mapRef',
    'dateAdded', 'dateModified', 'dateFlowering', 'dateFruiting'
  ];
}
