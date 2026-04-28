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
app.use(express.json());

// ─── Servir l'app HTML ───────────────────────────────────────────────
app.get('/', function(req, res) {
  const htmlPath = path.join(__dirname, 'app.html');
  if (fs.existsSync(htmlPath)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control','no-store, no-cache, must-revalidate');
  res.set('Pragma','no-cache');
  res.sendFile(htmlPath);
  } else {
    res.send('<h2>app.html manquant</h2>');
  }
});

// ─── Storage JSON ────────────────────────────────────────────────────
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

async function doSync() {
  const db = loadDB();
  const now = new Date();
  let added = 0;
  for (let o = -36; o <= 24; o++) {
    const s = new Date(now.getFullYear(), now.getMonth() + o, 1);
    const e = new Date(now.getFullYear(), now.getMonth() + o + 1, 0);
    const from = s.toISOString().slice(0, 10);
    const to   = e.toISOString().slice(0, 10);
    try {
      const d = await hostexGet('/reservations?check_in_date_min=' + from + '&check_in_date_max=' + to + '&page_size=50');
      const list = (d && d.data && d.data.reservations) ? d.data.reservations : [];
      for (const r of list) {
        const k = r.reservation_code || r.id;
        if (!db.reservations[k]) added++;
        db.reservations[k] = r;
      }
    } catch (e2) {}
    await new Promise(function(res) { setTimeout(res, 120); });
  }
  db.last_sync = now.toISOString();
  db.total = Object.keys(db.reservations).length;
  saveDB(db);
  return db;
}

app.post('/sync', async function(req, res) {
  try { const db = await doSync(); res.json({ ok: true, total: db.total, last_sync: db.last_sync }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/cron-sync', async function(req, res) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });
  try { const db = await doSync(); res.json({ ok: true, total: db.total }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/all-reservations', async function(req, res) {
  try {
    const db = loadDB();
    const stored = Object.values(db.reservations);
    let liveRes = [];
    try {
      const live = await hostexGet('/reservations?page_size=200&sort=check_in_date&sort_order=desc');
      liveRes = (live && live.data && live.data.reservations) ? live.data.reservations : [];
    } catch (e) {}
    const map = {};
    for (const r of stored) map[r.reservation_code || r.id] = r;
    // API overrides CSV - same key or newer data
    for (const r of liveRes) map[r.reservation_code || r.id] = r;
    const all = Object.values(map).sort(function(a, b) {
      return (b.check_in_date || '').localeCompare(a.check_in_date || '');
    });
    res.json({ error_code: 200, error_msg: 'Done.', data: { reservations: all, total: all.length, last_sync: db.last_sync } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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

app.post('/api-claude', async function(req, res) {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const data = await r.json();
    res.json(data);
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/health', function(req, res) {
  const db = loadDB();
  res.json({ status: 'ok', token_set: !!HOSTEX_TOKEN, reservations_stored: db.total || 0, last_sync: db.last_sync, timestamp: new Date().toISOString() });
});

app.listen(PORT, function() {
  console.log('Proxy + App sur port ' + PORT);
  const db = loadDB();
  if (!db.last_sync) { console.log('First sync...'); doSync().catch(console.error); }
});
