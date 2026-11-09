import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager, memoryLocalCache,
  doc, collection, setDoc, updateDoc, getDoc, getDocs, onSnapshot, query, orderBy, serverTimestamp, writeBatch, arrayUnion, getDocFromServer
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
// Staff pages (board/admin) keep an offline cache owned by this tab so moves survive Wi-Fi drops.
// Guest pages use an in-memory cache: a direct live connection with no cross-tab relay, so updates land in about a second.
const staffView = /^#\/(board|admin)/.test(location.hash);
const db = initializeFirestore(fb, {
  experimentalAutoDetectLongPolling: true,
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
const cleanup = () => { unsubs.forEach(u => { try { u(); } catch (e) {} }); unsubs = []; timers.forEach(clearInterval); timers = []; };
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
function photoFor(ev, o) { const p = (ev && ev.photos) || {}; return p[`${o.item}_${o.color}_${o.addon}`] || p[`${o.item}_${o.color}`] || p[o.item] || null; }
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
  if (view === 'board' && a) return staffGate(() => boardPage(a));
  if (view === 'admin') return staffGate(adminPage);
  return homePage();
}
addEventListener('hashchange', route);

function homePage() {
  $app.innerHTML = `<div class="page"><header class="band">${LOGO}<div class="ev">ivelisse board</div>${WAVE(390)}</header>
    <main class="content"><div class="rule"></div><h1>live <em>personalization</em></h1>
    <p class="note">Guests reach their event by scanning its QR code. Staff manage events and boards here.</p>
    <a class="btn" href="#/admin">Staff: events &amp; boards</a></main></div>`;
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
          <div><dt>Spelled right?</dt><dd><button class="linkbtn" id="edit" type="button">Edit</button></dd></div></dl></div>
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
  render();
}

// ---------- guest status ----------
async function statusPage(eventId, orderId) {
  $app.innerHTML = `<div class="page"><p class="note" style="padding:40px">Loading…</p></div>`;
  await ensureGuest();
  let ev = null, order = null, queue = null, connected = true, lastSig = '';
  try { const s = await getDoc(doc(db, 'events', eventId)); ev = s.exists() ? s.data() : null; } catch (e) {}
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
          : `<div class="eyebrow">you're in line</div><h1>we've got <em>yours</em></h1>`);
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
  unsubs.push(onSnapshot(doc(db, 'events', eventId, 'public', 'queue'), s => { queue = s.exists() ? (s.data().ids || []) : null; render(); }, () => {}));
  // Phones pause live connections in the background; re-check straight from the server when the page
  // comes back on screen and every 15s until the piece is ready, so the status can't get stuck.
  async function refresh() {
    if (order && (order.status === 'done' || order.status === 'picked') ) return;
    try {
      const [o, q] = await Promise.all([getDocFromServer(doc(db, 'events', eventId, 'orders', orderId)), getDocFromServer(doc(db, 'events', eventId, 'public', 'queue')).catch(() => null)]);
      if (o.exists()) order = o.data({ serverTimestamps: 'estimate' });
      if (q && q.exists()) queue = q.data().ids || [];
      connected = true; render();
    } catch (e) { connected = false; render(); }
  }
  const vis = () => { if (document.visibilityState === 'visible') { listen(); refresh(); } };
  document.addEventListener('visibilitychange', vis); addEventListener('focus', vis); addEventListener('pageshow', vis);
  unsubs.push(() => { document.removeEventListener('visibilitychange', vis); removeEventListener('focus', vis); removeEventListener('pageshow', vis); });
  // While someone is working on it, check every 4s (ready is close); while queued, every 15s.
  let tick = 0;
  timers.push(setInterval(() => { tick++; if (order?.status === 'progress' || tick % 4 === 0) refresh(); }, 4000));
  render();
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
          <a href="#/admin">events</a></div>${WAVE(1180)}</header>
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
    const d = document.getElementById('pk');
    document.getElementById('openpk').onclick = () => { d.showModal(); renderPickup(); document.getElementById('find').focus(); };
    document.getElementById('pkx').onclick = () => { d.close(); document.getElementById('openpk').focus(); };
    document.getElementById('find').oninput = renderPickup;
    document.getElementById('find').onkeydown = e => { if (e.key === 'Enter') e.preventDefault(); };
    document.querySelectorAll('.drop').forEach(el => new Sortable(el, {
      group: 'orders', animation: 150, delay: 120, delayOnTouchOnly: true, draggable: '.qc,.now', filter: 'button,.who', preventOnFilter: false,
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

// ---------- admin ----------
async function adminPage() {
  const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  let evs = [];
  async function load() {
    const snap = await getDocs(collection(db, 'events'));
    evs = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    render();
  }
  const itemChecks = ev => Object.values(DEFAULT_CATALOG).flatMap(s => Object.entries(s.items).map(([k, v]) =>
    `<label><input type="checkbox" name="item" value="${k}" ${!ev || ev.items?.[k] !== false ? 'checked' : ''}> ${esc(v.label)}</label>`)).join('');
  const photosText = ev => Object.entries(ev?.photos || {}).map(([k, v]) => `${k} = ${v}`).join('\n');
  function render() {
    $app.innerHTML = `<header class="band">${LOGO}<div class="ev">${esc(user.email)} · <a href="#" id="out" style="color:#fff">sign out</a></div>${WAVE(1180)}</header>
      <div class="wrap"><h1 style="text-align:left">your <em>events</em></h1>
      <details ${evs.length ? '' : 'open'} style="margin-top:12px"><summary class="lbl" style="cursor:pointer;min-height:44px;display:flex;align-items:center;color:var(--ink)">+ New event</summary>
        <form id="new">
          <div class="field"><label class="lbl" for="n-name">Event name</label><input id="n-name" required placeholder="Coach · NorthPark"></div>
          <div class="field"><label class="lbl" for="n-date">Date</label><input id="n-date" type="date" required></div>
          <div class="field"><label class="lbl" for="n-eng">Engravers (comma separated)</label><input id="n-eng" value="Steph, Veronica, Christina, DeVaughn"></div>
          <div class="field"><label class="lbl" for="n-pick">Where guests pick up</label><input id="n-pick" value="at the engraving table"></div>
          <div class="field"><span class="lbl">Items offered</span><div class="checks">${itemChecks(null)}</div></div>
          <button class="btn" style="width:100%">Create event</button>
        </form></details>
      ${evs.map(ev => {
        const url = `${baseUrl()}#/e/${encodeURIComponent(ev.id)}`;
        return `<div class="event" data-id="${esc(ev.id)}"><div class="qr" data-url="${esc(url)}"></div>
          <div class="info"><h2>${esc(ev.name)}</h2><div style="color:var(--muted)">${esc(fmtDate(ev.date))} · ${(ev.engravers || []).map(esc).join(', ')}${ev.open === false ? ' · <b>closed</b>' : ''}</div>
            <div class="links"><a href="#/board/${encodeURIComponent(ev.id)}">Open board</a><a href="#/e/${encodeURIComponent(ev.id)}">Guest form</a><a href="#" data-copy="${esc(url)}">Copy guest link</a><a href="#" data-qr="${esc(ev.id)}">Download QR</a><a href="#" data-export="${esc(ev.id)}">Export orders (Sheets)</a></div>
            <details><summary class="lbl" style="cursor:pointer;min-height:44px;display:flex;align-items:center;color:var(--ink)">Edit</summary>
              <div class="field"><label class="lbl">Engravers</label><input name="eng" value="${esc((ev.engravers || []).join(', '))}"></div>
              <div class="field"><label class="lbl">Where guests pick up</label><input name="pick" value="${esc(ev.pickupNote || 'at the engraving table')}"></div>
              <div class="field"><span class="lbl">Items offered</span><div class="checks">${itemChecks(ev)}</div></div>
              <div class="field"><label class="lbl">Example photos — one per line: key = photo link</label>
                <textarea name="photos" placeholder="bagtag_black_stars = https://drive.google.com/file/d/…/view&#10;bagtag_black = …&#10;tumbler = …">${esc(photosText(ev))}</textarea>
                <span style="font-size:.8125rem;color:var(--muted)">Keys: item, item_color, or item_color_detail (bagtag, tumbler_white, bagtag_tan_heart). Drive links must be shared "anyone with the link".</span></div>
              <label style="display:flex;gap:8px;align-items:center;min-height:44px"><input type="checkbox" name="open" ${ev.open === false ? '' : 'checked'}> Taking orders</label>
              <button class="btn out" data-save type="button">Save changes</button>
            </details></div></div>`;
      }).join('') || '<p class="note" style="text-align:left">No events yet.</p>'}
      </div>`;
    document.getElementById('out').onclick = e => { e.preventDefault(); signOut(auth).then(() => { location.hash = '#/'; }); };
    $app.querySelectorAll('.qr').forEach(el => { const q = qrcode(0, 'M'); q.addData(el.dataset.url); q.make(); el.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); });
    $app.querySelectorAll('[data-copy]').forEach(a => a.onclick = e => { e.preventDefault(); navigator.clipboard?.writeText(a.dataset.copy).then(() => toast('Guest link copied')); });
    $app.querySelectorAll('[data-qr]').forEach(a => a.onclick = e => {
      e.preventDefault(); const q = qrcode(0, 'M'); q.addData(a.closest('.event').querySelector('.qr').dataset.url); q.make();
      const l = document.createElement('a'); l.href = q.createDataURL(12, 4); l.download = `qr-${a.dataset.qr}.gif`; l.click();
    });
    $app.querySelectorAll('[data-export]').forEach(a => a.onclick = async e => {
      e.preventDefault(); const ev = evs.find(x => x.id === a.dataset.export);
      try { await exportOrders(ev.id, ev); } catch (err) { toast('Export failed: ' + (err.code || err.message)); }
    });
    document.getElementById('new').onsubmit = async e => {
      e.preventDefault();
      const name = document.getElementById('n-name').value.trim(), date = document.getElementById('n-date').value;
      const items = {}; e.target.querySelectorAll('[name=item]').forEach(c => items[c.value] = c.checked);
      const engravers = document.getElementById('n-eng').value.split(',').map(s => s.trim()).filter(Boolean);
      try {
        await setDoc(doc(db, 'events', slug(`${name}-${date}`)), { name, date, engravers, items, services: ['engraving'], catalog: DEFAULT_CATALOG, photos: {}, pickupNote: document.getElementById('n-pick').value.trim(), open: true, createdAt: serverTimestamp() });
        toast('Event created'); load();
      } catch (err) { toast('Could not create: ' + (err.code || err.message)); }
    };
    $app.querySelectorAll('[data-save]').forEach(btn => btn.onclick = async () => {
      const box = btn.closest('.event'); const id = box.dataset.id;
      const items = {}; box.querySelectorAll('[name=item]').forEach(c => items[c.value] = c.checked);
      const photos = {};
      box.querySelector('[name=photos]').value.split('\n').forEach(line => { const i = line.indexOf('='); if (i < 1) return; const k = line.slice(0, i).trim().replace(/\s+/g, ''); const v = line.slice(i + 1).trim(); if (k && v) photos[k] = driveToDirect(v); });
      const engravers = box.querySelector('[name=eng]').value.split(',').map(s => s.trim()).filter(Boolean);
      try { await updateDoc(doc(db, 'events', id), { items, photos, engravers, pickupNote: box.querySelector('[name=pick]').value.trim(), open: box.querySelector('[name=open]').checked }); toast('Saved'); load(); }
      catch (err) { toast('Could not save: ' + (err.code || err.message)); }
    });
  }
  $app.innerHTML = `<div class="page"><p class="note" style="padding:40px">Loading events…</p></div>`;
  load().catch(e => { $app.innerHTML = `<div class="wrap"><p class="err">Could not load events: ${esc(e.code || e.message)}</p></div>`; });
}

route();
