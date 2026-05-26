

// ===== WEB PUSH NOTIFICATIONS =====
const webpush = require('web-push');
const VAPID_PUBLIC = process.env.VAPID_PUBLIC || 'BJFwoHPQF_U65sVAS2s7aawrGceNCsSFxtdIB0Qolxfy2VH4HHm-ukdSCYMaonFKVwQdQvoTS5PGBWJ5IAHygxQ';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || 'vPeevLy4yk49Jtl3--Wu2eijo89xP7kV5KI4exgPSy8';
webpush.setVapidDetails('mailto:contact@illiberis.fr', VAPID_PUBLIC, VAPID_PRIVATE);
let pushSubscriptions = [];
try { pushSubscriptions = JSON.parse(require('fs').readFileSync('/tmp/push_subs.json','utf8')); } catch(e) {}
function saveSubs() { try { require('fs').writeFileSync('/tmp/push_subs.json', JSON.stringify(pushSubscriptions)); } catch(e) {} }
async function sendPushNotif(title, body, url, tag) {
  if(!pushSubscriptions.length) return;
  const payload = JSON.stringify({title:title||'Illiberis', body:body||'', url:url||'/mobile', tag:tag||'notif'});
  const failed = [];
  for (const sub of pushSubscriptions) {
    try { await webpush.sendNotification(sub, payload); }
    catch(e) { if(e.statusCode===410||e.statusCode===404) failed.push(sub.endpoint); }
  }
  if(failed.length) { pushSubscriptions=pushSubscriptions.filter(s=>!failed.includes(s.endpoint)); saveSubs(); }
  console.log('Push sent:', pushSubscriptions.length, 'subscribers');
}

// ============ SUPABASE DB ============
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://bdreatiovsfutxkyxxoo.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkcmVhdGlvdnNmdXR4a3l4eG9vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTE1MzA5MywiZXhwIjoyMDk0NzI5MDkzfQ.MqlLVk4pRoZhJ783fBP9dkXTLbXReqz26swE-tbQYFY';

async function supaFetch(path, method='GET', body=null) {
  const opts = {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'resolution=merge-duplicates' : ''
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, opts);
  if (!r.ok) {
    const err = await r.text();
    throw new Error('Supabase error: ' + err);
  }
  const text = await r.text();
  return text ? JSON.parse(text) : [];
}

async function supaLoadAll() {
  try {
    let all = [];
    let offset = 0;
    const limit = 1000;
    while (true) {
      const rows = await supaFetch(`reservations?select=*&order=check_in_date.desc&limit=${limit}&offset=${offset}`);
      all = all.concat(rows);
      if (rows.length < limit) break;
      offset += limit;
    }
    console.log('Supabase: loaded', all.length, 'reservations');
    return all;
  } catch(e) {
    console.error('Supabase load error:', e.message);
    return null;
  }
}

async function supaSave(reservations) {
  try {
    const rows = reservations.map(r => ({
      reservation_code: String(r.reservation_code || r.id || ''),
      guest_name: r.guest_name || r.g || '',
      check_in_date: r.check_in_date || r.ci || r.check_in || '',
      check_out_date: r.check_out_date || r.co || r.check_out || '',
      channel_type: r.channel_type || r.pl || 'direct',
      property_id: String(r.property_id || r.pi || ''),
      number_of_guests: r.number_of_guests || r.n || 1,
      status: r.status || r.st || 'accepted',
      total_price: parseFloat(r.total_price || r.a || 0),
      commission: parseFloat(r.commission || r.c || 0),
      currency: r.currency || 'EUR',
      guest_phone: r.guest_phone || r.ph || '',
      guest_email: r.guest_email || r.em || '',
      booked_at: r.booked_at || r.b || '',
      stay_status: r.stay_status || r.ss || '',
      updated_at: new Date().toISOString()
    })).filter(r => r.reservation_code);

    // Insérer par batch de 500
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      await supaFetch('reservations?on_conflict=reservation_code', 'POST', batch);
    }
    console.log('Supabase: saved', rows.length, 'reservations');
    return rows.length;
  } catch(e) {
    console.error('Supabase save error:', e.message);
    return 0;
  }
}

