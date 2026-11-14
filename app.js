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
const DEFAULT_CATALOG = {
  engraving: {
    label: 'Engraving',
    items: {
      bagtag: { label: 'Leather bag tag', material: 'leather', finishLabel: 'leather', colors: { black: 'Black', tan: 'Tan', blush: 'Blush' }, addons: { none: 'Name only', stars: 'Stars', heart: 'Heart' } },
      tumbler: { label: 'Tumbler', material: 'stainless steel', finishLabel: 'finish', colors: { black: 'Black', white: 'White', terracotta: 'Terracotta' }, addons: { none: 'Name only', stars: 'Stars', heart: 'Heart' } }
    }
  },
  calligraphy: { label: 'Calligraphy', items: {} }
};
const FONTS = { script: 'Script', serif: 'Serif' };
const SWATCH = { black: '#1d1b1a', tan: '#a86b43', blush: '#d9aa98', white: '#efece6', terracotta: '#b9623f' };
const STATUS_LABEL = { queue: 'Waiting', progress: 'Engraving', done: 'Ready for pickup', picked: 'Picked up' };
const WAVE = w => `<svg class="wave" viewBox="0 0 ${w} 24" preserveAspectRatio="none" aria-hidden="true"><path d="M0 15 C ${w * .23} 0 ${w * .44} 28 ${w * .64} 11 S ${w * .92} 5 ${w} 15 L${w} 24 L0 24Z" fill="#fff8f0"/></svg>`;
const LOGO = `<img class="logo" src="logo.png" alt="Ivelisse Designs">`;

