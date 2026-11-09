import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, setDoc, updateDoc, getDoc, getDocs, onSnapshot, query, orderBy, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = initializeFirestore(fb, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

// ---------- catalog ----------
// Each event stores its own copy so Steph can change options per event.
const DEFAULT_CATALOG = {
  engraving: {
    label: 'Engraving',
    items: {
      bagtag: { label: 'Leather bag tag', finishLabel: 'Leather', colors: { black: 'Black', tan: 'Tan', blush: 'Blush' }, addons: { none: 'None', stars: 'Stars', heart: 'Heart' } },
      tumbler: { label: 'Tumbler', finishLabel: 'Finish', colors: { black: 'Black', white: 'White', terracotta: 'Terracotta' }, addons: { none: 'None', stars: 'Stars', heart: 'Heart' } }
    }
  },
  calligraphy: { label: 'Calligraphy', items: {} }
};
const FONTS = { script: 'Script', serif: 'Serif' };
const SWATCH = { black: '#1d1d20', tan: '#a86b43', blush: '#d9aa98', white: '#efece6', terracotta: '#b9623f' };

// ---------- helpers ----------
const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortId = id => id.slice(-4).toUpperCase();
const fmtDate = d => { if (!d) return ''; const t = new Date(d + 'T12:00:00'); return isNaN(t) ? d : t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
let unsubs = [];
const cleanup = () => { unsubs.forEach(u => { try { u(); } catch (e) {} }); unsubs = []; };
function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}
const baseUrl = () => location.href.split('#')[0];
function driveToDirect(url) {
  const m = String(url).match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]{20,})/);
  return m ? `https://lh3.googleusercontent.com/d/${m[1]}=w900` : String(url).trim();
}
function photoFor(ev, o) {
  const p = (ev && ev.photos) || {};
  return p[`${o.item}_${o.color}_${o.addon}`] || p[`${o.item}_${o.color}`] || p[o.item] || null;
}
function previewHTML(ev, o, withName = true) {
  const photo = photoFor(ev, o);
  if (photo) return `<img src="${esc(photo)}" alt="Example: ${esc(describe(ev, o))}" loading="lazy">`;
  const item = o.item === 'tumbler' ? 'tumbler' : 'bagtag';
  return window.EngravePreview.renderPreview({ item, color: o.color, addon: o.addon, name: withName ? o.name : '', font: o.font });
}
function catalog(ev) { return (ev && ev.catalog) || DEFAULT_CATALOG; }
function itemDef(ev, key) {
  for (const s of Object.values(catalog(ev))) if (s.items && s.items[key]) return s.items[key];
  return null;
}
function describe(ev, o) {
  const it = itemDef(ev, o.item);
  if (!it) return o.item;
  const parts = [`${(it.colors[o.color] || o.color).toLowerCase()} ${it.label.toLowerCase()}`];
  if (o.addon && o.addon !== 'none') parts.push(it.addons[o.addon]?.toLowerCase() || o.addon);
  return parts.join(' · ');
}

// ---------- auth ----------
let user = null;
const authReady = new Promise(res => {
  let first = true;
  onAuthStateChanged(auth, u => { user = u; if (first) { first = false; res(); } });
});
async function ensureGuest() {
  await authReady;
  if (!user) { const c = await signInAnonymously(auth); user = c.user; }
  return user;
}
async function isStaff() {
  await authReady;
  if (!user || user.isAnonymous || !user.email) return false;
  try { return (await getDoc(doc(db, 'staff', user.email))).exists(); } catch (e) { return false; }
}
async function staffGate(render) {
  if (await isStaff()) return render();
  $app.innerHTML = `<div class="wrap"><div class="top"><span class="brand">ivelisse designs</span><span class="meta">staff</span></div>
    <h1>Staff sign-in</h1>
    <p class="note">${user && !user.isAnonymous ? `Signed in as ${esc(user.email)}, which isn't on the staff list yet.` : 'Sign in with the Google account on the staff list.'}</p>
    <p><button class="primary" id="g">Sign in with Google</button></p>
    ${user && !user.isAnonymous ? '<p><button class="ghost" id="out">Sign out</button></p>' : ''}
    <p class="note">On an iPad home-screen app, if the sign-in window doesn't open, open this page in Safari once and sign in there.</p></div>`;
  document.getElementById('g').onclick = async () => {
    try { await signInWithPopup(auth, new GoogleAuthProvider()); route(); }
    catch (e) { toast('Sign-in did not finish: ' + (e.code || e.message)); }
  };
  const out = document.getElementById('out'); if (out) out.onclick = () => signOut(auth).then(route);
}

