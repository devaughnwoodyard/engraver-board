import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager, memoryLocalCache,
  doc, collection, setDoc, updateDoc, getDoc, getDocs, onSnapshot, query, orderBy, serverTimestamp, writeBatch, arrayUnion, getDocFromServer, Timestamp, deleteDoc
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
// Staff pages (board/admin) keep an offline cache owned by this tab so moves survive Wi-Fi drops.
// Guest pages use an in-memory cache: a direct live connection with no cross-tab relay, so updates land in about a second.
const staffView = /^#\/(board|admin)/.test(location.hash);
const db = initializeFirestore(fb, {
  // Long-polling instead of a streaming connection: venue Wi-Fi, proxies and some phone/browser filters
  // buffer streams, which delays live updates by many seconds.
  experimentalForceLongPolling: true,
  localCache: staffView ? persistentLocalCache({ tabManager: persistentSingleTabManager({ forceOwnership: true }) }) : memoryLocalCache()
});

// ---------- catalog ----------
// One shared catalog in /config/catalog: categories → pieces → option groups → choices.
// Each event turns pieces and single choices on or off. Ids never change once made, so
// old orders and photos keep matching when a label is renamed.
const DETAIL = () => ({ id: 'addon', label: 'Detail', choices: [{ id: 'none', label: 'Name only' }, { id: 'stars', label: 'Stars' }, { id: 'heart', label: 'Heart' }] });
const DEFAULT_CATALOG = { categories: [
  { id: 'engraving', label: 'Engraving', items: [
    { id: 'bagtag', label: 'Leather bag tag', material: 'leather', preview: 'bagtag', groups: [
      { id: 'color', label: 'Leather', swatch: true, choices: [{ id: 'black', label: 'Black', color: '#1d1b1a' }, { id: 'tan', label: 'Tan', color: '#a86b43' }, { id: 'blush', label: 'Blush', color: '#d9aa98' }] }, DETAIL()] },
    { id: 'tumbler', label: 'Tumbler', material: 'stainless steel', preview: 'tumbler', groups: [
      { id: 'color', label: 'Finish', swatch: true, choices: [{ id: 'black', label: 'Black', color: '#1d1b1a' }, { id: 'white', label: 'White', color: '#efece6' }, { id: 'terracotta', label: 'Terracotta', color: '#b9623f' }] }, DETAIL()] }] },
  { id: 'calligraphy', label: 'Calligraphy', items: [] }] };
let CAT = DEFAULT_CATALOG, catLoading = null;
function loadCatalog(force = false) {
  if (!catLoading || force) catLoading = getDoc(doc(db, 'config', 'catalog'))
    .then(s => { const c = s.exists() && s.data().categories; if (Array.isArray(c)) CAT = { categories: c }; }).catch(() => {});
  return catLoading;
}
const FONTS = { script: 'Script', serif: 'Print' };
const SWATCH = { black: '#1d1b1a', tan: '#a86b43', blush: '#d9aa98', white: '#efece6', terracotta: '#b9623f' };
const STATUS_LABEL = { queue: 'Waiting', progress: 'Engraving', done: 'Ready for pickup', picked: 'Picked up' };
const WAVE = w => `<svg class="wave" viewBox="0 0 ${w} 24" preserveAspectRatio="none" aria-hidden="true"><path d="M0 15 C ${w * .23} 0 ${w * .44} 28 ${w * .64} 11 S ${w * .92} 5 ${w} 15 L${w} 24 L0 24Z" fill="#fff8f0"/></svg>`;
const LOGO = `<img class="logo" src="logo.png" alt="Ivelisse Designs">`;

// ---------- helpers ----------
const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortId = id => id.slice(-4).toUpperCase();
// US mobile numbers only: returns +1XXXXXXXXXX, '' when empty, or null when it isn't a valid number.
const normPhone = v => { const d = String(v || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); if (!d) return ''; return /^[2-9]\d{2}[2-9]\d{6}$/.test(d) ? '+1' + d : null; };
const fmtPhone = e => { const d = String(e || '').replace(/^\+1/, ''); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : e; };
const fmtDate = d => { if (!d) return ''; const t = new Date(d + 'T12:00:00'); return isNaN(t) ? d : t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
const fmtTime = d => d ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase() : '';
const tsDate = t => (t && typeof t.toDate === 'function') ? t.toDate() : (typeof t === 'number' ? new Date(t) : null);
let unsubs = [], timers = [];
const cleanup = () => { photoRerender = null; unsubs.forEach(u => { try { u(); } catch (e) {} }); unsubs = []; timers.forEach(clearInterval); timers = []; };
function toast(msg, action) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  if (action) t.querySelector('button').onclick = () => { action.run(); t.remove(); };
  document.body.appendChild(t); setTimeout(() => t.remove(), action ? 10000 : 2800);
}
const baseUrl = () => location.href.split('#')[0];
function driveToDirect(url) {
  const m = String(url).match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]{20,})/);
  return m ? `https://lh3.googleusercontent.com/d/${m[1]}=w900` : String(url).trim();
}
const allPieces = () => CAT.categories.flatMap(c => c.items.map(it => ({ cat: c, it })));
const pieceDef = id => allPieces().find(p => p.it.id === id) || null;
// Orders before the catalog change stored color/addon directly instead of opts.
const optsOf = o => o.opts || { color: o.color, addon: o.addon };
// An event lists the pieces it offers (new catalog pieces don't appear in it by surprise) and the choices it hides.
const offered = (ev, id) => !ev?.items || ev.items[id] === true;
const choicesFor = (ev, it, g) => g.choices.filter(c => !(ev?.hidden || {})[`${it.id}/${g.id}/${c.id}`]);
const firstOpts = (ev, it) => Object.fromEntries(it.groups.map(g => [g.id, (choicesFor(ev, it, g)[0] || g.choices[0] || {}).id]));
const pieceLabel = o => o.labels?.piece || pieceDef(o.item)?.it.label || o.item || '';
function choiceLabels(o) { // [{ g: group label, c: choice label, id }]
  if (o.labels?.opts) return o.labels.opts;
  const p = pieceDef(o.item), op = optsOf(o);
  if (!p) return Object.entries(op).filter(([, v]) => v).map(([g, v]) => ({ g, c: v, id: v }));
  return p.it.groups.filter(g => op[g.id] != null).map(g => { const ch = g.choices.find(c => c.id === op[g.id]); return { g: g.label, c: ch ? ch.label : op[g.id], id: op[g.id] }; });
}
// Example photos live in /photos/{key}, shared by every event. A piece's photos follow its first two
// option groups: piece_choice1, or piece_choice1_choice2 (a "none" second choice uses the shorter key).
// Each photo is fetched the first time a screen needs it, so a guest's phone only downloads what it shows.
const photoLib = {};       // key -> image data URL, or null once we know there is none
let photoRerender = null;  // the open page's redraw, run when a photo arrives
let photoTimer = null;
function requestPhoto(key) {
  if (key in photoLib) return;
  photoLib[key] = undefined;
  getDoc(doc(db, 'photos', key)).then(s => {
    photoLib[key] = s.exists() ? (s.data().data || null) : null;
    if (photoLib[key]) { clearTimeout(photoTimer); photoTimer = setTimeout(() => photoRerender && photoRerender(), 60); }
  }).catch(() => { photoLib[key] = null; });
}
function photoKeys(o) {
  const p = pieceDef(o.item), op = optsOf(o);
  const [g1, g2] = p ? p.it.groups : [{ id: 'color' }, { id: 'addon' }];
  const v1 = g1 && op[g1.id], v2 = g2 && op[g2.id];
  return [...new Set([v1 && v2 && v2 !== 'none' ? `${o.item}_${v1}_${v2}` : null, v1 ? `${o.item}_${v1}` : null, o.item].filter(Boolean))];
}
function photoFor(ev, o) {
  const p = (ev && ev.photos) || {}; // older events may still hold pasted photo links
  for (const k of photoKeys(o)) { if (p[k]) return p[k]; requestPhoto(k); if (photoLib[k]) return photoLib[k]; }
  return null;
}
function previewHTML(ev, o, withName = true) {
  const photo = photoFor(ev, o);
  if (photo) return `<img src="${esc(photo)}" alt="" loading="lazy">`;
  const p = pieceDef(o.item), op = optsOf(o);
  const sg = p?.it.groups.find(g => g.swatch), ch = sg && sg.choices.find(c => c.id === op[sg.id]);
  const kind = p?.it.preview || (o.item === 'tumbler' || o.item === 'bagtag' ? o.item : 'card');
  const mark = Object.values(op).find(v => v === 'stars' || v === 'heart') || 'none';
  return window.EngravePreview.renderPreview({ item: kind, color: sg ? op[sg.id] : op.color, hex: ch?.color, addon: mark, name: withName ? o.name : '', font: o.font });
}
function describe(ev, o) {
  const parts = choiceLabels(o).filter(x => x.id !== 'none').map(x => String(x.c).toLowerCase());
  const pl = pieceLabel(o).toLowerCase();
  return parts.length ? [`${parts[0]} ${pl}`, ...parts.slice(1)].join(' • ') : pl;
}
const myOrdersKey = id => 'eb-mine-' + id;
function myOrders(eventId) { try { return JSON.parse(localStorage.getItem(myOrdersKey(eventId)) || '[]'); } catch (e) { return []; } }
function rememberOrder(eventId, o) { try { const a = myOrders(eventId).filter(x => x.id !== o.id); a.unshift(o); localStorage.setItem(myOrdersKey(eventId), JSON.stringify(a.slice(0, 8))); } catch (e) {} }

// ---------- auth ----------
let user = null;
const authReady = new Promise(res => { let first = true; onAuthStateChanged(auth, u => { user = u; if (first) { first = false; res(); } }); });
async function ensureGuest() { await authReady; if (!user) { const c = await signInAnonymously(auth); user = c.user; } return user; }
async function isStaff() {
  await authReady;
  if (!user || user.isAnonymous || !user.email) return false;
  try { return (await getDoc(doc(db, 'staff', user.email))).exists(); } catch (e) { return false; }
}
async function staffGate(render) {
  if (await isStaff()) return render();
  $app.innerHTML = `<div class="page"><header class="band">${LOGO}<div class="ev">staff</div>${WAVE(390)}</header>
    <main class="content"><h1>staff <em>sign-in</em></h1>
    <p class="note">${user && !user.isAnonymous ? `Signed in as ${esc(user.email)}, which isn't on the staff list yet.` : 'Sign in with the Google account on the staff list.'}</p>
    <button class="btn" id="g" type="button">Sign in with Google</button>
    ${user && !user.isAnonymous ? '<button class="btn out" id="out" type="button">Sign out</button>' : ''}
    <p class="note" style="font-size:.8125rem">On an iPad home-screen app, if the sign-in window doesn't open, open this page in Safari once and sign in there.</p></main></div>`;
  document.getElementById('g').onclick = async () => {
    try { await signInWithPopup(auth, new GoogleAuthProvider()); route(); }
    catch (e) { toast('Sign-in did not finish: ' + (e.code || e.message)); }
  };
  const out = document.getElementById('out'); if (out) out.onclick = () => signOut(auth).then(route);
}

// ---------- router ----------
// Setup and catalog pages set leaveGuard while they hold unsaved changes.
let leaveGuard = null, lastHash = location.hash;
async function route() {
  if (leaveGuard && leaveGuard() && location.hash !== lastHash && !confirm('Leave without saving your changes?')) { history.replaceState(null, '', lastHash || '#/'); return; }
  leaveGuard = null; lastHash = location.hash;
  cleanup();
  const [view, a, b] = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  window.scrollTo(0, 0);
  if (view) await loadCatalog();
  if (view === 'e' && a) return guestForm(a);
  if (view === 'o' && a && b) return statusPage(a, b);
  if (view === 'board' && a) return a === DEMO_ID ? ensureGuest().then(() => boardPage(a)) : staffGate(() => boardPage(a));
  if (view === 'admin') return staffGate(() => a ? setupPage(a) : adminPage());
  if (view === 'photos') return staffGate(photosPage);
  if (view === 'catalog') return staffGate(catalogPage);
  return homePage();
}
addEventListener('hashchange', route);

