const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

const HOSTEX_TOKEN = process.env.HOSTEX_TOKEN || '';
const HOSTEX_BASE  = 'https://api.hostex.io/v3';

app.use(cors());
app.use(express.json());

app.all('/api/*', async (req, res) => {
  const hostexPath = req.path.replace(/^\/api/, '');
  const qs = new URLSearchParams(req.query).toString();
  const url = `${HOSTEX_BASE}${hostexPath}${qs ? '?' + qs : ''}`;

  try {
    const options = {
      method : req.method,
      headers: {
        'Hostex-Access-Token': HOSTEX_TOKEN,
        'Content-Type'       : 'application/json',
      },
    };
    if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
      options.body = JSON.stringify(req.body);
    }
    const hostexRes = await fetch(url, options);
    const data      = await hostexRes.json();
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
