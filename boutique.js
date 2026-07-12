// ═══════════════════════════════════════════════════════════════
// BOUTIQUE EXTRAS — Module pour hostex-proxy
// Pages : /boutique (voyageurs) et /boutique-admin (gestion, PIN)
// API   : /boutique-api/...
// ═══════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');
const express = require('express');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

// ——— À PERSONNALISER ———
const PIN_ADMIN = process.env.BOUTIQUE_PIN || '2026';
const NTFY_TOPIC = process.env.NTFY_TOPIC || '';   // ton topic ntfy.sh existant
const LOGEMENTS = ['Suite Illiberis', 'Loft Cinema Illiberis', 'Autre logement'];

const CATEGORIES = [
  { id: 'horaires',    label: 'Horaires flexibles' },
  { id: 'gourmand',    label: 'Gourmandises & terroir' },
  { id: 'celebration', label: 'Célébrations' },
  { id: 'confort',     label: 'Confort & services' },
  { id: 'experience',  label: 'Expériences' },
];

// Notification ntfy.sh
async function notifier(titre, message) {
  if (!NTFY_TOPIC) return;
  try {
    await fetch('https://ntfy.sh/' + NTFY_TOPIC, {
      method: 'POST',
      headers: { 'Title': titre, 'Priority': 'high', 'Tags': 'shopping_cart' },
      body: message,
    });
  } catch (e) { console.error('ntfy erreur:', e.message); }
}

// Middleware PIN admin
function verifPin(req, res, next) {
  if (req.headers['x-pin'] === PIN_ADMIN) return next();
  res.status(401).json({ error: 'PIN invalide' });
}