async function supaUpsert(reservation) {
  try {
    const r = reservation;
    const row = {
      reservation_code: String(r.reservation_code || r.id || ''),
      guest_name: r.guest_name || r.g || '',
      check_in_date: r.check_in_date || r.ci || r.check_in || '',
      check_out_date: r.check_out_date || r.co || r.check_out || '',
      channel_type: r.channel_type || r.pl || 'direct',
      property_id: String(r.property_id || r.pi || ''),
      number_of_guests: r.number_of_guests || r.n || 1,
      status: r.status || r.st || 'accepted',
      total_price: parseFloat(r.total_price || r.a || 0),
      commission: parseFloat(r.commission || r.c || 0),
      currency: r.currency || 'EUR',
      guest_phone: r.guest_phone || r.ph || '',
      guest_email: r.guest_email || r.em || '',
      booked_at: r.booked_at || r.b || '',
      stay_status: r.stay_status || r.ss || '',
      updated_at: new Date().toISOString()
    };
    if (!row.reservation_code) return;
    await supaFetch('reservations?on_conflict=reservation_code', 'POST', [row]);
  } catch(e) {
    console.error('Supabase upsert error:', e.message);
  }
}

// Cache mémoire pour éviter trop d'appels Supabase
let _supaCache = null;
let _supaCacheTime = 0;

async function getDB() {
  const now = Date.now();
  if (_supaCache && (now - _supaCacheTime) < 30000) return _supaCache; // cache 30s
  const rows = await supaLoadAll();
  if (rows) {
    _supaCache = rows;
    _supaCacheTime = now;
  }
  return _supaCache || [];
}