function homePage() {
  $app.innerHTML = `<div class="page"><header class="band">${LOGO}<div class="ev">ivelisse board</div>${WAVE(390)}</header>
    <main class="content"><div class="rule"></div><h1>live <em>personalization</em></h1>
    <p class="note">Guests reach their event by scanning its QR code. Staff manage events and boards here.</p>
    <a class="btn" href="#/board/demo">Try the demo board</a>
    <a class="btn out" href="#/e/demo">Try the guest form</a>
    <p class="note" style="font-size:.8125rem">The demo has sample orders and no sign-in. Use "reset demo" on the board to start over.</p>
    <a class="btn out" href="#/admin">Staff: events &amp; boards</a></main></div>`;
}

// ---------- guest form ----------
async function guestForm(eventId) {
  $app.innerHTML = `<div class="page"><p class="note" style="padding:40px">Loading…</p></div>`;
  await ensureGuest();
  let ev = null;
  try { const s = await getDoc(doc(db, 'events', eventId)); ev = s.exists() ? s.data() : null; } catch (e) {}
  const head = slim => `<header class="band ${slim ? 'slim' : ''}">${slim ? '' : LOGO}<div class="ev">${esc(ev?.name || '')}${ev?.date ? ' · ' + esc(fmtDate(ev.date)) : ''}</div>${WAVE(390)}</header>`;
  if (!ev) { $app.innerHTML = `<div class="page"><main class="content"><h1>event not <em>found</em></h1><p class="note">Check the QR code or ask the engraver.</p></main></div>`; return; }
  const mine = myOrders(eventId);
  if (ev.open === false) { $app.innerHTML = `<div class="page">${head(false)}<main class="content"><h1>orders are <em>closed</em></h1><p class="note">Thanks for stopping by. Pieces already ordered are still being finished.</p>${mineHTML()}</main></div>`; return; }

  // Categories with at least one piece this event offers (and every option group still has a choice on).
  const cats = CAT.categories.map(c => ({ c, items: c.items.filter(it => offered(ev, it.id) && it.groups.every(g => choicesFor(ev, it, g).length)) })).filter(x => x.items.length);
  const st = { step: 1, cat: cats[0]?.c.id, item: null, opts: {}, name: '', font: 'script', phone: '', sending: false };
  const curCat = () => cats.find(x => x.c.id === st.cat);
  const curItem = () => curCat()?.items.find(it => it.id === st.item) || null;
  function setItem(id) {
    st.item = id; const it = curItem(); if (!it) return;
    // Keep choices that still apply when switching pieces (black stays black), else take the first offered one.
    st.opts = Object.fromEntries(it.groups.map(g => { const ch = choicesFor(ev, it, g); return [g.id, ch.some(c => c.id === st.opts[g.id]) ? st.opts[g.id] : ch[0].id]; }));
  }
  if (cats[0]) setItem(cats[0].items[0].id);
  const order = () => ({ item: st.item, opts: st.opts, name: st.name, font: st.font });
  const submitKey = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())).replace(/-/g, '').slice(0, 20);

  function mineHTML() {
    if (!mine.length) return '';
    return `<div class="mine"><div class="eyebrow" style="text-align:left">your pieces</div>${mine.map(o => `<a href="#/o/${encodeURIComponent(eventId)}/${esc(o.id)}"><span>${esc(o.name)} • ${shortId(o.id)}</span><b>check status ›</b></a>`).join('')}</div>`;
  }
  const stepsHTML = () => `<ol class="steps">${['piece', 'personalize', 'one last look'].map((s, i) => `<li class="${i + 1 < st.step ? 'dn' : ''}" ${i + 1 === st.step ? 'aria-current="step"' : ''}>${s}</li>`).join('')}</ol>`;
  const radios = (name, entries, cur, cls) => `<div class="${cls}" role="radiogroup" aria-label="${esc(name)}">${entries.map(([k, v]) => `<button type="button" role="radio" aria-checked="${k === cur}" data-${name}="${esc(k)}">${esc(v)}</button>`).join('')}</div>`;
  const groupHTML = (it, g) => {
    const ch = choicesFor(ev, it, g);
    return `<fieldset><legend>choose your <em>${esc(g.label.toLowerCase())}</em></legend><div class="${g.swatch ? 'sw' : 'seg'}" role="radiogroup" aria-label="${esc(g.label)}">${ch.map(c =>
      `<button type="button" role="radio" aria-checked="${c.id === st.opts[g.id]}" data-g="${esc(g.id)}" data-c="${esc(c.id)}">${g.swatch ? `<span class="dot" style="background:${esc(c.color || SWATCH[c.id] || '#ccc')}"></span>` : ''}${esc(c.label.toLowerCase())}</button>`).join('')}</div></fieldset>`;
  };

  function render() {
    const it = curItem();
    let body = '', bar = '';
    if (st.step === 1) {
      const items = curCat()?.items || [];
      body = `<div class="rule"></div><h1>make it <em>yours</em></h1>
        <p class="note">pick a piece. we personalize it live, right here.</p>
        ${mineHTML()}
        ${cats.length > 1 ? `<fieldset><legend>what are we <em>making?</em></legend>${radios('cat', cats.map(x => [x.c.id, x.c.label]), st.cat, 'seg')}</fieldset>` : ''}
        <fieldset><legend>what are we personalizing?</legend>
          <div class="pick" role="radiogroup" aria-label="Piece">${items.map(p => `<button type="button" class="pcard" role="radio" aria-checked="${p.id === st.item}" data-item="${esc(p.id)}">
            ${p.id === st.item ? '<span class="tick" aria-hidden="true">✓</span>' : ''}<span class="ph">${previewHTML(ev, { item: p.id, opts: firstOpts(ev, p), name: '' }, false)}</span><span class="chip">${esc(p.label.toLowerCase())}</span></button>`).join('') || '<p class="note">Nothing is on the menu yet.</p>'}</div></fieldset>
        <p class="mats">${[...new Set(items.map(p => p.material).filter(Boolean))].map(esc).join(' • ')}</p>`;
      bar = `<button class="btn" id="next" type="button" ${it ? '' : 'disabled'}>Choose your details</button>`;
    } else if (st.step === 2) {
      // A group with a single choice left is decided already; it still shows on the review step.
      body = `${stepsHTML()}
        ${it.groups.filter(g => choicesFor(ev, it, g).length > 1).map(g => groupHTML(it, g)).join('')}
        <fieldset><legend>whose name goes on it?</legend>
          <label class="lbl" for="nm">Name or initials</label>
          <input id="nm" class="namefield" maxlength="14" autocomplete="off" autocapitalize="words" spellcheck="false" value="${esc(st.name)}">
          <div class="count" id="cnt">${st.name.length} / 14</div>
          ${radios('font', Object.entries(FONTS), st.font, 'seg')}</fieldset>
        <div class="mini"><span class="ph" id="pv">${previewHTML(ev, order())}</span><div><div class="k">a little preview</div><div class="nm" id="pvn">${esc(st.name) || '&nbsp;'}</div><div class="ds">${esc(describe(ev, order()))} • ${esc(FONTS[st.font].toLowerCase())}</div></div></div>
        ${photoFor(ev, order()) ? '<p class="note" style="font-size:.8125rem">Photo shows an example of this style. Yours will have your name.</p>' : ''}`;
      bar = `<button class="btn sec" id="back" type="button">Back</button><button class="btn" id="next" type="button" ${st.name.trim() ? '' : 'disabled'}>Next: one last look</button>`;
    } else {
      body = `${stepsHTML()}<h1>one last <em>look</em></h1>
        <div class="proof"><span class="ph">${previewHTML(ev, order())}</span>
          <dl class="rows"><div><dt>Name</dt><dd><b style="font-size:1.125rem">${esc(st.name.trim())}</b></dd></div><div><dt>Piece</dt><dd>${esc(it.label)}</dd></div>
          ${it.groups.map(g => `<div><dt>${esc(g.label)}</dt><dd>${esc(g.choices.find(c => c.id === st.opts[g.id])?.label || '')}</dd></div>`).join('')}
          <div><dt>Lettering</dt><dd>${esc(FONTS[st.font])}</dd></div>
          </dl><div class="spell"><span>Spelled right?</span><button class="editbtn" id="edit" type="button">✎ Edit</button></div></div>
        <div class="optin"><label class="lbl" for="ph">Want a text when it's ready? <span>optional</span></label>
          <input id="ph" class="phonefield" type="tel" inputmode="tel" autocomplete="tel" placeholder="(214) 555-0123" value="${esc(st.phone)}">
          <p class="fine" style="text-align:center">Up to 3 order texts from Ivelisse Designs. Msg &amp; data rates may apply. Reply STOP to opt out, HELP for help. <a href="privacy.html" target="_blank" rel="noopener">Privacy Policy</a> · <a href="sms-terms.html" target="_blank" rel="noopener">Terms &amp; Conditions</a></p></div>
        <p class="err" id="err" role="alert"></p>`;
      bar = `<button class="btn sec" id="back" type="button">Back</button><button class="btn" id="send" type="button" ${st.sending ? 'disabled' : ''}>${st.sending ? 'Sending…' : 'Send for engraving'}</button>`;
    }
    $app.innerHTML = `<div class="page">${head(st.step > 1)}<main class="content">${body}</main><div class="bar">${bar}</div></div>`;
    bind();
  }
  function bind() {
    $app.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { st.cat = b.dataset.cat; setItem(curCat().items[0].id); render(); });
    $app.querySelectorAll('[data-item]').forEach(b => b.onclick = () => { setItem(b.dataset.item); render(); });
    $app.querySelectorAll('[data-g]').forEach(b => b.onclick = () => { st.opts[b.dataset.g] = b.dataset.c; render(); });
    $app.querySelectorAll('[data-font]').forEach(b => b.onclick = () => { st.font = b.dataset.font; render(); });
    const nm = document.getElementById('nm');
    if (nm) nm.oninput = () => {
      st.name = nm.value.replace(/^\s+/, '');
      document.getElementById('cnt').textContent = `${st.name.length} / 14`;
      document.getElementById('pvn').textContent = st.name || ' ';
      if (!photoFor(ev, order())) document.getElementById('pv').innerHTML = previewHTML(ev, order());
      document.getElementById('next').disabled = !st.name.trim();
    };
    const go = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
    go('next', () => { st.step++; render(); window.scrollTo(0, 0); });
    go('back', () => { st.step--; render(); window.scrollTo(0, 0); });
    go('edit', () => { st.step = 2; render(); setTimeout(() => document.getElementById('nm')?.focus(), 50); });
    go('send', submit);
    const ph = document.getElementById('ph'); if (ph) ph.oninput = () => { st.phone = ph.value; document.getElementById('err').textContent = ''; };
  }
  async function submit() {
    const name = st.name.trim().slice(0, 14);
    const phone = normPhone(st.phone);
    if (phone === null) { document.getElementById('err').textContent = "That number doesn't look right. Use a 10-digit US mobile number, or leave it blank."; document.getElementById('ph')?.focus(); return; }
    const it = curItem();
    // Re-check the event is still taking orders and the piece and choices are still offered.
    try {
      const s = await getDoc(doc(db, 'events', eventId)); const fresh = s.exists() ? s.data() : null;
      if (fresh && fresh.open === false) { document.getElementById('err').textContent = 'Orders just closed for this event.'; return; }
      if (fresh && (!offered(fresh, it.id) || it.groups.some(g => !choicesFor(fresh, it, g).some(c => c.id === st.opts[g.id])))) {
        document.getElementById('err').textContent = 'That just sold out. Pick another and your name will carry over.';
        ev = fresh; st.step = 1; setTimeout(render, 1600); return;
      }
    } catch (e) { /* offline: the order still queues locally */ }
    st.sending = true; render();
    // The order id is fixed for this form visit, so a retry overwrites the same order instead of creating a second one.
    const ref = doc(db, 'events', eventId, 'orders', submitKey);
    // Labels are copied onto the order so the board and exports still read right if the catalog is renamed later.
    const labels = { piece: it.label, opts: it.groups.map(g => ({ g: g.label, c: g.choices.find(c => c.id === st.opts[g.id])?.label || st.opts[g.id], id: st.opts[g.id] })) };
    const data = { uid: user.uid, service: st.cat, item: it.id, opts: { ...st.opts }, labels, font: st.font, name, status: 'queue', engraver: null, createdAt: serverTimestamp(), clientAt: Date.now(), ...(phone ? { phone, textOptIn: true, optInAt: Date.now() } : {}) };
    // One batch: create the order and add it to the bottom of the public line, so the guest's
    // "pieces ahead" count works even when no board is open.
    const batch = writeBatch(db);
    batch.set(ref, data);
    batch.set(doc(db, 'events', eventId, 'public', 'queue'), { ids: arrayUnion(ref.id), updatedAt: serverTimestamp() }, { merge: true });
    batch.commit().catch(() => setDoc(ref, data).catch(e => toast('Could not send: ' + (e.code || e.message))));
    rememberOrder(eventId, { id: ref.id, name });
    location.hash = `#/o/${encodeURIComponent(eventId)}/${ref.id}`;
  }
  // A photo arriving mid-typing only swaps the preview, so the name field keeps focus.
  photoRerender = () => { if (document.activeElement?.id === 'nm') { const pv = document.getElementById('pv'); if (pv) pv.innerHTML = previewHTML(ev, order()); } else render(); };
  render();
}

