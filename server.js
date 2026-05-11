const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 8080;
const HOSTEX_TOKEN = process.env.HOSTEX_TOKEN || '';
const HOSTEX_BASE  = 'https://api.hostex.io/v3';
const DB_FILE = path.join('/tmp', 'reservations.json');

app.use(cors());
app.use(express.json({ limit: '10mb' }));

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { return { reservations: {}, last_sync: null, total: 0 }; }
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db));
}

async function hostexGet(p) {
  const r = await fetch(HOSTEX_BASE + p, {
    headers: { 'Hostex-Access-Token': HOSTEX_TOKEN, 'Content-Type': 'application/json' },
  });
  return r.json();
}

// Sync via iCal Airbnb et Booking (contient TOUTES les réservations)
async function syncFromICal() {
  const db = loadDB();
  const icalUrls = [
    {url: 'https://www.airbnb.fr/calendar/ical/1444758558715417027.ics?t=c42b72016c5748c18ee41cd64ae7e287', prop: '12619011', channel: 'airbnb'},
    {url: 'https://www.airbnb.fr/calendar/ical/1499112879728152781.ics?t=7dccb868b47241b9970e6d8caa1a5de8', prop: '12619012', channel: 'airbnb'},
    {url: 'https://ical.booking.com/v1/export?t=939b4e7b-3790-4c7a-8062-4b58f61c6af2', prop: '12619011', channel: 'booking.com'},
    {url: 'https://ical.booking.com/v1/export?t=0e46cbb9-8661-4a50-99d3-0dc9ec5ab511', prop: '12619012', channel: 'booking.com'},
  ];
  let added = 0;
  for(const {url, prop, channel} of icalUrls) {
    try {
      const r = await fetch(url, {headers:{'User-Agent':'Mozilla/5.0','Accept':'text/calendar,*/*'}});
      const rawText = await r.text();
      const text = rawText.replace(/\r\n[ \t]/g, '').replace(/\r/g, '');
      const events = text.split('BEGIN:VEVENT').slice(1);
      console.log('iCal', prop, events.length, 'events');
      for(const ev of events) {
        const dtstart = (ev.match(/DTSTART[^:\n]*:(\d+)/) || [])[1];
        const dtend = (ev.match(/DTEND[^:\n]*:(\d+)/) || [])[1];
        const uid = (ev.match(/UID:([^\n]+)/) || [])[1];
        const summary = ((ev.match(/SUMMARY:([^\n]+)/) || [])[1] || '').trim();
        const desc = ((ev.match(/DESCRIPTION:([^\n]+)/) || [])[1] || '').trim();
        if(!dtstart || !dtend || !uid) continue;
        if(summary === 'Not available' || summary === 'Blocked' || summary.includes('Not available') || summary === 'Airbnb (Not available)') continue;
        const ci = dtstart.slice(0,4)+'-'+dtstart.slice(4,6)+'-'+dtstart.slice(6,8);
        const co = dtend.slice(0,4)+'-'+dtend.slice(4,6)+'-'+dtend.slice(6,8);
        const codeMatch = desc.match(/details\/([A-Z0-9]+)/);
        const key = codeMatch ? codeMatch[1] : uid.trim().replace(/@.*/, '');
        if(true) { // toujours mettre a jour depuis iCal
          db.reservations[key] = {reservation_code:key, guest_name:summary==='Reserved'?'Voyageur Airbnb':(summary||'Voyageur'), check_in_date:ci, check_out_date:co, channel_type:channel, property_id:prop, number_of_guests:1, status:'accepted', total_price:0, currency:'EUR'};
          added++;
        }
      }
    } catch(e) { console.log('iCal error:', e.message); }
  }
  db.total = Object.keys(db.reservations).length;
  saveDB(db);
  console.log('iCal done added:', added, 'total:', db.total);
  return db;
}