function invalidateCache() {
  _supaCache = null;
  _supaCacheTime = 0;
}

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
  const icalCodes = [];
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
        if(summary === 'Not available' || summary === 'Blocked' || summary === 'Airbnb (Not available)' || summary.includes('Not available')) continue;
        const ci = dtstart.slice(0,4)+'-'+dtstart.slice(4,6)+'-'+dtstart.slice(6,8);
        const co = dtend.slice(0,4)+'-'+dtend.slice(4,6)+'-'+dtend.slice(6,8);
        const codeMatch = desc.match(/details\/([A-Z0-9]+)/);
        const key = codeMatch ? codeMatch[1] : uid.trim().replace(/@.*/, '');
        // Ajouter seulement si pas deja present avec des donnees enrichies
        const existing = db.reservations[key];
        const hasRealData = existing && existing.guest_name && existing.guest_name !== 'Voyageur Airbnb' && existing.guest_name !== 'Voyageur Booking.com';
        if(!existing || !hasRealData) {
          db.reservations[key] = {
            reservation_code: key,
            guest_name: hasRealData ? existing.guest_name : (summary === 'Reserved' ? 'Voyageur Airbnb' : (summary || 'Voyageur')),
            check_in_date: ci,
            check_out_date: co,
            channel_type: channel,
            property_id: prop,
            number_of_guests: existing ? existing.number_of_guests : 1,
            status: 'accepted',
            total_price: existing ? (existing.total_price || 0) : 0,
            commission: existing ? (existing.commission || 0) : 0,
            currency: 'EUR',
            rates: existing ? existing.rates : null,
            guest_phone: existing ? (existing.guest_phone || '') : '',
          };
          if(!existing) added++;
        }
        if(codeMatch) icalCodes.push(key);
      }
    } catch(e) { console.log('iCal error:', url, e.message); }
  }
  // Enrichir les codes iCal sans prix via API Hostex channel_id
  console.log('Enriching', icalCodes.length, 'iCal codes...');
  for(const key of icalCodes) {
    const r = db.reservations[key];
    if(r && (r.guest_name === 'Voyageur Airbnb' || !r.total_price)) {
      try {
        const apiRes = await hostexGet('/reservations?channel_id='+key+'&page_size=1');
        const match = apiRes && apiRes.data && apiRes.data.reservations && apiRes.data.reservations[0];
        if(match && match.guest_name) {
          const price = match.rates && match.rates.total_rate ? match.rates.total_rate.amount : 0;
          db.reservations[key].guest_name = match.guest_name;
          db.reservations[key].guest_phone = match.guest_phone || '';
          db.reservations[key].total_price = price;
          db.reservations[key].commission = match.rates && match.rates.total_commission ? match.rates.total_commission.amount : 0;
          db.reservations[key].number_of_guests = match.number_of_guests || 1;
          db.reservations[key].rates = match.rates;
          console.log('Enriched:', key, match.guest_name, price+'EUR');
        }
      } catch(e) {}
      await new Promise(res => setTimeout(res, 150));
    }
  }
  console.log('iCal done added:', added, 'total:', Object.keys(db.reservations).length);
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
      for (const r of list) { const k = r.reservation_code || r.id; r.total_price = r.rates && r.rates.total_rate ? r.rates.total_rate.amount : (r.total_price||0); r.currency = r.rates && r.rates.total_rate ? r.rates.total_rate.currency : (r.currency||'EUR'); r.commission = r.rates && r.rates.total_commission ? r.rates.total_commission.amount : 0; db.reservations[k] = r; }
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
      for (const r of list) { const k = r.reservation_code || r.id; r.total_price = r.rates && r.rates.total_rate ? r.rates.total_rate.amount : (r.total_price||0); r.currency = r.rates && r.rates.total_rate ? r.rates.total_rate.currency : (r.currency||'EUR'); r.commission = r.rates && r.rates.total_commission ? r.rates.total_commission.amount : 0; db.reservations[k] = r; }
    } catch(e2) {}
    await new Promise(res => setTimeout(res, 200));
  }
  // Aussi sync via iCal
  // Sync iCal et merger dans la DB courante
  try {
    const icalDb = await syncFromICal();
    for(const k of Object.keys(icalDb.reservations)) {
    for(const k of Object.keys(icalDb.reservations)) {
      const existing = db.reservations[k];
      const ical = icalDb.reservations[k];
      if(!existing) {
        // Nouvelle réservation iCal
        db.reservations[k] = ical;
      } else if(existing.guest_name === 'Voyageur Airbnb' || existing.guest_name === 'Voyageur Booking.com') {
        // Mettre à jour seulement les dates/canal si pas encore enrichi
        db.reservations[k].check_in_date = ical.check_in_date;
        db.reservations[k].check_out_date = ical.check_out_date;
        db.reservations[k].channel_type = ical.channel_type;
        db.reservations[k].property_id = ical.property_id;
      }
      // Si enrichi (vrai nom), on garde tout sans toucher
    }
    }
    console.log('iCal merged, total after merge:', Object.keys(db.reservations).length);
    // Enrichir les reservations iCal avec les vraies donnees API
    const apiRes = Object.values(db.reservations).filter(r => r.guest_name && r.guest_name !== 'Voyageur Airbnb' && r.guest_name !== 'Voyageur Booking.com' && r.guest_name !== 'Airbnb (Not available)');
    const icalRes = Object.values(db.reservations).filter(r => r.guest_name === 'Voyageur Airbnb' || r.guest_name === 'Airbnb (Not available)');
    for(const ical of icalRes) {
      const match = apiRes.find(a => a.check_in_date === ical.check_in_date && String(a.property_id) === String(ical.property_id));
      if(match) {
        db.reservations[ical.reservation_code].guest_name = match.guest_name;
        db.reservations[ical.reservation_code].guest_phone = match.guest_phone;
        db.reservations[ical.reservation_code].guest_email = match.guest_email;
        db.reservations[ical.reservation_code].total_price = match.total_price || (match.rates && match.rates.total_rate ? match.rates.total_rate.amount : 0);
        db.reservations[ical.reservation_code].currency = match.currency || 'EUR';
        db.reservations[ical.reservation_code].number_of_guests = match.number_of_guests;
        console.log('Enriched:', ical.check_in_date, '->', match.guest_name);
      }
    }
  } catch(e) { console.log('iCal sync error:', e.message); }
  db.last_sync = new Date().toISOString();
  db.total = Object.keys(db.reservations).length;
  saveDB(db);
  return db;
}

// Servir app HTML

// Web Push routes
app.get('/vapid-key', (req, res) => res.json({publicKey: VAPID_PUBLIC}));