// ---------- guest status ----------
async function statusPage(eventId, orderId) {
  $app.innerHTML = `<div class="page"><p class="note" style="padding:40px">Loading…</p></div>`;
  await ensureGuest();
  let ev = null, order = null, queue = null, connected = true, lastSig = '';
  // Don't hold the page on the event details; the order itself is what the guest is waiting for.
  getDoc(doc(db, 'events', eventId)).then(s => { ev = s.exists() ? s.data() : null; render(); }).catch(() => {});
  const link = `${baseUrl()}#/o/${encodeURIComponent(eventId)}/${orderId}`;

  function aheadText(n) { return n === 0 ? "you're next" : `${n} ${n === 1 ? 'piece' : 'pieces'} ahead of yours`; }
  function render() {
    if (!order) { $app.innerHTML = `<div class="page"><header class="band">${LOGO}<div class="ev">order ${shortId(orderId)}</div>${WAVE(390)}</header><main class="content"><h1>looking for your <em>order</em></h1><p class="note">If this doesn't change in a few seconds, it may have been placed on a different phone. Ask at the engraving table with your name.</p><a class="btn out" href="#/e/${encodeURIComponent(eventId)}">Back to the form</a></main></div>`; return; }
    const s = order.status, pos = queue ? queue.indexOf(orderId) : -1;
    const sig = s + '|' + pos + '|' + (order.engraver || '');
    const steps = ['in line', order.service === 'calligraphy' ? 'being lettered' : 'being engraved', 'ready'];
    const curIdx = { queue: 0, progress: 1, done: 2, picked: 2 }[s] ?? 0;
    const miles = `<ol class="miles">${steps.map((t, i) => `<li class="${i < curIdx || s === 'picked' ? 'dn' : ''}" ${i === curIdx && s !== 'picked' ? 'aria-current="step"' : ''}><b aria-hidden="true"></b>${t}</li>`).join('')}</ol>`;
    const item = `<div class="mini"><span class="ph">${previewHTML(ev, order)}</span><div><div class="nm">${esc(order.name)}</div><div class="ds">${esc(describe(ev, order, true))}<br>${esc((FONTS[order.font] || '').toLowerCase())}</div></div></div>`;
    const live = `<div class="live ${connected ? '' : 'off'}"><i aria-hidden="true"></i>${connected ? 'Live • updates on its own' : 'Reconnecting… your order is safe'}</div>`;
    const save = `<div class="save"><span>save this link to check later</span><button class="linkbtn" id="copy" type="button">Copy link</button></div>`;
    let html;
    if (s === 'done' || s === 'picked') {
      const pick = ev?.pickupNote || 'at the engraving table';
      html = `<header class="band readyband">${LOGO}
        ${s === 'done' ? `<h1 style="margin-top:8px">it's <em>ready!</em></h1><div style="font-size:1.0625rem;margin-top:6px">pick it up ${esc(pick)}</div><div class="code">${shortId(orderId)}</div><div style="font-size:.875rem;margin-top:8px">show this code</div>`
        : `<h1 style="margin-top:8px">enjoy it, <em>${esc(order.name)}</em></h1><div style="font-size:1.0625rem;margin-top:6px">thanks for celebrating with us</div>`}${WAVE(390)}</header>
        <main class="content"><div class="proof"><span class="ph">${previewHTML(ev, order)}</span><div style="font:800 1.125rem var(--body)">${esc(order.name)}</div><div style="font-size:.875rem;color:var(--muted)">${order.engraver ? 'made by ' + esc(order.engraver) : ''}${tsDate(order.doneAt) ? ' • ' + fmtTime(tsDate(order.doneAt)) : ''}</div></div></main>
        <div class="bar"><a class="btn out" href="#/e/${encodeURIComponent(eventId)}">Personalize another piece</a></div>`;
    } else {
      const state = s === 'progress'
        ? `<div class="eyebrow">it's happening</div><h1>${esc(order.engraver || 'we')} ${order.engraver ? 'is' : 'are'} <em>${order.service === 'calligraphy' ? 'lettering' : 'engraving'}</em> yours</h1>`
        : (pos >= 0 ? `<div class="eyebrow">you're in line</div>${pos === 0 ? `<h1>you're <em>next</em></h1>` : `<div class="big" aria-hidden="true">${pos}</div><h1 style="font-size:1.5rem;margin-top:4px" aria-hidden="true">${pos === 1 ? 'piece' : 'pieces'} ahead of <em>yours</em></h1><p class="note" style="margin-top:6px">you're #${pos + 1} in line</p>`}`
          : `<div class="eyebrow">you're in line</div><h1>${queue === null ? 'finding your <em>place</em>…' : `we've got <em>yours</em>`}</h1>`);
      html = `<header class="band">${LOGO}<div class="ev">order ${shortId(orderId)}</div>${WAVE(390)}</header>
        <main class="content"><div class="state">${state}</div>
        <p class="vh" role="status" aria-atomic="true" id="announce"></p>
        ${miles}${item}${order.phone ? `<p class="note" style="font-size:.875rem">We'll text ${esc(fmtPhone(order.phone))} when it's ready.</p>` : ''}${save}${live}</main>`;
    }
    $app.innerHTML = `<div class="page">${html}</div>${textButtonHTML()}`;
    const tb = document.getElementById('txtsim'); if (tb) tb.onclick = () => showTextSim(ev, order, pos, link);
    const ann = document.getElementById('announce');
    if (ann && sig !== lastSig) ann.textContent = s === 'progress' ? `${order.engraver || 'Your engraver'} is working on your piece.` : (pos >= 0 ? (pos === 0 ? "You're next." : aheadText(pos) + '.') : "You're in line.");
    if (sig !== lastSig && lastSig && s === 'done') { try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) {} document.title = '✓ Ready — Ivelisse'; }
    lastSig = sig;
    const c = document.getElementById('copy');
    if (c) c.onclick = () => (navigator.clipboard?.writeText(link) || Promise.reject()).then(() => toast('Link copied')).catch(() => toast(link));
  }
  let stopOrder = null;
  const listen = () => {
    if (stopOrder) stopOrder();
    stopOrder = onSnapshot(doc(db, 'events', eventId, 'orders', orderId), { includeMetadataChanges: true }, s => {
      connected = !s.metadata.fromCache; order = s.exists() ? s.data({ serverTimestamps: 'estimate' }) : null; render();
    }, () => render());
  };
  listen();
  unsubs.push(() => stopOrder && stopOrder());
  // Only trust the line once it comes from the server. Right after submitting, the phone's own pending
  // write makes the line look like it holds just this order, which would wrongly say "you're next".
  unsubs.push(onSnapshot(doc(db, 'events', eventId, 'public', 'queue'), { includeMetadataChanges: true }, s => {
    if (s.metadata.hasPendingWrites || s.metadata.fromCache) return;
    queue = s.exists() ? (s.data().ids || []) : []; render();
  }, () => {}));
  // Phones pause live connections in the background; re-check straight from the server when the page
  // comes back on screen and every 15s until the piece is ready, so the status can't get stuck.
  async function refresh(full = true) {
    if (order && (order.status === 'done' || order.status === 'picked')) return;
    try {
      const q = await getDocFromServer(doc(db, 'events', eventId, 'public', 'queue')).catch(() => null);
      if (q) queue = q.exists() ? (q.data().ids || []) : [];
      if (full || !order) { const o = await getDocFromServer(doc(db, 'events', eventId, 'orders', orderId)); if (o.exists()) order = o.data({ serverTimestamps: 'estimate' }); }
      connected = true; render();
    } catch (e) { connected = false; render(); }
  }
  const vis = () => { if (document.visibilityState === 'visible') { listen(); refresh(); } };
  document.addEventListener('visibilitychange', vis); addEventListener('focus', vis); addEventListener('pageshow', vis);
  unsubs.push(() => { document.removeEventListener('visibilitychange', vis); removeEventListener('focus', vis); removeEventListener('pageshow', vis); });
  // Live listeners usually win, but phones can be slow to open them. Fetch right away, then
  // re-check the line every 5s and the order itself every 10s until the piece is ready.
  refresh();
  let tick = 0;
  timers.push(setInterval(() => { tick++; refresh(tick % 2 === 0); }, 5000));
  photoRerender = render;
  render();
}

// ---------- text preview ----------
// Shows guests what the order texts look like, laid out like the iPhone Messages app.
// Nothing is sent; it's a simulation built from this order.
const TEXT_FROM = '+1 (469) 398-8476';
let textCssDone = false;
function textCss() {
  if (textCssDone) return; textCssDone = true;
  const s = document.createElement('style');
  s.textContent = `
.txtbtn{position:fixed;top:max(10px,env(safe-area-inset-top));right:10px;z-index:40;display:flex;align-items:center;gap:6px;min-height:40px;padding:0 14px;border:0;border-radius:20px;background:rgba(255,255,255,.94);color:#2b2522;font:700 .875rem var(--body);box-shadow:0 2px 10px rgba(0,0,0,.18);cursor:pointer}
.txtbtn svg{width:18px;height:18px}
.ims-wrap{position:fixed;inset:0;z-index:100;background:rgba(20,14,10,.55);display:flex;align-items:center;justify-content:center;animation:imsFade .2s ease}
@keyframes imsFade{from{opacity:0}to{opacity:1}}
.ims{width:100%;height:100%;background:#fff;display:flex;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Helvetica,Arial,sans-serif;color:#000;-webkit-font-smoothing:antialiased;overflow:hidden;position:relative}
@media (min-width:520px) and (min-height:760px){.ims{width:390px;height:844px;max-height:94vh;border-radius:54px;border:11px solid #111;box-shadow:0 30px 80px rgba(0,0,0,.45)}.ims .ims-island{display:block}}
.ims-status{height:47px;flex:none;display:flex;align-items:center;justify-content:space-between;padding:0 30px 0 34px;font-weight:600;font-size:16px;letter-spacing:-.2px;position:relative}
.ims-island{display:none;position:absolute;top:10px;left:50%;transform:translateX(-50%);width:122px;height:35px;border-radius:20px;background:#000}
.ims-icons{display:flex;gap:6px;align-items:center}
.ims-icons svg{height:12px;width:auto;display:block}
.ims-head{flex:none;display:grid;grid-template-columns:70px 1fr 70px;align-items:start;padding:2px 8px 8px;background:rgba(249,249,249,.94);border-bottom:.5px solid rgba(0,0,0,.18)}
.ims-back{border:0;background:none;color:#007aff;font-size:17px;display:flex;align-items:center;gap:2px;padding:10px 0 0;cursor:pointer;font-family:inherit}
.ims-back svg{width:12px;height:20px}
.ims-who{display:flex;flex-direction:column;align-items:center;gap:4px}
.ims-av{width:48px;height:48px;border-radius:50%;background:linear-gradient(#a5abb8,#858a96);display:flex;align-items:flex-end;justify-content:center;overflow:hidden}
.ims-av svg{width:40px;height:40px}
.ims-name{font-size:11px;color:#000;display:flex;align-items:center;gap:2px}
.ims-name svg{width:6px;height:10px;opacity:.4}
.ims-body{flex:1;overflow-y:auto;padding:10px 16px 14px;display:flex;flex-direction:column;-webkit-overflow-scrolling:touch}
.ims-meta{text-align:center;font-size:11px;color:#8a8a8e;margin:14px 0 8px;line-height:1.35}
.ims-meta b{font-weight:600}
.ims-row{display:flex;margin-top:2px;animation:imsPop .28s cubic-bezier(.2,.9,.3,1.2)}
@keyframes imsPop{from{opacity:0;transform:translateY(8px) scale(.96)}to{opacity:1;transform:none}}
.ims-b{position:relative;max-width:75%;background:#e9e9eb;color:#000;border-radius:18px;padding:7px 12px 8px;font-size:17px;line-height:1.29;letter-spacing:-.2px;word-wrap:break-word;overflow-wrap:anywhere}
.ims-b a{color:#000;text-decoration:underline}
.ims-row.tail .ims-b:not(.ims-pic)::before{content:'';position:absolute;left:-7px;bottom:0;width:20px;height:18px;background:#e9e9eb;border-bottom-right-radius:16px 14px}
.ims-row.tail .ims-b:not(.ims-pic)::after{content:'';position:absolute;left:-26px;bottom:0;width:26px;height:18px;background:#fff;border-bottom-right-radius:10px}
.ims-pic{padding:0;overflow:hidden;width:220px;max-width:62%;background:#e9e9eb;border-radius:18px}
.ims-pic img,.ims-pic svg{display:block;width:100%;height:auto}
.ims-pic .ph-wrap{aspect-ratio:3/4;display:flex;align-items:center;justify-content:center;background:#f4ece5}
.ims-pic .ph-wrap>*{width:100%;height:100%;object-fit:cover}
.ims-card{max-width:75%;width:260px;border-radius:18px;overflow:hidden;background:#e9e9eb;margin-top:2px}
.ims-card .hero{height:120px;background:linear-gradient(135deg,#b85c3a,#d9aa98);display:flex;align-items:center;justify-content:center;color:#fff8f0;font:400 30px var(--script,cursive)}
.ims-card .meta{padding:8px 12px 10px;font-size:13px;line-height:1.3}
.ims-card .t{font-weight:600;color:#000}
.ims-card .d{color:#8a8a8e}
.ims-typing{display:flex;gap:4px;align-items:center;padding:12px 14px}
.ims-typing i{width:8px;height:8px;border-radius:50%;background:#8e8e93;animation:imsDot 1.2s infinite}
.ims-typing i:nth-child(2){animation-delay:.15s}.ims-typing i:nth-child(3){animation-delay:.3s}
@keyframes imsDot{0%,60%,100%{opacity:.35;transform:none}30%{opacity:1;transform:translateY(-2px)}}
.ims-foot{flex:none;display:flex;align-items:center;gap:10px;padding:6px 12px 10px;background:#fff}
.ims-plus{width:34px;height:34px;border-radius:50%;background:#eeeef0;display:flex;align-items:center;justify-content:center;flex:none}
.ims-plus svg{width:16px;height:16px}
.ims-field{flex:1;height:36px;border:1px solid #c7c7cc;border-radius:18px;display:flex;align-items:center;justify-content:space-between;padding:0 6px 0 14px;color:#b0b0b5;font-size:16px}
.ims-field svg{width:18px;height:18px}
.ims-home{flex:none;height:22px;display:flex;align-items:center;justify-content:center}
.ims-home i{width:134px;height:5px;border-radius:3px;background:#000}
.ims-note{flex:none;display:flex;align-items:center;justify-content:center;gap:8px;padding:6px 12px 2px;font-size:11px;color:#8a8a8e}
.ims-replay{border:0;background:none;color:#007aff;font:600 12px -apple-system,system-ui,sans-serif;padding:4px 6px;cursor:pointer}
@media (prefers-reduced-motion:reduce){.ims-row,.ims-wrap{animation:none}.ims-typing i{animation:none}}`;
  document.head.appendChild(s);
}
const TXT_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12z"/></svg>`;
function textButtonHTML() { textCss(); return `<button class="txtbtn" id="txtsim" type="button" aria-label="Preview the texts you'll get">${TXT_ICON}Texts</button>`; }