// ---------- helpers ----------
const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortId = id => id.slice(-4).toUpperCase();
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
function catalog(ev) { return (ev && ev.catalog) || DEFAULT_CATALOG; }
function itemDef(ev, key) { for (const s of Object.values(catalog(ev))) if (s.items && s.items[key]) return s.items[key]; return null; }
// Example photos live in /photos/{key}, shared by every event (key: item_color or item_color_addon).
// Each is fetched the first time a screen needs it, so a guest's phone only downloads what it shows.
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
function photoFor(ev, o) {
  const p = (ev && ev.photos) || {}; // older events may still hold pasted photo links
  const keys = [...new Set([o.addon && o.addon !== 'none' ? `${o.item}_${o.color}_${o.addon}` : null, `${o.item}_${o.color}`, o.item].filter(Boolean))];
  for (const k of keys) { if (p[k]) return p[k]; requestPhoto(k); if (photoLib[k]) return photoLib[k]; }
  return null;
}
function previewHTML(ev, o, withName = true) {
  const photo = photoFor(ev, o);
  if (photo) return `<img src="${esc(photo)}" alt="" loading="lazy">`;
  return window.EngravePreview.renderPreview({ item: o.item === 'tumbler' ? 'tumbler' : 'bagtag', color: o.color, addon: o.addon, name: withName ? o.name : '', font: o.font });
}
function describe(ev, o, long = false) {
  const it = itemDef(ev, o.item); if (!it) return o.item || '';
  const c = (it.colors[o.color] || o.color || '').toLowerCase();
  const parts = [long ? `${c} ${it.label.toLowerCase()}` : `${c} ${it.label.toLowerCase().replace('leather ', '')}`];
  if (o.addon && o.addon !== 'none') parts.push((it.addons[o.addon] || o.addon).toLowerCase());
  return parts.join(' • ');
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
function route() {
  cleanup();
  const [view, a, b] = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  window.scrollTo(0, 0);
  if (view === 'e' && a) return guestForm(a);
  if (view === 'o' && a && b) return statusPage(a, b);
  if (view === 'board' && a) return a === DEMO_ID ? ensureGuest().then(() => boardPage(a)) : staffGate(() => boardPage(a));
  if (view === 'admin') return staffGate(() => a ? setupPage(a) : adminPage());
  if (view === 'photos') return staffGate(photosPage);
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

  const cat = catalog(ev);
  const services = (ev.services || ['engraving']).filter(s => cat[s] && Object.keys(cat[s].items).some(k => ev.items?.[k] !== false));
  const itemsFor = svc => Object.entries(cat[svc]?.items || {}).filter(([k]) => ev.items?.[k] !== false);
  const st = { step: 1, svc: services[0], item: null, color: null, addon: 'none', name: '', font: 'script', sending: false };
  const f = itemsFor(st.svc)[0]; if (f) { st.item = f[0]; st.color = Object.keys(f[1].colors)[0]; }
  const submitKey = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())).replace(/-/g, '').slice(0, 20);

  function mineHTML() {
    if (!mine.length) return '';
    return `<div class="mine"><div class="eyebrow" style="text-align:left">your pieces</div>${mine.map(o => `<a href="#/o/${encodeURIComponent(eventId)}/${esc(o.id)}"><span>${esc(o.name)} • ${shortId(o.id)}</span><b>check status ›</b></a>`).join('')}</div>`;
  }
  const stepsHTML = () => `<ol class="steps">${['piece', 'personalize', 'one last look'].map((s, i) => `<li class="${i + 1 < st.step ? 'dn' : ''}" ${i + 1 === st.step ? 'aria-current="step"' : ''}>${s}</li>`).join('')}</ol>`;
  const radios = (name, entries, cur, cls, extra = () => '') => `<div class="${cls}" role="radiogroup" aria-label="${esc(name)}">${entries.map(([k, v]) => `<button type="button" role="radio" aria-checked="${k === cur}" data-${name}="${esc(k)}">${extra(k)}${esc(v)}</button>`).join('')}</div>`;

  function render() {
    const it = st.item ? cat[st.svc].items[st.item] : null;
    let body = '', bar = '';
    if (st.step === 1) {
      body = `<div class="rule"></div><h1>make it <em>yours</em></h1>
        <p class="note">pick a piece. we personalize it live, right here.</p>
        ${mineHTML()}
        ${services.length > 1 ? `<fieldset><legend>engraving or <em>calligraphy?</em></legend>${radios('svc', services.map(s => [s, cat[s].label]), st.svc, 'seg')}</fieldset>` : ''}
        <fieldset><legend>what are we personalizing?</legend>
          <div class="pick" role="radiogroup" aria-label="Piece">${itemsFor(st.svc).map(([k, v]) => `<button type="button" class="pcard" role="radio" aria-checked="${k === st.item}" data-item="${k}">
            ${k === st.item ? '<span class="tick" aria-hidden="true">✓</span>' : ''}<span class="ph">${previewHTML(ev, { item: k, color: Object.keys(v.colors)[0], addon: 'none', name: '' }, false)}</span><span class="chip">${esc(v.label.toLowerCase())}</span></button>`).join('') || '<p class="note">Nothing is on the menu yet.</p>'}</div></fieldset>
        <p class="mats">${[...new Set(itemsFor(st.svc).map(([, v]) => v.material).filter(Boolean))].join(' • ')}</p>`;
      bar = `<button class="btn" id="next" type="button" ${it ? '' : 'disabled'}>Choose your details</button>`;
    } else if (st.step === 2) {
      body = `${stepsHTML()}
        <fieldset><legend>choose your <em>${esc(it.finishLabel || 'finish')}</em></legend>${radios('color', Object.entries(it.colors).map(([k, v]) => [k, v.toLowerCase()]), st.color, 'sw', k => `<span class="dot" style="background:${SWATCH[k] || '#ccc'}"></span>`)}</fieldset>
        <fieldset><legend>add a little something</legend>${radios('addon', Object.entries(it.addons).map(([k, v]) => [k, v.toLowerCase()]), st.addon, 'seg')}</fieldset>
        <fieldset><legend>whose name goes on it?</legend>
          <label class="lbl" for="nm">Name or initials</label>
          <input id="nm" class="namefield" maxlength="14" autocomplete="off" autocapitalize="words" spellcheck="false" value="${esc(st.name)}">
          <div class="count" id="cnt">${st.name.length} / 14</div>
          ${radios('font', Object.entries(FONTS), st.font, 'seg')}</fieldset>
        <div class="mini"><span class="ph" id="pv">${previewHTML(ev, st)}</span><div><div class="k">a little preview</div><div class="nm" id="pvn">${esc(st.name) || '&nbsp;'}</div><div class="ds">${esc(describe(ev, st))} • ${esc(FONTS[st.font].toLowerCase())}</div></div></div>
        ${photoFor(ev, st) ? '<p class="note" style="font-size:.8125rem">Photo shows an example of this style. Yours will have your name.</p>' : ''}`;
      bar = `<button class="btn sec" id="back" type="button">Back</button><button class="btn" id="next" type="button" ${st.name.trim() ? '' : 'disabled'}>Next: one last look</button>`;
    } else {
      body = `${stepsHTML()}<h1>one last <em>look</em></h1>
        <div class="proof"><span class="ph">${previewHTML(ev, st)}</span>
          <dl class="rows"><div><dt>Name</dt><dd><b style="font-size:1.125rem">${esc(st.name.trim())}</b></dd></div><div><dt>Piece</dt><dd>${esc(it.label)}</dd></div>
          <div><dt>Details</dt><dd>${esc(it.colors[st.color])} • ${esc(it.addons[st.addon])} • ${esc(FONTS[st.font])}</dd></div>
          </dl><div class="spell"><span>Spelled right?</span><button class="editbtn" id="edit" type="button">✎ Edit</button></div></div>
        <p class="err" id="err" role="alert"></p>`;
      bar = `<button class="btn sec" id="back" type="button">Back</button><button class="btn" id="send" type="button" ${st.sending ? 'disabled' : ''}>${st.sending ? 'Sending…' : 'Send for engraving'}</button>`;
    }
    $app.innerHTML = `<div class="page">${head(st.step > 1)}<main class="content">${body}</main><div class="bar">${bar}</div></div>`;
    bind();
  }
  function bind() {
    $app.querySelectorAll('[data-svc]').forEach(b => b.onclick = () => { st.svc = b.dataset.svc; const g = itemsFor(st.svc)[0]; st.item = g ? g[0] : null; st.color = g ? Object.keys(g[1].colors)[0] : null; st.addon = 'none'; render(); });
    $app.querySelectorAll('[data-item]').forEach(b => b.onclick = () => { st.item = b.dataset.item; const d = cat[st.svc].items[st.item]; if (!d.colors[st.color]) st.color = Object.keys(d.colors)[0]; if (!d.addons[st.addon]) st.addon = 'none'; render(); });
    $app.querySelectorAll('[data-color]').forEach(b => b.onclick = () => { st.color = b.dataset.color; render(); });
    $app.querySelectorAll('[data-addon]').forEach(b => b.onclick = () => { st.addon = b.dataset.addon; render(); });
    $app.querySelectorAll('[data-font]').forEach(b => b.onclick = () => { st.font = b.dataset.font; render(); });
    const nm = document.getElementById('nm');
    if (nm) nm.oninput = () => {
      st.name = nm.value.replace(/^\s+/, '');
      document.getElementById('cnt').textContent = `${st.name.length} / 14`;
      document.getElementById('pvn').textContent = st.name || ' ';
      if (!photoFor(ev, st)) document.getElementById('pv').innerHTML = previewHTML(ev, st);
      document.getElementById('next').disabled = !st.name.trim();
    };
    const go = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
    go('next', () => { st.step++; render(); window.scrollTo(0, 0); });
    go('back', () => { st.step--; render(); window.scrollTo(0, 0); });
    go('edit', () => { st.step = 2; render(); setTimeout(() => document.getElementById('nm')?.focus(), 50); });
    go('send', submit);
  }
  async function submit() {
    const name = st.name.trim().slice(0, 14);
    // Re-check the event is still taking orders and the piece is still offered.
    try {
      const s = await getDoc(doc(db, 'events', eventId)); const fresh = s.exists() ? s.data() : null;
      if (fresh && fresh.open === false) { document.getElementById('err').textContent = 'Orders just closed for this event.'; return; }
      if (fresh && fresh.items?.[st.item] === false) { document.getElementById('err').textContent = 'That piece just sold out. Pick another and your name will carry over.'; st.step = 1; setTimeout(render, 1600); return; }
    } catch (e) { /* offline: the order still queues locally */ }
    st.sending = true; render();
    // The order id is fixed for this form visit, so a retry overwrites the same order instead of creating a second one.
    const ref = doc(db, 'events', eventId, 'orders', submitKey);
    const data = { uid: user.uid, service: st.svc, item: st.item, color: st.color, addon: st.addon, font: st.font, name, status: 'queue', engraver: null, createdAt: serverTimestamp(), clientAt: Date.now() };
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
  photoRerender = () => { if (document.activeElement?.id === 'nm') { const pv = document.getElementById('pv'); if (pv) pv.innerHTML = previewHTML(ev, st); } else render(); };
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
        ${miles}${item}${save}${live}</main>`;
    }
    $app.innerHTML = `<div class="page">${html}</div>`;
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
  if (await isStaff()) await setDoc(evRef, { name: 'Demo event', date, engravers: DEMO_ENGRAVERS, items: { bagtag: true, tumbler: true }, services: ['engraving'], catalog: DEFAULT_CATALOG,
    photos: prev?.photos || {}, pickupNote: prev?.pickupNote || 'at the engraving table', open: true, demo: true, createdAt: prev?.createdAt || serverTimestamp() });
  // Clear every order in the demo event.
  const snap = await getDocs(collection(db, 'events', DEMO_ID, 'orders'));
  for (let i = 0; i < snap.docs.length; i += 400) { const b = writeBatch(db); snap.docs.slice(i, i + 400).forEach(d => b.delete(d.ref)); await b.commit(); }
  // Orders have to start in the queue (same rule guests follow), then get moved to their stage.
  const ago = m => m == null ? null : Timestamp.fromMillis(Date.now() - m * 60000);
  const make = writeBatch(db), place = writeBatch(db);
  DEMO_ORDERS.forEach(([id, name, item, color, addon, font, status, engraver, sub, started, ready, picked]) => {
    const ref = doc(db, 'events', DEMO_ID, 'orders', id);
    make.set(ref, { uid: user.uid, service: 'engraving', item, color, addon, font, name, status: 'queue', engraver: null, createdAt: ago(sub), clientAt: Date.now() - sub * 60000, demo: true });
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
    return `<div class="qc" data-id="${o.id}"><span class="ph">${previewHTML(ev, o)}</span><div class="nm"><span class="pos" aria-label="Position ${i + 1}">${i + 1}</span>${esc(o.name)}</div><div class="ds">#${shortId(o.id)} • ${esc(describe(ev, o, true))} • ${esc((FONTS[o.font] || '').toLowerCase())}</div>
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
          ${eventId === DEMO_ID ? '<a href="#" id="resetdemo">reset demo</a>' : ''}<a href="#/admin/${encodeURIComponent(eventId)}">event setup</a><a href="#/admin">all events</a></div>${WAVE(1180)}</header>
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
  const head = ['Order #', 'Name', 'Service', 'Item', 'Finish', 'Detail', 'Lettering', 'Submitted', 'Handled by', 'Started', 'Ready', 'Picked up', 'Wait in queue (min)', 'Time to make (min)', 'Submit to ready (min)', 'Status'];
  const rows = snap.docs.map(d => {
    const o = d.data(); const it = itemDef(ev, o.item) || { label: o.item, colors: {}, addons: {} };
    const sub = tsDate(o.createdAt), st = tsDate(o.startedAt), dn = (o.status === 'done' || o.status === 'picked') ? tsDate(o.doneAt) : null, pk = o.status === 'picked' ? tsDate(o.pickedAt) : null;
    return [shortId(d.id), o.name, catalog(ev)[o.service]?.label || o.service || '', it.label, it.colors[o.color] || o.color || '', it.addons[o.addon] || o.addon || '',
      FONTS[o.font] || o.font || '', fmtStamp(sub), o.engraver || '', fmtStamp(st), fmtStamp(dn), fmtStamp(pk), minsBetween(sub, st), minsBetween(st, dn), minsBetween(sub, dn), STATUS_LABEL[o.status] || o.status];
  });
  const cell = v => { const t = String(v ?? ''); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const csv = '﻿' + [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = `${eventId}-orders.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`${rows.length} orders exported. In Google Sheets: File → Import → Upload.`);
}

// ---------- staff: events list, event setup, photo library ----------
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const allItems = () => Object.values(DEFAULT_CATALOG).flatMap(s => Object.entries(s.items));
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const guestUrl = id => `${baseUrl()}#/e/${encodeURIComponent(id)}`;
const qrSvg = url => { const q = qrcode(0, 'M'); q.addData(url); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); };
function downloadQr(url, name) { const q = qrcode(0, 'M'); q.addData(url); q.make(); const l = document.createElement('a'); l.href = q.createDataURL(12, 4); l.download = `qr-${name}.gif`; l.click(); }
const staffHead = title => `<header class="band">${LOGO}<div class="ev">${esc(title)}</div>${WAVE(1180)}</header>
  <nav class="snav" aria-label="Staff"><a href="#/admin">Events</a><a href="#/photos">Photos</a><span>${esc(user.email)}</span><a href="#" id="out">Sign out</a></nav>`;
function bindStaffHead() { const o = document.getElementById('out'); if (o) o.onclick = e => { e.preventDefault(); signOut(auth).then(() => { location.hash = '#/'; }); }; }
const staffLoading = msg => `<div class="page"><p class="note" style="padding:40px">${esc(msg)}</p></div>`;

async function adminPage() {
  $app.innerHTML = staffLoading('Loading events…');
  let evs;
  try { evs = (await getDocs(collection(db, 'events'))).docs.map(d => ({ id: d.id, ...d.data() })); }
  catch (e) { $app.innerHTML = `<div class="wrap"><p class="err">Could not load events: ${esc(e.code || e.message)}</p></div>`; return; }
  const today = todayStr();
  const real = evs.filter(e => e.id !== DEMO_ID);
  const upcoming = real.filter(e => (e.date || '') >= today).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const past = real.filter(e => (e.date || '') < today).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const demo = evs.find(e => e.id === DEMO_ID);
  const card = ev => `<a class="evcard" href="#/admin/${encodeURIComponent(ev.id)}"><div><b>${esc(ev.name)}</b><span>${esc(fmtDate(ev.date))} · ${(ev.engravers || []).length} engravers</span></div>
    <span class="chip ${ev.open === false ? '' : 'on'}">${ev.open === false ? 'Closed' : 'Taking orders'}</span><span class="chev" aria-hidden="true">›</span></a>`;
  $app.innerHTML = `${staffHead('staff')}<main class="wrap">
    <h1>your <em>events</em></h1>
    <form id="new" class="card newev"><h2>new event</h2>
      <div class="field"><label class="lbl" for="n-name">Event name</label><input id="n-name" required placeholder="Coach · NorthPark"></div>
      <div class="field"><label class="lbl" for="n-date">Date</label><input id="n-date" type="date" required value="${today}"></div>
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
    const btn = e.target.querySelector('.btn'); btn.disabled = true;
    try {
      // Never overwrite an existing event that happens to share the name and date.
      const base = slug(`${name}-${date}`) || 'event'; let id = base;
      for (let n = 2; (await getDoc(doc(db, 'events', id))).exists(); n++) id = `${base}-${n}`;
      const items = Object.fromEntries(allItems().map(([k]) => [k, true]));
      await setDoc(doc(db, 'events', id), { name, date, engravers: ['Steph', 'Veronica', 'Christina', 'DeVaughn'], items, services: ['engraving'], catalog: DEFAULT_CATALOG, photos: {}, pickupNote: 'at the engraving table', open: true, createdAt: serverTimestamp() });
      location.hash = `#/admin/${encodeURIComponent(id)}`;
    } catch (err) { btn.disabled = false; toast('Could not create: ' + (err.code || err.message)); }
  };
}