app.post('/subscribe', (req, res) => {
  const sub = req.body;
  if(!sub || !sub.endpoint) return res.status(400).json({error:'Invalid subscription'});
  const exists = pushSubscriptions.find(s => s.endpoint === sub.endpoint);
  if(!exists) { pushSubscriptions.push(sub); saveSubs(); }
  res.json({ok: true, total: pushSubscriptions.length});
  console.log('New push subscriber, total:', pushSubscriptions.length);
});

app.get('/mobile', function(req, res) {
  res.sendFile(__dirname + '/mobile.html');
});

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
    // Hostex envoie dans payload.data, payload.reservation, ou plusieurs dans payload.reservations
    const items = payload.reservations || (payload.data ? [payload.data] : null) || (payload.reservation ? [payload.reservation] : null) || (payload.reservation_code ? [payload] : []);
    if (items.length > 0) {
      const db = loadDB();
      for (const r of items) {
        if (!r || !(r.reservation_code || r.id)) continue;
        const k = r.reservation_code || r.id;
        const price = r.rates && r.rates.total_rate ? r.rates.total_rate.amount : (r.total_price || 0);
        const com = r.rates && r.rates.total_commission ? r.rates.total_commission.amount : 0;
        db.reservations[k] = {
          reservation_code: k,
          guest_name: r.guest_name || '',
          check_in_date: r.check_in_date || '',
          check_out_date: r.check_out_date || '',
          channel_type: r.channel_type || 'airbnb',
          property_id: String(r.property_id || ''),
          number_of_guests: r.number_of_guests || 1,
          status: r.status || 'accepted',
          total_price: price,
          commission: com,
          currency: 'EUR',
          guest_phone: r.guest_phone || '',
          guest_email: r.guest_email || '',
          booked_at: r.booked_at || '',
          rates: r.rates || null,
        };
        console.log('Webhook reservation sauvegardee:', k, r.guest_name, price+'EUR');
      }
      db.total = Object.keys(db.reservations).length;
      db.last_sync = new Date().toISOString();
      saveDB(db);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Import CSV depuis Hostex
app.post('/import-csv', async function(req, res) {
  try {
    const { reservations } = req.body;
    if (!Array.isArray(reservations)) return res.status(400).json({ error: 'Invalid data' });
    const saved = await supaSave(reservations);
    invalidateCache();
    // Aussi sauvegarder en local comme backup
    const db = loadDB();
    for (const r of reservations) {
      const k = r.reservation_code || r.id;
      if (k) { db.reservations[k] = r; }
    }
    db.total = Object.keys(db.reservations).length;
    db.last_sync = new Date().toISOString();
    saveDB(db);
    res.json({ ok: true, added: saved, total: db.total });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// All reservations
app.get('/all-reservations', async function(req, res) {
  try {
    let stored = await getDB();
    if (!stored || stored.length === 0) {
      const db = loadDB();
      stored = Object.values(db.reservations || {});
    }
    res.json({ ok: true, data: { reservations: stored }, total: stored.length });
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

// Endpoint pour recevoir les reservations depuis le bookmarklet Hostex
// Sync complet avec token Hostex fourni par le bookmarklet
app.post('/sync-with-token', async function(req, res) {
  try {
    const token = req.body.token;
    if(!token) return res.status(400).json({error:'No token'});
    
    const db = loadDB();
    let all = {};
    const now = new Date();
    
    // Charger toutes les reservations mois par mois avec le vrai token
    for(let m = -6; m <= 18; m++) {
      const d = new Date(now.getFullYear(), now.getMonth()+m, 1);
      const year = d.getFullYear();
      const month = String(d.getMonth()+1).padStart(2,'0');
      try {
        const r = await fetch(`https://api.hostex.io/v3/reservations?check_in_date_min=${year}-${month}-01&check_in_date_max=${year}-${month}-31&page_size=50`, {
          headers: { 'Hostex-Access-Token': token, 'Content-Type': 'application/json' }
        });
        const data = await r.json();
        const list = data?.data?.reservations || [];
        list.filter(rv => rv.status !== 'cancelled').forEach(rv => { all[rv.reservation_code||rv.id] = rv; });
        console.log(`Month ${year}-${month}: ${list.length} reservations`);
      } catch(e) { console.log('Month error:', e.message); }
      await new Promise(res => setTimeout(res, 200));
    }
    
    // Aussi les sorts
    for(const sort of ['check_in_date&sort_order=asc','created_at&sort_order=desc']) {
      try {
        const r = await fetch(`https://api.hostex.io/v3/reservations?page_size=50&sort=${sort}`, {
          headers: { 'Hostex-Access-Token': token }
        });
        const data = await r.json();
        (data?.data?.reservations||[]).filter(rv=>rv.status!=='cancelled').forEach(rv=>{all[rv.reservation_code||rv.id]=rv;});
      } catch(e) {}
      await new Promise(res => setTimeout(res, 200));
    }
    
    const reservations = Object.values(all);
    console.log('sync-with-token: total found', reservations.length);
    
    let added = 0;
    for(const rv of reservations) {
      const k = rv.reservation_code || rv.id;
      if(!k) continue;
      const price = rv.rates?.total_rate?.amount || rv.total_price || 0;
      const com = rv.rates?.total_commission?.amount || 0;
      if(!db.reservations[k]) added++;
      db.reservations[k] = {
        reservation_code: k,
        guest_name: rv.guest_name || '',
        check_in_date: rv.check_in_date || '',
        check_out_date: rv.check_out_date || '',
        channel_type: rv.channel_type || 'airbnb',
        property_id: String(rv.property_id || ''),
        number_of_guests: rv.number_of_guests || 1,
        status: rv.status || 'accepted',
        total_price: price,
        commission: com,
        currency: 'EUR',
        guest_phone: rv.guest_phone || '',
        guest_email: rv.guest_email || '',
        booked_at: rv.booked_at || '',
        rates: rv.rates || null,
      };
    }
    db.total = Object.keys(db.reservations).length;
    saveDB(db);
    res.json({ok:true, found: reservations.length, added, total: db.total});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/sync-from-browser', async function(req, res) {
  try {
    const db = loadDB();
    const reservations = req.body.reservations || [];
    let added = 0;
    for(const rv of reservations) {
      const k = rv.reservation_code || rv.id;
      if(!k) continue;
      const price = rv.rates && rv.rates.total_rate ? rv.rates.total_rate.amount : (rv.total_price || 0);
      const com = rv.rates && rv.rates.total_commission ? rv.rates.total_commission.amount : 0;
      const existing = db.reservations[k];
      // Toujours mettre à jour avec les vraies données
      db.reservations[k] = {
        reservation_code: k,
        guest_name: rv.guest_name || (existing && existing.guest_name) || 'Voyageur',
        check_in_date: rv.check_in_date || (existing && existing.check_in_date) || '',
        check_out_date: rv.check_out_date || (existing && existing.check_out_date) || '',
        channel_type: rv.channel_type || (existing && existing.channel_type) || 'airbnb',
        property_id: String(rv.property_id || (existing && existing.property_id) || ''),
        number_of_guests: rv.number_of_guests || (existing && existing.number_of_guests) || 1,
        status: rv.status || 'accepted',
        total_price: price || (existing && existing.total_price) || 0,
        commission: com || (existing && existing.commission) || 0,
        currency: 'EUR',
        guest_phone: rv.guest_phone || (existing && existing.guest_phone) || '',
        guest_email: rv.guest_email || (existing && existing.guest_email) || '',
        booked_at: rv.booked_at || (existing && existing.booked_at) || '',
        rates: rv.rates || (existing && existing.rates) || null,
      };
      if(!existing) added++;
    }
    db.total = Object.keys(db.reservations).length;
    saveDB(db);
    console.log('sync-from-browser: received', reservations.length, 'added', added, 'total', db.total);
    res.json({ok:true, received: reservations.length, added, total: db.total});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/health', async function(req, res) {
  const db = loadDB();
  res.json({ status: 'ok', token_set: !!HOSTEX_TOKEN, reservations_stored: (await getDB()).length || db.total || 0, last_sync: db.last_sync, timestamp: new Date().toISOString(), webhook_url: 'https://hostex-proxy.onrender.com/webhook' });
});


// Keep-alive pour Render (evite la mise en veille)
setInterval(async function() {
  try {
    await fetch('https://hostex-proxy.onrender.com/health');
    console.log('Keep-alive ping OK', new Date().toISOString());
  } catch(e) {}
}, 14 * 60 * 1000); // toutes les 14 minutes

app.listen(PORT, function() { console.log('Listening on', PORT); });

// Sync léger au démarrage - enrichit via channel_id sans recréer de doublons
async function lightSync() {
  const db = loadDB();
  if(!db.reservations) return;
  console.log('Light sync: enrichissement', Object.keys(db.reservations).length, 'reservations...');
  let enriched = 0;
  for(const k of Object.keys(db.reservations)) {
    const r = db.reservations[k];
    if(r.guest_name && r.guest_name !== 'Voyageur Airbnb' && r.guest_name !== 'Voyageur Booking.com') continue;
    if(!k.startsWith('HM')) continue;
    try {
      const apiRes = await hostexGet('/reservations?channel_id='+k+'&page_size=1');
      const match = apiRes && apiRes.data && apiRes.data.reservations && apiRes.data.reservations[0];
      if(match && match.guest_name) {
        db.reservations[k].guest_name = match.guest_name;
        db.reservations[k].guest_phone = match.guest_phone || '';
        const price = match.rates && match.rates.total_rate ? match.rates.total_rate.amount : 0;
        if(price > 0) db.reservations[k].total_price = price;
        enriched++;
      }
    } catch(e) {}
    await new Promise(res => setTimeout(res, 150));
  }
  db.last_sync = new Date().toISOString();
  saveDB(db);
  console.log('Light sync done, enriched:', enriched);
}

// Sync automatique Hostex -> Supabase toutes les 15 min
async function syncHostexToSupabase() {
  if (!HOSTEX_TOKEN) return;
  try {
    let allRes = [];
    for (let page = 1; page <= 10; page++) {
      const data = await hostexGet('/reservations?page_size=50&page=' + page + '&sort=check_in_date&sort_order=desc');
      const list = (data && data.data && data.data.reservations) || [];
      if (!list.length) break;
      allRes = allRes.concat(list);
      if (list.length < 50) break;
    }
    if (allRes.length > 0) {
      const toSave = allRes.map(r => {
        // Normaliser le code: supprimer les préfixes 0- et suffixes -icXXXX -idXXXX
        let code = r.reservation_code || r.id || '';
        if (code.startsWith('0-')) code = code.split('-')[1]; // 0-HMXXXX-icXXXX -> HMXXXX
        if (code.match(/-ic[a-z0-9]+$/) || code.match(/-id[a-z0-9]+$/)) {
          code = code.replace(/-ic[a-z0-9]+$/, '').replace(/-id[a-z0-9]+$/, '');
        }
        return {
        reservation_code: code || r.reservation_code || r.id,
        guest_name: r.guest_name || '',
        check_in_date: r.check_in_date || '',
        check_out_date: r.check_out_date || '',
        channel_type: r.channel_type || 'direct',
        property_id: String(r.property_id || ''),
        number_of_guests: r.number_of_guests || 1,
        status: r.status || 'accepted',
        total_price: (r.rates && r.rates.total_rate) ? parseFloat(r.rates.total_rate.amount) : parseFloat(r.total_price || 0),
        commission: (r.rates && r.rates.total_commission) ? parseFloat(r.rates.total_commission.amount) : 0,
        currency: 'EUR',
        guest_phone: r.guest_phone || '',
        stay_status: r.stay_status || '',
        booked_at: r.created_at || ''
      }}).filter(r => r.reservation_code && r.check_in_date);
      await supaSave(toSave);
      invalidateCache();
      console.log('Auto-sync: ' + toSave.length + ' reservations synced to Supabase');
    }
  } catch(e) {
    console.error('Auto-sync error:', e.message);
  }
}

// Sync 10s après démarrage puis toutes les 15 min
setTimeout(() => syncHostexToSupabase().catch(console.error), 10000);
setInterval(() => syncHostexToSupabase().catch(console.error), 15 * 60 * 1000);
console.log('Serveur démarré - auto-sync Hostex->Supabase toutes les 15min');

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
// Lun 18 mai 2026 15:37:22 CEST
// force Mar 19 mai 2026 15:21:30 CEST
