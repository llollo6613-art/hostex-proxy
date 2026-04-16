const express = require('express');
const cors    = require('cors');
const app     = express();
const PORT    = process.env.PORT || 8080;
const HOSTEX_TOKEN = process.env.HOSTEX_TOKEN || '';
const HOSTEX_BASE  = 'https://api.hostex.io/v3';
app.use(cors());
app.use(express.json());
async function hostexGet(path) {
  const r = await fetch(HOSTEX_BASE + path, {
    headers: { 'Hostex-Access-Token': HOSTEX_TOKEN, 'Content-Type': 'application/json' },
  });
  return r.json();
}
app.get('/all-reservations', async (req, res) => {
  try {
    const allReservations = [];
    const seen = new Set();
    const now = new Date();
    const slices = [];
    for (let offset = -36; offset <= 24; offset += 1) {
      const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      const end   = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
      slices.push({ from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) });
    }
    for (let i = 0; i < slices.length; i += 6) {
      const batch = slices.slice(i, i + 6);
      const results = await Promise.all(
        batch.map(s => hostexGet(`/reservations?check_in_date_min=${s.from}&check_in_date_max=${s.to}&page_size=50`).catch(() => null))
      );
      for (const data of results) {
        if (!data?.data?.reservations) continue;
        for (const r of data.data.reservations) {
          const key = r.reservation_code || r.id;
          if (!seen.has(key)) { seen.add(key); allReservations.push(r); }
        }
      }
    }
    allReservations.sort((a, b) => (b.check_in_date || '').localeCompare(a.check_in_date || ''));
    console.log(`✓ all-reservations : ${allReservations.length} réservations chargées`);
    res.json({ error_code: 200, error_msg: 'Done.', data: { reservations: allReservations, total: allReservations.length } });
  } catch (err) {
    res.status(500).json({ error: 'Error', message: err.message });
  }
});
app.all('/api/*', async (req, res) => {
  const hostexPath = req.path.replace(/^\/api/, '');
  const qs = new URLSearchParams(req.query).toString();
  const url = `${HOSTEX_BASE}${hostexPath}${qs ? '?' + qs : ''}`;
  try {
    const options = { method: req.method, headers: { 'Hostex-Access-Token': HOSTEX_TOKEN, 'Content-Type': 'application/json' } };
    if (['POST', 'PATCH', 'PUT'].includes(req.method)) options.body = JSON.stringify(req.body);
    const hostexRes = await fetch(url, options);
    const data = await hostexRes.json();
    res.status(hostexRes.status).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Proxy error', message: err.message });
  }
});
app.get('/health', (_, res) => {
  res.json({ status: 'ok', token_set: !!HOSTEX_TOKEN, timestamp: new Date().toISOString() });
});
app.listen(PORT, () => {
  console.log(`✓ Proxy démarré sur le port ${PORT}`);
  console.log(`  Token configuré : ${HOSTEX_TOKEN ? 'OUI' : 'NON'}`);
});
