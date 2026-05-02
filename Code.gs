// ═══════════════════════════════════════════════════════════════════
// PlantDB — Google Apps Script Backend  v2
// Deploy as: Web App → Execute as Me → Anyone can access
// ═══════════════════════════════════════════════════════════════════
const SHEET_NAME   = 'Plants';
const META_SHEET   = 'Meta';
const PHOTOS_SHEET = 'Photos';

function doGet(e)  { return handleRequest(e); }
function doPost(e) { return handleRequest(e); }

function handleRequest(e) {
  try {
    const params = e.parameter || {};
    const action = params.action || (e.postData ? JSON.parse(e.postData.contents).action : 'ping');
    let result;
    switch(action) {
      case 'ping':        result = {ok:true,version:2,ts:Date.now()}; break;
      case 'getAll':      result = getAll(); break;
      case 'savePlant':   result = savePlant(JSON.parse(e.postData.contents)); break;
      case 'deletePlant': result = deletePlant(JSON.parse(e.postData.contents)); break;
      case 'getMeta':     result = getMeta(); break;
      case 'saveMeta':    result = saveMeta(JSON.parse(e.postData.contents)); break;
      case 'replaceAll':  result = replaceAll(JSON.parse(e.postData.contents)); break;
      default:            result = {error:'Unknown action: '+action};
    }
    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({error:err.toString()})).setMimeType(ContentService.MimeType.JSON);
  }
}

const PLANT_COLS = [
  'id','no','family','genus','species','subsp','variety','cultivar','common',
  'h','w','type1','type2','type3','le','climate','aspect','soil','constraints',
  'desc','cultural','refs',
  'leafType','flowerColour','floweringSeason','fruitDesc','fruitingPeriod','nativeRegion',
  'uses','wildlife','ecoRole','indigenousNotes',
  'toxic','toxicNotes','allergen','allergenNotes','weedStatus','healthStatus',
  'gps','mapRef','tags','notes','collection','log','dateAdded','dateModified'
];

function getOrCreate(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if(!sh) { sh = ss.insertSheet(name); if(headers) sh.appendRow(headers); }
  return sh;
}

function getAll() {
  const sh = getOrCreate(SHEET_NAME, PLANT_COLS);
  const data = sh.getDataRange().getValues();
  if(data.length <= 1) return {plants:[],nextId:1,nextPid:1};
  const headers = data[0];
  const plants = data.slice(1).map(row => {
    const p = {};
    headers.forEach((h,i) => { p[h] = row[i]===''?'':row[i]; });
    p.tags = p.tags ? String(p.tags).split('|').filter(Boolean) : [];
    try { p.log = p.log ? JSON.parse(p.log) : []; } catch(e) { p.log = []; }
    p.photos = [];
    return p;
  });
  const meta = getMeta();
  return {plants, nextId:meta.nextId||plants.length+1, nextPid:meta.nextPid||1};
}

function savePlant(body) {
  const p = body.plant;
  const sh = getOrCreate(SHEET_NAME, PLANT_COLS);
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const row = PLANT_COLS.map(col => {
    if(col==='tags')   return (p.tags||[]).join('|');
    if(col==='log')    return JSON.stringify(p.log||[]);
    if(col==='photos') return '';
    return p[col]===undefined?'':p[col];
  });
  const idCol = headers.indexOf('id');
  let found = -1;
  for(let i=1; i<data.length; i++) { if(String(data[i][idCol])===String(p.id)){found=i;break;} }
  if(found>=0) sh.getRange(found+1,1,1,row.length).setValues([row]);
  else sh.appendRow(row);
  return {ok:true, id:p.id};
}

function deletePlant(body) {
  const sh = getOrCreate(SHEET_NAME, PLANT_COLS);
  const data = sh.getDataRange().getValues();
  const idCol = data[0].indexOf('id');
  for(let i=data.length-1; i>=1; i--) {
    if(String(data[i][idCol])===String(body.id)) { sh.deleteRow(i+1); return {ok:true}; }
  }
  return {ok:false,error:'Not found'};
}

function replaceAll(body) {
  const sh = getOrCreate(SHEET_NAME, PLANT_COLS);
  const lr = sh.getLastRow();
  if(lr>1) sh.deleteRows(2,lr-1);
  (body.plants||[]).forEach(p => savePlant({plant:p}));
  saveMeta({nextId:body.nextId, nextPid:body.nextPid, collections:body.collections, savedSearches:body.savedSearches});
  return {ok:true, count:(body.plants||[]).length};
}

function getMeta() {
  const sh = getOrCreate(META_SHEET, ['key','value']);
  const data = sh.getDataRange().getValues();
  const meta = {};
  data.slice(1).forEach(row => { try{meta[row[0]]=JSON.parse(row[1]);}catch(e){meta[row[0]]=row[1];} });
  return meta;
}

function saveMeta(body) {
  const sh = getOrCreate(META_SHEET, ['key','value']);
  const data = sh.getDataRange().getValues();
  const keys = data.slice(1).map(r=>r[0]);
  Object.entries(body).forEach(([key,val]) => {
    const stored = typeof val==='object' ? JSON.stringify(val) : String(val);
    const idx = keys.indexOf(key);
    if(idx>=0) sh.getRange(idx+2,2).setValue(stored);
    else { sh.appendRow([key,stored]); keys.push(key); }
  });
  return {ok:true};
}

function setupSpreadsheet() {
  getOrCreate(SHEET_NAME, PLANT_COLS);
  getOrCreate(META_SHEET, ['key','value']);
  SpreadsheetApp.getActiveSpreadsheet().toast('PlantDB sheets ready!','Setup Complete',5);
}
