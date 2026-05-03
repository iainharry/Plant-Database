// ═══════════════════════════════════════════════════════════════════
// PlantDB — Google Apps Script Backend
// Deploy as: Web App → Execute as Me → Anyone can access
// ═══════════════════════════════════════════════════════════════════

const SHEET_NAME     = 'Plants';
const META_SHEET     = 'Meta';
const PHOTOS_SHEET   = 'Photos';
const VERSION        = 1;

// ── Entry point ──────────────────────────────────────────────────────
function doGet(e) {
  return handleRequest(e);
}
function doPost(e) {
  return handleRequest(e);
}

function handleRequest(e) {
  // CORS headers so the PWA can call from any origin
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  try {
    const params = e.parameter || {};
    const action = params.action || (e.postData ? JSON.parse(e.postData.contents).action : 'ping');
    let result;

    switch (action) {
      case 'ping':        result = { ok: true, version: VERSION, ts: Date.now() }; break;
      case 'getAll':      result = getAll(); break;
      case 'savePlant':   result = savePlant(JSON.parse(e.postData.contents)); break;
      case 'deletePlant': result = deletePlant(JSON.parse(e.postData.contents)); break;
      case 'getMeta':     result = getMeta(); break;
      case 'saveMeta':    result = saveMeta(JSON.parse(e.postData.contents)); break;
      case 'getPhoto':    result = getPhoto(params.plantId, params.photoId); break;
      case 'savePhoto':   result = savePhoto(JSON.parse(e.postData.contents)); break;
      case 'deletePhoto': result = deletePhoto(JSON.parse(e.postData.contents)); break;
      case 'replaceAll':  result = replaceAll(JSON.parse(e.postData.contents)); break;
      default:            result = { error: 'Unknown action: ' + action };
    }

    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: err.toString(), stack: err.stack }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ── Sheet helpers ────────────────────────────────────────────────────
function getOrCreateSheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers) sheet.appendRow(headers);
  }
  return sheet;
}

// Column order for the Plants sheet
const PLANT_COLS = [
  'id','no','family','genus','species','subsp','variety','cultivar','common',
  'h','w','type1','type2','type3','le',
  'climate','aspect','soil','constraints',
  'desc','cultural','refs',
  'leafType','flowerColour','floweringSeason','fruitDesc','fruitingPeriod','nativeRegion',
  'uses','wildlife','ecoRole','indigenousNotes',
  'toxic','toxicNotes','allergen','allergenNotes','weedStatus','healthStatus',
  'gps','mapRef',
  'tags','notes','collection',
  'dateAdded','dateModified'
];

function getPlantsSheet() {
  return getOrCreateSheet(SHEET_NAME, PLANT_COLS);
}

function getMetaSheet() {
  return getOrCreateSheet(META_SHEET, ['key','value']);
}

function getPhotosSheet() {
  return getOrCreateSheet(PHOTOS_SHEET, ['plantId','photoId','dataUrl','editedUrl','caption','rot','scale','panX','panY','flipH','flipV','sortOrder']);
}

// ── GET ALL plants (photos loaded separately on demand) ──────────────
function getAll() {
  const sheet = getPlantsSheet();
  const data  = sheet.getDataRange().getValues();
  if (data.length <= 1) return { plants: [], nextId: 1, nextPid: 1 };

  const headers = data[0];
  const plants  = data.slice(1).map(row => {
    const p = {};
    headers.forEach((h, i) => { p[h] = row[i] === '' ? '' : row[i]; });
    // Parse stored types back
    p.tags = p.tags ? String(p.tags).split('|').filter(Boolean) : [];
    p.photos = []; // photos loaded separately to keep response fast
    return p;
  });

  const meta = getMeta();
  return { plants, nextId: meta.nextId || plants.length + 1, nextPid: meta.nextPid || 1 };
}

// ── SAVE single plant (upsert) ───────────────────────────────────────
function savePlant(body) {
  const p     = body.plant;
  const sheet = getPlantsSheet();
  const data  = sheet.getDataRange().getValues();
  const headers = data[0];

  // Build row array in column order
  const row = PLANT_COLS.map(col => {
    if (col === 'tags')   return (p.tags || []).join('|');
    if (col === 'photos') return ''; // photos stored separately
    const v = p[col];
    return v === undefined ? '' : v;
  });

  // Find existing row by id
  const idCol = headers.indexOf('id');
  let found = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(p.id)) { found = i; break; }
  }

  if (found >= 0) {
    sheet.getRange(found + 1, 1, 1, row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }

  return { ok: true, id: p.id };
}

// ── DELETE single plant ──────────────────────────────────────────────
function deletePlant(body) {
  const sheet = getPlantsSheet();
  const data  = sheet.getDataRange().getValues();
  const idCol = data[0].indexOf('id');

  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][idCol]) === String(body.id)) {
      sheet.deleteRow(i + 1);
      // Also delete all photos for this plant
      deletePhotosForPlant(body.id);
      return { ok: true };
    }
  }
  return { ok: false, error: 'Plant not found' };
}