async function doSync() {
  const db = loadDB();
  let page = 1;
  let total = 0;
  // Page par page jusqu'a epuisement
  while (true) {
    let hasNew = false;
    try {
      const d = await hostexGet('/reservations?page_size=50&page=' + page);
      const list = (d && d.data && d.data.reservations) ? d.data.reservations : [];
      if (list.length === 0) break;
      for (const r of list) {
        const k = r.reservation_code || r.id;
        db.reservations[k] = r;
        hasNew = true;
      }
      total += list.length;
      if (list.length < 50) break;
      page++;
    } catch (e) { break; }
    await new Promise(res => setTimeout(res, 300));
  }
  // Charger avec différents sorts pour maximiser la couverture
  const now = new Date();
  const sorts = [
    '/reservations?page_size=50&sort=check_in_date&sort_order=asc',
    '/reservations?page_size=50&sort=check_in_date&sort_order=desc',
    '/reservations?page_size=50&sort=created_at&sort_order=desc',
    '/reservations?page_size=50&sort=updated_at&sort_order=desc',
  ];
  for (const url of sorts) {
    try {
      const d = await hostexGet(url);
      const list = (d && d.data && d.data.reservations) ? d.data.reservations : [];
      for (const r of list) { const k = r.reservation_code || r.id; if(!db.reservations[k]) { r.total_price = r.rates && r.rates.total_rate ? r.rates.total_rate.amount : (r.total_price||0); r.currency = r.rates && r.rates.total_rate ? r.rates.total_rate.currency : (r.currency||'EUR'); } db.reservations[k] = r; }
    } catch(e2) {}
    await new Promise(res => setTimeout(res, 300));
  }
  // Aussi par mois futur
  for (let m = 0; m <= 14; m++) {
    const s = new Date(now.getFullYear(), now.getMonth() + m, 1);
    const e = new Date(now.getFullYear(), now.getMonth() + m + 1, 0);
    try {
      const d = await hostexGet('/reservations?check_in_date_min=' + s.toISOString().slice(0,10) + '&check_in_date_max=' + e.toISOString().slice(0,10) + '&page_size=50');
      const list = (d && d.data && d.data.reservations) ? d.data.reservations : [];
      for (const r of list) { const k = r.reservation_code || r.id; if(!db.reservations[k]) { r.total_price = r.rates && r.rates.total_rate ? r.rates.total_rate.amount : (r.total_price||0); r.currency = r.rates && r.rates.total_rate ? r.rates.total_rate.currency : (r.currency||'EUR'); } db.reservations[k] = r; }
    } catch(e2) {}
    await new Promise(res => setTimeout(res, 200));
  }
  // Aussi sync via iCal
  // Sync iCal et merger dans la DB courante
  try {
    const icalDb = await syncFromICal();
    for(const k of Object.keys(icalDb.reservations)) {
      if(!db.reservations[k]) db.reservations[k] = icalDb.reservations[k];
    }
    console.log('iCal merged, total after merge:', Object.keys(db.reservations).length);
  } catch(e) { console.log('iCal sync error:', e.message); }
  db.last_sync = new Date().toISOString();
  db.total = Object.keys(db.reservations).length;
  saveDB(db);
  return db;
}

// Servir app HTML
app.get('/', function(req, res) {
  const htmlPath = path.join(__dirname, 'app.html');
  if (fs.existsSync(htmlPath)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control','no-store, no-cache, must-revalidate');
    res.sendFile(htmlPath);
  } else {
    res.send('<h2>app.html manquant</h2>');
  }
});

// Servir menage HTML
app.get('/menage', function(req, res) {
  const p = path.join(__dirname, 'menage.html');
  if (fs.existsSync(p)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.sendFile(p);
  } else { res.status(404).send('menage.html manquant'); }
});