// ---------- router ----------
function route() {
  cleanup();
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [view, a, b] = parts;
  if (view === 'e' && a) return guestForm(a);
  if (view === 'o' && a && b) return statusPage(a, b);
  if (view === 'board' && a) return staffGate(() => boardPage(a));
  if (view === 'admin') return staffGate(adminPage);
  return homePage();
}
addEventListener('hashchange', route);

function homePage() {
  $app.innerHTML = `<div class="wrap"><div class="top"><span class="brand">ivelisse designs</span><span class="meta">board</span></div>
    <h1>Ivelisse Board</h1>
    <p class="note">Guests reach their event by scanning its QR code. Staff manage events here.</p>
    <p><a class="primary" style="display:flex;align-items:center;justify-content:center;text-decoration:none" href="#/admin">Staff: events &amp; boards</a></p></div>`;
}

// ---------- guest form ----------
async function guestForm(eventId) {
  $app.innerHTML = `<div class="wrap"><p class="muted">Loading…</p></div>`;
  await ensureGuest();
  let ev;
  try { const s = await getDoc(doc(db, 'events', eventId)); ev = s.exists() ? s.data() : null; } catch (e) { ev = null; }
  if (!ev) { $app.innerHTML = `<div class="wrap"><h1>Event not found</h1><p class="note">Check the QR code or ask the engraver.</p></div>`; return; }
  if (ev.open === false) { $app.innerHTML = `<div class="wrap"><h1>${esc(ev.name)}</h1><p class="note">Orders are closed for this event.</p></div>`; return; }

  const cat = catalog(ev);
  const services = (ev.services || ['engraving']).filter(s => cat[s] && Object.keys(cat[s].items).some(k => ev.items?.[k] !== false));
  const itemsFor = svc => Object.entries(cat[svc]?.items || {}).filter(([k]) => ev.items?.[k] !== false);
  const last = (() => { try { return JSON.parse(localStorage.getItem('eb-last-' + eventId) || 'null'); } catch (e) { return null; } })();

  const st = { svc: services[0], item: null, color: null, addon: 'none', name: '', font: 'script' };
  const first = itemsFor(st.svc)[0]; if (first) { st.item = first[0]; st.color = Object.keys(first[1].colors)[0]; }

  function render() {
    const it = st.item ? cat[st.svc].items[st.item] : null;
    const o = { ...st };
    $app.innerHTML = `<div class="wrap">
      <div class="top"><span class="brand">ivelisse designs</span><span class="meta">${esc(ev.name)}${ev.date ? ' · ' + esc(fmtDate(ev.date)) : ''}</span></div>
      ${last ? `<p class="note">You have an order in: <a href="#/o/${esc(eventId)}/${esc(last.id)}">check on ${esc(last.name)}</a></p>` : ''}
      <div class="preview" id="pv">${it ? previewHTML(ev, o) : ''}<div class="cap">${it ? (photoFor(ev, o) ? 'example of this style' : 'preview') : ''}</div></div>
      <h1 style="margin-top:18px">Make it yours.</h1>
      ${services.length > 1 ? `<div class="step"><div class="label">Service</div><div class="seg">${services.map(s => `<button data-svc="${s}" aria-pressed="${s === st.svc}">${esc(cat[s].label)}</button>`).join('')}</div></div>` : ''}
      <div class="step"><div class="label">01 — Piece</div><div class="rows" style="margin-top:8px">${itemsFor(st.svc).map(([k, v]) => `<button data-item="${k}" aria-pressed="${k === st.item}">${esc(v.label.toLowerCase())}</button>`).join('') || '<p class="note">Nothing offered yet.</p>'}</div></div>
      ${it ? `
      <div class="step"><div class="label">02 — ${esc(it.finishLabel || 'Finish')}</div><div class="swatches">${Object.entries(it.colors).map(([k, v]) => `<button data-color="${k}" aria-pressed="${k === st.color}"><span class="dot" style="background:${SWATCH[k] || '#ccc'}"></span>${esc(v.toLowerCase())}</button>`).join('')}</div></div>
      <div class="step"><div class="label">03 — Detail</div><div class="seg">${Object.entries(it.addons).map(([k, v]) => `<button data-addon="${k}" aria-pressed="${k === st.addon}">${esc(v.toLowerCase())}</button>`).join('')}</div></div>
      <div class="step"><label class="label" for="nm">04 — Name or initials</label>
        <input id="nm" class="namefield ${st.font === 'serif' ? 'serif' : 'script'}" maxlength="14" autocomplete="off" autocapitalize="words" value="${esc(st.name)}" placeholder="Your name">
        <div class="fonts">${Object.entries(FONTS).map(([k, v]) => `<button data-font="${k}" aria-pressed="${k === st.font}" class="${k === 'serif' ? 'serif' : 'script'}" style="font-size:${k === 'script' ? 22 : 16}px">${v}</button>`).join('')}</div></div>
      <p class="err" id="err"></p>
      <button class="primary" id="go" ${st.name.trim() ? '' : 'disabled'}>Send to engraver</button>` : ''}
      </div>`;
    $app.querySelectorAll('[data-svc]').forEach(b => b.onclick = () => { st.svc = b.dataset.svc; const f = itemsFor(st.svc)[0]; st.item = f ? f[0] : null; st.color = f ? Object.keys(f[1].colors)[0] : null; st.addon = 'none'; render(); });
    $app.querySelectorAll('[data-item]').forEach(b => b.onclick = () => { st.item = b.dataset.item; const d = cat[st.svc].items[st.item]; if (!d.colors[st.color]) st.color = Object.keys(d.colors)[0]; if (!d.addons[st.addon]) st.addon = 'none'; render(); });
    $app.querySelectorAll('[data-color]').forEach(b => b.onclick = () => { st.color = b.dataset.color; render(); });
    $app.querySelectorAll('[data-addon]').forEach(b => b.onclick = () => { st.addon = b.dataset.addon; render(); });
    $app.querySelectorAll('[data-font]').forEach(b => b.onclick = () => { st.font = b.dataset.font; render(); });
    const nm = document.getElementById('nm');
    if (nm) nm.oninput = () => {
      st.name = nm.value;
      document.getElementById('go').disabled = !st.name.trim();
      const pv = document.getElementById('pv');
      if (!photoFor(ev, st)) pv.firstElementChild.outerHTML = previewHTML(ev, st);
    };
    const go = document.getElementById('go');
    if (go) go.onclick = submit;
  }

  async function submit() {
    const name = st.name.trim().slice(0, 14);
    if (!name) return;
    const ref = doc(collection(db, 'events', eventId, 'orders'));
    const data = {
      uid: user.uid, service: st.svc, item: st.item, color: st.color, addon: st.addon, font: st.font, name,
      status: 'queue', engraver: null, createdAt: serverTimestamp(), clientAt: Date.now()
    };
    // Don't await: with offline persistence the write queues locally and syncs when back online.
    setDoc(ref, data).catch(e => toast('Could not send: ' + (e.code || e.message)));
    try { localStorage.setItem('eb-last-' + eventId, JSON.stringify({ id: ref.id, name })); } catch (e) {}
    location.hash = `#/o/${encodeURIComponent(eventId)}/${ref.id}`;
  }
  render();
}

