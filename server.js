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

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { reservations: {}, last_sync: null }; }
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db));
}

async function hostexGet(path) {
  const r = await fetch(HOSTEX_BASE + path, {
    headers: { 'Hostex-Access-Token': HOSTEX_TOKEN, 'Content-Type': 'application/json' },
  });
  return r.json();
}

async function syncReservations() {
  const db = loadDB();
  const now = new Date();
  let added = 0;

  // Tranches d'1 mois : 36 mois en arrière → 24 mois en avant
  for (let offset = -36; offset <= 24; offset++) {
    const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const end   = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
    const from  = start.toISOString().slice(0, 10);
    const to    = end.toISOString().slice(0, 10);
    try {
      const data = await hostexGet(`/reservations?check_in_date_min=${from}&check_in_date_max=${to}&page_size=50`);
      for (const r of data?.data?.reservations || []) {
        const key = r.reservation_code || r.id;
        if (!db.reservations[key]) { db.reservations[key] = r; added++; }
        else db.reservations[key] = r; // mise à jour
      }
    } catch {}
    await new Promise(r => setTimeout(r, 100)); // pause anti-rate-limit
  }

  db.last_sync = now.toISOString();
  db.total = Object.keys(db.reservations).length;
  saveDB(db);
  console.log(`✓ Sync : ${added} nouvelles, ${db.total} total`);
  return db;
}

// ─── Sync manuel ou automatique ──────────────────────────────────
app.post('/sync', async (req, res) => {
  const db = await syncReservations();
  res.json({ ok: true, total: db.total, last_sync: db.last_sync });
});

// ─── Cron endpoint (appelé par Railway Cron toutes les 2 semaines)
app.get('/cron-sync', async (req, res) => {
  const secret = req.headers['x-cron-secret'];
  if (secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const db = await syncReservations();
  res.json({ ok: true, total: db.total });
});

// ─── Toutes les réservations (JSON stocké + API live fusionnés) ──
app.get('/all-res
cd ~/projets/locatif/hostex-proxy
cat > server.js << 'EOF'
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

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { reservations: {}, last_sync: null }; }
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db));
}

async function hostexGet(path) {
  const r = await fetch(HOSTEX_BASE + path, {
    headers: { 'Hostex-Access-Token': HOSTEX_TOKEN, 'Content-Type': 'application/json' },
  });
  return r.json();
}

async function syncReservations() {
  const db = loadDB();
  const now = new Date();
  let added = 0;

  // Tranches d'1 mois : 36 mois en arrière → 24 mois en avant
  for (let offset = -36; offset <= 24; offset++) {
    const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const end   = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
    const from  = start.toISOString().slice(0, 10);
    const to    = end.toISOString().slice(0, 10);
    try {
      const data = await hostexGet(`/reservations?check_in_date_min=${from}&check_in_date_max=${to}&page_size=50`);
      for (const r of data?.data?.reservations || []) {
        const key = r.reservation_code || r.id;
        if (!db.reservations[key]) { db.reservations[key] = r; added++; }
        else db.reservations[key] = r; // mise à jour
      }
    } catch {}
    await new Promise(r => setTimeout(r, 100)); // pause anti-rate-limit
  }

  db.last_sync = now.toISOString();
  db.total = Object.keys(db.reservations).length;
  saveDB(db);
  console.log(`✓ Sync : ${added} nouvelles, ${db.total} total`);
  return db;
}

// ─── Sync manuel ou automatique ──────────────────────────────────
app.post('/sync', async (req, res) => {
  const db = await syncReservations();
  res.json({ ok: true, total: db.total, last_sync: db.last_sync });
});

// ─── Cron endpoint (appelé par Railway Cron toutes les 2 semaines)
app.get('/cron-sync', async (req, res) => {
  const secret = req.headers['x-cron-secret'];
  if (secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const db = await syncReservations();
  res.json({ ok: true, total: db.total });
});

// ─── Toutes les réservations (JSON stocké + API live fusionnés) ──
app.get('/all-reservations', async (req, res) => {
  try {
    const db = loadDB();
    const stored = Object.values(db.reservations);

    // API live pour les 20 plus récentes
    const live = await hostexGet('/reservations?page_size=50').catch(() => ({ data: { reservations: [] } }));
    const liveRes = live?.data?.reservations || [];

    // Fusion et déduplication
    const map = {};
    for (const r of stored) map[r.reservation_code || r.id] = r;
    for (const r of liveRes) map[r.reservation_code || r.id] = r; // live écrase si plus récent

    const all = Object.values(map).sort((a, b) => (b.check_in_date || '').localeCompare(a.check_in_date || ''));

    res.json({
      error_code: 200,
      error_msg: 'Done.',
      data: { reservations: all, total: all.length, last_sync: db.last_sync }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Proxy générique ─────────────────────────────────────────────
app.all('/api/*', async (req, res) => {
  const hostexPath = req.path.replace(/^\/api/, '');
  const qs = new URLSearchParams(req.query).toString();
  const url = `${HOSTEX_BASE}${hostexPath}${qs ? '?' + qs : ''}`;
  try {
    const options = { method: req.method, headers: { 'Hostex-Access-Token': HOSTEX_TOKEN, 'Content-Type': 'application/json' } };
    if (['POST', 'PATCH', 'PUT'].includes(req.method)) options.body = JSON.stringify(req.body);
    const r = await fetch(url, options);
    res.status(r.status).json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Health check ────────────────────────────────────────────────
app.get('/health', (_, res) => {
  const db = loadDB();
  res.json({ status: 'ok', token_set: !!HOSTEX_TOKEN, reservations_stored: db.total || 0, last_sync: db.last_sync });
});

app.listen(PORT, async () => {
  console.log(`✓ Proxy démarré sur le port ${PORT}`);
  // Sync automatique au démarrage si pas encore fait
  const db = loadDB();
  if (!db.last_sync) {
    console.log('Première sync au démarrage...');
    syncReservations().catch(console.error);
  }
});