// Sync manuel
app.post('/sync', async function(req, res) {
  try { const db = await doSync(); res.json({ ok: true, total: db.total, last_sync: db.last_sync }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Cron sync
app.get('/cron-sync', async function(req, res) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });
  try { const db = await doSync(); res.json({ ok: true, total: db.total }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// WEBHOOK Hostex - reception automatique des nouvelles reservations
app.post('/webhook', async function(req, res) {
  try {
    const payload = req.body;
    console.log('Webhook recu:', JSON.stringify(payload).slice(0, 200));
    // Hostex envoie l'objet reservation dans payload.data ou directement
    const r = payload.data || payload.reservation || payload;
    if (r && (r.reservation_code || r.id)) {
      const db = loadDB();
      const k = r.reservation_code || r.id;
      db.reservations[k] = r;
      db.total = Object.keys(db.reservations).length;
      db.last_sync = new Date().toISOString();
      saveDB(db);
      console.log('Reservation sauvegardee via webhook:', k);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Import CSV depuis Hostex
app.post('/import-csv', function(req, res) {
  try {
    const { reservations } = req.body;
    if (!Array.isArray(reservations)) return res.status(400).json({ error: 'Invalid data' });
    const db = loadDB();
    let added = 0;
    for (const r of reservations) {
      const k = r.reservation_code || r.id;
      if (k) { db.reservations[k] = r; added++; }
    }
    db.total = Object.keys(db.reservations).length;
    db.last_sync = new Date().toISOString();
    saveDB(db);
    res.json({ ok: true, added, total: db.total });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// All reservations
app.get('/all-reservations', async function(req, res) {
  try {
    const db = loadDB();
    const stored = Object.values(db.reservations);
    // Live: toutes les pages
    let liveRes = [];
    try {
      const live = await hostexGet('/reservations?page_size=50&sort=check_in_date&sort_order=desc');
      liveRes = (live && live.data && live.data.reservations) ? live.data.reservations : [];
    } catch(e) {}
    // Merger stored + live, live a priorite
    const map = {};
    for (const r of stored) map[r.reservation_code || r.id] = r;
    for (const r of liveRes) map[r.reservation_code || r.id] = r;
    const all = Object.values(map).sort((a,b) => (b.check_in_date||b.check_in||'').localeCompare(a.check_in_date||a.check_in||''));
    res.json({ error_code: 200, error_msg: 'Done.', data: { reservations: all, total: all.length, last_sync: db.last_sync } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Proxy API Hostex
app.all('/api/*', async function(req, res) {
  const hp = req.path.replace(/^\/api/, '');
  const qs = new URLSearchParams(req.query).toString();
  const url = HOSTEX_BASE + hp + (qs ? '?' + qs : '');
  try {
    const opts = { method: req.method, headers: { 'Hostex-Access-Token': HOSTEX_TOKEN, 'Content-Type': 'application/json' } };
    if (['POST','PATCH','PUT'].includes(req.method)) opts.body = JSON.stringify(req.body);
    const r = await fetch(url, opts);
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Proxy Claude API
app.post('/api-claude', async function(req, res) {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });
    res.status(r.status).json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Health
app.get('/sync-hostex', function(req, res) {
  const p = require('path').join(__dirname, 'sync-hostex.html');
  const fs2 = require('fs');
  if(fs2.existsSync(p)){
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.sendFile(p);
  } else { res.status(404).send('sync-hostex.html manquant'); }
});

app.get('/bookmarklet', function(req, res) {
  const p = require('path').join(__dirname, 'bookmarklet.html');
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.sendFile(p);
});

app.post('/reset-db', function(req, res) {
  const db = {reservations:{}, last_sync:null, total:0};
  saveDB(db);
  res.json({ok:true, msg:'DB reset'});
});

app.get('/health', function(req, res) {
  const db = loadDB();
  res.json({ status: 'ok', token_set: !!HOSTEX_TOKEN, reservations_stored: db.total || 0, last_sync: db.last_sync, timestamp: new Date().toISOString(), webhook_url: 'https://hostex-proxy-production.up.railway.app/webhook' });
});

app.listen(PORT, function() { console.log('Listening on', PORT); });

// Sync au démarrage si pas de données récentes
const db0 = loadDB();
const lastSync = db0.last_sync ? new Date(db0.last_sync) : null;
const needsSync = !lastSync || (Date.now() - lastSync.getTime() > 3600000); // 1h
if (needsSync) { console.log('Auto-sync au démarrage...'); doSync().catch(console.error); }

// Sync toutes les heures
setInterval(() => { doSync().catch(console.error); }, 3600000);

app.get('/test-booking-ical', async function(req, res) {
  try {
    const url = 'https://ical.booking.com/v1/export?t=939b4e7b-3790-4c7a-8062-4b58f61c6af2';
    const r = await fetch(url, {headers:{'User-Agent':'Mozilla/5.0'}});
    const text = await r.text();
    res.json({ok:true, status:r.status, lines:text.split('\n').length, preview:text.slice(0,200)});
  } catch(e) {
    res.json({ok:false, error:e.message});
  }
});