module.exports = function (app, sendPushNotif) {

  // ═══════════ API PUBLIQUE ═══════════

  // Catalogue actif
  app.get('/boutique-api/extras', async (req, res) => {
    const { data, error } = await supabase.from('extras')
      .select('*').eq('actif', true).order('categorie').order('prix');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  // Nouvelle commande (décrémente le stock)
  app.post('/boutique-api/commande', express.json(), async (req, res) => {
    const { client, logement, date_arrivee, items } = req.body;
    if (!client || !items || !items.length) return res.status(400).json({ error: 'Données manquantes' });

    // Vérification + décrément du stock
    for (const it of items) {
      const { data: ex } = await supabase.from('extras').select('stock, nom').eq('id', it.extra_id).single();
      if (ex && ex.stock !== null) {
        if (ex.stock < it.qte) return res.status(409).json({ error: 'Stock insuffisant : ' + ex.nom });
        await supabase.from('extras').update({ stock: ex.stock - it.qte }).eq('id', it.extra_id);
      }
    }

    const total = items.reduce((s, i) => s + i.prix * i.qte, 0);
    const { data, error } = await supabase.from('commandes_extras')
      .insert({ client, logement, date_arrivee: date_arrivee || null, items, total, statut: 'nouvelle' })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });

    const detail = items.map(i => i.nom + ' x' + i.qte).join(', ');
    notifier('🛎️ Commande extras — ' + total + '€',
      client + ' (' + logement + ')' + (date_arrivee ? ' — arrivée ' + date_arrivee : '') + '\n' + detail);
    if (typeof sendPushNotif === 'function') {
      try {
        await sendPushNotif('🛎️ Commande extras — ' + total + '€',
          client + ' (' + logement + ') : ' + detail, '/boutique-admin', 'boutique', 'owner');
      } catch (ePush) { console.error('Push boutique:', ePush.message); }
    }

    res.json({ ok: true, id: data.id, total });
  });

  // ═══════════ API ADMIN (PIN requis) ═══════════

  app.get('/boutique-api/admin/extras', verifPin, async (req, res) => {
    const { data, error } = await supabase.from('extras').select('*').order('categorie').order('nom');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  app.post('/boutique-api/admin/extras', express.json(), verifPin, async (req, res) => {
    const { nom, description, categorie, prix, stock, seuil } = req.body;
    const { data, error } = await supabase.from('extras')
      .insert({ nom, description: description || '', categorie, prix, stock: stock === '' || stock == null ? null : stock, seuil: seuil || 2 })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  app.put('/boutique-api/admin/extras/:id', express.json(), verifPin, async (req, res) => {
    const maj = { ...req.body };
    if (maj.stock === '' || maj.stock === undefined) maj.stock = null;
    const { error } = await supabase.from('extras').update(maj).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  });

  app.delete('/boutique-api/admin/extras/:id', verifPin, async (req, res) => {
    const { error } = await supabase.from('extras').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  });

  app.get('/boutique-api/admin/commandes', verifPin, async (req, res) => {
    const { data, error } = await supabase.from('commandes_extras').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  // Changement de statut (annulation = remise en stock)
  app.put('/boutique-api/admin/commandes/:id', express.json(), verifPin, async (req, res) => {
    const { statut } = req.body;
    const { data: cmd } = await supabase.from('commandes_extras').select('*').eq('id', req.params.id).single();
    if (!cmd) return res.status(404).json({ error: 'Commande introuvable' });

    if (statut === 'annulee' && cmd.statut !== 'annulee') {
      for (const it of cmd.items) {
        const { data: ex } = await supabase.from('extras').select('stock').eq('id', it.extra_id).single();
        if (ex && ex.stock !== null) {
          await supabase.from('extras').update({ stock: ex.stock + it.qte }).eq('id', it.extra_id);
        }
      }
    }
    const { error } = await supabase.from('commandes_extras').update({ statut }).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  });

  // ═══════════ PAGE VOYAGEURS : /boutique ═══════════

  app.get('/boutique', (req, res) => {
    res.send(PAGE_BOUTIQUE);
  });

  // ═══════════ PAGE GESTION : /boutique-admin ═══════════

  app.get('/boutique-admin', (req, res) => {
    res.send(PAGE_ADMIN);
  });
};

// ═══════════════════════════════════════════════════════════════
// HTML — page voyageurs
// ═══════════════════════════════════════════════════════════════

const STYLE_COMMUN = `
<style>
  :root { --sand:#F6F1E8; --ink:#23262C; --garnet:#7D2231; --gold:#C6A15B; --goldpale:#EFE3CC; --olive:#5F6F52; --white:#FFFDF9; --line:#E3D9C8; --muted:#8A8375; }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--sand); color: var(--ink); font-family: 'Jost', 'Avenir', sans-serif; }
  h1, .serif { font-family: 'Cormorant Garamond', Georgia, serif; }
  header { background: var(--garnet); color: var(--white); text-align: center; padding: 26px 16px 22px; }
  header .sur { font-size: 11px; letter-spacing: .35em; text-transform: uppercase; color: var(--gold); margin-bottom: 6px; }
  header h1 { font-size: 32px; font-weight: 500; }
  header .trait { width: 48px; height: 1px; background: var(--gold); margin: 12px auto 0; }
  main { max-width: 920px; margin: 0 auto; padding: 24px 14px 70px; }
  .btn { background: var(--garnet); color: var(--white); border: none; border-radius: 2px; padding: 12px 22px; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; cursor: pointer; font-family: inherit; }
  .ghost { background: transparent; color: var(--garnet); border: 1px solid var(--garnet); border-radius: 2px; padding: 7px 14px; font-size: 12px; cursor: pointer; font-family: inherit; }
  .ghost.on { background: var(--garnet); color: var(--white); }
  input, select { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 2px; background: var(--white); font-size: 14px; font-family: inherit; color: var(--ink); }
  .carte { background: var(--white); border: 1px solid var(--line); padding: 16px; }
  footer { text-align: center; padding: 16px; font-size: 11px; color: var(--muted); letter-spacing: .1em; }
  @media (max-width: 600px) { header h1 { font-size: 26px; } }
</style>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600&family=Jost:wght@300;400;500;600&display=swap" rel="stylesheet">
`;

const PAGE_BOUTIQUE = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>La Conciergerie — Nuits Insolites</title>
${STYLE_COMMUN}
<style>
  @keyframes fadeUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
  .hero { text-align: center; padding: 30px 16px 8px; }
  .hero .accroche { font-family: 'Cormorant Garamond', serif; font-style: italic; font-size: 21px; color: var(--ink); max-width: 560px; margin: 0 auto; line-height: 1.5; animation: fadeUp .6s ease both; }
  .promesses { display: flex; flex-wrap: wrap; gap: 6px 22px; justify-content: center; margin: 16px auto 4px; animation: fadeUp .6s .15s ease both; }
  .promesses span { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
  .promesses b { color: var(--gold); font-weight: 400; margin-right: 6px; }
  .filtres { display: flex; gap: 8px; overflow-x: auto; padding: 18px 4px 14px; -webkit-overflow-scrolling: touch; animation: fadeUp .6s .25s ease both; }
  .chip { flex: 0 0 auto; display: flex; align-items: center; gap: 7px; background: var(--white); color: var(--ink); border: 1px solid var(--line); border-radius: 999px; padding: 9px 16px; font-size: 13px; cursor: pointer; font-family: inherit; transition: all .2s; }
  .chip .ic { color: var(--gold); }
  .chip .n { font-size: 11px; color: var(--muted); }
  .chip.on { background: var(--garnet); color: var(--white); border-color: var(--garnet); }
  .chip.on .ic, .chip.on .n { color: var(--goldpale); }
  .grille { display: grid; grid-template-columns: repeat(auto-fill, minmax(255px, 1fr)); gap: 13px; }
  .extra { background: var(--white); border: 1px solid var(--line); padding: 17px 17px 15px; display: flex; flex-direction: column; animation: fadeUp .5s ease both; transition: transform .2s, box-shadow .2s, border-color .2s; position: relative; }
  .extra:hover { transform: translateY(-3px); box-shadow: 0 10px 26px rgba(35,38,44,.09); }
  .extra.aupanier { border-color: var(--gold); }
  .extra .cat { font-size: 10px; letter-spacing: .2em; text-transform: uppercase; color: var(--gold); margin-bottom: 5px; }
  .extra .nom { font-family: 'Cormorant Garamond', serif; font-size: 19px; font-weight: 600; line-height: 1.25; }
  .extra .desc { font-size: 13px; color: var(--muted); line-height: 1.55; margin: 7px 0 12px; flex: 1; }
  .extra .bas { display: flex; align-items: center; justify-content: space-between; }
  .extra .prix { font-family: 'Cormorant Garamond', serif; font-size: 21px; color: var(--garnet); }
  .rare { position: absolute; top: 12px; right: 12px; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--garnet); background: var(--goldpale); padding: 3px 8px; }
  .qte { display: flex; align-items: center; gap: 10px; }
  .barre { position: fixed; left: 0; right: 0; bottom: 0; background: var(--garnet); color: var(--white); display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 13px 18px; box-shadow: 0 -6px 22px rgba(35,38,44,.25); animation: fadeUp .3s ease both; z-index: 50; }
  .barre .r { font-size: 14px; }
  .barre .r b { font-family: 'Cormorant Garamond', serif; font-size: 19px; margin-left: 8px; }
  .barre button { background: var(--gold); color: var(--ink); border: none; border-radius: 2px; padding: 10px 18px; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; cursor: pointer; font-family: inherit; }
  .panier { margin-top: 34px; background: var(--white); border: 1px solid var(--gold); padding: 24px 20px; scroll-margin-top: 20px; animation: fadeUp .4s ease both; }
  .ligne { display: flex; justify-content: space-between; font-size: 14px; padding: 6px 0; border-bottom: 1px dashed var(--line); }
  .total { display: flex; justify-content: space-between; padding: 12px 0 16px; font-family: 'Cormorant Garamond', serif; font-size: 19px; }
  .form { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin-bottom: 14px; }
  .ok { background: var(--white); border: 1px solid var(--line); padding: 36px 26px; text-align: center; max-width: 500px; margin: 40px auto; animation: fadeUp .5s ease both; }
  .note { font-size: 12px; color: var(--muted); text-align: center; margin-top: 10px; }
  .vide, .erreur { text-align: center; color: var(--muted); font-size: 14px; padding: 40px 16px; }
  .erreur { color: var(--garnet); }
  main { padding-bottom: 110px; }
</style>
</head>
<body>
<header>
  <div class="sur">Nuits Insolites · Perpignan</div>
  <h1>La Conciergerie</h1>
  <div class="trait"></div>
</header>
<main>
  <div class="hero">
    <p class="accroche">Composez votre séjour avant d'arriver&nbsp;: tout sera prêt en poussant la porte.</p>
    <div class="promesses">
      <span><b>✦</b>Préparé avant votre arrivée</span>
      <span><b>✦</b>Producteurs du Roussillon</span>
      <span><b>✦</b>Paiement sécurisé, rien débité aujourd'hui</span>
    </div>
  </div>
  <div id="app"><p class="vide">Ouverture de la conciergerie…</p></div>
</main>
<footer>NUITS INSOLITES · CONCIERGERIE PRIVÉE · PERPIGNAN</footer>
<script>
var CATS = ${JSON.stringify(CATEGORIES)};
var ICONES = { horaires: '◷', gourmand: '✦', celebration: '❋', confort: '❖', experience: '✧' };
var LOGEMENTS = ${JSON.stringify(LOGEMENTS)};
var extras = [], panier = {}, filtre = 'tous';
window._nom = ''; window._arr = ''; window._log = LOGEMENTS[0];

function eur(n) { return Number(n).toFixed(2).replace('.', ',').replace(',00', '') + ' \u20AC'; }
function catLabel(id) { var c = CATS.find(function(x){ return x.id === id; }); return c ? c.label : id; }

function charger() {
  fetch('/boutique-api/extras')
    .then(function(r){ if (r.ok === false) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(d){
      if (d.error) throw new Error(d.error);
      extras = d; rendre();
    })
    .catch(function(e){
      document.getElementById('app').innerHTML =
        '<p class="erreur">Le catalogue est momentanément indisponible.<br><small>' + e.message + '</small></p>';
    });
}

function rendre() {
  var lignes = Object.keys(panier).map(function(id){
    var e = extras.find(function(x){ return String(x.id) === String(id); });
    return e ? { e: e, qte: panier[id] } : null;
  }).filter(Boolean);
  var total = lignes.reduce(function(s, l){ return s + Number(l.e.prix) * l.qte; }, 0);
  var nbArticles = lignes.reduce(function(s, l){ return s + l.qte; }, 0);
  var visibles = extras.filter(function(e){ return filtre === 'tous' || e.categorie === filtre; });

  var h = '<div class="filtres">';
  h += '<button class="chip' + (filtre === 'tous' ? ' on' : '') + '" data-action="filtre" data-val="tous">Tout <span class="n">' + extras.length + '</span></button>';
  CATS.forEach(function(c){
    var n = extras.filter(function(e){ return e.categorie === c.id; }).length;
    if (n === 0) return;
    h += '<button class="chip' + (filtre === c.id ? ' on' : '') + '" data-action="filtre" data-val="' + c.id + '">';
    h += '<span class="ic">' + (ICONES[c.id] || '') + '</span>' + c.label + ' <span class="n">' + n + '</span></button>';
  });
  h += '</div>';

  if (visibles.length === 0) {
    h += '<p class="vide">Aucun extra dans cette catégorie pour le moment.</p>';
  }

  h += '<div class="grille">';
  visibles.forEach(function(e, i){
    var epuise = e.stock !== null && e.stock <= 0;
    var rare = e.stock !== null && e.stock > 0 && e.stock <= e.seuil;
    var qte = panier[e.id] || 0;
    h += '<div class="extra' + (qte ? ' aupanier' : '') + '" style="animation-delay:' + Math.min(i * 45, 400) + 'ms;' + (epuise ? 'opacity:.55;' : '') + '">';
    if (rare) h += '<span class="rare">Plus que ' + e.stock + '</span>';
    h += '<div class="cat">' + catLabel(e.categorie) + '</div>';
    h += '<div class="nom">' + e.nom + '</div>';
    h += '<div class="desc">' + (e.description || '') + '</div>';
    h += '<div class="bas"><span class="prix">' + eur(e.prix) + '</span>';
    if (epuise) {
      h += '<span style="font-size:12px;color:var(--muted)">Épuisé</span>';
    } else if (qte === 0) {
      h += '<button class="ghost" data-action="plus" data-id="' + e.id + '">Ajouter</button>';
    } else {
      var max = e.stock !== null && qte >= e.stock;
      h += '<span class="qte">';
      h += '<button class="ghost" data-action="moins" data-id="' + e.id + '">−</button>';
      h += '<b>' + qte + '</b>';
      h += '<button class="ghost" data-action="plus" data-id="' + e.id + '"' + (max ? ' disabled style="opacity:.4"' : '') + '>+</button>';
      h += '</span>';
    }
    h += '</div></div>';
  });
  h += '</div>';

  if (lignes.length) {
    h += '<div class="panier" id="panier">';
    h += '<div class="serif" style="font-size:22px;color:var(--garnet);margin-bottom:12px">Votre sélection</div>';
    lignes.forEach(function(l){
      h += '<div class="ligne"><span>' + l.e.nom + ' × ' + l.qte + '</span><span>' + eur(Number(l.e.prix) * l.qte) + '</span></div>';
    });
    h += '<div class="total"><span>Total</span><span style="color:var(--garnet)">' + eur(total) + '</span></div>';
    h += '<div class="form">';
    h += '<input id="f_nom" placeholder="Votre nom" value="' + window._nom.replace(/"/g, '&quot;') + '" oninput="window._nom=this.value">';
    h += '<select id="f_log" oninput="window._log=this.value">' + LOGEMENTS.map(function(l){ return '<option' + (window._log === l ? ' selected' : '') + '>' + l + '</option>'; }).join('') + '</select>';
    h += '<input id="f_arr" type="date" value="' + window._arr + '" oninput="window._arr=this.value">';
    h += '</div>';
    h += '<button class="btn" style="width:100%" data-action="envoyer">Envoyer ma demande — ' + eur(total) + '</button>';
    h += '<p class="note">Paiement sécurisé par lien envoyé après validation. Rien n\\'est débité maintenant.</p>';
    h += '</div>';
    h += '<div class="barre"><span class="r">' + nbArticles + ' article' + (nbArticles > 1 ? 's' : '') + '<b>' + eur(total) + '</b></span>';
    h += '<button data-action="voirpanier">Voir ma sélection</button></div>';
  }

  document.getElementById('app').innerHTML = h;
}

function envoyer() {
  var nom = (window._nom || '').trim();
  if (nom === '') { document.getElementById('f_nom').focus(); document.getElementById('f_nom').style.borderColor = 'var(--garnet)'; return; }
  var items = Object.keys(panier).map(function(id){
    var e = extras.find(function(x){ return String(x.id) === String(id); });
    return { extra_id: e.id, nom: e.nom, prix: Number(e.prix), qte: panier[id] };
  });
  fetch('/boutique-api/commande', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client: nom, logement: window._log, date_arrivee: window._arr || null, items: items })
  })
  .then(function(r){ return r.json(); })
  .then(function(d){
    if (d.error) { alert(d.error); charger(); return; }
    panier = {};
    document.getElementById('app').innerHTML =
      '<div class="ok"><div class="serif" style="font-size:25px;color:var(--garnet);margin-bottom:10px">Demande envoyée</div>' +
      '<p style="font-size:14px;line-height:1.7;color:var(--muted);margin-bottom:18px">Merci ' + nom +
      '. Votre sélection (' + eur(d.total) + ') a bien été transmise. Vous recevrez un lien de paiement sécurisé avant votre arrivée pour la confirmer.</p>' +
      '<button class="ghost" data-action="retour">Retour à la boutique</button></div>';
    window.scrollTo(0, 0);
  })
  .catch(function(){ alert('Erreur réseau, merci de réessayer.'); });
}

document.addEventListener('click', function(ev){
  var el = ev.target.closest('[data-action]');
  if (el === null) return;
  var action = el.getAttribute('data-action');
  var id = el.getAttribute('data-id');
  if (action === 'filtre') { filtre = el.getAttribute('data-val'); rendre(); }
  if (action === 'plus') { panier[id] = (panier[id] || 0) + 1; rendre(); }
  if (action === 'moins') { if (panier[id] > 1) { panier[id] -= 1; } else { delete panier[id]; } rendre(); }
  if (action === 'voirpanier') { var p = document.getElementById('panier'); if (p) p.scrollIntoView({ behavior: 'smooth' }); }
  if (action === 'envoyer') { envoyer(); }
  if (action === 'retour') { charger(); }
});

charger();
</script>
</body>
</html>`;

// ═══════════════════════════════════════════════════════════════
// HTML — page gestion (PIN)
// ═══════════════════════════════════════════════════════════════

const PAGE_ADMIN = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gestion Boutique — Illiberis</title>
${STYLE_COMMUN}
<style>
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 18px; }
  .kpi .l { font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
  .kpi .v { font-family: 'Cormorant Garamond', serif; font-size: 26px; margin-top: 3px; }
  .alerte { background: var(--goldpale); border: 1px solid var(--gold); padding: 10px 14px; font-size: 13px; margin-bottom: 16px; }
  .onglets { display: flex; gap: 6px; border-bottom: 1px solid var(--line); margin-bottom: 16px; }
  .onglet { background: none; border: none; border-bottom: 2px solid transparent; padding: 10px 12px; font-size: 12px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); cursor: pointer; font-family: inherit; }
  .onglet.on { border-bottom-color: var(--garnet); color: var(--garnet); }
  .cmd { margin-bottom: 10px; }
  .badge { font-size: 10px; letter-spacing: .1em; text-transform: uppercase; padding: 4px 10px; color: var(--white); }
  .pinbox { max-width: 320px; margin: 60px auto; text-align: center; }
  .lignea { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; padding: 9px 12px; margin-bottom: 7px; }
  .mini { padding: 4px 10px; font-size: 11px; }
  .formx { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin-bottom: 8px; }
</style>
</head>
<body>
<header>
  <div class="sur">Gestion · Boutique extras</div>
  <h1>La Conciergerie</h1>
  <div class="trait"></div>
</header>
<main id="app"></main>
<script>
var PIN = localStorage.getItem('boutique_pin') || '';
var extras = [], commandes = [], onglet = 'commandes', edition = null;

function eur(n) { return Number(n).toFixed(2).replace('.', ',').replace(',00', '') + ' €'; }
function api(url, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ 'Content-Type': 'application/json', 'X-Pin': PIN }, opts.headers || {});
  return fetch(url, opts).then(function(r){
    if (r.status === 401) { localStorage.removeItem('boutique_pin'); PIN=''; rendrePin(true); throw new Error('PIN'); }
    return r.json();
  });
}

function rendrePin(erreur) {
  document.getElementById('app').innerHTML =
    '<div class="pinbox carte"><div class="serif" style="font-size:22px;margin-bottom:14px">Accès gestion</div>' +
    '<input id="pin" type="password" placeholder="Code PIN" style="text-align:center;letter-spacing:.4em;font-size:18px" onkeydown="if(event.key===\\'Enter\\')valider()">' +
    (erreur ? '<div style="font-size:12px;color:var(--garnet);margin-top:8px">Code incorrect.</div>' : '') +
    '<button class="btn" style="width:100%;margin-top:12px" onclick="valider()">Entrer</button></div>';
}
function valider() {
  PIN = document.getElementById('pin').value;
  localStorage.setItem('boutique_pin', PIN);
  charger();
}

function charger() {
  Promise.all([ api('/boutique-api/admin/extras'), api('/boutique-api/admin/commandes') ])
    .then(function(r){ extras = r[0]; commandes = r[1]; rendre(); })
    .catch(function(){});
}

function rendre() {
  var ca = commandes.filter(function(c){return c.statut==='payee'||c.statut==='livree';}).reduce(function(s,c){return s+Number(c.total);},0);
  var nouvelles = commandes.filter(function(c){return c.statut==='nouvelle';}).length;
  var alertes = extras.filter(function(e){return e.stock!==null && e.stock<=e.seuil && e.actif;});

  var h = '<div class="kpis">';
  h += '<div class="kpi carte"><div class="l">CA extras encaissé</div><div class="v" style="color:var(--garnet)">' + eur(ca) + '</div></div>';
  h += '<div class="kpi carte"><div class="l">À traiter</div><div class="v" style="color:var(--gold)">' + nouvelles + '</div></div>';
  h += '<div class="kpi carte"><div class="l">Alertes stock</div><div class="v" style="color:' + (alertes.length?'var(--garnet)':'var(--olive)') + '">' + alertes.length + '</div></div>';
  h += '</div>';
  if (alertes.length) h += '<div class="alerte"><b>Stock bas :</b> ' + alertes.map(function(a){return a.nom + ' (' + a.stock + ')';}).join(' · ') + '</div>';

  h += '<div class="onglets">';
  ['commandes','catalogue','stock'].forEach(function(t){
    h += '<button class="onglet' + (onglet===t?' on':'') + '" onclick="setOnglet(\\'' + t + '\\')">' + t + '</button>';
  });
  h += '</div>';

  if (onglet === 'commandes') h += vueCommandes();
  if (onglet === 'catalogue') h += vueCatalogue();
  if (onglet === 'stock') h += vueStock();
  document.getElementById('app').innerHTML = h;
}
function setOnglet(t) { onglet = t; edition = null; rendre(); }

function vueCommandes() {
  if (!commandes.length) return '<p style="color:var(--muted);font-size:14px">Aucune commande. Partagez le lien /boutique à vos voyageurs à J-3.</p>';
  var couleurs = { nouvelle: 'var(--garnet)', payee: 'var(--gold)', livree: 'var(--olive)', annulee: 'var(--muted)' };
  var libs = { nouvelle: 'Nouvelle', payee: 'Payée', livree: 'Livrée', annulee: 'Annulée' };
  var h = '';
  commandes.forEach(function(c){
    h += '<div class="cmd carte" style="' + (c.statut==='annulee'?'opacity:.55':'') + '">';
    h += '<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px">';
    h += '<div><span class="serif" style="font-size:17px;font-weight:600">' + c.client + '</span>';
    h += '<span style="font-size:12px;color:var(--muted)"> — ' + c.logement + (c.date_arrivee ? ' · arrivée ' + c.date_arrivee.split('-').reverse().join('/') : '') + '</span></div>';
    h += '<span class="badge" style="background:' + couleurs[c.statut] + '">' + libs[c.statut] + '</span></div>';
    h += '<div style="font-size:13px;color:var(--muted);margin:6px 0">' + c.items.map(function(i){return i.nom + ' ×' + i.qte;}).join(' · ') + ' — <b style="color:var(--ink)">' + eur(c.total) + '</b></div>';
    if (c.statut !== 'annulee' && c.statut !== 'livree') {
      h += '<div style="display:flex;gap:6px;flex-wrap:wrap">';
      ['nouvelle','payee','livree'].filter(function(s){return s!==c.statut;}).forEach(function(s){
        h += '<button class="ghost mini" onclick="statut(' + c.id + ',\\'' + s + '\\')">Marquer ' + libs[s].toLowerCase() + '</button>';
      });
      h += '<button class="ghost mini" style="color:var(--muted);border-color:var(--muted)" onclick="statut(' + c.id + ',\\'annulee\\')">Annuler (restock)</button></div>';
    }
    h += '</div>';
  });
  return h;
}
function statut(id, s) { api('/boutique-api/admin/commandes/' + id, { method: 'PUT', body: JSON.stringify({ statut: s }) }).then(charger); }

function vueCatalogue() {
  var h = '<button class="btn" style="margin-bottom:12px" onclick="editer(0)">+ Nouvel extra</button>';
  if (edition) {
    h += '<div class="carte" style="border-color:var(--gold);margin-bottom:14px"><div class="formx">';
    h += '<input id="e_nom" placeholder="Nom" value="' + (edition.nom||'') + '">';
    h += '<select id="e_cat">' + ${JSON.stringify(CATEGORIES)}.map(function(c){return '<option value="' + c.id + '"' + (edition.categorie===c.id?' selected':'') + '>' + c.label + '</option>';}).join('') + '</select>';
    h += '<input id="e_prix" type="number" step="0.5" placeholder="Prix €" value="' + (edition.prix!=null?edition.prix:'') + '">';
    h += '<input id="e_stock" type="number" placeholder="Stock (vide = illimité)" value="' + (edition.stock!=null?edition.stock:'') + '">';
    h += '<input id="e_seuil" type="number" placeholder="Seuil alerte" value="' + (edition.seuil!=null?edition.seuil:2) + '">';
    h += '</div><input id="e_desc" placeholder="Description courte" value="' + (edition.description||'') + '">';
    h += '<div style="display:flex;gap:8px;margin-top:10px"><button class="btn" onclick="sauver()">Enregistrer</button>';
    h += '<button class="ghost" onclick="edition=null;rendre()">Fermer</button></div></div>';
  }
  extras.forEach(function(e){
    h += '<div class="lignea carte" style="' + (e.actif?'':'opacity:.5') + '">';
    h += '<div style="flex:1;min-width:170px"><b style="font-size:13px">' + e.nom + '</b>';
    h += '<span style="font-size:12px;color:var(--muted)"> · ' + eur(e.prix) + ' · ' + (e.stock===null?'illimité':'stock ' + e.stock) + '</span></div>';
    h += '<div style="display:flex;gap:5px">';
    h += '<button class="ghost mini" onclick="editer(' + e.id + ')">Modifier</button>';
    h += '<button class="ghost mini" onclick="basculer(' + e.id + ',' + !e.actif + ')">' + (e.actif?'Masquer':'Afficher') + '</button>';
    h += '<button class="ghost mini" style="color:var(--muted);border-color:var(--muted)" onclick="supprimer(' + e.id + ')">Suppr.</button>';
    h += '</div></div>';
  });
  return h;
}
function editer(id) {
  edition = id ? Object.assign({}, extras.find(function(e){return e.id===id;})) : { nom:'', description:'', categorie:'gourmand', prix:'', stock:'', seuil:2 };
  rendre();
  window.scrollTo(0, 0);
}
function sauver() {
  var corps = {
    nom: document.getElementById('e_nom').value.trim(),
    categorie: document.getElementById('e_cat').value,
    prix: parseFloat(document.getElementById('e_prix').value) || 0,
    stock: document.getElementById('e_stock').value === '' ? null : parseInt(document.getElementById('e_stock').value),
    seuil: parseInt(document.getElementById('e_seuil').value) || 2,
    description: document.getElementById('e_desc').value,
  };
  if (!corps.nom) { alert('Le nom est obligatoire.'); return; }
  var p = edition.id
    ? api('/boutique-api/admin/extras/' + edition.id, { method: 'PUT', body: JSON.stringify(corps) })
    : api('/boutique-api/admin/extras', { method: 'POST', body: JSON.stringify(corps) });
  p.then(function(){ edition = null; charger(); });
}
function basculer(id, actif) { api('/boutique-api/admin/extras/' + id, { method: 'PUT', body: JSON.stringify({ actif: actif }) }).then(charger); }
function supprimer(id) { if (confirm('Supprimer définitivement cet extra ?')) api('/boutique-api/admin/extras/' + id, { method: 'DELETE' }).then(charger); }

function vueStock() {
  var h = '';
  extras.filter(function(e){return e.stock !== null;}).forEach(function(e){
    var bas = e.stock <= e.seuil;
    h += '<div class="lignea carte" style="' + (bas?'border-color:var(--garnet)':'') + '">';
    h += '<div><b style="font-size:13px">' + e.nom + '</b>' + (bas?' <span style="font-size:10px;color:var(--garnet);letter-spacing:.08em;text-transform:uppercase">Réappro !</span>':'') + '</div>';
    h += '<div style="display:flex;align-items:center;gap:12px">';
    h += '<button class="ghost mini" onclick="stockDelta(' + e.id + ',' + e.stock + ',-1)">−</button>';
    h += '<span class="serif" style="font-size:19px;min-width:26px;text-align:center;color:' + (bas?'var(--garnet)':'var(--ink)') + '">' + e.stock + '</span>';
    h += '<button class="ghost mini" onclick="stockDelta(' + e.id + ',' + e.stock + ',1)">+</button></div></div>';
  });
  return h || '<p style="color:var(--muted);font-size:14px">Aucun extra avec stock suivi.</p>';
}
function stockDelta(id, actuel, d) {
  var n = Math.max(0, actuel + d);
  api('/boutique-api/admin/extras/' + id, { method: 'PUT', body: JSON.stringify({ stock: n }) }).then(charger);
}

if (PIN) charger(); else rendrePin(false);
</script>
</body>
</html>`;
