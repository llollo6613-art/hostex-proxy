

// ===== WEB PUSH NOTIFICATIONS =====
const webpush = require('web-push');
const VAPID_PUBLIC = process.env.VAPID_PUBLIC || 'BJFwoHPQF_U65sVAS2s7aawrGceNCsSFxtdIB0Qolxfy2VH4HHm-ukdSCYMaonFKVwQdQvoTS5PGBWJ5IAHygxQ';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || 'vPeevLy4yk49Jtl3--Wu2eijo89xP7kV5KI4exgPSy8';
webpush.setVapidDetails('mailto:contact@illiberis.fr', VAPID_PUBLIC, VAPID_PRIVATE);
let pushSubscriptions = [];
// Charger les abonnements depuis Supabase au démarrage
async function loadSubs() {
  try {
    const rows = await supaFetch('push_subscriptions?select=subscription,role');
    pushSubscriptions = rows.map(r => ({...JSON.parse(r.subscription), role: r.role||'owner'}));
    console.log('Push subs loaded:', pushSubscriptions.length);
  } catch(e) { console.log('loadSubs error:', e.message); }
}
async function saveSubs() {
  // Sauvegarder aussi en fichier comme backup
  try { require('fs').writeFileSync('/tmp/push_subs.json', JSON.stringify(pushSubscriptions)); } catch(e) {}
}
async function sendPushNotif(title, body, url, tag, targetRole) {
  if(!pushSubscriptions.length) return;
  // Filtrer par rôle si spécifié, sinon envoyer à 'owner' uniquement
  const role = targetRole || 'owner';
  const targets = role === 'all' ? pushSubscriptions : pushSubscriptions.filter(s => (s.role||'owner') === role);
  if(!targets.length) return;
  const payload = JSON.stringify({title:title||'Illiberis', body:body||'', url:url||'/mobile', tag:tag||'notif'});
  const failed = [];
  for (const sub of targets) {
    try { await webpush.sendNotification(sub, payload); }
    catch(e) { if(e.statusCode===410||e.statusCode===404) failed.push(sub.endpoint); }
  }
  if(failed.length) { pushSubscriptions=pushSubscriptions.filter(s=>!failed.includes(s.endpoint)); saveSubs(); }
  console.log('Push sent to', role, ':', targets.length, 'subscribers');
}


// ===== NOTIFICATIONS NTFY.SH (fonctionne sur tous les telephones) =====
const NTFY_BASE = 'https://ntfy.sh';
const NTFY_RESA = 'illiberis-reservations-2026';   // Pour toi - nouvelles resas
const NTFY_MENAGE = 'illiberis-menage-2026';        // Pour ta femme de menage

