// ═══════════════════════════════════════════════════════════════
// BOUTIQUE EXTRAS — Module pour hostex-proxy
// Pages : /boutique (voyageurs) et /boutique-admin (gestion, PIN)
// API   : /api/boutique/...
// ═══════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

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

module.exports = function (app) {

  // ═══════════ API PUBLIQUE ═══════════

  // Catalogue actif
  app.get('/api/boutique/extras', async (req, res) => {
    const { data, error } = await supabase.from('extras')
      .select('*').eq('actif', true).order('categorie').order('prix');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  // Nouvelle commande (décrémente le stock)
  app.post('/api/boutique/commande', async (req, res) => {
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

    res.json({ ok: true, id: data.id, total });
  });

  // ═══════════ API ADMIN (PIN requis) ═══════════

  app.get('/api/boutique/admin/extras', verifPin, async (req, res) => {
    const { data, error } = await supabase.from('extras').select('*').order('categorie').order('nom');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  app.post('/api/boutique/admin/extras', verifPin, async (req, res) => {
    const { nom, description, categorie, prix, stock, seuil } = req.body;
    const { data, error } = await supabase.from('extras')
      .insert({ nom, description: description || '', categorie, prix, stock: stock === '' || stock == null ? null : stock, seuil: seuil || 2 })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  app.put('/api/boutique/admin/extras/:id', verifPin, async (req, res) => {
    const maj = { ...req.body };
    if (maj.stock === '' || maj.stock === undefined) maj.stock = null;
    const { error } = await supabase.from('extras').update(maj).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  });

  app.delete('/api/boutique/admin/extras/:id', verifPin, async (req, res) => {
    const { error } = await supabase.from('extras').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  });

  app.get('/api/boutique/admin/commandes', verifPin, async (req, res) => {
    const { data, error } = await supabase.from('commandes_extras').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  // Changement de statut (annulation = remise en stock)
  app.put('/api/boutique/admin/commandes/:id', verifPin, async (req, res) => {
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
  .intro { font-family: 'Cormorant Garamond', serif; font-style: italic; font-size: 18px; color: var(--muted); text-align: center; max-width: 540px; margin: 0 auto 22px; line-height: 1.5; }
  .filtres { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-bottom: 24px; }
  .grille { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }
  .extra .cat { font-size: 10px; letter-spacing: .2em; text-transform: uppercase; color: var(--gold); margin-bottom: 5px; }
  .extra .nom { font-family: 'Cormorant Garamond', serif; font-size: 19px; font-weight: 600; line-height: 1.25; }
  .extra .desc { font-size: 13px; color: var(--muted); line-height: 1.5; margin: 7px 0 12px; min-height: 40px; }
  .extra .bas { display: flex; align-items: center; justify-content: space-between; }
  .extra .prix { font-family: 'Cormorant Garamond', serif; font-size: 20px; color: var(--garnet); }
  .panier { margin-top: 32px; background: var(--white); border: 1px solid var(--gold); padding: 24px 20px; }
  .ligne { display: flex; justify-content: space-between; font-size: 14px; padding: 6px 0; border-bottom: 1px dashed var(--line); }
  .total { display: flex; justify-content: space-between; padding: 12px 0 16px; font-family: 'Cormorant Garamond', serif; font-size: 19px; }
  .form { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin-bottom: 14px; }
  .ok { background: var(--white); border: 1px solid var(--line); padding: 36px 26px; text-align: center; max-width: 500px; margin: 40px auto; }
  .qte { display: flex; align-items: center; gap: 10px; }
  .note { font-size: 12px; color: var(--muted); text-align: center; margin-top: 10px; }
</style>
</head>
<body>
<header>
  <div class="sur">Nuits Insolites · Perpignan</div>
  <h1>La Conciergerie</h1>
  <div class="trait"></div>
</header>
<main id="app"></main>
<footer>NUITS INSOLITES · CONCIERGERIE PRIVÉE · PERPIGNAN</footer>
<script>
var CATS = ${JSON.stringify(CATEGORIES)};
var LOGEMENTS = ${JSON.stringify(LOGEMENTS)};
var extras = [], panier = {}, filtre = 'tous';

function eur(n) { return n.toFixed(2).replace('.', ',').replace(',00', '') + ' €'; }
function catLabel(id) { var c = CATS.find(function(x){return x.id===id;}); return c ? c.label : id; }

function charger() {
  fetch('/api/boutique/extras').then(function(r){return r.json();}).then(function(d){ extras = d; rendre(); });
}

function rendre() {
  var lignes = Object.keys(panier).map(function(id){
    var e = extras.find(function(x){return x.id==id;});
    return e ? { e: e, qte: panier[id] } : null;
  }).filter(Boolean);
  var total = lignes.reduce(function(s,l){return s + l.e.prix*l.qte;}, 0);
  var visibles = extras.filter(function(e){return filtre==='tous' || e.categorie===filtre;});

  var h = '<p class="intro">Composez votre séjour avant d\\'arriver : tout sera prêt en poussant la porte.</p>';
  h += '<div class="filtres"><button class="ghost' + (filtre==='tous'?' on':'') + '" onclick="setFiltre(\\'tous\\')">Tout</button>';
  CATS.forEach(function(c){ h += '<button class="ghost' + (filtre===c.id?' on':'') + '" onclick="setFiltre(\\'' + c.id + '\\')">' + c.label + '</button>'; });
  h += '</div><div class="grille">';

  visibles.forEach(function(e){
    var epuise = e.stock !== null && e.stock <= 0;
    var qte = panier[e.id] || 0;
    h += '<div class="extra carte" style="' + (epuise?'opacity:.55;':'') + (qte?'border-color:var(--gold);':'') + '">';
    h += '<div class="cat">' + catLabel(e.categorie) + '</div>';
    h += '<div class="nom">' + e.nom + '</div>';
    h += '<div class="desc">' + (e.description||'') + '</div>';
    h += '<div class="bas"><span class="prix">' + eur(Number(e.prix)) + '</span>';
    if (epuise) h += '<span style="font-size:12px;color:var(--muted)">Épuisé</span>';
    else if (!qte) h += '<button class="ghost" onclick="plus(' + e.id + ')">Ajouter</button>';
    else {
      h += '<span class="qte"><button class="ghost" onclick="moins(' + e.id + ')">−</button><b>' + qte + '</b>';
      var max = e.stock !== null && qte >= e.stock;
      h += '<button class="ghost" ' + (max?'disabled style="opacity:.4"':'') + ' onclick="plus(' + e.id + ')">+</button></span>';
    }
    h += '</div></div>';
  });
  h += '</div>';

  if (lignes.length) {
    h += '<div class="panier"><div class="serif" style="font-size:22px;color:var(--garnet);margin-bottom:12px">Votre sélection</div>';
    lignes.forEach(function(l){ h += '<div class="ligne"><span>' + l.e.nom + ' × ' + l.qte + '</span><span>' + eur(l.e.prix*l.qte) + '</span></div>'; });
    h += '<div class="total"><span>Total</span><span style="color:var(--garnet)">' + eur(total) + '</span></div>';
    h += '<div class="form">';
    h += '<input id="nom" placeholder="Votre nom" value="' + (window._nom||'') + '" oninput="window._nom=this.value">';
    h += '<select id="logement">' + LOGEMENTS.map(function(l){return '<option' + (window._log===l?' selected':'') + '>' + l + '</option>';}).join('') + '</select>';
    h += '<input id="arrivee" type="date" value="' + (window._arr||'') + '" oninput="window._arr=this.value">';
    h += '</div>';
    h += '<button class="btn" style="width:100%" onclick="envoyer(' + total + ')">Envoyer ma demande — ' + eur(total) + '</button>';
    h += '<p class="note">Paiement sécurisé par lien envoyé après validation. Rien n\\'est débité maintenant.</p></div>';
  }
  document.getElementById('app').innerHTML = h;
}

function setFiltre(f) { filtre = f; rendre(); }
function plus(id) { panier[id] = (panier[id]||0) + 1; rendre(); }
function moins(id) { if (panier[id] > 1) panier[id]--; else delete panier[id]; rendre(); }

function envoyer(total) {
  var nom = document.getElementById('nom').value.trim();
  if (!nom) { alert('Merci d\\'indiquer votre nom.'); return; }
  window._log = document.getElementById('logement').value;
  var items = Object.keys(panier).map(function(id){
    var e = extras.find(function(x){return x.id==id;});
    return { extra_id: e.id, nom: e.nom, prix: Number(e.prix), qte: panier[id] };
  });
  fetch('/api/boutique/commande', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client: nom, logement: window._log, date_arrivee: window._arr || null, items: items })
  }).then(function(r){return r.json();}).then(function(d){
    if (d.error) { alert(d.error); charger(); return; }
    panier = {};
    document.getElementById('app').innerHTML =
      '<div class="ok"><div class="serif" style="font-size:25px;color:var(--garnet);margin-bottom:10px">Demande envoyée</div>' +
      '<p style="font-size:14px;line-height:1.7;color:var(--muted);margin-bottom:18px">Merci ' + nom +
      '. Votre sélection (' + eur(d.total) + ') a bien été transmise. Vous recevrez un lien de paiement sécurisé avant votre arrivée pour la confirmer.</p>' +
      '<button class="ghost" onclick="charger()">Retour à la boutique</button></div>';
  });
}
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
  Promise.all([ api('/api/boutique/admin/extras'), api('/api/boutique/admin/commandes') ])
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
function statut(id, s) { api('/api/boutique/admin/commandes/' + id, { method: 'PUT', body: JSON.stringify({ statut: s }) }).then(charger); }

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
    ? api('/api/boutique/admin/extras/' + edition.id, { method: 'PUT', body: JSON.stringify(corps) })
    : api('/api/boutique/admin/extras', { method: 'POST', body: JSON.stringify(corps) });
  p.then(function(){ edition = null; charger(); });
}
function basculer(id, actif) { api('/api/boutique/admin/extras/' + id, { method: 'PUT', body: JSON.stringify({ actif: actif }) }).then(charger); }
function supprimer(id) { if (confirm('Supprimer définitivement cet extra ?')) api('/api/boutique/admin/extras/' + id, { method: 'DELETE' }).then(charger); }

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
  api('/api/boutique/admin/extras/' + id, { method: 'PUT', body: JSON.stringify({ stock: n }) }).then(charger);
}

if (PIN) charger(); else rendrePin(false);
</script>
</body>
</html>`;