// ---------- guest status ----------
async function statusPage(eventId, orderId) {
  $app.innerHTML = `<div class="wrap"><p class="muted">Loading…</p></div>`;
  await ensureGuest();
  let ev = null, order = null, queue = [];
  try { const s = await getDoc(doc(db, 'events', eventId)); ev = s.exists() ? s.data() : null; } catch (e) {}

  function render() {
    if (!order) { $app.innerHTML = `<div class="wrap"><div class="top"><span class="brand">ivelisse designs</span></div><p class="note">Looking for your order… If this doesn't change, it may have been placed on a different phone.</p></div>`; return; }
    const pos = queue.indexOf(orderId);
    const s = order.status;
    const pct = s === 'done' ? 100 : s === 'progress' ? 62 : 18;
    $app.innerHTML = `<div class="wrap">
      <div class="top"><span class="brand">ivelisse designs</span><span class="meta">order ${shortId(orderId)}</span></div>
      ${s === 'done' ? `<div class="ready"><div class="label" style="color:#e9dccf">Done</div><div class="serif">It's ready.</div><div>Pick it up at the ${ev?.services?.includes('calligraphy') && order.service === 'calligraphy' ? 'calligraphy' : 'engraving'} table.</div></div>` : ''}
      <div style="display:flex;gap:18px;align-items:center">
        <div class="preview" style="padding:6px;width:130px">${previewHTML(ev, order)}</div>
        <div><div class="${order.font === 'serif' ? 'serif' : 'script'}" style="font-size:${order.font === 'serif' ? 28 : 40}px;line-height:1">${esc(order.name)}</div><div class="muted" style="font-size:14px">${esc(describe(ev, order))}</div></div>
      </div>
      <div style="border-top:1px solid var(--line);margin-top:22px;padding-top:20px">
        ${s === 'queue' ? `<div class="label">In the queue</div>${pos >= 0 ? `<div style="display:flex;align-items:baseline;gap:10px;margin-top:6px"><span class="bignum">${pos}</span><span>${pos === 1 ? 'piece' : 'pieces'} ahead of yours</span></div>` : `<p class="note">Waiting for an engraver.</p>`}` : ''}
        ${s === 'progress' ? `<div class="label">Being made now</div><h1 style="margin:6px 0 0">${esc(order.engraver || 'Your engraver')} is working on it</h1>` : ''}
        ${s === 'done' ? `<div class="label">Finished</div>` : ''}
        <div class="bar ${s === 'progress' ? 'live' : ''}"><i style="width:${pct}%"></i></div>
      </div>
      <div class="timeline" style="margin-top:10px">
        <div class="done"><span>received</span><span class="muted">✓</span></div>
        <div class="${s === 'queue' ? 'now' : 'done'}"><span>waiting for an engraver</span><span>${s === 'queue' ? 'now' : '✓'}</span></div>
        <div class="${s === 'progress' ? 'now' : s === 'done' ? 'done' : ''}"><span>${order.service === 'calligraphy' ? 'lettering' : 'engraving'}</span><span>${s === 'progress' ? 'now' : s === 'done' ? '✓' : '—'}</span></div>
        <div class="${s === 'done' ? 'now' : ''}"><span>ready for pickup</span><span>${s === 'done' ? '✓' : '—'}</span></div>
      </div>
      <p class="note" style="margin-top:20px">This page updates on its own. Keep it open or come back with the same phone.</p>
      <p><a href="#/e/${esc(eventId)}">Personalize another piece</a></p>
    </div>`;
  }
  unsubs.push(onSnapshot(doc(db, 'events', eventId, 'orders', orderId), s => { order = s.exists() ? s.data() : null; render(); }, () => render()));
  unsubs.push(onSnapshot(doc(db, 'events', eventId, 'public', 'queue'), s => { queue = (s.exists() && s.data().ids) || []; render(); }, () => {}));
  render();
}

// ---------- board ----------
async function boardPage(eventId) {
  let ev = null, orders = [], online = navigator.onLine, lastQueueSig = '';
  unsubs.push(onSnapshot(doc(db, 'events', eventId), s => { ev = s.exists() ? s.data() : null; render(); }));
  unsubs.push(onSnapshot(query(collection(db, 'events', eventId, 'orders'), orderBy('createdAt')), { includeMetadataChanges: true }, s => {
    orders = s.docs.map(d => ({ id: d.id, pending: d.metadata.hasPendingWrites, ...d.data({ serverTimestamps: 'estimate' }) }));
    online = !s.metadata.fromCache || navigator.onLine;
    render();
    syncQueue();
  }));
  const onl = () => { online = navigator.onLine; render(); };
  addEventListener('online', onl); addEventListener('offline', onl);
  unsubs.push(() => { removeEventListener('online', onl); removeEventListener('offline', onl); });

  function syncQueue() {
    const ids = orders.filter(o => o.status === 'queue').map(o => o.id);
    const sig = ids.join(',');
    if (sig === lastQueueSig) return;
    lastQueueSig = sig;
    setDoc(doc(db, 'events', eventId, 'public', 'queue'), { ids, updatedAt: serverTimestamp() }).catch(() => {});
  }

  let dragging = false;
  function cardHTML(o, engravers) {
    const opts = [['queue|', 'Queue'], ...engravers.flatMap(e => [[`progress|${e}`, `${e} · now`], [`done|${e}`, `${e} · done`]])];
    const cur = `${o.status}|${o.engraver || ''}`;
    return `<div class="card" data-id="${o.id}">
      <div class="thumb">${previewHTML(ev, o)}</div>
      <div class="body"><div class="nm ${o.font === 'serif' ? 'serif' : ''}" style="${o.font === 'serif' ? 'font-size:18px' : ''}">${esc(o.name)}</div>
        <div class="ds">#${shortId(o.id)} · ${esc(describe(ev, o))}${o.pending ? ' · syncing' : ''}</div></div>
      <select aria-label="Move ${esc(o.name)}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
    </div>`;
  }
  function render() {
    if (dragging) return; // don't rebuild the DOM mid-drag
    if (!ev) { $app.innerHTML = `<div class="wrap"><p class="muted">Loading board…</p></div>`; return; }
    const engravers = (ev.engravers && ev.engravers.length) ? ev.engravers : ['Steph'];
    const q = orders.filter(o => o.status === 'queue');
    const inP = e => orders.filter(o => o.status === 'progress' && o.engraver === e);
    const dn = e => orders.filter(o => o.status === 'done' && o.engraver === e).reverse();
    const totals = { q: q.length, p: orders.filter(o => o.status === 'progress').length, d: orders.filter(o => o.status === 'done').length };
    $app.innerHTML = `<div class="board">
      <div class="top"><span class="brand">ivelisse designs · ${esc(ev.name)}</span>
        <span class="meta">${totals.q} waiting · ${totals.p} working · ${totals.d} done &nbsp; <span class="sync ${online ? '' : 'off'}"><i></i>${online ? 'live' : 'offline — saving on this iPad'}</span> &nbsp; <a href="#/admin">events</a></span></div>
      <div class="lanes" style="--n:${engravers.length}">
        <section class="lane"><h2>Queue <small>oldest first</small></h2><div class="drop" data-status="queue" data-engraver="" data-empty="no one waiting">${q.map(o => cardHTML(o, engravers)).join('')}</div></section>
        ${engravers.map(e => `<section class="lane"><h2>${esc(e)} <small>${dn(e).length} done</small></h2>
          <div class="label" style="margin-top:6px">Now</div>
          <div class="drop now" data-status="progress" data-engraver="${esc(e)}" data-empty="drag a card here to start">${inP(e).map(o => cardHTML(o, engravers)).join('')}</div>
          <div class="label" style="margin-top:12px;color:var(--muted)">Done</div>
          <div class="drop done" data-status="done" data-engraver="${esc(e)}" data-empty="finished pieces land here">${dn(e).map(o => cardHTML(o, engravers)).join('')}</div>
        </section>`).join('')}
      </div></div>`;
    $app.querySelectorAll('.drop').forEach(el => {
      new Sortable(el, {
        group: 'orders', animation: 150, delay: 80, delayOnTouchOnly: true, filter: 'select', preventOnFilter: false,
        onStart: () => { dragging = true; },
        onEnd: evt => {
          dragging = false;
          const id = evt.item.dataset.id, to = evt.to;
          if (evt.from !== to) move(id, to.dataset.status, to.dataset.engraver || null);
          else render();
        }
      });
    });
    $app.querySelectorAll('.card select').forEach(sel => sel.onchange = () => {
      const [status, eng] = sel.value.split('|');
      move(sel.closest('.card').dataset.id, status, eng || null);
    });
  }
  function move(id, status, engraver) {
    const patch = { status, engraver: status === 'queue' ? null : engraver, updatedAt: serverTimestamp() };
    if (status === 'progress') patch.startedAt = serverTimestamp();
    if (status === 'done') patch.doneAt = serverTimestamp();
    // Optimistic: the local cache updates immediately; Firestore syncs when online.
    updateDoc(doc(db, 'events', eventId, 'orders', id), patch).catch(e => { toast('Move failed: ' + (e.code || e.message)); });
  }
  render();
}

// ---------- export ----------
const tsDate = t => (t && typeof t.toDate === 'function') ? t.toDate() : null;
const fmtStamp = d => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
const mins = (a, b) => (a && b && b >= a) ? Math.round((b - a) / 6000) / 10 : '';
async function exportOrders(eventId, ev) {
  const snap = await getDocs(query(collection(db, 'events', eventId, 'orders'), orderBy('createdAt')));
  const head = ['Order #', 'Name', 'Service', 'Item', 'Finish', 'Detail', 'Lettering', 'Submitted', 'Handled by', 'Started', 'Finished', 'Wait in queue (min)', 'Time to make (min)', 'Total (min)', 'Status'];
  const rows = snap.docs.map(d => {
    const o = d.data(); const it = itemDef(ev, o.item) || { label: o.item, colors: {}, addons: {} };
    const sub = tsDate(o.createdAt), st = tsDate(o.startedAt), dn = o.status === 'done' ? tsDate(o.doneAt) : null;
    return [shortId(d.id), o.name, catalog(ev)[o.service]?.label || o.service || '', it.label, it.colors[o.color] || o.color || '', it.addons[o.addon] || o.addon || '',
      FONTS[o.font] || o.font || '', fmtStamp(sub), o.engraver || '', fmtStamp(st), fmtStamp(dn), mins(sub, st), mins(st, dn), mins(sub, dn),
      { queue: 'Waiting', progress: 'In progress', done: 'Done' }[o.status] || o.status];
  });
  const cell = v => { const t = String(v ?? ''); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const csv = '\ufeff' + [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `${eventId}-orders.csv`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`${rows.length} orders exported. In Google Sheets: File → Import → Upload.`);
}

// ---------- admin ----------
async function adminPage() {
  const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  async function load() {
    const snap = await getDocs(collection(db, 'events'));
    const evs = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    render(evs);
  }
  function itemChecks(ev) {
    return Object.entries(DEFAULT_CATALOG).flatMap(([svc, s]) => Object.entries(s.items).map(([k, v]) =>
      `<label><input type="checkbox" name="item" value="${k}" ${!ev || ev.items?.[k] !== false ? 'checked' : ''}> ${esc(v.label)}</label>`)).join('');
  }
  function photosText(ev) { return Object.entries(ev?.photos || {}).map(([k, v]) => `${k} = ${v}`).join('\n'); }
  function render(evs) {
    $app.innerHTML = `<div class="wrap" style="max-width:860px">
      <div class="top"><span class="brand">ivelisse designs</span><span class="meta">${esc(user.email)} · <a href="#" id="out">sign out</a></span></div>
      <h1>Events</h1>
      <details ${evs.length ? '' : 'open'}><summary class="label" style="cursor:pointer;min-height:44px;display:flex;align-items:center">+ New event</summary>
        <form id="new">
          <div class="field"><label class="label" for="n-name">Event name</label><input id="n-name" required placeholder="Coach · NorthPark"></div>
          <div class="field"><label class="label" for="n-date">Date</label><input id="n-date" type="date" required></div>
          <div class="field"><label class="label" for="n-eng">Engravers (comma separated)</label><input id="n-eng" value="Steph"></div>
          <div class="field"><span class="label">Items offered</span><div class="checks">${itemChecks(null)}</div></div>
          <button class="primary">Create event</button>
        </form></details>
      ${evs.map(ev => {
        const url = `${baseUrl()}#/e/${encodeURIComponent(ev.id)}`;
        return `<div class="event" data-id="${esc(ev.id)}">
          <div class="qr" data-url="${esc(url)}"></div>
          <div class="info">
            <h2>${esc(ev.name)}</h2><div class="muted">${esc(fmtDate(ev.date))} · ${(ev.engravers || []).map(esc).join(', ')}${ev.open === false ? ' · closed' : ''}</div>
            <div class="links"><a href="#/board/${encodeURIComponent(ev.id)}">Open board</a><a href="#/e/${encodeURIComponent(ev.id)}">Guest form</a><a href="#" data-copy="${esc(url)}">Copy guest link</a><a href="#" data-qr="${esc(ev.id)}">Download QR</a><a href="#" data-export="${esc(ev.id)}">Export orders (Sheets)</a></div>
            <details><summary class="label" style="cursor:pointer;min-height:44px;display:flex;align-items:center">Edit</summary>
              <div class="field"><label class="label">Engravers</label><input name="eng" value="${esc((ev.engravers || []).join(', '))}"></div>
              <div class="field"><span class="label">Items offered</span><div class="checks">${itemChecks(ev)}</div></div>
              <div class="field"><label class="label">Example photos — one per line: key = photo link</label>
                <textarea name="photos" placeholder="bagtag_black_stars = https://drive.google.com/file/d/…/view&#10;bagtag_black = …&#10;tumbler = …">${esc(photosText(ev))}</textarea>
                <span class="note">Keys: item, item_color, or item_color_detail (e.g. bagtag, tumbler_white, bagtag_tan_heart). Drive links must be shared "anyone with the link".</span></div>
              <label style="display:flex;gap:8px;align-items:center;min-height:44px"><input type="checkbox" name="open" ${ev.open === false ? '' : 'checked'}> Taking orders</label>
              <button class="ghost" data-save>Save changes</button>
            </details>
          </div></div>`;
      }).join('') || '<p class="note">No events yet.</p>'}
    </div>`;
    document.getElementById('out').onclick = e => { e.preventDefault(); signOut(auth).then(() => { location.hash = '#/'; }); };
    $app.querySelectorAll('.qr').forEach(el => {
      const q = qrcode(0, 'M'); q.addData(el.dataset.url); q.make();
      el.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    });
    $app.querySelectorAll('[data-copy]').forEach(a => a.onclick = e => { e.preventDefault(); navigator.clipboard?.writeText(a.dataset.copy).then(() => toast('Guest link copied')); });
    $app.querySelectorAll('[data-qr]').forEach(a => a.onclick = e => {
      e.preventDefault();
      const box = a.closest('.event'); const q = qrcode(0, 'M'); q.addData(box.querySelector('.qr').dataset.url); q.make();
      const link = document.createElement('a'); link.href = q.createDataURL(12, 4); link.download = `qr-${a.dataset.qr}.gif`; link.click();
    });
    $app.querySelectorAll('[data-export]').forEach(a => a.onclick = async e => {
      e.preventDefault();
      const id = a.dataset.export; const ev = evs.find(x => x.id === id);
      try { await exportOrders(id, ev); } catch (err) { toast('Export failed: ' + (err.code || err.message)); }
    });
    document.getElementById('new').onsubmit = async e => {
      e.preventDefault();
      const name = document.getElementById('n-name').value.trim(), date = document.getElementById('n-date').value;
      const id = slug(`${name}-${date}`);
      const items = {}; e.target.querySelectorAll('[name=item]').forEach(c => items[c.value] = c.checked);
      const engravers = document.getElementById('n-eng').value.split(',').map(s => s.trim()).filter(Boolean);
      try {
        await setDoc(doc(db, 'events', id), { name, date, engravers, items, services: ['engraving'], catalog: DEFAULT_CATALOG, photos: {}, open: true, createdAt: serverTimestamp() });
        toast('Event created'); load();
      } catch (err) { toast('Could not create: ' + (err.code || err.message)); }
    };
    $app.querySelectorAll('[data-save]').forEach(btn => btn.onclick = async () => {
      const box = btn.closest('.event'); const id = box.dataset.id;
      const items = {}; box.querySelectorAll('[name=item]').forEach(c => items[c.value] = c.checked);
      const photos = {};
      box.querySelector('[name=photos]').value.split('\n').forEach(line => {
        const i = line.indexOf('='); if (i < 1) return;
        const k = line.slice(0, i).trim().replace(/\s+/g, ''); const v = line.slice(i + 1).trim();
        if (k && v) photos[k] = driveToDirect(v);
      });
      const engravers = box.querySelector('[name=eng]').value.split(',').map(s => s.trim()).filter(Boolean);
      try { await updateDoc(doc(db, 'events', id), { items, photos, engravers, open: box.querySelector('[name=open]').checked }); toast('Saved'); load(); }
      catch (err) { toast('Could not save: ' + (err.code || err.message)); }
    });
  }
  $app.innerHTML = `<div class="wrap"><p class="muted">Loading events…</p></div>`;
  load().catch(e => { $app.innerHTML = `<div class="wrap"><p class="err">Could not load events: ${esc(e.code || e.message)}</p></div>`; });
}

route();