async function sendNtfy(topic, title, message, priority) {
  try {
    const resp = await fetch(NTFY_BASE + '/' + topic, {
      method: 'POST',
      headers: {
        'Title': encodeURIComponent(title),
        'Priority': priority || 'high',
        'Tags': 'house',
        'Content-Type': 'text/plain; charset=utf-8'
      },
      body: message
    });
    console.log('Ntfy sent [' + topic + ']:', title, '- status:', resp.status);
  } catch(e) { console.error('Ntfy error:', e.message); }
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

  // Détecter annulations Booking : résas futures absentes du iCal → cancelled
  try {
    const today = new Date().toISOString().split('T')[0];
    // Collecter toutes les dates présentes dans le iCal Booking par prop
    const icalBookingKeys = {};
    for(const {url, prop, channel} of icalUrls) {
      if(channel !== 'booking.com') continue;
      try {
        const r2 = await fetch(url, {headers:{'User-Agent':'Mozilla/5.0','Accept':'text/calendar,*/*'}});
        const raw2 = await r2.text();
        const text2 = raw2.replace(/\r\n[ \t]/g, '').replace(/\r/g, '');
        const events2 = text2.split('BEGIN:VEVENT').slice(1);
        if(!icalBookingKeys[prop]) icalBookingKeys[prop] = new Set();
        for(const ev2 of events2) {
          const dtstart2 = (ev2.match(/DTSTART[^:\n]*:(\d+)/) || [])[1];
          const dtend2 = (ev2.match(/DTEND[^:\n]*:(\d+)/) || [])[1];
          if(!dtstart2 || !dtend2) continue;
          const ci2 = dtstart2.slice(0,4)+'-'+dtstart2.slice(4,6)+'-'+dtstart2.slice(6,8);
          icalBookingKeys[prop].add(ci2);
        }
      } catch(e2) { console.log('iCal cancel check error:', e2.message); }
    }
    // Marquer cancelled les résas Booking futures absentes du iCal
    let cancelledCount = 0;
    for(const key of Object.keys(db.reservations)) {
      const r = db.reservations[key];
      if(!r || r.status === 'cancelled') continue;
      if(r.channel_type !== 'booking.com') continue;
      if(!r.check_in_date || r.check_in_date < today) continue;
      const propKeys = icalBookingKeys[r.property_id];
      if(propKeys && !propKeys.has(r.check_in_date)) {
        db.reservations[key].status = 'cancelled';
        cancelledCount++;
        console.log('Auto-cancelled:', key, r.guest_name, r.check_in_date);
        // Mettre à jour dans Supabase aussi
        try {
          await supaFetch('reservations?reservation_code=eq.'+encodeURIComponent(key), 'PATCH', {status:'cancelled'});
        } catch(e3) { console.log('Supabase cancel error:', e3.message); }
      }
    }
    console.log('Auto-cancelled Booking:', cancelledCount, 'reservations');

    // Synchroniser le statut des doublons (-id... -bk...) avec la résa principale
    let syncedCount = 0;
    for(const key of Object.keys(db.reservations)) {
      const r = db.reservations[key];
      if(!r) continue;
      // Trouver si c'est un doublon (contient -id ou -bk dans le code)
      const baseKey = key.replace(/-id[a-z0-9]+$/, '').replace(/-bk$/, '');
      if(baseKey === key) continue; // pas un doublon
      const base = db.reservations[baseKey];
      if(base && base.status === 'cancelled' && r.status !== 'cancelled') {
        db.reservations[key].status = 'cancelled';
        syncedCount++;
        try {
          await supaFetch('reservations?reservation_code=eq.'+encodeURIComponent(key), 'PATCH', {status:'cancelled'});
        } catch(e) {}
      }
    }
    if(syncedCount > 0) console.log('Synced duplicate statuses:', syncedCount);
  } catch(e) { console.log('Cancel detection error:', e.message); }

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
app.get('/sw.js', (req, res) => { res.setHeader('Content-Type','application/javascript'); res.sendFile(__dirname+'/sw.js'); });
app.get('/manifest.json', (req, res) => res.sendFile(__dirname+'/manifest.json'));
app.get('/icon.svg', (req, res) => { res.setHeader('Content-Type','image/svg+xml'); res.sendFile(__dirname+'/icon.svg'); });
app.get('/vapid-key', (req, res) => res.json({publicKey: VAPID_PUBLIC}));
app.get('/manifest-menage.json', (req, res) => res.sendFile(__dirname+'/manifest-menage.json'));
app.get('/icon-menage-192.png', (req, res) => res.sendFile(__dirname+'/icon-menage-192.png'));
app.get('/icon-menage-512.png', (req, res) => res.sendFile(__dirname+'/icon-menage-512.png'));

// DIAGNOSTIC : lister les abonnements push (pour repérer les doublons d'appareils)
app.get('/debug-subs', async function(req, res) {
  try {
    const byRole = { owner: [], menage: [], autre: [] };
    pushSubscriptions.forEach(function(s, i) {
      const r = s.role || 'owner';
      const bucket = byRole[r] ? r : 'autre';
      // Extraire un identifiant lisible de l'endpoint (domaine du service push + fin)
      let ep = s.endpoint || '';
      let shortEp = ep.slice(0, 40) + '...' + ep.slice(-12);
      byRole[bucket].push({ idx: i, endpoint: shortEp });
    });
    res.json({
      total: pushSubscriptions.length,
      owner_count: byRole.owner.length,
      menage_count: byRole.menage.length,
      autre_count: byRole.autre.length,
      owner: byRole.owner,
      menage: byRole.menage,
      autre: byRole.autre
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DIAGNOSTIC : audit des statuts de réservations (repérer les annulations en masse)
app.get('/debug-audit', async function(req, res) {
  try {
    const all = await getDB();
    const todayStr = new Date().toISOString().slice(0, 10);
    const byStatus = {};
    let futureCancelled = [];
    let futureActive = 0;
    all.forEach(function(r) {
      const st = r.status || 'null';
      byStatus[st] = (byStatus[st] || 0) + 1;
      if (r.check_in_date && r.check_in_date >= todayStr) {
        if (st === 'cancelled') futureCancelled.push({ code: r.reservation_code, guest: r.guest_name, checkin: r.check_in_date, channel: r.channel_type });
        else futureActive++;
      }
    });
    res.json({
      total: all.length,
      par_statut: byStatus,
      futures_actives: futureActive,
      futures_annulees_count: futureCancelled.length,
      futures_annulees: futureCancelled.slice(0, 50)
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// RÉPARATION : restaurer les réservations annulées à tort.
// Repasse en 'accepted' toute résa 'cancelled' qui existe ENCORE dans l'API Hostex.
app.get('/repair-cancellations', async function(req, res) {
  try {
    // 1. Récupérer TOUS les codes présents dans l'API Hostex (toutes pages, tous tris)
    const apiCodes = new Set();
    for (const sortParam of ['', '&sort=check_in_date&sort_order=desc', '&sort=check_in_date&sort_order=asc', '&sort=booked_at&sort_order=desc']) {
      for (let page = 1; page <= 15; page++) {
        const data = await hostexGet('/reservations?page_size=100&page=' + page + sortParam);
        const list = (data && data.data && data.data.reservations) || [];
        if (!list.length) break;
        list.forEach(function(r) {
          let code = r.reservation_code || r.id || '';
          apiCodes.add(code);
          // aussi la version normalisée
          let norm = code;
          if (norm.startsWith('0-')) norm = norm.split('-')[1];
          norm = norm.replace(/-ic[a-z0-9]+$/, '').replace(/-id[a-z0-9]+$/, '').replace(/-bk$/, '');
          apiCodes.add(norm);
        });
        if (list.length < 100) break;
      }
    }
    // 2. Parcourir les résas 'cancelled' en base et restaurer celles encore dans l'API
    const all = await getDB();
    const cancelled = all.filter(r => r.status === 'cancelled');
    const restored = [];
    const keptCancelled = [];
    for (const r of cancelled) {
      let code = r.reservation_code || '';
      let norm = code;
      if (norm.startsWith('0-')) norm = norm.split('-')[1];
      norm = norm.replace(/-ic[a-z0-9]+$/, '').replace(/-id[a-z0-9]+$/, '').replace(/-bk$/, '');
      if (apiCodes.has(code) || apiCodes.has(norm)) {
        // Existe encore dans Hostex => n'aurait pas dû être annulée => restaurer
        try {
          await supaFetch('reservations?reservation_code=eq.' + encodeURIComponent(r.reservation_code), 'PATCH', { status: 'accepted' });
          restored.push({ code: r.reservation_code, guest: r.guest_name, checkin: r.check_in_date });
        } catch(e) { console.error('Restore error:', e.message); }
      } else {
        keptCancelled.push({ code: r.reservation_code, guest: r.guest_name, checkin: r.check_in_date });
      }
    }
    invalidateCache();
    res.json({
      api_codes_count: apiCodes.size,
      restaurees_count: restored.length,
      restaurees: restored,
      vraies_annulations_count: keptCancelled.length,
      vraies_annulations: keptCancelled
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// RÉPARATION v2 : restaurer via les iCal Airbnb/Booking (source FIABLE, contient tout).
// Toute résa 'cancelled' dont le code OU les dates correspondent à un événement iCal actif est restaurée.
// RÉPARATION v3 : restaurer les résa FUTURES 'cancelled' SAUF les vraies annulations confirmées.
// Ne touche PAS aux réservations passées (leurs annulations restent telles quelles).
// DÉDUPLICATION : supprime les doublons (même réservation stockée sous plusieurs codes).
// Normalise le code (retire préfixe 0-, suffixes -bk / -icXXX / -idXXX) et garde 1 seule version.
function _normCode(code) {
  let c = code || '';
  if (c.startsWith('0-')) {
    const parts = c.split('-');
    c = parts[1] || c;
  }
  c = c.replace(/-ic[a-z0-9]+$/i, '').replace(/-id[a-z0-9]+$/i, '').replace(/-ie[a-z0-9]+$/i, '').replace(/-bk$/i, '');
  return c;
}
app.get('/dedup', async function(req, res) {
  try {
    const dryRun = req.query.apply !== '1';  // par défaut simulation ; ?apply=1 pour exécuter
    const all = await getDB();
    // Grouper par code normalisé
    const groups = {};
    all.forEach(function(r) {
      const norm = _normCode(r.reservation_code);
      (groups[norm] = groups[norm] || []).push(r);
    });
    const toDelete = [];
    const kept = [];
    Object.keys(groups).forEach(function(norm) {
      const grp = groups[norm];
      if (grp.length <= 1) return;  // pas de doublon
      // Choisir la version à GARDER : priorité au code le plus riche en données
      // (celui avec le plus d'infos : prix, commission, guest réel), sinon le code le plus court
      grp.sort(function(a, b) {
        const aScore = (a.total_price > 0 ? 2 : 0) + (a.commission > 0 ? 1 : 0) + (a.guest_name && !a.guest_name.includes('Voyageur') ? 1 : 0);
        const bScore = (b.total_price > 0 ? 2 : 0) + (b.commission > 0 ? 1 : 0) + (b.guest_name && !b.guest_name.includes('Voyageur') ? 1 : 0);
        if (bScore !== aScore) return bScore - aScore;
        return (a.reservation_code || '').length - (b.reservation_code || '').length;
      });
      kept.push({ norm: norm, garde: grp[0].reservation_code, guest: grp[0].guest_name });
      for (let i = 1; i < grp.length; i++) toDelete.push(grp[i]);
    });
    if (!dryRun) {
      for (const r of toDelete) {
        try {
          await supaFetch('reservations?reservation_code=eq.' + encodeURIComponent(r.reservation_code), 'DELETE');
        } catch(e) { console.error('Dedup delete error:', e.message); }
      }
      invalidateCache();
    }
    res.json({
      mode: dryRun ? 'SIMULATION (ajouter ?apply=1 pour exécuter)' : 'APPLIQUÉ',
      doublons_trouves: toDelete.length,
      a_supprimer: toDelete.map(function(r){ return { code: r.reservation_code, guest: r.guest_name, checkin: r.check_in_date }; }),
      versions_gardees: kept.slice(0, 60)
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/repair-all', async function(req, res) {
  try {
    const realCancellations = ['HMBKRESPHX']; // Remi Sans
    const realCancelGuests = ['remi sans', 'komarskyi']; // par nom aussi
    const todayStr = new Date().toISOString().slice(0, 10);
    const all = await getDB();
    // Uniquement les résa cancelled dont le check-in est aujourd'hui ou futur
    const cancelled = all.filter(r => r.status === 'cancelled' && r.check_in_date && r.check_in_date >= todayStr);
    const restored = [], kept = [];
    for (const r of cancelled) {
      const guestLower = (r.guest_name || '').toLowerCase();
      const isReal = realCancellations.includes(r.reservation_code)
        || realCancelGuests.some(g => guestLower.includes(g));
      if (isReal) {
        kept.push({ code: r.reservation_code, guest: r.guest_name, checkin: r.check_in_date });
      } else {
        try {
          await supaFetch('reservations?reservation_code=eq.' + encodeURIComponent(r.reservation_code), 'PATCH', { status: 'accepted' });
          restored.push({ code: r.reservation_code, guest: r.guest_name, checkin: r.check_in_date });
        } catch(e) { console.error('Restore error:', e.message); }
      }
    }
    invalidateCache();
    res.json({
      note: 'Seules les résa FUTURES ont été traitées. Les annulations passées sont inchangées.',
      restaurees_count: restored.length,
      restaurees: restored,
      vraies_annulations_conservees: kept
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DÉTECTION ANNULATIONS via iCal (source fiable) — SANS notification.
// Marque 'cancelled' les résas FUTURES actives en base mais absentes des iCal,
// uniquement dans la fenêtre de dates couverte par les iCal. Simulation par défaut ; ?apply=1 pour exécuter.
// TEST : diagnostique l'accès aux iCal (Render peut-il les joindre ?)
// Usage : /test-ical  OU  /test-ical?url=https://...ics (pour tester une URL fraîche)
app.get('/test-ical', async function(req, res) {
  try {
    const testUrls = req.query.url ? [{n:'URL fournie', url:req.query.url}] : [
      {n:'Airbnb Suite', url:'https://www.airbnb.fr/calendar/ical/1444758558715417027.ics?t=c42b72016c5748c18ee41cd64ae7e287'},
      {n:'Booking Suite', url:'https://ical.booking.com/v1/export?t=939b4e7b-3790-4c7a-8062-4b58f61c6af2'},
      {n:'Booking Loft', url:'https://ical.booking.com/v1/export?t=0e46cbb9-8661-4a50-99d3-0dc9ec5ab511'},
    ];
    const results = [];
    for (const {n, url} of testUrls) {
      try {
        const r = await fetch(url, {headers:{'User-Agent':'Mozilla/5.0','Accept':'text/calendar,*/*'}});
        const t = await r.text();
        const nbEvents = (t.match(/BEGIN:VEVENT/g) || []).length;
        // Extraire un événement complet pour analyse du format
        const cleaned = t.replace(/\r\n[ \t]/g, '').replace(/\r/g, '');
        const firstEvent = cleaned.split('BEGIN:VEVENT')[1] ? cleaned.split('BEGIN:VEVENT')[1].split('END:VEVENT')[0] : '';
        results.push({ nom: n, http_status: r.status, taille: t.length, evenements: nbEvents, evenement_complet: firstEvent.slice(0, 500) });
      } catch(e) {
        results.push({ nom: n, erreur: e.message });
      }
    }
    res.json({ resultats: results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/detect-cancel-ical', async function(req, res) {
  try {
    const dryRun = req.query.apply !== '1';
    const icalUrls = [
      {url: 'https://www.airbnb.fr/calendar/ical/1444758558715417027.ics?t=c42b72016c5748c18ee41cd64ae7e287', prop: '12619011'},
      {url: 'https://www.airbnb.fr/calendar/ical/1499112879728152781.ics?t=7dccb868b47241b9970e6d8caa1a5de8', prop: '12619012'},
      {url: 'https://ical.booking.com/v1/export?t=939b4e7b-3790-4c7a-8062-4b58f61c6af2', prop: '12619011'},
      {url: 'https://ical.booking.com/v1/export?t=0e46cbb9-8661-4a50-99d3-0dc9ec5ab511', prop: '12619012'},
    ];
    const activeCodes = new Set();
    const activeDates = new Set();       // "prop|checkin"
    const datesCouvertes = [];           // toutes les dates de check-in vues dans les iCal
    // Suivre quelles PLATEFORMES ont un iCal valide (avec evenements). On n'annulera
    // QUE les resas des plateformes dont l'iCal a repondu — sinon faux positifs en masse.
    const platesValides = { airbnb: false, booking: false };
    for (const {url, prop} of icalUrls) {
      const isBooking = url.includes('booking.com');
      const plat = isBooking ? 'booking' : 'airbnb';
      try {
        const r = await fetch(url, {headers:{'User-Agent':'Mozilla/5.0','Accept':'text/calendar,*/*'}});
        const rawText = await r.text();
        const text = rawText.replace(/\r\n[ \t]/g, '').replace(/\r/g, '');
        const events = text.split('BEGIN:VEVENT').slice(1);
        let evCount = 0;
        for (const ev of events) {
          const dtstart = (ev.match(/DTSTART[^:\n]*:(\d+)/) || [])[1];
          const dtend = (ev.match(/DTEND[^:\n]*:(\d+)/) || [])[1];
          const summary = ((ev.match(/SUMMARY:([^\n]+)/) || [])[1] || '').trim();
          const desc = ((ev.match(/DESCRIPTION:([^\n]+)/) || [])[1] || '').trim();
          if (!dtstart) continue;
          if (isBooking) {
            // iCal Booking : événements "CLOSED - Not available" = dates OCCUPÉES par une résa active.
            // Pas de code client disponible → on marque TOUTES les nuits occupées (prop|date).
            const ci = dtstart.slice(0,4)+'-'+dtstart.slice(4,6)+'-'+dtstart.slice(6,8);
            activeDates.add(prop + '|' + ci);
            datesCouvertes.push(ci);
            // Marquer aussi chaque nuit entre dtstart et dtend (occupation complète)
            if (dtend) {
              let d = new Date(ci + 'T12:00:00');
              const fin = new Date(dtend.slice(0,4)+'-'+dtend.slice(4,6)+'-'+dtend.slice(6,8) + 'T12:00:00');
              while (d < fin) {
                const ds = d.toISOString().slice(0,10);
                activeDates.add(prop + '|' + ds);
                datesCouvertes.push(ds);
                d.setDate(d.getDate() + 1);
              }
            }
            evCount++;
          } else {
            // iCal Airbnb : "Reserved" avec code dans la description. On ignore les blocages manuels.
            if (summary.includes('Not available') || summary === 'Blocked') continue;
            const ci = dtstart.slice(0,4)+'-'+dtstart.slice(4,6)+'-'+dtstart.slice(6,8);
            const codeMatch = desc.match(/details\/([A-Z0-9]+)/);
            if (codeMatch) activeCodes.add(codeMatch[1]);
            activeDates.add(prop + '|' + ci);
            datesCouvertes.push(ci);
            evCount++;
          }
        }
        if (evCount > 0) platesValides[plat] = true;
      } catch(eICal) { console.error('iCal fetch error:', eICal.message); }
    }
    const icalOK = (platesValides.airbnb ? 1 : 0) + (platesValides.booking ? 1 : 0);
    // SÉCURITÉ : si aucun iCal n'a répondu correctement, on ne touche à RIEN (évite d'annuler en masse)
    if (icalOK === 0 || datesCouvertes.length < 3) {
      return res.json({ erreur_securite: 'iCal indisponibles ou vides — aucune action pour éviter les faux positifs', icalOK, evenements: datesCouvertes.length });
    }
    // Fenêtre de dates couverte par les iCal
    datesCouvertes.sort();
    const winMin = datesCouvertes[0];
    const winMax = datesCouvertes[datesCouvertes.length - 1];
    const todayStr = new Date().toISOString().slice(0, 10);

    const all = await getDB();
    const aAnnuler = [];
    for (const r of all) {
      if (r.status === 'cancelled') continue;
      if (!r.check_in_date) continue;
      if (r.check_in_date < todayStr) continue;          // futur uniquement
      if (r.check_in_date < winMin || r.check_in_date > winMax) continue; // dans la fenêtre iCal
      // Ne traiter que si l'iCal de CETTE plateforme a repondu (sinon faux positif)
      const ch = (r.channel_type||'').toLowerCase();
      const platResa = ch.includes('booking') ? 'booking' : (ch.includes('airbnb') ? 'airbnb' : 'autre');
      if (platResa === 'autre') continue;
      if (!platesValides[platResa]) continue;   // iCal de cette plateforme indisponible => on ne touche pas
      // code normalisé
      let code = r.reservation_code || '';
      let norm = code;
      if (norm.startsWith('0-')) norm = norm.split('-')[1];
      norm = norm.replace(/-ic[a-z0-9]+$/, '').replace(/-id[a-z0-9]+$/, '').replace(/-ie[a-z0-9]+$/, '').replace(/-bk$/, '');
      const presentByCode = activeCodes.has(code) || activeCodes.has(norm);
      const presentByDate = activeDates.has(String(r.property_id) + '|' + r.check_in_date);
      if (!presentByCode && !presentByDate) {
        aAnnuler.push(r);
      }
    }
    let done = 0;
    if (!dryRun) {
      for (const r of aAnnuler) {
        try {
          await supaFetch('reservations?reservation_code=eq.' + encodeURIComponent(r.reservation_code), 'PATCH', { status: 'cancelled' });
          done++;
        } catch(e) { console.error('Cancel patch error:', e.message); }
      }
      invalidateCache();
    }
    res.json({
      mode: dryRun ? 'SIMULATION (ajouter ?apply=1 pour exécuter)' : 'APPLIQUÉ — sans notification',
      fenetre_ical: winMin + ' → ' + winMax,
      plateformes_ical_valides: platesValides,
      ical_actifs: activeCodes.size,
      a_annuler_count: aAnnuler.length,
      annulees: done,
      liste: aAnnuler.map(r => ({ code: r.reservation_code, guest: r.guest_name, checkin: r.check_in_date, channel: r.channel_type }))
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/repair-ical', async function(req, res) {
  try {
    const icalUrls = [
      {url: 'https://www.airbnb.fr/calendar/ical/1444758558715417027.ics?t=c42b72016c5748c18ee41cd64ae7e287', prop: '12619011'},
      {url: 'https://www.airbnb.fr/calendar/ical/1499112879728152781.ics?t=7dccb868b47241b9970e6d8caa1a5de8', prop: '12619012'},
      {url: 'https://ical.booking.com/v1/export?t=939b4e7b-3790-4c7a-8062-4b58f61c6af2', prop: '12619011'},
      {url: 'https://ical.booking.com/v1/export?t=0e46cbb9-8661-4a50-99d3-0dc9ec5ab511', prop: '12619012'},
    ];
    const activeCodes = new Set();
    const activeDates = new Set();  // "prop|checkin" pour matcher par dates si code différent
    for (const {url, prop} of icalUrls) {
      try {
        const r = await fetch(url, {headers:{'User-Agent':'Mozilla/5.0','Accept':'text/calendar,*/*'}});
        const rawText = await r.text();
        const text = rawText.replace(/\r\n[ \t]/g, '').replace(/\r/g, '');
        const events = text.split('BEGIN:VEVENT').slice(1);
        for (const ev of events) {
          const dtstart = (ev.match(/DTSTART[^:\n]*:(\d+)/) || [])[1];
          const summary = ((ev.match(/SUMMARY:([^\n]+)/) || [])[1] || '').trim();
          const desc = ((ev.match(/DESCRIPTION:([^\n]+)/) || [])[1] || '').trim();
          if (!dtstart) continue;
          if (summary.includes('Not available') || summary === 'Blocked') continue;
          const ci = dtstart.slice(0,4)+'-'+dtstart.slice(4,6)+'-'+dtstart.slice(6,8);
          const codeMatch = desc.match(/details\/([A-Z0-9]+)/);
          if (codeMatch) activeCodes.add(codeMatch[1]);
          activeDates.add(prop + '|' + ci);
        }
      } catch(eICal) { console.error('iCal fetch error:', eICal.message); }
    }
    // Restaurer les résas cancelled présentes dans les iCal
    const all = await getDB();
    const cancelled = all.filter(r => r.status === 'cancelled');
    const restored = [], kept = [];
    for (const r of cancelled) {
      let code = r.reservation_code || '';
      let norm = code;
      if (norm.startsWith('0-')) norm = norm.split('-')[1];
      norm = norm.replace(/-ic[a-z0-9]+$/, '').replace(/-id[a-z0-9]+$/, '').replace(/-bk$/, '');
      const byCode = activeCodes.has(code) || activeCodes.has(norm);
      const byDate = activeDates.has(String(r.property_id) + '|' + r.check_in_date);
      if (byCode || byDate) {
        try {
          await supaFetch('reservations?reservation_code=eq.' + encodeURIComponent(r.reservation_code), 'PATCH', { status: 'accepted' });
          restored.push({ code: r.reservation_code, guest: r.guest_name, checkin: r.check_in_date, via: byCode ? 'code' : 'date' });
        } catch(e) { console.error('Restore error:', e.message); }
      } else {
        kept.push({ code: r.reservation_code, guest: r.guest_name, checkin: r.check_in_date });
      }
    }
    invalidateCache();
    res.json({
      ical_codes: activeCodes.size,
      ical_dates: activeDates.size,
      restaurees_count: restored.length,
      restaurees: restored,
      restent_annulees_count: kept.length,
      restent_annulees: kept
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/subscribe', async (req, res) => {
  const {endpoint, role, ...rest} = req.body || {};
  const sub = {endpoint, ...rest};
  if(!sub || !sub.endpoint) return res.status(400).json({error:'Invalid subscription'});
  const subRole = role || 'owner';
  const idx = pushSubscriptions.findIndex(s => s.endpoint === sub.endpoint);
  if(idx === -1) {
    pushSubscriptions.push({...sub, role: subRole});
  } else {
    pushSubscriptions[idx] = {...pushSubscriptions[idx], role: subRole};
  }
  saveSubs();
  try {
    await supaFetch('push_subscriptions?on_conflict=endpoint', 'POST', [{
      endpoint: sub.endpoint,
      subscription: JSON.stringify(sub),
      role: subRole
    }]);
  } catch(e) { console.log('Supabase sub save error:', e.message); }
  res.json({ok: true, total: pushSubscriptions.length, role: subRole});
  console.log('Push subscriber:', subRole, 'total:', pushSubscriptions.length);
});


// Notification quand femme de ménage valide un ménage
app.post('/menage-done', async function(req, res) {
  const { prop, date } = req.body || {};
  const propName = prop === '12619011' ? 'Suite Illiberis' : 'Loft Cinema Illiberis';
  const msg = propName + ' - Ménage effectué le ' + (date || new Date().toLocaleDateString('fr-FR'));
  // Web Push + ntfy
  await sendPushNotif('✅ Ménage terminé !', msg, '/mobile', 'menage-done', 'owner');
  res.json({ ok: true });
  console.log('Menage done notif sent:', propName);
});

// Notes ménage
app.get('/notes-list', async function(req, res) {
  try {
    const notes = await supaFetch('menage_notes?select=*&order=created_at.desc&limit=50');
    res.json({ok:true, notes});
  } catch(e) { res.json({ok:false, notes:[]}); }
});

app.post('/note-add', async function(req, res) {
  try {
    const {prop_id, text, author, reservation_code} = req.body;
    if(!prop_id || !text) return res.status(400).json({error:'Missing fields'});
    await supaFetch('menage_notes', 'POST', [{prop_id, text, author: author||'menage', reservation_code: reservation_code||null}]);
    // Notifier
    const propName = prop_id==='12619011' ? 'Suite Illiberis' : 'Loft Cinema';
    if(author==='owner'){
      // Propriétaire → notifier femme de ménage via push
      await sendPushNotif('📝 Note propriétaire', propName+': '+text, '/menage', 'note-owner');
    } else {
      // Femme de ménage → notifier propriétaire via push
      await sendPushNotif('📝 Note ménage', propName+': '+text, '/mobile', 'note-menage');
    }
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/note-delete', async function(req, res) {
  try {
    const {id} = req.body;
    if(!id) return res.status(400).json({error:'Missing id'});
    await supaFetch('menage_notes?id=eq.'+encodeURIComponent(id), 'DELETE');
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ===== MESSAGERIE PAR LOGEMENT =====
app.get('/messages-list', async function(req, res) {
  try {
    const prop = req.query.prop;
    let path = 'messages?select=*&order=created_at.asc&limit=200';
    if(prop) path = 'messages?prop_id=eq.'+encodeURIComponent(prop)+'&select=*&order=created_at.asc&limit=200';
    const messages = await supaFetch(path);
    res.json({ok:true, messages});
  } catch(e) { res.json({ok:false, messages:[]}); }
});

app.post('/message-send', async function(req, res) {
  try {
    const {prop_id, text, author} = req.body;
    if(!prop_id || !text || !author) return res.status(400).json({error:'Missing fields'});
    await supaFetch('messages', 'POST', [{prop_id, text, author}]);
    const propName = prop_id==='12619011' ? 'Suite Illiberis' : (prop_id==='12619012' ? 'Loft Cinema' : 'Général');
    if(author==='owner'){
      await sendPushNotif('💬 '+propName, text, '/menage?msg='+prop_id, 'msg-'+prop_id, 'menage');
    } else {
      await sendPushNotif('💬 '+propName, text, '/mobile?msg='+prop_id, 'msg-'+prop_id, 'owner');
    }
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/message-delete', async function(req, res) {
  try {
    const {id} = req.body;
    if(!id) return res.status(400).json({error:'Missing id'});
    await supaFetch('messages?id=eq.'+encodeURIComponent(id), 'DELETE');
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/revenue', function(req, res) {
  res.sendFile(__dirname+'/revenue.html');
});

app.get('/messagerie', function(req, res) {
  res.sendFile(__dirname+'/messagerie.html');
});

app.get('/tarifs-mobile', function(req, res) {
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.sendFile(__dirname+'/tarifs-mobile.html');
});

app.get('/menage-app', function(req, res) {
  res.sendFile(__dirname + '/menage-app.html');
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
// DIAGNOSTIC détaillé de la détection d'annulation
app.get('/debug-detection', async function(req, res) {
  try {
    // Récupérer les résas de l'API Hostex (comme la sync)
    let allRes = [];
    for (let page = 1; page <= 10; page++) {
      const data = await hostexGet('/reservations?page_size=50&page=' + page + '&sort=check_in_date&sort_order=desc');
      const list = (data && data.data && data.data.reservations) || [];
      if (!list.length) break;
      allRes = allRes.concat(list);
      if (list.length < 50) break;
    }
    const apiCodes = allRes.map(r => {
      let code = r.reservation_code || r.id || '';
      if (code.startsWith('0-')) code = code.split('-')[1];
      if (code.match(/-ic[a-z0-9]+$/) || code.match(/-id[a-z0-9]+$/)) code = code.replace(/-ic[a-z0-9]+$/, '').replace(/-id[a-z0-9]+$/, '');
      return code;
    });
    const existing = await getDB();
    const todayStr = new Date().toISOString().slice(0, 10);
    const futureInDB = existing.filter(r => r.status !== 'cancelled' && r.check_in_date && r.check_in_date >= todayStr);
    const futureInApi = allRes.filter(r => r.status !== 'cancelled' && r.check_in_date && r.check_in_date >= todayStr);
    const remiInDB = existing.find(r => (r.guest_name || '').toLowerCase().includes('remi'));
    res.json({
      today: todayStr,
      total_api: allRes.length,
      total_db: existing.length,
      futureInDB_count: futureInDB.length,
      futureInApi_count: futureInApi.length,
      apiSeemsComplete: futureInDB.length === 0 || futureInApi.length >= Math.floor(futureInDB.length / 2),
      remi_in_db: remiInDB ? { code: remiInDB.reservation_code, status: remiInDB.status, checkin: remiInDB.check_in_date } : null,
      remi_code_in_api: remiInDB ? apiCodes.includes(remiInDB.reservation_code) : null,
      remi_checkin_future: remiInDB ? (remiInDB.check_in_date >= todayStr) : null,
      sample_api_codes: apiCodes.slice(0, 5)
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Déclenche la vraie sync Supabase (avec détection annulations) à la demande
app.get('/force-sync', async function(req, res) {
  try {
    await syncHostexToSupabase();
    res.json({ ok: true, message: 'Sync Supabase terminée (voir logs pour détails annulations)' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DEBUG : comparer API Hostex vs Supabase pour un client (ex: /debug-cancel?q=remi)
app.get('/debug-cancel', async function(req, res) {
  try {
    const q = (req.query.q || '').toLowerCase();
    if (!q) return res.json({ error: 'ajouter ?q=nom_du_client' });
    let apiMatches = [];
    for (let page = 1; page <= 10; page++) {
      const data = await hostexGet('/reservations?page_size=50&page=' + page + '&sort=check_in_date&sort_order=desc');
      const list = (data && data.data && data.data.reservations) || [];
      if (!list.length) break;
      list.forEach(function(r) {
        if ((r.guest_name || '').toLowerCase().includes(q)) {
          apiMatches.push({ code: r.reservation_code || r.id, guest: r.guest_name, status: r.status, check_in: r.check_in_date, check_out: r.check_out_date, channel: r.channel_type });
        }
      });
      if (list.length < 50) break;
    }
    let supaRows = [];
    try {
      supaRows = await supaFetch('reservations?select=reservation_code,guest_name,status,check_in_date,check_out_date,channel_type&guest_name=ilike.*' + encodeURIComponent(q) + '*');
    } catch(e2) { supaRows = [{ error: e2.message }]; }
    res.json({ recherche: q, api_hostex: apiMatches, base_supabase: supaRows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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

app.post('/test-push', async function(req, res) {
  const prop = 'Suite Illiberis';
  const msgOwner = prop + ' · Airbnb · 320€\nArrivée 2026-06-15 (3 nuits)\nJean Dupont';
  const msgMenage = prop + '\nJean Dupont · 3 nuits\nArrivée le 2026-06-15 · Ménage le 2026-06-18';
  await sendPushNotif('🏠 Nouvelle réservation !', msgOwner, '/mobile', 'test-resa', 'owner');
  await sendPushNotif('🏠 Nouvelle arrivée à préparer', msgMenage, '/menage', 'test-resa', 'menage');
  res.json({ok: true, subscribers: pushSubscriptions.length});
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

try {
  require('./boutique')(app, sendPushNotif);
  console.log('Boutique chargee OK');
} catch(eBoutique) {
  console.error('Boutique non chargee (serveur continue):', eBoutique.message);
}

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
      // Détecter les nouvelles réservations — bookées dans les 30 dernières minutes
      const existing = await getDB();
      const existingCodes = new Set(existing.map(r => r.reservation_code));
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const newRes = toSave.filter(r => {
        // Nouvelle si pas dans Supabase OU bookée récemment
        const isNew = !existingCodes.has(r.reservation_code);
        const isRecent = r.booked_at && r.booked_at > thirtyMinAgo;
        return (isNew || isRecent) && r.status !== 'cancelled';
      });

      // === DÉTECTION DES ANNULATIONS ===
      // Cas 1 : Hostex renvoie le statut 'cancelled' pour une résa qui était active en base
      const cancelledNow = [];
      const existingByCode = {};
      existing.forEach(r => { existingByCode[r.reservation_code] = r; });
      toSave.forEach(r => {
        const prev = existingByCode[r.reservation_code];
        if (r.status === 'cancelled' && prev && prev.status && prev.status !== 'cancelled') {
          cancelledNow.push(r);
        }
      });
      // Cas 2 DÉSACTIVÉ : la détection par "disparition de l'API" est trop risquée car
      // l'API Hostex renvoie des listes partielles/variables — cela a annulé des résas valides.
      // On ne conserve QUE le Cas 1 (statut 'cancelled' explicite renvoyé par Hostex), fiable.
      const disappeared = [];
      // (aucune détection par disparition)

      await supaSave(toSave);
      invalidateCache();
      console.log('Auto-sync: ' + toSave.length + ' synced, ' + newRes.length + ' new, ' + cancelledNow.length + ' cancelled');

      // Notifs d'ANNULATION (propriétaire + ménage)
      // Garde-fou anti-spam : si beaucoup d'annulations détectées d'un coup (ex: premier
      // passage qui rattrape l'historique), on n'envoie PAS de notif individuelle pour
      // éviter le déluge — on log seulement. Les notifs ne partent que pour 1-3 annulations.
      if (cancelledNow.length > 0 && cancelledNow.length <= 3) {
        for (const r of cancelledNow) {
          const prop = String(r.property_id) === '12619011' ? 'Suite Illiberis' : 'Loft Cinema';
          const ch = r.channel_type === 'airbnb' ? 'Airbnb' : (r.channel_type === 'booking.com' || r.channel_type === 'booking' ? 'Booking' : (r.channel_type || ''));
          const msgCancel = prop + ' · ' + ch + '\n' + (r.guest_name || '') + '\nArrivée prévue le ' + (r.check_in_date || '') + ' — ANNULÉE';
          await sendPushNotif('❌ Réservation annulée', msgCancel, '/mobile', 'cancel-resa', 'owner');
          await sendPushNotif('❌ Séjour annulé', prop + '\n' + (r.guest_name || '') + '\nLe ménage prévu le ' + (r.check_out_date || '') + ' est annulé', '/menage', 'cancel-resa', 'menage');
        }
      } else if (cancelledNow.length > 3) {
        console.log('Anti-spam: ' + cancelledNow.length + ' annulations détectées, notifications groupées non envoyées');
      }


      // Notifs pour les nouvelles réservations
      // Garde-fou anti-spam : on ne notifie QUE les résas réellement nouvelles (absentes de
      // la base au moment de la sync), pas celles "récentes" qui pourraient être re-notifiées
      // à chaque passage. Et jamais plus de 3 d'un coup.
      const trulyNew = newRes.filter(r => !existingCodes.has(r.reservation_code));
      if (trulyNew.length > 0 && trulyNew.length <= 3) {
        for (const r of trulyNew) {
          const prop = r.property_id === '12619011' ? 'Suite Illiberis' : 'Loft Cinema';
          const ch = r.channel_type === 'airbnb' ? 'Airbnb' : 'Booking';
          const price = r.total_price ? Math.round(r.total_price) + '€' : '';
          const ciDate = new Date((r.check_in_date||'') + 'T12:00:00');
          const coDate = new Date((r.check_out_date||'') + 'T12:00:00');
          const nights = Math.round((coDate - ciDate) / 86400000);
          const today = new Date(); today.setHours(12,0,0,0);
          const joursAvant = Math.round((ciDate - today) / 86400000);
          function decompteTxt(dateObj, motif){
            const j = Math.round((dateObj - today) / 86400000);
            if (isNaN(j)) return motif;
            if (j < 0) return motif + ' pass\u00e9' + (motif === 'Arriv\u00e9e' ? 'e' : '');
            if (j === 0) return motif + ' aujourd\'hui';
            if (j === 1) return motif + ' demain';
            return motif + ' dans ' + j + ' jours';
          }
          const decompteArrivee = decompteTxt(ciDate, 'Arriv\u00e9e');
          const decompteMenage = decompteTxt(coDate, 'M\u00e9nage');
          const msgOwner = prop + ' · ' + ch + ' · ' + price + '\n' + decompteArrivee + ' (' + (r.check_in_date||'') + ') · ' + nights + ' nuits\n' + (r.guest_name||'');
          await sendPushNotif('🏠 Nouvelle réservation !', msgOwner, '/mobile', 'new-resa', 'owner');
          const msgMenage = prop + '\n' + (r.guest_name||'') + ' · ' + nights + ' nuits\n' + decompteArrivee + ' (' + (r.check_in_date||'') + ')\n' + decompteMenage + ' (' + (r.check_out_date||'') + ')';
          await sendPushNotif('🏠 Nouvelle arrivée à préparer', msgMenage, '/menage', 'new-resa', 'menage');
        }
      } else if (trulyNew.length > 3) {
        console.log('Anti-spam: ' + trulyNew.length + ' nouvelles résas, notifications non envoyées');
      }
    }
  } catch(e) {
    console.error('Auto-sync error:', e.message);
  }
}

// Charger les abonnements push au démarrage
loadSubs().catch(console.error);

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