async function setupPage(eventId) {
  $app.innerHTML = staffLoading('Loading event…');
  let ev;
  try { const s = await getDoc(doc(db, 'events', eventId)); ev = s.exists() ? s.data() : null; } catch (e) { ev = null; }
  if (!ev) { $app.innerHTML = `${staffHead('event setup')}<main class="wrap"><h1>event not <em>found</em></h1><p><a href="#/admin">Back to events</a></p></main>`; bindStaffHead(); return; }
  const st = { name: ev.name || '', date: ev.date || '', pickup: ev.pickupNote || 'at the engraving table', open: ev.open !== false,
    engravers: [...(ev.engravers || [])], items: Object.fromEntries(allItems().map(([k]) => [k, ev.items?.[k] !== false])) };
  const savedEngravers = [...st.engravers];
  let dirty = false, saving = false;
  const url = guestUrl(eventId);
  const legacy = Object.keys(ev.photos || {}).length;
  const markDirty = () => { dirty = true; const d = document.getElementById('dirty'); if (d) d.textContent = 'Unsaved changes'; const b = document.getElementById('save'); if (b) b.disabled = false; };
  const chipsHTML = () => st.engravers.map((e, i) => `<span>${esc(e)}<button type="button" data-rm="${i}" aria-label="Remove ${esc(e)}">×</button></span>`).join('') || '<em class="note">No engravers yet.</em>';

  $app.innerHTML = `${staffHead('event setup')}<main class="wrap setup">
    <h1>${esc(st.name)}</h1>
    <div class="btnrow"><a class="btn" href="#/board/${encodeURIComponent(eventId)}">Open board</a><a class="btn out" href="#/e/${encodeURIComponent(eventId)}">Preview guest form</a></div>
    <section class="card"><h2>details</h2>
      <div class="field"><label class="lbl" for="s-name">Event name</label><input id="s-name" value="${esc(st.name)}"></div>
      <div class="field"><label class="lbl" for="s-date">Date</label><input id="s-date" type="date" value="${esc(st.date)}"></div>
      <div class="field"><label class="lbl" for="s-pick">Where guests pick up (finishes "pick it up …")</label><input id="s-pick" value="${esc(st.pickup)}"></div>
      <label class="tog"><input type="checkbox" id="s-open" ${st.open ? 'checked' : ''}> Taking orders <small>Turn off to close the guest form. Pieces already ordered still show on the board.</small></label></section>
    <section class="card"><h2>engravers</h2><p class="hint">Each engraver gets a lane on the board.</p>
      <div class="chips" id="chips">${chipsHTML()}</div>
      <div class="addrow"><label class="vh" for="s-eng">Add an engraver</label><input id="s-eng" placeholder="Name" autocapitalize="words"><button class="btn out" id="addeng" type="button">Add</button></div></section>
    <section class="card"><h2>pieces offered</h2><p class="hint">Guests only see the pieces checked here. Example photos come from the <a href="#/photos">photo library</a>.</p>
      <div class="items">${allItems().map(([k, v]) => `<label class="itile"><span class="ph">${previewHTML(ev, { item: k, color: Object.keys(v.colors)[0], addon: 'none' }, false)}</span>
        <span><input type="checkbox" data-item="${k}" ${st.items[k] ? 'checked' : ''}> ${esc(v.label)}</span></label>`).join('')}</div></section>
    <section class="card"><h2>guest link &amp; QR</h2>
      <div class="share"><div class="qr" aria-label="QR code for the guest form">${qrSvg(url)}</div>
        <div class="shareinfo"><div class="url">${esc(url)}</div><div class="btnrow"><button class="btn out" id="copy" type="button">Copy link</button><button class="btn out" id="dlqr" type="button">Download QR to print</button></div></div></div></section>
    <section class="card"><h2>after the event</h2><p class="hint">Orders with times for each step, as a file Google Sheets opens.</p>
      <button class="btn out" id="export" type="button">Export orders</button>
      ${legacy ? `<p class="hint" style="margin-top:14px">This event still has ${legacy} photo link${legacy === 1 ? '' : 's'} from the old setup, which override the photo library.</p><button class="linkbtn" id="clearlegacy" type="button">Remove old photo links</button>` : ''}</section>
  </main>
  <div class="savebar"><span id="dirty">All changes saved</span><button class="btn" id="save" type="button" disabled>Save</button></div>`;
  bindStaffHead();
  photoRerender = () => document.querySelectorAll('.itile').forEach((t, i) => { const [k, v] = allItems()[i]; t.querySelector('.ph').innerHTML = previewHTML(ev, { item: k, color: Object.keys(v.colors)[0], addon: 'none' }, false); });

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
  [['s-name', 'name'], ['s-date', 'date'], ['s-pick', 'pickup']].forEach(([id, k]) => document.getElementById(id).oninput = e => { st[k] = e.target.value; markDirty(); });
  document.getElementById('s-open').onchange = e => { st.open = e.target.checked; markDirty(); };
  document.querySelectorAll('[data-item]').forEach(c => c.onchange = () => { st.items[c.dataset.item] = c.checked; markDirty(); });
  document.getElementById('copy').onclick = () => (navigator.clipboard?.writeText(url) || Promise.reject()).then(() => toast('Guest link copied')).catch(() => toast(url));
  document.getElementById('dlqr').onclick = () => downloadQr(url, eventId);
  document.getElementById('export').onclick = async () => { try { await exportOrders(eventId, ev); } catch (err) { toast('Export failed: ' + (err.code || err.message)); } };
  const cl = document.getElementById('clearlegacy');
  if (cl) cl.onclick = async () => { try { await updateDoc(doc(db, 'events', eventId), { photos: {} }); toast('Old photo links removed'); setupPage(eventId); } catch (err) { toast('Could not remove: ' + (err.code || err.message)); } };

  document.getElementById('save').onclick = async () => {
    if (saving || !dirty) return;
    if (!st.name.trim() || !st.date) { toast('The event needs a name and a date.'); return; }
    if (!st.engravers.length) { toast('Add at least one engraver.'); return; }
    if (!Object.values(st.items).some(Boolean)) { toast('Offer at least one piece.'); return; }
    saving = true; const b = document.getElementById('save'); b.disabled = true; b.textContent = 'Saving…';
    try {
      // Removing an engraver hides their lane, so don't allow it while they have a piece in progress.
      const removed = savedEngravers.filter(e => !st.engravers.includes(e));
      if (removed.length) {
        const busy = (await getDocs(collection(db, 'events', eventId, 'orders'))).docs.map(d => d.data()).find(o => o.status === 'progress' && removed.includes(o.engraver));
        if (busy) { toast(`${busy.engraver} has ${busy.name}'s piece in progress. Finish or move it before removing them.`); return; }
      }
      await updateDoc(doc(db, 'events', eventId), { name: st.name.trim(), date: st.date, pickupNote: st.pickup.trim() || 'at the engraving table', open: st.open, engravers: st.engravers, items: st.items, updatedAt: serverTimestamp() });
      savedEngravers.splice(0, savedEngravers.length, ...st.engravers);
      dirty = false; document.getElementById('dirty').textContent = 'All changes saved'; document.querySelector('.setup h1').textContent = st.name.trim(); toast('Saved');
    } catch (err) { toast('Could not save: ' + (err.code || err.message)); }
    finally { saving = false; b.textContent = 'Save'; b.disabled = !dirty; }
  };
  const leave = e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  addEventListener('beforeunload', leave); unsubs.push(() => removeEventListener('beforeunload', leave));
}

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