function showTextSim(ev, order, pos, link) {
  textCss();
  const name = order.name || 'there';
  const piece = pieceLabel(order).toLowerCase() || 'piece';
  const line = pos >= 0 ? pos + 1 : 3;
  const pick = ev?.pickupNote || 'at the engraving table';
  const t0 = tsDate(order.createdAt) || tsDate(order.clientAt) || new Date();
  const at = m => new Date(t0.getTime() + m * 60000);
  const clock = d => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const now = new Date();
  const linkA = u => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`;
  const card = (title, domain, hero) => `<div class="ims-card"><div class="hero">${hero}</div><div class="meta"><div class="t">${esc(title)}</div><div class="d">${esc(domain)}</div></div></div>`;
  // Each step: a centered timestamp (optional) and the bubbles that arrive together.
  const steps = [
    { meta: `<b>Text Message</b><br>Today ${clock(at(0))}`, items: [
      `Ivelisse Designs: Thanks, ${esc(name)}! Your ${esc(piece)} order is in and you're #${line} in line. Track it here: ${linkA(link)} Reply STOP to opt out, HELP for help.`,
      { card: card('Your order • Ivelisse Designs', link.replace(/^https?:\/\//, '').split('/')[0], 'Ivelisse') }] },
    { meta: `Today ${clock(at(18))}`, items: [`Ivelisse Designs: ${esc(name)}, your ${esc(piece)} is ready! Pick it up ${esc(pick)}. Reply STOP to opt out.`] }
  ];

  const wrap = document.createElement('div');
  wrap.className = 'ims-wrap';
  wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true'); wrap.setAttribute('aria-label', 'Preview of your order texts');
  wrap.innerHTML = `<div class="ims">
    <div class="ims-status"><span>${clock(now).replace(/\s?[AP]M$/i, '')}</span><span class="ims-island"></span>
      <span class="ims-icons"><svg viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>
      <svg viewBox="0 0 16 12"><path d="M8 2.6c2.2 0 4.2.9 5.7 2.3l1.1-1.1A9.6 9.6 0 0 0 8 1 9.6 9.6 0 0 0 1.2 3.8l1.1 1.1A8 8 0 0 1 8 2.6zm0 3.3c1.3 0 2.5.5 3.4 1.4l1.1-1.1A6.4 6.4 0 0 0 8 4.3a6.4 6.4 0 0 0-4.5 1.9l1.1 1.1A4.8 4.8 0 0 1 8 5.9zm0 3.3a1.6 1.6 0 0 0-1.1.5L8 11l1.1-1.3A1.6 1.6 0 0 0 8 9.2z"/></svg>
      <svg viewBox="0 0 27 12"><rect x=".5" y=".5" width="22" height="11" rx="3.2" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="16" height="8" rx="2"/><path d="M24 4v4c.8-.3 1.4-1.1 1.4-2s-.6-1.7-1.4-2z" opacity=".4"/></svg></span></div>
    <div class="ims-head"><button class="ims-back" type="button" aria-label="Close preview"><svg viewBox="0 0 12 20"><path d="M10 2 2 10l8 8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <div class="ims-who"><div class="ims-av"><svg viewBox="0 0 40 40" fill="#fff"><circle cx="20" cy="15" r="8"/><path d="M4 40c0-9 7-15 16-15s16 6 16 15z"/></svg></div><div class="ims-name">${TEXT_FROM}<svg viewBox="0 0 6 10"><path d="M1 1l4 4-4 4" fill="none" stroke="#000" stroke-width="1.5"/></svg></div></div><span></span></div>
    <div class="ims-body" aria-live="polite"></div>
    <div class="ims-note"><span>Preview only. No texts were sent.</span><button class="ims-replay" type="button">Replay</button></div>
    <div class="ims-foot"><span class="ims-plus"><svg viewBox="0 0 16 16"><path d="M8 2v12M2 8h12" stroke="#8e8e93" stroke-width="2" stroke-linecap="round"/></svg></span>
      <span class="ims-field">Text Message • SMS<svg viewBox="0 0 24 24" fill="none" stroke="#b0b0b5" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></span></div>
    <div class="ims-home"><i></i></div></div>`;
  document.body.appendChild(wrap);
  const body = wrap.querySelector('.ims-body');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let timer = null, alive = true;
  const wait = ms => new Promise(r => { timer = setTimeout(r, reduce ? 0 : ms); });
  const scroll = () => body.scrollTo({ top: body.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
  function bubble(it, tail) {
    const row = document.createElement('div'); row.className = 'ims-row' + (tail ? ' tail' : '');
    if (typeof it === 'string') row.innerHTML = `<div class="ims-b">${it}</div>`;
    else if (it.pic) row.innerHTML = `<div class="ims-b ims-pic"><div class="ph-wrap">${it.pic}</div></div>`;
    else row.innerHTML = it.card;
    body.appendChild(row); scroll();
  }
  async function play() {
    body.innerHTML = '';
    for (const st of steps) {
      if (!alive) return;
      const m = document.createElement('div'); m.className = 'ims-meta'; m.innerHTML = st.meta; body.appendChild(m);
      for (let i = 0; i < st.items.length; i++) {
        const it = st.items[i];
        if (typeof it === 'string' || it.pic) {
          const ty = document.createElement('div'); ty.className = 'ims-row tail'; ty.innerHTML = `<div class="ims-b ims-typing"><i></i><i></i><i></i></div>`;
          body.appendChild(ty); scroll(); await wait(1100); if (!alive) return; ty.remove();
        } else await wait(250);
        if (!alive) return;
        const lastText = st.items.slice(i + 1).every(x => typeof x !== 'string' && !x.pic);
        bubble(it, (typeof it === 'string' || it.pic) && lastText);
      }
      await wait(1300);
    }
  }
  function close() { alive = false; clearTimeout(timer); removeEventListener('keydown', key); wrap.remove(); document.getElementById('txtsim')?.focus(); }
  const key = e => { if (e.key === 'Escape') close(); };
  addEventListener('keydown', key);
  wrap.querySelector('.ims-back').onclick = close;
  wrap.onclick = e => { if (e.target === wrap) close(); };
  wrap.querySelector('.ims-replay').onclick = () => { alive = false; clearTimeout(timer); setTimeout(() => { alive = true; play(); }, 0); };
  wrap.querySelector('.ims-back').focus();
  play();
}

// ---------- demo event ----------
// A practice event with sample orders in every stage. Reset wipes its orders (including any test
// orders placed through the guest form) and puts the samples back. Real events are never touched.
const DEMO_ID = 'demo';
const DEMO_ENGRAVERS = ['Steph', 'Veronica', 'Christina', 'DeVaughn'];
const DEMO_ORDERS = [
  // [id, name, item, color, addon, font, status, engraver, minutes ago submitted, started, ready, picked up]
  ['demo-r3k8', 'Harper', 'bagtag', 'black', 'none', 'script', 'picked', 'Steph', 48, 44, 39, 35],
  ['demo-w5n2', 'Ethan', 'tumbler', 'black', 'stars', 'serif', 'picked', 'Veronica', 45, 41, 34, 30],
  ['demo-h7q4', 'Camila', 'bagtag', 'blush', 'heart', 'script', 'done', 'Christina', 38, 33, 27, null],
  ['demo-t9b6', 'Noah', 'tumbler', 'white', 'none', 'serif', 'done', 'Steph', 34, 28, 21, null],
  ['demo-m2x7', 'Ava', 'bagtag', 'tan', 'stars', 'script', 'done', 'Veronica', 30, 24, 16, null],
  ['demo-c4j9', 'Priya', 'tumbler', 'terracotta', 'heart', 'script', 'progress', 'Steph', 22, 5, null, null],
  ['demo-p6d3', 'Jordan', 'bagtag', 'black', 'stars', 'serif', 'progress', 'Veronica', 19, 3, null, null],
  ['demo-k8f5', 'Maya', 'bagtag', 'tan', 'none', 'script', 'queue', null, 14, null, null, null],
  ['demo-y3g7', 'Liam', 'tumbler', 'black', 'none', 'serif', 'queue', null, 11, null, null, null],
  ['demo-b5v2', 'Sofia', 'bagtag', 'blush', 'heart', 'script', 'queue', null, 7, null, null, null],
  ['demo-z7s4', 'Zoe', 'tumbler', 'white', 'stars', 'script', 'queue', null, 3, null, null, null]
];
async function resetDemo() {
  const evRef = doc(db, 'events', DEMO_ID);
  const old = await getDoc(evRef).catch(() => null);
  const prev = old && old.exists() ? old.data() : null;
  const today = new Date(); const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  if (await isStaff()) await setDoc(evRef, { name: 'Demo event', date, engravers: DEMO_ENGRAVERS, items: { bagtag: true, tumbler: true }, hidden: prev?.hidden || {},
    photos: prev?.photos || {}, pickupNote: prev?.pickupNote || 'at the engraving table', open: true, demo: true, createdAt: prev?.createdAt || serverTimestamp() });
  // Clear every order in the demo event.
  const snap = await getDocs(collection(db, 'events', DEMO_ID, 'orders'));
  for (let i = 0; i < snap.docs.length; i += 400) { const b = writeBatch(db); snap.docs.slice(i, i + 400).forEach(d => b.delete(d.ref)); await b.commit(); }
  // Orders have to start in the queue (same rule guests follow), then get moved to their stage.
  const ago = m => m == null ? null : Timestamp.fromMillis(Date.now() - m * 60000);
  const make = writeBatch(db), place = writeBatch(db);
  DEMO_ORDERS.forEach(([id, name, item, color, addon, font, status, engraver, sub, started, ready, picked]) => {
    const ref = doc(db, 'events', DEMO_ID, 'orders', id);
    make.set(ref, { uid: user.uid, service: 'engraving', item, opts: { color, addon }, font, name, status: 'queue', engraver: null, createdAt: ago(sub), clientAt: Date.now() - sub * 60000, demo: true });
    if (status !== 'queue') place.update(ref, { status, engraver, startedAt: ago(started), doneAt: ago(ready), pickedAt: ago(picked), updatedAt: serverTimestamp() });
  });
  await make.commit();
  place.set(doc(db, 'events', DEMO_ID, 'public', 'queue'), { ids: DEMO_ORDERS.filter(o => o[6] === 'queue').map(o => o[0]), updatedAt: serverTimestamp() });
  await place.commit();
}
async function confirmResetDemo(exists) {
  if (exists && !confirm('Reset the demo event? This clears every order in it and puts the sample orders back. Real events are not touched.')) return false;
  try { await resetDemo(); toast(exists ? 'Demo reset' : 'Demo event ready'); return true; }
  catch (e) { toast('Demo reset failed: ' + (e.code || e.message)); return false; }
}

// ---------- board ----------
async function boardPage(eventId) {
  let ev = null, orders = [], fromCache = false, lastQueueSig = '', dragging = false, openWho = null, pickupQuery = '';
  const online = () => navigator.onLine && !fromCache;
  unsubs.push(onSnapshot(doc(db, 'events', eventId), s => { ev = s.exists() ? s.data() : null; render(); }));
  unsubs.push(onSnapshot(query(collection(db, 'events', eventId, 'orders'), orderBy('createdAt')), { includeMetadataChanges: true }, s => {
    orders = s.docs.map(d => ({ id: d.id, pending: d.metadata.hasPendingWrites, ...d.data({ serverTimestamps: 'estimate' }) }));
    fromCache = s.metadata.fromCache; render(); syncQueue();
  }));
  const onl = () => render(); addEventListener('online', onl); addEventListener('offline', onl);
  unsubs.push(() => { removeEventListener('online', onl); removeEventListener('offline', onl); });
  timers.push(setInterval(() => render(), 30000)); // refresh wait ages

  function syncQueue() {
    const ids = orders.filter(o => o.status === 'queue').map(o => o.id), sig = ids.join(',');
    if (sig === lastQueueSig) return; lastQueueSig = sig;
    setDoc(doc(db, 'events', eventId, 'public', 'queue'), { ids, updatedAt: serverTimestamp() }).catch(() => {});
  }
  const engravers = () => (ev?.engravers?.length ? ev.engravers : ['Steph']);
  const working = e => orders.find(o => o.status === 'progress' && o.engraver === e);
  const freeEngravers = () => engravers().filter(e => !working(e));
  const mins = o => { const d = tsDate(o.createdAt) || tsDate(o.clientAt); return d ? Math.max(0, Math.round((Date.now() - d) / 60000)) : 0; };
  const pendChip = o => o.pending ? `<div class="pend">${online() ? 'Saving…' : 'Offline • move pending'}</div>` : '';

  function queueCard(o, free, i) {
    const m = mins(o);
    const action = free.length === 0 ? `<button class="go" type="button" disabled>All engravers busy</button>`
      : free.length === 1 ? `<button class="go" type="button" data-start="${o.id}" data-who="${esc(free[0])}">Start with ${esc(free[0])}</button>`
      : `<button class="go" type="button" data-pick="${o.id}" aria-expanded="${openWho === o.id}">Start ▾</button>`;
    return `<div class="qc" data-id="${o.id}"><span class="ph">${previewHTML(ev, o)}</span><div class="nm"><span class="pos" aria-label="Position ${i + 1}">${i + 1}</span>${esc(o.name)}</div><div class="ds">#${shortId(o.id)} • ${esc(describe(ev, o, true))} • ${esc((FONTS[o.font] || '').toLowerCase())}${o.phone ? ' • <b class="txt">gets texts</b>' : ''}</div>
      <div class="ft"><span class="age ${m >= 10 ? 'hot' : ''}">waiting ${m} min</span>${action}</div>
      ${openWho === o.id ? `<div class="who">${free.map(e => `<button type="button" data-start="${o.id}" data-who="${esc(e)}">${esc(e)}</button>`).join('')}</div>` : ''}${pendChip(o)}</div>`;
  }
  function nowCard(o) {
    const st = tsDate(o.startedAt); const m = st ? Math.max(0, Math.round((Date.now() - st) / 60000)) : 0;
    return `<div class="now" data-id="${o.id}"><div class="top"><span class="ph">${previewHTML(ev, o)}</span><div><div class="nm">${esc(o.name)}</div><div class="ds">#${shortId(o.id)} • ${esc(describe(ev, o, true))}<br>${esc((FONTS[o.font] || '').toLowerCase())} • ${m} min in</div></div></div>
      <button class="rd" type="button" data-ready="${o.id}">Mark ready ✓</button>${pendChip(o)}</div>`;
  }
  function render() {
    if (dragging) return;
    if (!ev) { $app.innerHTML = `<div class="page"><p class="note" style="padding:40px">Loading board…</p></div>`; return; }
    const dlgOpen = document.getElementById('pk')?.open; const qv = document.getElementById('find')?.value ?? pickupQuery;
    const free = freeEngravers();
    const q = orders.filter(o => o.status === 'queue');
    const n = { q: q.length, p: orders.filter(o => o.status === 'progress').length, r: orders.filter(o => o.status === 'done').length, x: orders.filter(o => o.status === 'picked').length };
    $app.innerHTML = `<div class="boardpage">
      <header class="bh">${LOGO}<div><div class="t">${esc(ev.name)}</div><div class="sub">${esc(fmtDate(ev.date))}</div></div>
        <div class="k"><span><b>${n.q}</b>waiting</span><span><b>${n.p}</b>engraving</span><span><b>${n.x}</b>picked up</span>
          <button class="pu" id="openpk" type="button">${n.r} to pick up ›</button>
          <span class="lv ${online() ? '' : 'off'}"><i aria-hidden="true"></i>${online() ? 'Live' : 'Offline • moves save on this iPad'}</span>
          ${eventId === DEMO_ID ? '<a href="#" id="resetdemo">reset demo</a>' : ''}<a href="#/admin/${encodeURIComponent(eventId)}">event setup</a><a href="#/catalog">catalog</a></div>${WAVE(1180)}</header>
      <main class="lanes" style="--n:${engravers().length}">
        <section class="lane" aria-label="Queue"><h2>queue <small>first in line at the top</small></h2>
          <div class="drop" data-status="queue" data-engraver="">${q.map((o, i) => queueCard(o, free, i)).join('') || '<p class="note">No one waiting.</p>'}</div></section>
        ${engravers().map(e => { const w = working(e); const made = orders.filter(o => (o.status === 'done' || o.status === 'picked') && o.engraver === e);
          return `<section class="lane" aria-label="${esc(e)}"><h2>${esc(e.toLowerCase())} <small>${made.length} engraved</small></h2>
            <div class="drop zone" data-status="progress" data-engraver="${esc(e)}">${w ? nowCard(w) : `<div class="free"><div><b>free</b>tap Start on a queue card<br>or drag one here</div></div>`}</div>
            <details class="eng"><summary>Engraved (${made.length})</summary><ul>${made.slice().reverse().map(o => `<li>${esc(o.name)} • #${shortId(o.id)} • ${o.status === 'picked' ? 'picked up' : 'waiting for pickup'}</li>`).join('')}</ul></details></section>`; }).join('')}
      </main>
      <dialog class="pickup" id="pk" aria-labelledby="pkt"><div class="pk-in">
        <h2 id="pkt"><span>ready for <em>pickup</em></span><button class="close" id="pkx" type="button" aria-label="Close">×</button></h2>
        <label class="lbl" for="find">Find by code</label>
        <input class="find" id="find" autocapitalize="characters" autocomplete="off" spellcheck="false" maxlength="4" value="${esc(qv)}">
        <div class="pk-list" id="pkl"></div>
        <p class="note" style="font-size:.8125rem;text-align:left">Picked up by mistake? Tap Undo on the message that appears.</p></div></dialog>
    </div>`;
    bindBoard();
    if (dlgOpen) { document.getElementById('pk').showModal(); renderPickup(); const f = document.getElementById('find'); f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
  }
  function renderPickup() {
    const v = (document.getElementById('find')?.value || '').trim().toUpperCase(); pickupQuery = v;
    const list = orders.filter(o => o.status === 'done' && (!v || shortId(o.id).startsWith(v) || o.name.toUpperCase().startsWith(v)));
    document.getElementById('pkl').innerHTML = list.map(o => `<div class="pr ${v.length === 4 && shortId(o.id) === v ? 'match' : ''}"><span class="c">${shortId(o.id)}</span><span class="ph">${previewHTML(ev, o)}</span>
      <div><div style="font:800 1.0625rem var(--body)">${esc(o.name)}</div><div style="font-size:.8125rem;color:var(--muted)">${esc(describe(ev, o))}${o.engraver ? ' • by ' + esc(o.engraver) : ''}</div></div>
      <button class="pk" type="button" data-picked="${o.id}">Picked up</button></div>`).join('') || `<p class="note">${v ? 'No ready piece matches that code.' : 'Nothing waiting for pickup.'}</p>`;
    document.querySelectorAll('[data-picked]').forEach(b => b.onclick = () => {
      const id = b.dataset.picked; move(id, 'picked');
      toast(`${shortId(id)} picked up`, { label: 'Undo', run: () => move(id, 'done', null, true) });
    });
  }
  function bindBoard() {
    document.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => { openWho = openWho === b.dataset.pick ? null : b.dataset.pick; render(); });
    document.querySelectorAll('[data-start]').forEach(b => b.onclick = () => { openWho = null; move(b.dataset.start, 'progress', b.dataset.who); });
    document.querySelectorAll('[data-ready]').forEach(b => b.onclick = () => move(b.dataset.ready, 'done'));
    const rs = document.getElementById('resetdemo'); if (rs) rs.onclick = e => { e.preventDefault(); confirmResetDemo(true); };
    const d = document.getElementById('pk');
    document.getElementById('openpk').onclick = () => { d.showModal(); renderPickup(); document.getElementById('find').focus(); };
    document.getElementById('pkx').onclick = () => { d.close(); document.getElementById('openpk').focus(); };
    document.getElementById('find').oninput = renderPickup;
    document.getElementById('find').onkeydown = e => { if (e.key === 'Enter') e.preventDefault(); };
    // On a phone the cards fill the screen, so a touch has to scroll the page first; dragging needs a longer hold.
    const phone = matchMedia('(max-width:820px)').matches;
    document.querySelectorAll('.drop').forEach(el => new Sortable(el, {
      group: 'orders', animation: 150, delay: phone ? 350 : 120, delayOnTouchOnly: true, touchStartThreshold: phone ? 8 : 1, ...(phone ? { supportPointer: false } : {}), draggable: '.qc,.now', filter: 'button,.who', preventOnFilter: false,
      onStart: () => { dragging = true; },
      onMove: evt => !(evt.to.classList.contains('zone') && evt.to.querySelector('.now') && evt.to !== evt.from), // one piece per engraver
      onEnd: evt => {
        dragging = false;
        const id = evt.item.dataset.id, to = evt.to;
        if (evt.from !== to) move(id, to.dataset.status, to.dataset.engraver || null); else render();
      }
    }));
  }
  function move(id, status, engraver = null, undo = false) {
    const o = orders.find(x => x.id === id); if (!o) return;
    if (status === 'progress' && working(engraver) && working(engraver).id !== id) { toast(`${engraver} already has a piece in progress.`); render(); return; }
    const patch = { status, updatedAt: serverTimestamp() };
    if (status === 'queue') { patch.engraver = null; patch.startedAt = null; patch.doneAt = null; patch.pickedAt = null; }
    if (status === 'progress') { patch.engraver = engraver; patch.startedAt = serverTimestamp(); patch.doneAt = null; patch.pickedAt = null; }
    if (status === 'done') { if (!undo) patch.doneAt = serverTimestamp(); patch.pickedAt = null; }
    if (status === 'picked') patch.pickedAt = serverTimestamp();
    updateDoc(doc(db, 'events', eventId, 'orders', id), patch).catch(e => { toast('That move did not save: ' + (e.code || e.message)); });
  }
  photoRerender = render;
  render();
}

// ---------- export ----------
const fmtStamp = d => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
const minsBetween = (a, b) => (a && b && b >= a) ? Math.round((b - a) / 6000) / 10 : '';
async function exportOrders(eventId, ev) {
  const snap = await getDocs(query(collection(db, 'events', eventId, 'orders'), orderBy('createdAt')));
  const head = ['Order #', 'Name', 'Category', 'Piece', 'Choices', 'Lettering', 'Texts', 'Submitted', 'Handled by', 'Started', 'Ready', 'Picked up', 'Wait in queue (min)', 'Time to make (min)', 'Submit to ready (min)', 'Status'];
  const rows = snap.docs.map(d => {
    const o = d.data();
    const sub = tsDate(o.createdAt), st = tsDate(o.startedAt), dn = (o.status === 'done' || o.status === 'picked') ? tsDate(o.doneAt) : null, pk = o.status === 'picked' ? tsDate(o.pickedAt) : null;
    return [shortId(d.id), o.name, CAT.categories.find(c => c.id === o.service)?.label || o.service || '', pieceLabel(o), choiceLabels(o).map(x => `${x.g}: ${x.c}`).join('; '),
      FONTS[o.font] || o.font || '', o.phone ? 'yes' : '', fmtStamp(sub), o.engraver || '', fmtStamp(st), fmtStamp(dn), fmtStamp(pk), minsBetween(sub, st), minsBetween(st, dn), minsBetween(sub, dn), STATUS_LABEL[o.status] || o.status];
  });
  const cell = v => { const t = String(v ?? ''); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const csv = '\ufeff' + [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = `${eventId}-orders.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`${rows.length} orders exported. In Google Sheets: File → Import → Upload.`);
}

// ---------- staff: event setup, catalog, photos ----------
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const guestUrl = id => `${baseUrl()}#/e/${encodeURIComponent(id)}`;
const qrSvg = url => { const q = qrcode(0, 'M'); q.addData(url); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); };
function downloadQr(url, name) { const q = qrcode(0, 'M'); q.addData(url); q.make(); const l = document.createElement('a'); l.href = q.createDataURL(12, 4); l.download = `qr-${name}.gif`; l.click(); }
const STAFF_TABS = [['setup', '#/admin', 'Event setup'], ['catalog', '#/catalog', 'Catalog'], ['photos', '#/photos', 'Photos']];
const staffHead = (title, tab) => `<header class="band">${LOGO}<div class="ev">${esc(title)}</div>${WAVE(1180)}</header>
  <nav class="snav" aria-label="Staff">${STAFF_TABS.map(([k, h, l]) => `<a href="${h}" ${k === tab ? 'aria-current="page"' : ''}>${l}</a>`).join('')}<span>${esc(user.email)}</span><a href="#" id="out">Sign out</a></nav>`;
function bindStaffHead() { const o = document.getElementById('out'); if (o) o.onclick = e => { e.preventDefault(); signOut(auth).then(() => { location.hash = '#/'; }); }; }
const staffLoading = msg => `<div class="page"><p class="note" style="padding:40px">${esc(msg)}</p></div>`;
const dropHidden = h => Object.fromEntries(Object.entries(h || {}).filter(([, v]) => v === true));
async function listEvents() { return (await getDocs(collection(db, 'events'))).docs.map(d => ({ id: d.id, ...d.data() })); }
const byDateDesc = (a, b) => String(b.date || '').localeCompare(String(a.date || ''));

// The parts of an event's setup that carry over to the next one.
const setupFrom = src => ({ engravers: [...(src.engravers || [])], pickupNote: src.pickupNote || 'at the engraving table',
  items: Object.fromEntries(allPieces().map(({ it }) => [it.id, offered(src, it.id)])), hidden: dropHidden(src.hidden) });

async function adminPage() {
  $app.innerHTML = staffLoading('Loading events…');
  let evs;
  try { evs = await listEvents(); }
  catch (e) { $app.innerHTML = `<div class="wrap"><p class="err">Could not load events: ${esc(e.code || e.message)}</p></div>`; return; }
  const today = todayStr();
  const real = evs.filter(e => e.id !== DEMO_ID);
  const upcoming = real.filter(e => (e.date || '') >= today).sort((a, b) => -byDateDesc(a, b));
  const past = real.filter(e => (e.date || '') < today).sort(byDateDesc);
  const demo = evs.find(e => e.id === DEMO_ID);
  const card = ev => `<a class="evcard" href="#/admin/${encodeURIComponent(ev.id)}"><div><b>${esc(ev.name)}</b><span>${esc(fmtDate(ev.date))} · ${(ev.engravers || []).length} engravers · ${allPieces().filter(p => offered(ev, p.it.id)).length} pieces</span></div>
    <span class="chip ${ev.open === false ? '' : 'on'}">${ev.open === false ? 'Closed' : 'Taking orders'}</span><span class="chev" aria-hidden="true">›</span></a>`;
  $app.innerHTML = `${staffHead('event setup', 'setup')}<main class="wrap">
    <h1>event <em>setup</em></h1>
    <form id="new" class="card newev"><h2>new event</h2>
      <div class="field"><label class="lbl" for="n-name">Event name</label><input id="n-name" required placeholder="Coach · NorthPark"></div>
      <div class="field"><label class="lbl" for="n-date">Date</label><input id="n-date" type="date" required value="${today}"></div>
      <div class="field wide"><label class="lbl" for="n-from">Start from</label><select id="n-from"><option value="">Everything in the catalog</option>
        ${real.slice().sort(byDateDesc).map(e => `<option value="${esc(e.id)}">Copy ${esc(e.name)} · ${esc(fmtDate(e.date))}</option>`).join('')}</select>
        <span class="hint">Copying brings over the engravers, pickup spot, and which pieces and choices are offered.</span></div>
      <button class="btn">Create and set up</button></form>
    <h2 class="sec">upcoming</h2><div class="evlist">${upcoming.map(card).join('') || '<p class="note" style="text-align:left">Nothing scheduled. Create one above.</p>'}</div>
    ${past.length ? `<details class="pastev"><summary>Past events (${past.length})</summary><div class="evlist">${past.map(card).join('')}</div></details>` : ''}
    <h2 class="sec">practice</h2>
    ${demo ? `<div class="evlist">${card(demo)}</div><button class="linkbtn" id="rsdemo" type="button">Reset demo orders</button>`
      : `<p class="note" style="text-align:left">A demo event comes with sample orders in every stage, to try the board.</p><button class="btn out" id="mkdemo" type="button" style="margin-top:10px;width:100%">Create demo event</button>`}
  </main>`;
  bindStaffHead();
  const mk = document.getElementById('mkdemo'); if (mk) mk.onclick = async () => { mk.disabled = true; if (await confirmResetDemo(false)) adminPage(); else mk.disabled = false; };
  const rs = document.getElementById('rsdemo'); if (rs) rs.onclick = () => confirmResetDemo(true);
  document.getElementById('new').onsubmit = async e => {
    e.preventDefault();
    const name = document.getElementById('n-name').value.trim(), date = document.getElementById('n-date').value;
    if (!name || !date) return;
    const src = evs.find(x => x.id === document.getElementById('n-from').value);
    const btn = e.target.querySelector('.btn'); btn.disabled = true;
    try {
      // Never overwrite an existing event that happens to share the name and date.
      const base = slug(`${name}-${date}`) || 'event'; let id = base;
      for (let n = 2; (await getDoc(doc(db, 'events', id))).exists(); n++) id = `${base}-${n}`;
      const setup = src ? setupFrom(src) : { engravers: ['Steph', 'Veronica', 'Christina', 'DeVaughn'], pickupNote: 'at the engraving table', items: Object.fromEntries(allPieces().map(({ it }) => [it.id, true])), hidden: {} };
      await setDoc(doc(db, 'events', id), { name, date, ...setup, photos: {}, open: true, createdAt: serverTimestamp(), ...(src ? { copiedFrom: src.id } : {}) });
      location.hash = `#/admin/${encodeURIComponent(id)}`;
    } catch (err) { btn.disabled = false; toast('Could not create: ' + (err.code || err.message)); }
  };
}

async function setupPage(eventId) {
  $app.innerHTML = staffLoading('Loading event…');
  let ev = null, others = [];
  try { const s = await getDoc(doc(db, 'events', eventId)); ev = s.exists() ? s.data() : null; } catch (e) {}
  if (!ev) { $app.innerHTML = `${staffHead('event setup', 'setup')}<main class="wrap"><h1>event not <em>found</em></h1><p><a href="#/admin">Back to events</a></p></main>`; bindStaffHead(); return; }
  try { others = (await listEvents()).filter(e => e.id !== eventId && e.id !== DEMO_ID).sort(byDateDesc); } catch (e) {}
  const st = { name: ev.name || '', date: ev.date || '', open: ev.open !== false, ...setupFrom(ev) };
  let savedEngravers = [...st.engravers], dirty = false, saving = false, savedName = st.name;
  const url = guestUrl(eventId);
  const legacy = Object.keys(ev.photos || {}).length;
  leaveGuard = () => dirty;

  const chipsHTML = () => st.engravers.map((e, i) => `<span>${esc(e)}<button type="button" data-rm="${i}" aria-label="Remove ${esc(e)}">×</button></span>`).join('') || '<em class="note">No engravers yet.</em>';
  const pieceRow = it => {
    const on = st.items[it.id] === true;
    const shown = { ...ev, items: st.items, hidden: st.hidden };
    return `<div class="prow ${on ? 'on' : ''}"><label class="ptop"><span class="ph">${previewHTML(shown, { item: it.id, opts: firstOpts(shown, it) }, false)}</span>
      <span class="pn"><span><input type="checkbox" data-item="${esc(it.id)}" ${on ? 'checked' : ''}> <b>${esc(it.label)}</b></span><small>${on ? (it.groups.length ? 'Tap a choice to turn it off for this event.' : 'No options; guests just add a name.') : 'Not offered at this event'}</small></span></label>
      ${on ? it.groups.map(g => `<div class="cgrp"><span class="gl">${esc(g.label)}</span><div class="cchips">${g.choices.map(c => { const path = `${it.id}/${g.id}/${c.id}`, off = st.hidden[path] === true;
        return `<button type="button" class="cc" aria-pressed="${!off}" data-ch="${esc(path)}">${g.swatch ? `<i style="background:${esc(c.color || SWATCH[c.id] || '#ccc')}"></i>` : ''}${esc(c.label)}</button>`; }).join('')}</div></div>`).join('') : ''}</div>`;
  };

  function render() {
    $app.innerHTML = `${staffHead('event setup', 'setup')}<main class="wrap setup">
      <a class="backlink" href="#/admin">‹ All events</a>
      <h1>${esc(savedName)}</h1>
      <div class="btnrow"><a class="btn" href="#/board/${encodeURIComponent(eventId)}">Open board</a><a class="btn out" href="#/e/${encodeURIComponent(eventId)}">Preview guest form</a></div>
      ${others.length ? `<section class="card"><h2>copy from another event</h2><p class="hint">Brings over engravers, pickup spot, and pieces and choices. Name, date, and orders stay as they are. Nothing saves until you tap Save.</p>
        <div class="addrow"><label class="vh" for="cp-from">Event to copy</label><select id="cp-from">${others.map(e => `<option value="${esc(e.id)}">${esc(e.name)} · ${esc(fmtDate(e.date))}</option>`).join('')}</select><button class="btn out" id="cp" type="button">Copy</button></div></section>` : ''}
      <section class="card"><h2>details</h2>
        <div class="field"><label class="lbl" for="s-name">Event name</label><input id="s-name" value="${esc(st.name)}"></div>
        <div class="field"><label class="lbl" for="s-date">Date</label><input id="s-date" type="date" value="${esc(st.date)}"></div>
        <div class="field"><label class="lbl" for="s-pick">Where guests pick up (finishes "pick it up …")</label><input id="s-pick" value="${esc(st.pickupNote)}"></div>
        <label class="tog"><input type="checkbox" id="s-open" ${st.open ? 'checked' : ''}> Taking orders <small>Turn off to close the guest form. Pieces already ordered still show on the board.</small></label></section>
      <section class="card"><h2>engravers</h2><p class="hint">Each engraver gets a lane on the board.</p>
        <div class="chips" id="chips">${chipsHTML()}</div>
        <div class="addrow"><label class="vh" for="s-eng">Add an engraver</label><input id="s-eng" placeholder="Name" autocapitalize="words"><button class="btn out" id="addeng" type="button">Add</button></div></section>
      <section class="card"><h2>pieces &amp; choices</h2><p class="hint">Check the pieces this event offers, then tap any choice to switch it off here only. To add pieces or choices, edit the <a href="#/catalog">catalog</a>.</p>
        ${CAT.categories.filter(c => c.items.length).map(c => `<h3 class="cathead">${esc(c.label)}</h3>${c.items.map(pieceRow).join('')}`).join('') || '<p class="note">The catalog is empty.</p>'}</section>
      <section class="card"><h2>guest link &amp; QR</h2>
        <div class="share"><div class="qr" aria-label="QR code for the guest form">${qrSvg(url)}</div>
          <div class="shareinfo"><div class="url">${esc(url)}</div><div class="btnrow"><button class="btn out" id="copy" type="button">Copy link</button><button class="btn out" id="dlqr" type="button">Download QR to print</button></div></div></div></section>
      <section class="card"><h2>after the event</h2><p class="hint">Orders with times for each step, as a file Google Sheets opens.</p>
        <button class="btn out" id="export" type="button">Export orders</button>
        ${legacy ? `<p class="hint" style="margin-top:14px">This event still has ${legacy} photo link${legacy === 1 ? '' : 's'} from the old setup, which override the photo library.</p><button class="linkbtn" id="clearlegacy" type="button">Remove old photo links</button>` : ''}</section>
    </main>
    <div class="savebar"><span id="dirty">${dirty ? 'Unsaved changes' : 'All changes saved'}</span><button class="btn" id="save" type="button" ${dirty ? '' : 'disabled'}>Save</button></div>`;
    bind();
  }
  const markDirty = () => { dirty = true; document.getElementById('dirty').textContent = 'Unsaved changes'; document.getElementById('save').disabled = false; };
  function bind() {
    bindStaffHead();
    const bindChips = () => document.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { st.engravers.splice(+b.dataset.rm, 1); document.getElementById('chips').innerHTML = chipsHTML(); bindChips(); markDirty(); });
    bindChips();
    const engIn = document.getElementById('s-eng');
    const addEng = () => {
      const n = engIn.value.trim(); if (!n) return;
      if (st.engravers.some(e => e.toLowerCase() === n.toLowerCase())) { toast(`${n} is already on the list`); return; }
      st.engravers.push(n); engIn.value = ''; document.getElementById('chips').innerHTML = chipsHTML(); bindChips(); markDirty(); engIn.focus();
    };
    document.getElementById('addeng').onclick = addEng;
    engIn.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addEng(); } };
    [['s-name', 'name'], ['s-date', 'date'], ['s-pick', 'pickupNote']].forEach(([id, k]) => document.getElementById(id).oninput = e => { st[k] = e.target.value; markDirty(); });
    document.getElementById('s-open').onchange = e => { st.open = e.target.checked; markDirty(); };
    document.querySelectorAll('[data-item]').forEach(c => c.onchange = () => { st.items[c.dataset.item] = c.checked; dirty = true; render(); });
    document.querySelectorAll('[data-ch]').forEach(b => b.onclick = () => { const p = b.dataset.ch; if (st.hidden[p]) delete st.hidden[p]; else st.hidden[p] = true; b.setAttribute('aria-pressed', String(!st.hidden[p])); markDirty(); });
    const cp = document.getElementById('cp');
    if (cp) cp.onclick = () => { const src = others.find(e => e.id === document.getElementById('cp-from').value); if (!src) return; Object.assign(st, setupFrom(src)); dirty = true; render(); toast(`Copied setup from ${src.name}. Review it, then Save.`); };
    document.getElementById('copy').onclick = () => (navigator.clipboard?.writeText(url) || Promise.reject()).then(() => toast('Guest link copied')).catch(() => toast(url));
    document.getElementById('dlqr').onclick = () => downloadQr(url, eventId);
    document.getElementById('export').onclick = async () => { try { await exportOrders(eventId, ev); } catch (err) { toast('Export failed: ' + (err.code || err.message)); } };
    const cl = document.getElementById('clearlegacy');
    if (cl) cl.onclick = async () => { try { await updateDoc(doc(db, 'events', eventId), { photos: {} }); ev.photos = {}; toast('Old photo links removed'); render(); } catch (err) { toast('Could not remove: ' + (err.code || err.message)); } };
    document.getElementById('save').onclick = save;
  }
  async function save() {
    if (saving || !dirty) return;
    if (!st.name.trim() || !st.date) { toast('The event needs a name and a date.'); return; }
    if (!st.engravers.length) { toast('Add at least one engraver.'); return; }
    const on = allPieces().filter(({ it }) => st.items[it.id]);
    if (!on.length) { toast('Offer at least one piece.'); return; }
    const empty = on.flatMap(({ it }) => it.groups.filter(g => !g.choices.some(c => !st.hidden[`${it.id}/${g.id}/${c.id}`])).map(g => `${it.label}: ${g.label}`));
    if (empty.length) { toast(`Leave at least one choice on for ${empty[0]}.`); return; }
    saving = true; const b = document.getElementById('save'); b.disabled = true; b.textContent = 'Saving…';
    try {
      // Removing an engraver hides their lane, so don't allow it while they have a piece in progress.
      const removed = savedEngravers.filter(e => !st.engravers.includes(e));
      if (removed.length) {
        const busy = (await getDocs(collection(db, 'events', eventId, 'orders'))).docs.map(d => d.data()).find(o => o.status === 'progress' && removed.includes(o.engraver));
        if (busy) { toast(`${busy.engraver} has ${busy.name}'s piece in progress. Finish or move it before removing them.`); return; }
      }
      await updateDoc(doc(db, 'events', eventId), { name: st.name.trim(), date: st.date, pickupNote: st.pickupNote.trim() || 'at the engraving table', open: st.open,
        engravers: st.engravers, items: st.items, hidden: dropHidden(st.hidden), updatedAt: serverTimestamp() });
      savedEngravers = [...st.engravers]; savedName = st.name.trim(); dirty = false; render(); toast('Saved');
    } catch (err) { toast('Could not save: ' + (err.code || err.message)); }
    finally { saving = false; const s = document.getElementById('save'); if (s) { s.textContent = 'Save'; s.disabled = !dirty; } }
  }
  const leave = e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  addEventListener('beforeunload', leave); unsubs.push(() => removeEventListener('beforeunload', leave));
  photoRerender = render;
  render();
}

// ---------- catalog editor ----------
async function catalogPage() {
  $app.innerHTML = staffLoading('Loading catalog…');
  await loadCatalog(true);
  const cat = JSON.parse(JSON.stringify(CAT));
  const opened = new Set();
  let dirty = false, saving = false;
  leaveGuard = () => dirty;
  const DRAW = [['bagtag', 'Bag tag drawing'], ['tumbler', 'Tumbler drawing'], ['card', 'Card with the name']];
  const at = el => { const d = el.closest('[data-ci]').dataset; return { c: cat.categories[+d.ci], it: d.ii != null ? cat.categories[+d.ci].items[+d.ii] : null }; };
  const grp = el => at(el).it.groups[+el.closest('[data-gi]').dataset.gi];
  const move = (arr, i, d) => { const j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; };
  const tools = (kind, i, n) => `<span class="tools"><button type="button" data-up="${kind}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button><button type="button" data-down="${kind}" ${i === n - 1 ? 'disabled' : ''} aria-label="Move down">↓</button><button type="button" data-del="${kind}" aria-label="Delete">×</button></span>`;

  const groupHTML = (g, gi, n) => `<div class="gedit" data-gi="${gi}">
    <div class="ghead"><label class="vh">Option group name</label><input class="gname" data-f="group" value="${esc(g.label)}" placeholder="e.g. Finish, Size, Detail">
      <label class="sw-tog"><input type="checkbox" data-swatch ${g.swatch ? 'checked' : ''}> color dots</label>${tools('group', gi, n)}</div>
    <div class="chlist">${g.choices.map((c, xi) => `<span class="chi" data-xi="${xi}">${g.swatch ? `<input type="color" data-f="color" value="${esc(c.color || SWATCH[c.id] || '#cccccc')}" aria-label="${esc(c.label)} color">` : ''}<input data-f="choice" value="${esc(c.label)}" aria-label="Choice name"><button type="button" data-del="choice" aria-label="Remove ${esc(c.label)}">×</button></span>`).join('') || '<em class="hint">No choices yet.</em>'}</div>
    <div class="addrow"><input data-newchoice placeholder="Add a choice, e.g. Navy" aria-label="New choice"><button class="btn out" type="button" data-addchoice>Add</button></div></div>`;
  const pieceHTML = (it, ci, ii, n) => `<details class="pedit" data-ci="${ci}" data-ii="${ii}" ${opened.has(it) ? 'open' : ''}>
    <summary><span class="ph">${drawFor(it)}</span><span class="pn"><b>${esc(it.label || 'Untitled piece')}</b><small>${it.groups.map(g => `${esc(g.label)} (${g.choices.length})`).join(' · ') || 'no options'}</small></span>${tools('piece', ii, n)}</summary>
    <div class="pbody">
      <div class="two"><div class="field"><label class="lbl">Piece name</label><input data-f="piece" value="${esc(it.label)}" placeholder="e.g. Wine glass"></div>
        <div class="field"><label class="lbl">Material line <span class="hint">optional, shown under the pieces</span></label><input data-f="material" value="${esc(it.material || '')}" placeholder="e.g. crystal"></div></div>
      <div class="two"><div class="field"><label class="lbl">Preview when there's no photo</label><select data-f="preview">${DRAW.map(([k, l]) => `<option value="${k}" ${it.preview === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label class="lbl">Category</label><select data-movecat>${cat.categories.map((c, j) => `<option value="${j}" ${j === ci ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></div></div>
      <h4 class="gtitle">Option groups <span class="hint">guests pick one of each, in this order</span></h4>
      ${it.groups.map((g, gi) => groupHTML(g, gi, it.groups.length)).join('') || '<p class="hint">No options: guests pick the piece and add a name.</p>'}
      <button class="btn out addg" type="button" data-addgroup>+ Add option group</button>
    </div></details>`;
  const drawFor = it => { const sg = it.groups.find(g => g.swatch), c0 = sg?.choices[0];
    return window.EngravePreview.renderPreview({ item: it.preview || 'card', color: c0?.id, hex: c0?.color, addon: 'none', name: '', font: 'script' }); };

  function render() {
    const y = scrollY;
    $app.innerHTML = `${staffHead('catalog', 'catalog')}<main class="wrap catalog">
      <h1>the <em>catalog</em></h1>
      <p class="hint">Categories hold pieces. Each piece has its own option groups (finish, size, detail…), shown to guests in this order. Every event picks which pieces and choices it offers in <a href="#/admin">Event setup</a>. Photos follow each piece's first two groups.</p>
      ${cat.categories.map((c, ci) => `<section class="catsec" data-ci="${ci}">
        <div class="cathdr"><label class="vh">Category name</label><input class="catname" data-f="cat" value="${esc(c.label)}" placeholder="Category name">${tools('cat', ci, cat.categories.length)}</div>
        ${c.items.map((it, ii) => pieceHTML(it, ci, ii, c.items.length)).join('') || '<p class="hint">No pieces in this category yet.</p>'}
        <button class="btn out addp" type="button" data-addpiece>+ Add a piece to ${esc(c.label || 'this category')}</button></section>`).join('')}
      <button class="btn out" type="button" id="addcat" style="width:100%;margin-top:18px">+ Add category</button>
    </main>
    <div class="savebar"><span id="dirty">${dirty ? 'Unsaved changes' : 'All changes saved'}</span><button class="btn" id="save" type="button" ${dirty ? '' : 'disabled'}>Save catalog</button></div>`;
    bind(); scrollTo(0, y);
  }
  const markDirty = () => { dirty = true; document.getElementById('dirty').textContent = 'Unsaved changes'; document.getElementById('save').disabled = false; };
  const change = fn => e => { fn(e); dirty = true; render(); };
  function bind() {
    bindStaffHead();
    document.querySelectorAll('details.pedit').forEach(d => d.ontoggle = () => { const { it } = at(d); d.open ? opened.add(it) : opened.delete(it); });
    document.querySelectorAll('[data-f]').forEach(inp => {
      const ev = inp.tagName === 'SELECT' ? 'onchange' : 'oninput';
      inp[ev] = () => {
        const f = inp.dataset.f, v = inp.value;
        if (f === 'cat') at(inp).c.label = v;
        else if (f === 'piece') at(inp).it.label = v;
        else if (f === 'material') at(inp).it.material = v;
        else if (f === 'preview') { at(inp).it.preview = v; dirty = true; render(); return; }
        else if (f === 'group') grp(inp).label = v;
        else if (f === 'choice') grp(inp).choices[+inp.closest('[data-xi]').dataset.xi].label = v;
        else if (f === 'color') grp(inp).choices[+inp.closest('[data-xi]').dataset.xi].color = v;
        markDirty();
      };
    });
    document.querySelectorAll('[data-swatch]').forEach(cb => cb.onchange = change(() => { const g = grp(cb); g.swatch = cb.checked; if (g.swatch) g.choices.forEach(c => { c.color = c.color || SWATCH[c.id] || '#cccccc'; }); }));
    document.querySelectorAll('[data-movecat]').forEach(sel => sel.onchange = change(() => { const { c, it } = at(sel); c.items.splice(c.items.indexOf(it), 1); cat.categories[+sel.value].items.push(it); opened.add(it); }));
    const addChoice = el => { const box = el.closest('.gedit'), inp = box.querySelector('[data-newchoice]'), label = inp.value.trim(); if (!label) { inp.focus(); return; }
      const g = grp(el); if (g.choices.some(c => c.label.toLowerCase() === label.toLowerCase())) { toast(`${label} is already there`); return; }
      g.choices.push({ label, _new: true, ...(g.swatch ? { color: '#cccccc' } : {}) }); dirty = true;
      const gi = box.dataset.gi, ci = box.closest('[data-ci]').dataset.ci, ii = box.closest('[data-ii]').dataset.ii; render();
      document.querySelector(`[data-ci="${ci}"][data-ii="${ii}"] [data-gi="${gi}"] [data-newchoice]`)?.focus(); };
    document.querySelectorAll('[data-addchoice]').forEach(b => b.onclick = () => addChoice(b));
    document.querySelectorAll('[data-newchoice]').forEach(i => i.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addChoice(i); } });
    document.querySelectorAll('[data-addgroup]').forEach(b => b.onclick = change(() => { at(b).it.groups.push({ label: '', swatch: false, choices: [], _new: true }); }));
    document.querySelectorAll('[data-addpiece]').forEach(b => b.onclick = () => { const it = { label: '', material: '', preview: 'card', groups: [], _new: true }; at(b).c.items.push(it); opened.add(it); dirty = true; render(); [...document.querySelectorAll('details.pedit')].find(d => at(d).it === it)?.querySelector('[data-f="piece"]').focus(); });
    document.getElementById('addcat').onclick = change(() => { cat.categories.push({ label: '', items: [], _new: true }); });
    const nav = (b, d) => { const kind = b.dataset.up || b.dataset.down; const { c, it } = at(b);
      if (kind === 'cat') move(cat.categories, cat.categories.indexOf(c), d);
      else if (kind === 'piece') move(c.items, c.items.indexOf(it), d);
      else if (kind === 'group') move(it.groups, +b.closest('[data-gi]').dataset.gi, d); };
    document.querySelectorAll('[data-up]').forEach(b => b.onclick = e => { e.preventDefault(); nav(b, -1); dirty = true; render(); });
    document.querySelectorAll('[data-down]').forEach(b => b.onclick = e => { e.preventDefault(); nav(b, 1); dirty = true; render(); });
    document.querySelectorAll('[data-del]').forEach(b => b.onclick = e => {
      e.preventDefault(); const kind = b.dataset.del, { c, it } = at(b);
      if (kind === 'cat') { if (c.items.length && !confirm(`Delete ${c.label || 'this category'} and its ${c.items.length} piece(s)? Events that offer them will stop showing them.`)) return; cat.categories.splice(cat.categories.indexOf(c), 1); }
      else if (kind === 'piece') { if (!it._new && !confirm(`Delete ${it.label}? Events that offer it will stop showing it. Past orders keep their details.`)) return; c.items.splice(c.items.indexOf(it), 1); }
      else if (kind === 'group') it.groups.splice(+b.closest('[data-gi]').dataset.gi, 1);
      else if (kind === 'choice') grp(b).choices.splice(+b.closest('[data-xi]').dataset.xi, 1);
      dirty = true; render();
    });
    document.getElementById('save').onclick = save;
  }
  // New things get a permanent id from their name when first saved; existing ids never change.
  const uniq = (label, taken, fallback) => { const b = slug(label) || fallback; let id = b; for (let n = 2; taken.has(id); n++) id = `${b}-${n}`; taken.add(id); return id; };
  async function save() {
    if (saving || !dirty) return;
    const problems = [];
    cat.categories.forEach(c => { if (!c.label.trim()) problems.push('A category needs a name.');
      c.items.forEach(it => { const nm = it.label.trim() || 'A piece'; if (!it.label.trim()) problems.push('A piece needs a name.');
        it.groups.forEach(g => { if (!g.label.trim()) problems.push(`${nm}: an option group needs a name.`); if (!g.choices.length) problems.push(`${nm}: ${g.label || 'an option group'} needs at least one choice.`);
          if (g.choices.some(x => !x.label.trim())) problems.push(`${nm}: a choice under ${g.label} has no name.`); }); }); });
    if (problems.length) { toast(problems[0]); return; }
    const catIds = new Set(cat.categories.filter(c => !c._new).map(c => c.id)), pieceIds = new Set(cat.categories.flatMap(c => c.items).filter(i => !i._new).map(i => i.id));
    const clean = cat.categories.map(c => ({ id: c._new ? uniq(c.label, catIds, 'category') : c.id, label: c.label.trim(),
      items: c.items.map(it => { const gIds = new Set(it.groups.filter(g => !g._new).map(g => g.id));
        return { id: it._new ? uniq(it.label, pieceIds, 'piece') : it.id, label: it.label.trim(), material: (it.material || '').trim(), preview: it.preview || 'card',
          groups: it.groups.map(g => { const xIds = new Set(g.choices.filter(x => !x._new).map(x => x.id));
            return { id: g._new ? uniq(g.label, gIds, 'option') : g.id, label: g.label.trim(), swatch: !!g.swatch,
              choices: g.choices.map(x => ({ id: x._new ? uniq(x.label, xIds, 'choice') : x.id, label: x.label.trim(), ...(g.swatch && x.color ? { color: x.color } : {}) })) }; }) }; }) }));
    saving = true; const b = document.getElementById('save'); b.disabled = true; b.textContent = 'Saving…';
    try {
      await setDoc(doc(db, 'config', 'catalog'), { categories: clean, updatedAt: serverTimestamp(), by: user.email });
      CAT = { categories: clean }; catLoading = Promise.resolve();
      const added = clean.flatMap(c => c.items).filter(i => !pieceIds.has(i.id));
      dirty = false; toast(added.length ? `Saved. Turn ${added.map(i => i.label).join(', ')} on in each event's setup to offer it.` : 'Catalog saved');
      catalogPage();
    } catch (err) { toast('Could not save: ' + (err.code || err.message)); b.disabled = false; }
    finally { saving = false; b.textContent = 'Save catalog'; }
  }
  const leave = e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  addEventListener('beforeunload', leave); unsubs.push(() => removeEventListener('beforeunload', leave));
  render();
}

// ---------- photo library ----------
// Phone photos shrink to a small JPEG stored in Firestore (the free plan has no file storage).
async function fileToJpeg(file, max = 720) {
  const src = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = src; await img.decode();
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    let out = c.toDataURL('image/jpeg', 0.72);
    if (out.length > 600000) out = c.toDataURL('image/jpeg', 0.5);
    return out;
  } finally { URL.revokeObjectURL(src); }
}
function photoSlots(it) {
  const [g1, g2] = it.groups;
  if (!g1) return [{ key: it.id, opts: {}, label: 'Any' }];
  return g1.choices.flatMap(c1 => {
    if (!g2) return [{ key: `${it.id}_${c1.id}`, opts: { [g1.id]: c1.id }, label: c1.label }];
    const none = g2.choices.find(c => c.id === 'none');
    return [{ key: `${it.id}_${c1.id}`, opts: { [g1.id]: c1.id, [g2.id]: 'none' }, label: `${c1.label} · ${none ? none.label.toLowerCase() : 'any ' + g2.label.toLowerCase()}` },
      ...g2.choices.filter(c => c.id !== 'none').map(c2 => ({ key: `${it.id}_${c1.id}_${c2.id}`, opts: { [g1.id]: c1.id, [g2.id]: c2.id }, label: `${c1.label} · ${c2.label.toLowerCase()}` }))];
  });
}
async function photosPage() {
  $app.innerHTML = staffLoading('Loading photos…');
  await loadCatalog(true);
  const pieces = allPieces().map(p => ({ ...p, slots: photoSlots(p.it).map(s => ({ ...s, item: p.it.id })) }));
  const slots = pieces.flatMap(p => p.slots);
  await Promise.all(slots.map(s => getDoc(doc(db, 'photos', s.key)).then(d => { photoLib[s.key] = d.exists() ? (d.data().data || null) : null; }).catch(() => {})));
  const busy = new Set();
  const drawn = s => { const p = pieceDef(s.item), sg = p.it.groups.find(g => g.swatch), ch = sg && sg.choices.find(c => c.id === s.opts[sg.id]);
    return window.EngravePreview.renderPreview({ item: p.it.preview || 'card', color: sg ? s.opts[sg.id] : undefined, hex: ch?.color, addon: Object.values(s.opts).find(v => v === 'stars' || v === 'heart') || 'none', name: '', font: 'script' }); };
  const tile = s => {
    const has = typeof photoLib[s.key] === 'string', up = busy.has(s.key);
    return `<figure class="ptile" data-key="${esc(s.key)}"><div class="pimg ${has ? '' : 'none'}">${has ? `<img src="${esc(photoLib[s.key])}" alt="">` : drawn(s)}${has ? '' : '<span class="tag">no photo yet</span>'}</div>
      <figcaption>${esc(s.label)}</figcaption><div class="acts"><label class="up ${up ? 'busy' : ''}">${up ? 'Uploading…' : has ? 'Replace' : 'Add photo'}<input type="file" accept="image/*" data-upload="${esc(s.key)}" ${up ? 'disabled' : ''}></label>
      ${has && !up ? `<button class="rm" type="button" data-remove="${esc(s.key)}" aria-label="Remove photo">×</button>` : ''}</div></figure>`;
  };
  function render() {
    const y = scrollY, n = slots.filter(s => typeof photoLib[s.key] === 'string').length;
    $app.innerHTML = `${staffHead('photos', 'photos')}<main class="wrap"><h1>example <em>photos</em></h1>
      <p class="hint">${n} of ${slots.length} added. Guests see these as they choose; without one they see a drawn preview. Every event uses this library. Shoot in portrait with the piece centered. Pieces and choices come from the <a href="#/catalog">catalog</a>.</p>
      ${pieces.map(p => `<h2 class="sec">${esc(p.it.label.toLowerCase())} <small>${esc(p.cat.label)}</small></h2><div class="pgrid">${p.slots.map(tile).join('')}</div>`).join('') || '<p class="note">The catalog has no pieces yet.</p>'}</main>`;
    bindStaffHead(); scrollTo(0, y);
    document.querySelectorAll('[data-upload]').forEach(inp => inp.onchange = async () => {
      const f = inp.files && inp.files[0]; if (!f) return; const key = inp.dataset.upload;
      busy.add(key); render();
      try {
        const data = await fileToJpeg(f);
        await setDoc(doc(db, 'photos', key), { data, updatedAt: serverTimestamp(), by: user.email });
        photoLib[key] = data; toast('Photo saved');
      } catch (err) { toast('Could not save that photo: ' + (err.code || err.message || 'unreadable image')); }
      finally { busy.delete(key); render(); }
    });
    document.querySelectorAll('[data-remove]').forEach(b => b.onclick = async () => {
      const key = b.dataset.remove, old = photoLib[key];
      try {
        await deleteDoc(doc(db, 'photos', key)); photoLib[key] = null; render();
        toast('Photo removed', { label: 'Undo', run: () => setDoc(doc(db, 'photos', key), { data: old, updatedAt: serverTimestamp(), by: user.email }).then(() => { photoLib[key] = old; render(); }) });
      } catch (err) { toast('Could not remove: ' + (err.code || err.message)); }
    });
  }
  render();
}


route();