// ── REPLACE ALL plants (import) ──────────────────────────────────────
function replaceAll(body) {
  const sheet = getPlantsSheet();
  // Clear existing data except header
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.deleteRows(2, lastRow - 1);

  // Clear photos too
  const ps = getPhotosSheet();
  const plr = ps.getLastRow();
  if (plr > 1) ps.deleteRows(2, plr - 1);

  // Re-insert all
  (body.plants || []).forEach(p => savePlant({ plant: p }));
  // Re-insert all photos
  (body.allPhotos || []).forEach(ph => savePhoto({ photo: ph }));

  saveMeta({ nextId: body.nextId, nextPid: body.nextPid });
  return { ok: true, count: (body.plants || []).length };
}

// ── META (nextId, nextPid, collections, savedSearches) ───────────────
function getMeta() {
  const sheet = getMetaSheet();
  const data  = sheet.getDataRange().getValues();
  const meta  = {};
  data.slice(1).forEach(row => {
    try { meta[row[0]] = JSON.parse(row[1]); } catch(e) { meta[row[0]] = row[1]; }
  });
  return meta;
}

function saveMeta(body) {
  const sheet = getMetaSheet();
  const data  = sheet.getDataRange().getValues();
  const keys  = data.slice(1).map(r => r[0]);

  Object.entries(body).forEach(([key, val]) => {
    const stored = typeof val === 'object' ? JSON.stringify(val) : String(val);
    const idx = keys.indexOf(key);
    if (idx >= 0) {
      sheet.getRange(idx + 2, 2).setValue(stored);
    } else {
      sheet.appendRow([key, stored]);
      keys.push(key);
    }
  });

  return { ok: true };
}

// ── PHOTOS (stored as base64 in the Photos sheet) ────────────────────
function getPhoto(plantId, photoId) {
  const sheet = getPhotosSheet();
  const data  = sheet.getDataRange().getValues();
  const headers = data[0];
  const pidCol = headers.indexOf('plantId');
  const idCol  = headers.indexOf('photoId');

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][pidCol]) === String(plantId) &&
        String(data[i][idCol])  === String(photoId)) {
      const ph = {};
      headers.forEach((h, j) => ph[h] = data[i][j]);
      return { photo: ph };
    }
  }
  return { photo: null };
}

function getPhotosForPlant(plantId) {
  const sheet = getPhotosSheet();
  const data  = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  const headers = data[0];
  const pidCol  = headers.indexOf('plantId');
  const sortCol = headers.indexOf('sortOrder');

  return data.slice(1)
    .filter(row => String(row[pidCol]) === String(plantId))
    .sort((a, b) => (a[sortCol] || 0) - (b[sortCol] || 0))
    .map(row => {
      const ph = {};
      headers.forEach((h, j) => {
        if (h === 'flipH' || h === 'flipV') ph[h] = row[j] === true || row[j] === 'TRUE';
        else ph[h] = row[j];
      });
      return ph;
    });
}

function savePhoto(body) {
  const ph    = body.photo;
  const sheet = getPhotosSheet();
  const data  = sheet.getDataRange().getValues();
  const headers = data[0];
  const pidCol  = headers.indexOf('plantId');
  const idCol   = headers.indexOf('photoId');

  const row = headers.map(h => {
    if (h === 'flipH' || h === 'flipV') return ph[h] ? 'TRUE' : 'FALSE';
    return ph[h] === undefined ? '' : ph[h];
  });

  let found = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][pidCol]) === String(ph.plantId) &&
        String(data[i][idCol])  === String(ph.photoId)) {
      found = i; break;
    }
  }

  if (found >= 0) {
    sheet.getRange(found + 1, 1, 1, row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }
  return { ok: true };
}

function deletePhoto(body) {
  const sheet = getPhotosSheet();
  const data  = sheet.getDataRange().getValues();
  const headers = data[0];
  const pidCol  = headers.indexOf('plantId');
  const idCol   = headers.indexOf('photoId');

  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][pidCol]) === String(body.plantId) &&
        String(data[i][idCol])  === String(body.photoId)) {
      sheet.deleteRow(i + 1);
      return { ok: true };
    }
  }
  return { ok: false };
}

function deletePhotosForPlant(plantId) {
  const sheet = getPhotosSheet();
  const data  = sheet.getDataRange().getValues();
  const headers = data[0];
  const pidCol  = headers.indexOf('plantId');

  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][pidCol]) === String(plantId)) sheet.deleteRow(i + 1);
  }
}

// ── Utility: called manually to set up the spreadsheet ───────────────
function setupSpreadsheet() {
  getPlantsSheet();
  getMetaSheet();
  getPhotosSheet();
  SpreadsheetApp.getActiveSpreadsheet().toast('PlantDB sheets ready!', 'Setup Complete', 5);
}