async function photosPage() {
  const slots = allItems().flatMap(([item, v]) => Object.entries(v.colors).flatMap(([color, cLabel]) =>
    Object.entries(v.addons).map(([addon, aLabel]) => ({ item, color, addon, key: addon === 'none' ? `${item}_${color}` : `${item}_${color}_${addon}`, label: `${cLabel} · ${aLabel.toLowerCase()}` }))));
  $app.innerHTML = staffLoading('Loading photos…');
  await Promise.all(slots.map(s => getDoc(doc(db, 'photos', s.key)).then(d => { photoLib[s.key] = d.exists() ? (d.data().data || null) : null; }).catch(() => {})));
  const busy = new Set();
  const tile = s => {
    const has = typeof photoLib[s.key] === 'string', up = busy.has(s.key);
    return `<figure class="ptile" data-key="${s.key}"><div class="pimg ${has ? '' : 'none'}">${has ? `<img src="${esc(photoLib[s.key])}" alt="">` : window.EngravePreview.renderPreview({ item: s.item === 'tumbler' ? 'tumbler' : 'bagtag', color: s.color, addon: s.addon, name: '', font: 'script' })}${has ? '' : '<span class="tag">no photo yet</span>'}</div>
      <figcaption>${esc(s.label)}</figcaption><div class="acts"><label class="up ${up ? 'busy' : ''}">${up ? 'Uploading…' : has ? 'Replace' : 'Add photo'}<input type="file" accept="image/*" data-up="${s.key}" ${up ? 'disabled' : ''}></label>
      ${has && !up ? `<button class="rm" type="button" data-del="${s.key}" aria-label="Remove photo">×</button>` : ''}</div></figure>`;
  };
  function render() {
    const n = slots.filter(s => typeof photoLib[s.key] === 'string').length;
    $app.innerHTML = `${staffHead('photos')}<main class="wrap"><h1>example <em>photos</em></h1>
      <p class="hint">${n} of ${slots.length} added. Guests see these when they pick a finish and detail; without one they see a drawn preview. Every event uses this library. Shoot in portrait with the piece centered.</p>
      ${allItems().map(([item, v]) => `<h2 class="sec">${esc(v.label.toLowerCase())}</h2><div class="pgrid">${slots.filter(s => s.item === item).map(tile).join('')}</div>`).join('')}</main>`;
    bindStaffHead();
    document.querySelectorAll('[data-up]').forEach(inp => inp.onchange = async () => {
      const f = inp.files && inp.files[0]; if (!f) return; const key = inp.dataset.up;
      busy.add(key); render();
      try {
        const data = await fileToJpeg(f);
        await setDoc(doc(db, 'photos', key), { data, updatedAt: serverTimestamp(), by: user.email });
        photoLib[key] = data; toast('Photo saved');
      } catch (err) { toast('Could not save that photo: ' + (err.code || err.message || 'unreadable image')); }
      finally { busy.delete(key); render(); }
    });
    document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      const key = b.dataset.del, old = photoLib[key];
      try {
        await deleteDoc(doc(db, 'photos', key)); photoLib[key] = null; render();
        toast('Photo removed', { label: 'Undo', run: () => setDoc(doc(db, 'photos', key), { data: old, updatedAt: serverTimestamp(), by: user.email }).then(() => { photoLib[key] = old; render(); }) });
      } catch (err) { toast('Could not remove: ' + (err.code || err.message)); }
    });
  }
  render();
}


route();
