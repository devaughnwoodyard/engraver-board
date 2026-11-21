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
// Event setup, catalog and photos are for the managers (Google accounts listed in /staff).
async function staffGate(render) {
  if (await isStaff()) return render();
  $app.innerHTML = `<div class="page"><header class="band">${LOGO}<div class="ev">event setup</div>${WAVE(390)}</header>
    <main class="content">${crumbs([['Events', '#/'], ['Event setup', '#/admin'], ['Sign in']])}<h1>event <em>setup</em></h1>
    <p class="note">${user && !user.isAnonymous ? `${esc(user.email)} can't open event setup.` : "Sign in with Steph's or DeVaughn's Google account."}</p>
    <button class="btn" id="g" type="button">Sign in with Google</button>
    ${user && !user.isAnonymous ? '<button class="btn out" id="out" type="button">Sign out</button>' : ''}
    <p class="note" style="font-size:.8125rem">On an iPad home-screen app, if the sign-in window doesn't open, open this page in Safari once and sign in there.</p></main></div>`;

  document.getElementById('g').onclick = async () => {
    try { await signInWithPopup(auth, new GoogleAuthProvider()); route(); }
    catch (e) { toast('Sign-in did not finish: ' + (e.code || e.message)); }
  };
  const out = document.getElementById('out'); if (out) out.onclick = () => signOut(auth).then(route);
}

// Event staff: tap the event, enter the staff PIN once on this device, then pick your name.
// One PIN covers every event (managers set it in Event setup). The database rules check it, and only while the event is open.
const staffKey = id => 'eb-staff-' + id;
function staffName(id) { try { return localStorage.getItem(staffKey(id)) || ''; } catch (e) { return ''; } }
function setStaffName(id, n) { try { localStorage.setItem(staffKey(id), n); } catch (e) {} }
const newPin = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
const pinRef = () => doc(db, 'private', 'access');
async function loadPin() { // managers only
  const s = await getDoc(pinRef());
  if (s.exists() && s.data().pin) return s.data().pin;
  const p = newPin(); await setDoc(pinRef(), { pin: p, updatedAt: serverTimestamp() }); return p;
}
// Events running now: open and dated yesterday through next week, closest to today first. Two can run at once.
function openEvents(evs) {
  const today = todayStr(), from = addDays(today, -1), to = addDays(today, 7);
  const dist = e => Math.abs(new Date(e.date + 'T12:00:00') - new Date(today + 'T12:00:00'));
  return evs.filter(e => e.id !== DEMO_ID && e.open !== false && (e.date || '') >= from && (e.date || '') <= to)
    .sort((a, b) => dist(a) - dist(b) || String(a.name).localeCompare(String(b.name)));
}
async function canWorkBoard(eventId) {
  if (eventId === DEMO_ID || await isStaff()) return true;
  if (!user) return false;
  try { return (await getDocFromServer(doc(db, 'events', eventId, 'staffSessions', user.uid))).exists(); }
  catch (e) { try { return (await getDoc(doc(db, 'events', eventId, 'staffSessions', user.uid))).exists(); } catch (x) { return false; } }
}
async function boardGate(eventId) {
  await authReady;
  if (eventId === DEMO_ID) await ensureGuest();
  if (await canWorkBoard(eventId)) return boardPage(eventId);
  location.replace(`${baseUrl()}#/staff/${encodeURIComponent(eventId)}`);
}

// Managers previewing the guest side, or on the board, always get a way back to the event's setup.
const POV_KEY = 'eb-pov';
const povOn = id => { try { return sessionStorage.getItem(POV_KEY) === id; } catch (e) { return false; } };
const setPov = id => { try { id ? sessionStorage.setItem(POV_KEY, id) : sessionStorage.removeItem(POV_KEY); } catch (e) {} };
function setupPill(eventId, raised) {
  const a = document.createElement('a'); a.className = 'backpill' + (raised ? ' raised' : ''); a.href = `#/admin/${encodeURIComponent(eventId)}`; a.textContent = '‹ Go back to Event Setup';
  document.body.appendChild(a); document.body.classList.add('haspill');
  unsubs.push(() => { a.remove(); document.body.classList.remove('haspill'); });
  getDoc(doc(db, 'events', eventId)).then(s => { if (s.exists()) a.textContent = `‹ Go back to Event Setup for ${s.data().name}`; }).catch(() => {});
}

// Breadcrumbs: [[label, href], …, [label]] — the last one is where you are.
const crumbs = list => `<nav class="crumbs" aria-label="Breadcrumb">${list.map(([l, h], i) => i < list.length - 1 && h ? `<a href="${h}">${esc(l)}</a>` : `<span aria-current="page">${esc(l)}</span>`).join('<i aria-hidden="true">›</i>')}</nav>`;

// Events home → tap an event → staff PIN → pick your name (the event's guest QR shows here) → board.
async function staffSignIn(eventId, step) {
  $app.innerHTML = `<div class="page"><p class="note" style="padding:40px">Loading…</p></div>`;
  await authReady;
  const mgr = await isStaff();
  const head = `<header class="band">${LOGO}<div class="ev">events</div>${WAVE(390)}</header>`;
  const setupLink = `<a class="barlink" href="#/admin">Event setup</a>`;

  if (!eventId) {
    let live = [];
    try { live = openEvents(await listEvents()); } catch (e) {}
    $app.innerHTML = `<div class="page">${head}<main class="content">${crumbs([['Events']])}
      ${live.length ? `<div class="evpick tall">${live.map(e => `<a href="#/staff/${encodeURIComponent(e.id)}"><b>${esc(e.name)}</b><small>${esc(fmtDate(e.date))}</small></a>`).join('')}</div>`
        : `<div class="rule"></div><h1>no event is <em>open</em></h1>`}
      </main><div class="bar stack">${setupLink}</div></div>`;
    return;
  }

  let ev = null;
  try { const s = await getDoc(doc(db, 'events', eventId)); ev = s.exists() ? s.data() : null; } catch (e) {}
  if (!ev) { location.replace(`${baseUrl()}#/`); return; }
  const trail = [['Events', '#/'], [ev.name, `#/staff/${encodeURIComponent(eventId)}`]];
  const signedIn = mgr || eventId === DEMO_ID || await canWorkBoard(eventId);

  if (ev.open === false && !mgr && !signedIn) {
    $app.innerHTML = `<div class="page">${head}<main class="content">${crumbs([trail[0], [ev.name]])}<div class="rule"></div><h1>this event is <em>closed</em></h1></main><div class="bar stack">${setupLink}</div></div>`;
    return;
  }

  // Step 1: the PIN (skipped once this device is in, and for Steph and DeVaughn).
  if (!signedIn) {
    const st = { pin: '', busy: false, err: '' };
    const render = () => {
      $app.innerHTML = `<div class="page">${head}<main class="content">${crumbs([trail[0], [ev.name]])}
        <div class="evnow"><h1>${esc(ev.name)}</h1><p class="note">${esc(fmtDate(ev.date))}</p></div>
        <div class="field"><label class="lbl" for="pin" style="text-align:center">Staff PIN</label>
          <input id="pin" class="pinfield" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="one-time-code" value="${esc(st.pin)}"></div>
        <p class="err" role="alert">${esc(st.err)}</p></main>
        <div class="bar stack"><button class="btn" id="go" type="button" ${st.busy || st.pin.length !== 4 ? 'disabled' : ''}>${st.busy ? 'Checking…' : 'Continue'}</button></div></div>`;
      const p = document.getElementById('pin'); p.focus();
      p.oninput = () => { st.pin = p.value.replace(/\D/g, '').slice(0, 4); p.value = st.pin; st.err = ''; document.getElementById('go').disabled = st.pin.length !== 4; if (st.pin.length === 4) go(); };
      document.getElementById('go').onclick = go;
    };
    const go = async () => {
      if (st.busy) return; st.busy = true; render();
      try {
        await ensureGuest();
        await setDoc(doc(db, 'events', eventId, 'staffSessions', user.uid), { pin: st.pin, at: serverTimestamp() });
        location.hash = `#/staff/${encodeURIComponent(eventId)}/who`;
      } catch (e) { st.busy = false; st.pin = ''; st.err = e.code === 'permission-denied' ? "That PIN doesn't match." : 'Could not sign in: ' + (e.code || e.message); render(); }
    };
    render();
    return;
  }

  // Step 2: who are you? The guest QR for this event sits right here to show guests.
  const names = ev.engravers || [];
  const url = guestUrl(eventId);
  $app.innerHTML = `<div class="page">${head}<main class="content">${crumbs([...trail, ['Who are you?']])}
    <fieldset><legend>who are <em>you?</em></legend>
      <div class="namegrid">${names.map(n => `<button type="button" data-nm="${esc(n)}" ${n === staffName(eventId) ? 'aria-current="true"' : ''}>${esc(n)}</button>`).join('') || '<p class="note">No staff names on this event yet.</p>'}</div></fieldset>
    <section class="eventqr"><div class="qr" aria-label="QR code guests scan to order">${qrSvg(url)}</div><div><b>Guests scan to order</b><span>${esc(ev.name)}</span></div></section>
    </main></div>`;
  $app.querySelectorAll('[data-nm]').forEach(b => b.onclick = () => { setStaffName(eventId, b.dataset.nm); location.hash = `#/board/${encodeURIComponent(eventId)}`; });
}

// The one guest QR: always opens whichever event is open now.
async function goToCurrent() {
  $app.innerHTML = `<div class="page"><p class="note" style="padding:40px">Loading…</p></div>`;
  let live = [];
  try { live = openEvents(await listEvents()); } catch (e) {}
  if (live.length === 1) { location.replace(`${baseUrl()}#/e/${encodeURIComponent(live[0].id)}`); return; }
  if (live.length > 1) {
    $app.innerHTML = `<div class="page"><header class="band">${LOGO}${WAVE(390)}</header><main class="content"><div class="rule"></div><h1>which event are <em>you at?</em></h1>
      <div class="evpick">${live.map(e => `<a href="#/e/${encodeURIComponent(e.id)}"><b>${esc(e.name)}</b><small>${esc(fmtDate(e.date))}</small></a>`).join('')}</div></main></div>`;
    return;
  }
  $app.innerHTML = `<div class="page"><header class="band">${LOGO}${WAVE(390)}</header><main class="content"><div class="rule"></div><h1>see you at the <em>next event</em></h1>
    <p class="note">We're not taking orders right now.</p></main></div>`;
}

// ---------- router ----------
// Setup and form builder pages set leaveGuard while they hold unsaved changes.
let leaveGuard = null, lastHash = location.hash;
async function route() {
  if (leaveGuard && leaveGuard() && location.hash !== lastHash && !confirm('Leave without saving your changes?')) { history.replaceState(null, '', lastHash || '#/'); return; }
  leaveGuard = null; lastHash = location.hash;
  cleanup();
  const [view, a, b] = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  window.scrollTo(0, 0);
  await loadCatalog();
  if (view === 'go') return goToCurrent();
  if (view === 'e' && a) return guestForm(a);
  if (view === 'o' && a && b) return statusPage(a, b);
  if (view === 'board' && a) return boardGate(a);
  if (view === 'admin') return staffGate(() => a ? setupPage(a) : adminPage());
  if (view === 'photos') return staffGate(photosPage);
  if (view === 'catalog') { location.replace(`${baseUrl()}#/admin`); return; }
  return staffSignIn(view === 'staff' ? a : undefined, view === 'staff' ? b : undefined);
}
addEventListener('hashchange', route);

// ---------- guest form ----------
async function guestForm(eventId) {
  $app.innerHTML = `<div class="page"><p class="note" style="padding:40px">Loading…</p></div>`;
  if (povOn(eventId)) setupPill(eventId, true);
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
  if (povOn(eventId)) setupPill(eventId, true);
  await ensureGuest();
  let ev = null, order = null, queue = null, connected = true, lastSig = '', brand = {};
  // Don't hold the page on the event details; the order itself is what the guest is waiting for.
  getDoc(doc(db, 'events', eventId)).then(s => { ev = s.exists() ? s.data() : null; render(); }).catch(() => {});
  getDoc(brandRef(eventId)).then(s => { brand = s.exists() ? s.data() : {}; render(); }).catch(() => {});
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
      html = `<header class="band readyband">${brandCorners(brand)}${LOGO}
        ${s === 'done' ? `<h1 style="margin-top:8px">it's <em>ready!</em></h1><div style="font-size:1.0625rem;margin-top:6px">pick it up ${esc(pick)}</div><div class="code">${shortId(orderId)}</div><div style="font-size:.875rem;margin-top:8px">show this code</div>`
        : `<h1 style="margin-top:8px">enjoy it, <em>${esc(order.name)}</em></h1><div style="font-size:1.0625rem;margin-top:6px">thanks for celebrating with us</div>`}${WAVE(390)}</header>
        <main class="content"><div class="proof"><span class="ph">${previewHTML(ev, order)}</span><div style="font:800 1.125rem var(--body)">${esc(order.name)}</div><div style="font-size:.875rem;color:var(--muted)">${order.engraver ? 'made by ' + esc(order.engraver) : ''}${tsDate(order.doneAt) ? ' • ' + fmtTime(tsDate(order.doneAt)) : ''}</div></div>${brandBottom(brand)}</main>
        <div class="bar"><a class="btn out" href="#/e/${encodeURIComponent(eventId)}">Personalize another piece</a></div>`;
    } else {
      const state = s === 'progress'
        ? `<div class="eyebrow">it's happening</div><h1>${esc(order.engraver || 'we')} ${order.engraver ? 'is' : 'are'} <em>${order.service === 'calligraphy' ? 'lettering' : 'engraving'}</em> yours</h1>`
        : (pos >= 0 ? `<div class="eyebrow">you're in line</div>${pos === 0 ? `<h1>you're <em>next</em></h1>` : `<div class="big" aria-hidden="true">${pos}</div><h1 style="font-size:1.5rem;margin-top:4px" aria-hidden="true">${pos === 1 ? 'piece' : 'pieces'} ahead of <em>yours</em></h1><p class="note" style="margin-top:6px">you're #${pos + 1} in line</p>`}`
          : `<div class="eyebrow">you're in line</div><h1>${queue === null ? 'finding your <em>place</em>…' : `we've got <em>yours</em>`}</h1>`);
      html = `<header class="band">${brandCorners(brand)}${LOGO}<div class="ev">order ${shortId(orderId)}</div>${WAVE(390)}</header>
        <main class="content"><div class="state">${state}</div>
        <p class="vh" role="status" aria-atomic="true" id="announce"></p>
        ${miles}${item}${order.phone ? `<p class="note" style="font-size:.875rem">We'll text ${esc(fmtPhone(order.phone))} when it's ready.</p>` : ''}${save}${live}${brandBottom(brand)}</main>`;
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

// ---------- text preview ----------
// Shows guests what the order texts look like, laid out like the iPhone Messages app.
// Nothing is sent; it's a simulation built from this order.
const TEXT_FROM = '+1 (469) 398-8476';
// Steph's Google Business Profile link.
const REVIEW_URL = 'https://share.google/pYr87ENQgaxoU85Ng';
const IG_URL = 'https://instagram.com/ivelissedesigns';
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
  const day = d => { const n = new Date(); n.setHours(0, 0, 0, 0); const x = new Date(d); x.setHours(0, 0, 0, 0); const diff = Math.round((x - n) / 864e5); return diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : x.toLocaleDateString('en-US', { weekday: 'long' }); };
  const stamp = d => `${day(d)} ${clock(d)}`;
  // The thank-you goes out a few hours later, but never overnight: late orders get it the next morning at 10.
  const thanksAt = (() => { const d = at(180); if (d.getHours() >= 21 || d.getHours() < 9 || d.getDate() !== at(0).getDate()) { const m = new Date(at(0)); if (at(0).getHours() >= 9) m.setDate(m.getDate() + 1); m.setHours(10, 0, 0, 0); return m; } return d; })();
  const now = new Date();
  const linkA = u => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`;
  const card = (title, domain, hero) => `<div class="ims-card"><div class="hero">${hero}</div><div class="meta"><div class="t">${esc(title)}</div><div class="d">${esc(domain)}</div></div></div>`;
  // Each step: a centered timestamp (optional) and the bubbles that arrive together.
  const steps = [
    { meta: `<b>Text Message</b><br>${stamp(at(0))}`, items: [
      `Ivelisse Designs: Thanks, ${esc(name)}! Your ${esc(piece)} order is in and you're #${line} in line. Reply STOP to opt out, HELP for help.`] },
    { meta: `${stamp(at(18))}`, items: [`Ivelisse Designs: ${esc(name)}, your ${esc(piece)} is ready! Pick it up ${esc(pick)}. Reply STOP to opt out.`] },
    { meta: `${stamp(thanksAt)}`, items: [
      `Ivelisse Designs: Thanks for celebrating with us, ${esc(name)}! Loved your ${esc(piece)}? Leave us a quick Google review: ${linkA(REVIEW_URL)} and follow us on Instagram: ${linkA(IG_URL)} Reply STOP to opt out.`,
      { card: card('Ivelisse Designs', 'share.google', 'Ivelisse Designs') }] }
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
  const mgr = await isStaff();
  if (mgr) setupPill(eventId, false);
  const me = staffName(eventId);
  const online = () => navigator.onLine && !fromCache;
  unsubs.push(onSnapshot(doc(db, 'events', eventId), s => { ev = s.exists() ? s.data() : null; render(); }));
  unsubs.push(onSnapshot(query(collection(db, 'events', eventId, 'orders'), orderBy('createdAt')), { includeMetadataChanges: true }, s => {
    orders = s.docs.map(d => ({ id: d.id, pending: d.metadata.hasPendingWrites, ...d.data({ serverTimestamps: 'estimate' }) }));
    fromCache = s.metadata.fromCache; render(); syncQueue();
  }, e => { if (e.code === 'permission-denied') location.replace(`${baseUrl()}#/staff/${encodeURIComponent(eventId)}`); }));
  const onl = () => render(); addEventListener('online', onl); addEventListener('offline', onl);
  unsubs.push(() => { removeEventListener('online', onl); removeEventListener('offline', onl); });
  timers.push(setInterval(() => render(), 30000)); // refresh wait ages

  function syncQueue() {
    const ids = orders.filter(o => o.status === 'queue').map(o => o.id), sig = ids.join(',');
    if (sig === lastQueueSig) return; lastQueueSig = sig;
    setDoc(doc(db, 'events', eventId, 'public', 'queue'), { ids, updatedAt: serverTimestamp() }).catch(() => {});
  }
  const staff = () => (ev?.engravers?.length ? ev.engravers : ['Steph']);
  // Anyone can hold any number of pieces; oldest started sits at the top of their column.
  const holding = e => orders.filter(o => o.status === 'progress' && o.engraver === e).sort((a, b) => (tsDate(a.startedAt) || 0) - (tsDate(b.startedAt) || 0));
  const mins = o => { const d = tsDate(o.createdAt) || tsDate(o.clientAt); return d ? Math.max(0, Math.round((Date.now() - d) / 60000)) : 0; };
  const pendChip = o => o.pending ? `<div class="pend">${online() ? 'Saving…' : 'Offline • move pending'}</div>` : '';

  // Up to 3 staff: one button each (1 = full width, 2 = left and right, 3 = thirds). More than 3: tap to open the list.
  function assignRow(o) {
    const names = staff();
    const btn = e => `<button type="button" class="as ${e === me ? 'me' : ''}" data-start="${o.id}" data-who="${esc(e)}" aria-label="Assign to ${esc(e)}">${names.length === 1 ? 'Assign to ' : ''}${esc(e)}</button>`;
    if (names.length <= 3) return `<div class="assign n${names.length}">${names.map(btn).join('')}</div>`;
    return `<div class="assign n1"><button type="button" class="as" data-pick="${o.id}" aria-expanded="${openWho === o.id}">${openWho === o.id ? 'Assign to… ▴' : 'Tap to assign ▾'}</button></div>
      ${openWho === o.id ? `<div class="assign n2">${names.map(btn).join('')}</div>` : ''}`;
  }
  function queueCard(o, i) {
    const m = mins(o);
    return `<div class="qc" data-id="${o.id}"><span class="ph">${previewHTML(ev, o)}</span><div class="nm"><span class="pos" aria-label="Position ${i + 1}">${i + 1}</span>${esc(o.name)}</div><div class="ds">#${shortId(o.id)} • ${esc(describe(ev, o, true))} • ${esc((FONTS[o.font] || '').toLowerCase())}${o.phone ? ' • <b class="txt">gets texts</b>' : ''}</div>
      <div class="ft"><span class="age ${m >= 10 ? 'hot' : ''}">waiting ${m} min</span></div>${assignRow(o)}${pendChip(o)}</div>`;
  }
  function nowCard(o) {
    const st = tsDate(o.startedAt); const m = st ? Math.max(0, Math.round((Date.now() - st) / 60000)) : 0;
    return `<div class="now" data-id="${o.id}"><div class="top"><span class="ph">${previewHTML(ev, o)}</span><div><div class="nm">${esc(o.name)}</div><div class="ds">#${shortId(o.id)} • ${esc(describe(ev, o, true))}<br>${esc((FONTS[o.font] || '').toLowerCase())} • ${m} min in</div></div></div>
      <div class="acts2"><button class="ret" type="button" data-return="${o.id}">Return to queue</button><button class="rd" type="button" data-ready="${o.id}">Mark ready!</button></div>${pendChip(o)}</div>`;
  }
  function readyCard(o) {
    return `<div class="rc" data-id="${o.id}"><span class="ph">${previewHTML(ev, o)}</span><div><div class="nm">${esc(o.name)} <span class="cd">${shortId(o.id)}</span></div><div class="ds">${esc(describe(ev, o))}${o.engraver ? ' • ' + esc(o.engraver) : ''}</div></div>
      <button class="pk2" type="button" data-picked="${o.id}">Picked up</button>${pendChip(o)}</div>`;
  }
  function render() {
    if (dragging) return;
    if (!ev) { $app.innerHTML = `<div class="page"><p class="note" style="padding:40px">Loading board…</p></div>`; return; }
    const dlgOpen = document.getElementById('pk')?.open; const qv = document.getElementById('find')?.value ?? pickupQuery;
    const q = orders.filter(o => o.status === 'queue'), ready = orders.filter(o => o.status === 'done');
    const n = { q: q.length, p: orders.filter(o => o.status === 'progress').length, r: ready.length, x: orders.filter(o => o.status === 'picked').length };
    // Pieces held by someone no longer on the event still need a home on screen.
    const names = [...staff(), ...new Set(orders.filter(o => o.status === 'progress' && o.engraver && !staff().includes(o.engraver)).map(o => o.engraver))];
    $app.innerHTML = `<div class="boardpage">
      <header class="bh">${LOGO}<div><div class="t">${esc(ev.name)}</div><div class="sub">${esc(fmtDate(ev.date))}</div></div>
        <div class="k"><span><b>${n.q}</b>waiting</span><span><b>${n.p}</b>in progress</span><span><b>${n.x}</b>picked up</span>
          <button class="pu" id="openpk" type="button">Find by code ›</button>
          <span class="lv ${online() ? '' : 'off'}"><i aria-hidden="true"></i>${online() ? 'Live' : 'Offline • moves save on this iPad'}</span></div>${WAVE(1180)}</header>
      <main class="lanes">
        <section class="lane q" aria-label="Queue"><h2>queue <small>${n.q}</small></h2>
          <div class="drop" data-status="queue" data-engraver="">${q.map(queueCard).join('') || '<p class="note">No one waiting.</p>'}</div></section>
        ${names.map(e => { const h = holding(e); 
          return `<section class="lane staff ${e === me ? 'mine' : ''}" aria-label="${esc(e)}"><h2><span>${esc(e.toLowerCase())}${e === me ? ' <small class="you">you</small>' : ''}</span> <small>${h.length || ''}</small></h2>
            <div class="drop zone" data-status="progress" data-engraver="${esc(e)}">${h.map(nowCard).join('')}<div class="free"><div><b>free</b></div></div></div>
            </section>`; }).join('')}
        <section class="lane ready" aria-label="Ready for pickup"><h2>ready <small>${n.r}</small></h2>
          <div class="drop" data-status="done" data-engraver="">${ready.map(readyCard).join('') || '<p class="note">Nothing waiting for pickup.</p>'}</div></section>
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
  const pickedUp = id => { move(id, 'picked'); toast(`${shortId(id)} picked up`, { label: 'Undo', run: () => move(id, 'done', null, true) }); };
  function renderPickup() {
    const v = (document.getElementById('find')?.value || '').trim().toUpperCase(); pickupQuery = v;
    const list = orders.filter(o => o.status === 'done' && (!v || shortId(o.id).startsWith(v) || o.name.toUpperCase().startsWith(v)));
    document.getElementById('pkl').innerHTML = list.map(o => `<div class="pr ${v.length === 4 && shortId(o.id) === v ? 'match' : ''}"><span class="c">${shortId(o.id)}</span><span class="ph">${previewHTML(ev, o)}</span>
      <div><div style="font:800 1.0625rem var(--body)">${esc(o.name)}</div><div style="font-size:.8125rem;color:var(--muted)">${esc(describe(ev, o))}${o.engraver ? ' • by ' + esc(o.engraver) : ''}</div></div>
      <button class="pk" type="button" data-pickedx="${o.id}">Picked up</button></div>`).join('') || `<p class="note">${v ? 'No ready piece matches that code.' : 'Nothing waiting for pickup.'}</p>`;
    document.querySelectorAll('[data-pickedx]').forEach(b => b.onclick = () => pickedUp(b.dataset.pickedx));
  }
  function bindBoard() {
    document.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => { openWho = openWho === b.dataset.pick ? null : b.dataset.pick; render(); });
    document.querySelectorAll('[data-start]').forEach(b => b.onclick = () => { openWho = null; move(b.dataset.start, 'progress', b.dataset.who); });
    document.querySelectorAll('[data-return]').forEach(b => b.onclick = () => move(b.dataset.return, 'queue'));
    document.querySelectorAll('[data-ready]').forEach(b => b.onclick = () => move(b.dataset.ready, 'done'));
    document.querySelectorAll('[data-picked]').forEach(b => b.onclick = () => pickedUp(b.dataset.picked));
    const d = document.getElementById('pk');
    document.getElementById('openpk').onclick = () => { d.showModal(); renderPickup(); document.getElementById('find').focus(); };
    document.getElementById('pkx').onclick = () => { d.close(); document.getElementById('openpk').focus(); };
    document.getElementById('find').oninput = renderPickup;
    document.getElementById('find').onkeydown = e => { if (e.key === 'Enter') e.preventDefault(); };
    // On a phone the cards fill the screen, so a touch has to scroll the page first; dragging needs a longer hold.
    const phone = matchMedia('(max-width:820px)').matches;
    document.querySelectorAll('.drop').forEach(el => new Sortable(el, {
      group: 'orders', animation: 150, delay: phone ? 350 : 120, delayOnTouchOnly: true, touchStartThreshold: phone ? 8 : 1, ...(phone ? { supportPointer: false } : {}), draggable: '.qc,.now,.rc', filter: 'button,.assign', preventOnFilter: false,
      onStart: () => { dragging = true; },
      onEnd: evt => {
        dragging = false;
        const id = evt.item.dataset.id, from = evt.from, to = evt.to;
        if (from !== to) move(id, to.dataset.status, to.dataset.engraver || null); else render();
      }
    }));
  }
  function move(id, status, engraver = null, undo = false) {
    const o = orders.find(x => x.id === id); if (!o) return;
    const patch = { status, updatedAt: serverTimestamp(), movedBy: me || user?.email || null };
    if (status === 'queue') { patch.engraver = null; patch.startedAt = null; patch.doneAt = null; patch.pickedAt = null; }
    if (status === 'progress') { patch.engraver = engraver; if (o.status !== 'progress') patch.startedAt = serverTimestamp(); patch.doneAt = null; patch.pickedAt = null; }
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
const staffHead = (title, tab, here) => `<header class="band">${LOGO}<div class="ev">event setup</div>${WAVE(1180)}</header>
  <div class="shead2">${crumbs([['Events', '#/'], ['Event setup', '#/admin'], ...(tab === 'photos' ? [['Photos']] : here ? [[here]] : [])].slice(0, tab === 'photos' || here ? 3 : 2))}
  <nav class="snav" aria-label="Event setup">${tab === 'photos' ? '' : '<a href="#/photos">Photos</a>'}<span>${esc(user.email)}</span><a href="#" id="out">Sign out</a></nav></div>`;
function bindStaffHead() { const o = document.getElementById('out'); if (o) o.onclick = e => { e.preventDefault(); signOut(auth).then(() => { location.hash = '#/'; }); }; }
const staffLoading = msg => `<div class="page"><p class="note" style="padding:40px">${esc(msg)}</p></div>`;
const dropHidden = h => Object.fromEntries(Object.entries(h || {}).filter(([, v]) => v === true));
async function listEvents() { return (await getDocs(collection(db, 'events'))).docs.map(d => ({ id: d.id, ...d.data() })); }
const byDateDesc = (a, b) => String(b.date || '').localeCompare(String(a.date || ''));

// The parts of an event's setup that carry over to the next one.
const setupFrom = src => ({ engravers: [...(src.engravers || [])], pickupNote: src.pickupNote || 'at the engraving table',
  items: Object.fromEntries(allPieces().map(({ it }) => [it.id, offered(src, it.id)])), hidden: dropHidden(src.hidden) });

// ---------- branding images ----------
// Logos shrink to a small PNG (keeps transparency) stored in the event's public branding doc.
async function fileToLogo(file, max = 360) {
  const img = await loadPicture(file), w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  let size = max, out = '';
  for (let i = 0; i < 4; i++) {
    const s = Math.min(1, size / Math.max(w, h));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    out = c.toDataURL('image/png');
    if (out.length < 250000) return out;
    size = Math.round(size * 0.7);
  }
  return out;
}
const BRAND_SLOTS = [['tl', 'Top left'], ['tr', 'Top right'], ['bc', 'Bottom center']];
const brandRef = id => doc(db, 'events', id, 'public', 'branding');
const brandCorners = b => `${b?.tl ? `<img class="bcorner tl" src="${esc(b.tl)}" alt="">` : ''}${b?.tr ? `<img class="bcorner tr" src="${esc(b.tr)}" alt="">` : ''}`;
const brandBottom = b => b?.bc ? `<div class="bbottom"><img src="${esc(b.bc)}" alt=""></div>` : '';

const goUrl = () => `${baseUrl()}#/go`;

// New event, optionally reusing another event's staff, pickup spot, menu and branding.
async function createEvent(name, date, src) {
  // Never overwrite an existing event that happens to share the name and date.
  const base = slug(`${name}-${date}`) || 'event'; let id = base;
  for (let n = 2; (await getDoc(doc(db, 'events', id))).exists(); n++) id = `${base}-${n}`;
  const setup = src ? setupFrom(src) : { engravers: ['Steph'], pickupNote: 'at the engraving table', items: Object.fromEntries(allPieces().map(({ it }) => [it.id, true])), hidden: {} };
  await setDoc(doc(db, 'events', id), { name, date, ...setup, photos: {}, open: true, createdAt: serverTimestamp(), ...(src ? { copiedFrom: src.id } : {}) });
  if (src) { try { const b = await getDoc(brandRef(src.id)); if (b.exists()) await setDoc(brandRef(id), b.data()); } catch (x) {} }
  return id;
}

async function adminPage() {
  $app.innerHTML = staffLoading('Loading events…');
  let evs, pin = '';
  try { [evs, pin] = await Promise.all([listEvents(), loadPin()]); }
  catch (e) { $app.innerHTML = `<div class="wrap"><p class="err">Could not load events: ${esc(e.code || e.message)}</p></div>`; return; }
  const today = todayStr();
  const real = evs.filter(e => e.id !== DEMO_ID);
  const live = openEvents(evs), isLive = ev => live.some(e => e.id === ev.id);
  const upcoming = real.filter(e => (e.date || '') >= addDays(today, -1)).sort((a, b) => -byDateDesc(a, b));
  const past = real.filter(e => (e.date || '') < addDays(today, -1)).sort(byDateDesc);
  const card = ev => { const to = `#/admin/${encodeURIComponent(ev.id)}`;
    return `<div class="evcard ${isLive(ev) ? 'islive' : ''}"><a class="evmain" href="${to}"><b>${esc(ev.name)}</b><span>${esc(fmtDate(ev.date))} · ${(ev.engravers || []).length} staff</span></a>
    ${isLive(ev) ? `<a class="btn out pov" data-pov="${esc(ev.id)}" href="#/e/${encodeURIComponent(ev.id)}">Client's POV</a>` : ''}
    <a class="evtail" href="${to}" aria-label="Set up ${esc(ev.name)}">${isLive(ev) ? '<span class="chip live">Live now</span>' : `<span class="chip ${ev.open === false ? '' : 'on'}">${ev.open === false ? 'Closed' : 'Open'}</span>`}<span class="chev" aria-hidden="true">›</span></a></div>`; };
  setPov(null);
  $app.innerHTML = `${staffHead('event setup', 'setup')}<main class="wrap">
    <h1>event <em>setup</em></h1>
    <div class="toprow">
      <section class="card"><h2>staff PIN</h2>
        <div class="pinedit"><label class="vh" for="pinin">Staff PIN</label><input id="pinin" class="pinfield" inputmode="numeric" pattern="[0-9]*" maxlength="4" value="${esc(pin)}"><button class="btn" id="pinsave" type="button" disabled>Save</button></div>
        <p class="hint">Same PIN every event. Works only while an event is open.</p></section>
      <section class="card"><h2>guest QR</h2>
        <div class="share"><div class="qr" aria-label="QR code for the guest form">${qrSvg(goUrl())}</div>
          <div class="shareinfo"><p class="hint" style="margin:0">Print once. ${live.length > 1 ? 'Two events are open, so guests pick theirs.' : live.length ? `Opens <b>${esc(live[0].name)}</b> right now.` : 'Opens whichever event is open.'}</p>
            <button class="btn out" id="dlqr" type="button">Download QR</button><button class="btn out" id="copy" type="button">Copy link</button></div></div></section>
    </div>
    <div class="evlist" style="margin-top:18px">${upcoming.map(card).join('') || '<p class="note" style="text-align:left">Nothing scheduled.</p>'}</div>
    <details class="newev card" ${upcoming.length ? '' : 'open'}><summary>+ New event</summary>
      <form id="new">
        <div class="field"><label class="lbl" for="n-name">Event name</label><input id="n-name" required placeholder="Coach · NorthPark"></div>
        <div class="field"><label class="lbl" for="n-date">Date</label><input id="n-date" type="date" required value="${today}"></div>
        <div class="field wide"><label class="lbl" for="n-from">Start from</label><select id="n-from"><option value="">Blank: every piece on</option>
          ${real.slice().sort(byDateDesc).map(e => `<option value="${esc(e.id)}">Copy ${esc(e.name)} · ${esc(fmtDate(e.date))}</option>`).join('')}</select></div>
        <button class="btn">Create event</button></form></details>
    ${past.length ? `<details class="pastev"><summary>Past events (${past.length})</summary><div class="evlist">${past.map(card).join('')}</div></details>` : ''}
  </main>`;
  bindStaffHead();
  document.querySelectorAll('[data-pov]').forEach(a => a.onclick = () => setPov(a.dataset.pov));
  const pinIn = document.getElementById('pinin'), pinSave = document.getElementById('pinsave');
  pinIn.oninput = () => { pinIn.value = pinIn.value.replace(/\D/g, '').slice(0, 4); pinSave.disabled = pinIn.value.length !== 4 || pinIn.value === pin; };
  pinSave.onclick = async () => { pinSave.disabled = true; try { await setDoc(pinRef(), { pin: pinIn.value, updatedAt: serverTimestamp() }); pin = pinIn.value; toast('PIN saved'); } catch (err) { pinSave.disabled = false; toast('Could not save: ' + (err.code || err.message)); } };
  document.getElementById('dlqr').onclick = () => downloadQr(goUrl(), 'ivelisse-orders');
  document.getElementById('copy').onclick = () => (navigator.clipboard?.writeText(goUrl()) || Promise.reject()).then(() => toast('Guest link copied')).catch(() => toast(goUrl()));
  document.getElementById('new').onsubmit = async e => {
    e.preventDefault();
    const name = document.getElementById('n-name').value.trim(), date = document.getElementById('n-date').value;
    if (!name || !date) return;
    const src = evs.find(x => x.id === document.getElementById('n-from').value);
    const btn = e.target.querySelector('.btn'); btn.disabled = true;
    try {
      const id = await createEvent(name, date, src);
      location.hash = `#/admin/${encodeURIComponent(id)}`;
    } catch (err) { btn.disabled = false; toast('Could not create: ' + (err.code || err.message)); }
  };
}

// ---------- menu tree ----------
// The event's menu, top-down: category → piece → question → choice. Tap a row to open its branch and edit
// names right on it. Switches turn a piece or a choice on or off for this event only; names, photos and
// anything added or deleted are shared by every event. Photos come straight from the camera roll.
function menuTree(cat, { changed, rerender }) {
  const DRAW = [['bagtag', 'Bag tag'], ['tumbler', 'Tumbler'], ['card', 'Card']];
  const color = c => c.color || SWATCH[c.id] || '#cccccc';
  const drawFor = it => { const sg = it.groups.find(g => g.swatch), c0 = sg?.choices[0];
    return window.EngravePreview.renderPreview({ item: it.preview || 'card', color: c0?.id, hex: c0?.color, addon: 'none', name: '', font: 'script' }); };
  // path "c.p.q.x" → the list it lives in, its index, and the thing itself
  const at = path => {
    const [c, p, q, x] = path.split('.').map(Number);
    if (x != null) { const arr = cat.categories[c].items[p].groups[q].choices; return { arr, i: x, o: arr[x] }; }
    if (q != null) { const arr = cat.categories[c].items[p].groups; return { arr, i: q, o: arr[q] }; }
    if (p != null) { const arr = cat.categories[c].items; return { arr, i: p, o: arr[p] }; }
    return { arr: cat.categories, i: c, o: cat.categories[c] };
  };
  const tools = (path, i, n) => `<span class="ttools"><button type="button" data-up="${path}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button><button type="button" data-down="${path}" ${i === n - 1 ? 'disabled' : ''} aria-label="Move down">↓</button><button type="button" data-del="${path}" aria-label="Delete">×</button></span>`;
  const sw = (attr, path, on, label) => `<label class="sw2" title="${label}"><input type="checkbox" ${attr}="${path}" ${on ? 'checked' : ''} aria-label="${label}"><i></i></label>`;
  const photo = (key, label, fallback) => {
    if (!key) return `<button type="button" class="tphoto off" data-nophoto aria-label="Photo">${fallback || '+'}</button>`;
    const has = typeof photoLib[key] === 'string';
    return `<span class="tpwrap"><label class="tphoto" aria-label="Photo for ${esc(label)}">${has ? `<img src="${esc(photoLib[key])}" alt="">` : (fallback || '<span>+ photo</span>')}<input type="file" accept="image/*" data-pfile="${esc(key)}"></label>${has ? `<button type="button" class="tprm" data-prm="${esc(key)}" aria-label="Remove photo">×</button>` : ''}</span>`;
  };
  const row = (path, i, n, kind, label, { open, canOpen = true, off = false, meta = '', lead = '', after = '' } = {}) => `<div class="trow ${kind} ${open ? 'open' : ''} ${off ? 'off' : ''}" ${canOpen ? `data-row="${path}"` : ''}>
      ${canOpen ? `<button type="button" class="tarrow" data-tog="${path}" aria-expanded="${!!open}" aria-label="${open ? 'Close' : 'Open'} ${esc(label || kind)}">${open ? '▾' : '▸'}</button>` : '<span class="tarrow"></span>'}
      ${lead}<span class="ttag">${kind}</span>
      <input class="tname" id="n-${path}" data-name="${path}" value="${esc(label)}" placeholder="Name this ${kind}" aria-label="${kind} name">
      ${meta ? `<span class="tmeta">${meta}</span>` : ''}${tools(path, i, n)}${after}</div>`;

  function html() {
    return `<div class="tree">${cat.categories.map((c, ci) => {
      const cp = `${ci}`;
      return `${row(cp, ci, cat.categories.length, 'category', c.label, { open: c._open, meta: `${c.items.filter(x => x._on).length} of ${c.items.length} on` })}
      ${c._open ? `<div class="tkids">${c.items.map((it, pi) => {
        const pp = `${ci}.${pi}`;
        return `${row(pp, pi, c.items.length, 'piece', it.label, { open: it._open, off: !it._on, lead: photo(it._new ? null : it.id, it.label, drawFor(it)), after: sw('data-on', pp, it._on, 'Offer at this event') })}
        ${it._open ? `<div class="tkids">
          <div class="tdetails"><label>Material<input data-f="material" data-at="${pp}" value="${esc(it.material || '')}" placeholder="e.g. crystal"></label>
            <label>Drawing<select data-f="preview" data-at="${pp}">${DRAW.map(([k, l]) => `<option value="${k}" ${it.preview === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
            ${cat.categories.length > 1 ? `<label>Category<select data-movecat="${pp}">${cat.categories.map((y, j) => `<option value="${j}" ${j === ci ? 'selected' : ''}>${esc(y.label)}</option>`).join('')}</select></label>` : ''}</div>
          ${it.groups.map((g, gi) => {
            const gp = `${pp}.${gi}`;
            return `${row(gp, gi, it.groups.length, 'question', g.label, { open: g._open, meta: `${g.choices.filter(x => !x._off).length} of ${g.choices.length} on`,
              after: `<label class="tcolors"><input type="checkbox" data-swatch="${gp}" ${g.swatch ? 'checked' : ''}> colors</label>` })}
            ${g._open ? `<div class="tkids">${g.choices.map((x, xi) => {
              const xp = `${gp}.${xi}`, dot = g.swatch ? `<i class="dot" style="background:${esc(color(x))}"></i>` : '';
              return row(xp, xi, g.choices.length, 'choice', x.label, { canOpen: false, off: x._off,
                lead: gi === 0 ? photo(it._new || x._new ? null : `${it.id}_${x.id}`, `${it.label} · ${x.label}`, dot) : dot,
                after: `${g.swatch ? `<input type="color" data-color="${xp}" value="${esc(color(x))}" aria-label="${esc(x.label)} color">` : ''}${sw('data-chon', xp, !x._off, 'Offer at this event')}` });
            }).join('')}<div class="tadd in"><input data-newchoice="${gp}" placeholder="+ add a choice" aria-label="New choice for ${esc(g.label)}"></div></div>` : ''}`;
          }).join('')}
          <button type="button" class="tadd" data-add="question" data-at="${pp}">+ add a question</button>
        </div>` : ''}`;
      }).join('')}<button type="button" class="tadd" data-add="piece" data-at="${cp}">+ add a piece</button></div>` : ''}`;
    }).join('')}<button type="button" class="tadd" data-add="category">+ add a category</button></div>`;
  }
  const change = (fn, focusId) => { fn(); changed(true); rerender(focusId); };
  function bind() {
    const all = sel => document.querySelectorAll('.tree ' + sel);
    const toggle = path => { const { o } = at(path); o._open = !o._open; rerender(); };
    all('[data-tog]').forEach(b => b.onclick = e => { e.stopPropagation(); toggle(b.dataset.tog); });
    all('[data-row]').forEach(r => r.onclick = e => { if (e.target.closest('input,button,label,select')) return; toggle(r.dataset.row); });
    all('[data-name]').forEach(inp => inp.oninput = () => { at(inp.dataset.name).o.label = inp.value; changed(true); });
    all('[data-f]').forEach(inp => inp[inp.tagName === 'SELECT' ? 'onchange' : 'oninput'] = () => {
      at(inp.dataset.at).o[inp.dataset.f] = inp.value;
      if (inp.dataset.f === 'preview') change(() => {}); else changed(true);
    });
    all('[data-on]').forEach(cb => cb.onchange = () => { at(cb.dataset.on).o._on = cb.checked; changed(false); rerender(); });
    all('[data-chon]').forEach(cb => cb.onchange = () => { at(cb.dataset.chon).o._off = !cb.checked; changed(false); rerender(); });
    all('[data-color]').forEach(inp => inp.oninput = () => { at(inp.dataset.color).o.color = inp.value; const d = inp.closest('.trow').querySelector('.dot'); if (d) d.style.background = inp.value; changed(true); });
    all('[data-swatch]').forEach(cb => cb.onchange = () => change(() => { const g = at(cb.dataset.swatch).o; g.swatch = cb.checked; if (g.swatch) g.choices.forEach(x => { x.color = x.color || SWATCH[x.id] || '#cccccc'; }); }));
    all('[data-movecat]').forEach(sel => sel.onchange = () => change(() => { const { arr, i, o } = at(sel.dataset.movecat); arr.splice(i, 1); const to = cat.categories[+sel.value]; to.items.push(o); to._open = true; }));
    all('[data-newchoice]').forEach(nc => {
      const add = () => { const label = nc.value.trim(); if (!label) return; nc.value = '';
        const path = nc.dataset.newchoice, g = at(path).o; if (g.choices.some(x => x.label.toLowerCase() === label.toLowerCase())) { toast(`${label} is already there`); return; }
        change(() => g.choices.push({ label, _new: true, ...(g.swatch ? { color: '#cccccc' } : {}) }));
        document.querySelector(`.tree [data-newchoice="${path}"]`)?.focus(); };
      nc.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
      nc.onblur = () => { if (nc.value.trim()) add(); };
    });
    all('[data-add]').forEach(b => b.onclick = () => {
      const k = b.dataset.add;
      if (k === 'category') change(() => cat.categories.push({ label: '', items: [], _new: true, _open: true }), `n-${cat.categories.length}`);
      if (k === 'piece') { const c = at(b.dataset.at).o; change(() => c.items.push({ label: '', material: '', preview: 'card', groups: [], _new: true, _open: true, _on: true }), `n-${b.dataset.at}.${c.items.length}`); }
      if (k === 'question') { const it = at(b.dataset.at).o; change(() => it.groups.push({ label: '', swatch: false, choices: [], _new: true, _open: true }), `n-${b.dataset.at}.${it.groups.length}`); }
    });
    all('[data-nophoto]').forEach(b => b.onclick = () => toast('Save first, then add the photo.'));
    all('[data-pfile]').forEach(inp => inp.onchange = async () => {
      const f = inp.files && inp.files[0]; if (!f) return; const key = inp.dataset.pfile;
      toast('Saving photo…');
      let data;
      try { data = await fileToJpeg(f); } catch (err) { toast("That photo couldn't be read. Try a JPG or PNG."); return; }
      try { await setDoc(doc(db, 'photos', key), { data, updatedAt: serverTimestamp(), by: user.email }); photoLib[key] = data; toast('Photo saved'); rerender(); }
      catch (err) { toast('Could not save the photo: ' + (err.code || err.message)); }
    });
    all('[data-prm]').forEach(b => b.onclick = async () => {
      const key = b.dataset.prm;
      try { await deleteDoc(doc(db, 'photos', key)); photoLib[key] = null; toast('Photo removed'); rerender(); } catch (err) { toast('Could not remove: ' + (err.code || err.message)); }
    });
    const mv = (path, d) => { const { arr, i } = at(path); const j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; };
    all('[data-up]').forEach(b => b.onclick = () => change(() => mv(b.dataset.up, -1)));
    all('[data-down]').forEach(b => b.onclick = () => change(() => mv(b.dataset.down, 1)));
    all('[data-del]').forEach(b => b.onclick = () => {
      const path = b.dataset.del, { arr, i, o } = at(path), depth = path.split('.').length;
      if (depth === 1 && o.items.length && !confirm(`Delete ${o.label || 'this category'} and its ${o.items.length} piece(s) from every event?`)) return;
      if (depth === 2 && !o._new && !confirm(`Delete ${o.label} from every event? To hide it at this event only, use its switch.`)) return;
      change(() => arr.splice(i, 1));
    });
  }
  // First thing wrong with the menu, or ''.
  function problem() {
    for (const c of cat.categories) {
      if (!c.label.trim()) return 'A category needs a name.';
      for (const it of c.items) {
        const nm = it.label.trim(); if (!nm) return 'A piece needs a name.';
        for (const g of it.groups) {
          if (!g.label.trim()) return `${nm}: a question needs a name.`;
          if (!g.choices.length) return `${nm}: ${g.label} needs at least one choice.`;
          if (g.choices.some(x => !x.label.trim())) return `${nm}: a choice under ${g.label} has no name.`;
          if (it._on && g.choices.every(x => x._off)) return `${nm}: leave at least one ${g.label} choice on.`;
        }
      }
    }
    if (!cat.categories.some(c => c.items.some(it => it._on))) return 'Turn on at least one piece.';
    return '';
  }
  // New things get a permanent id from their name when first saved; existing ids never change.
  const uniq = (label, taken, fallback) => { const b = slug(label) || fallback; let id = b; for (let n = 2; taken.has(id); n++) id = `${b}-${n}`; taken.add(id); return id; };
  // Gives new things their ids, then returns the shared catalog plus this event's on/off maps.
  function finalize() {
    const catIds = new Set(cat.categories.filter(c => !c._new).map(c => c.id)), pieceIds = new Set(cat.categories.flatMap(c => c.items).filter(i => !i._new).map(i => i.id));
    const items = {}, hidden = {};
    const clean = cat.categories.map(c => {
      if (c._new) { c.id = uniq(c.label, catIds, 'category'); delete c._new; }
      return { id: c.id, label: c.label.trim(), items: c.items.map(it => {
        if (it._new) { it.id = uniq(it.label, pieceIds, 'piece'); delete it._new; }
        items[it.id] = !!it._on;
        const gIds = new Set(it.groups.filter(g => !g._new).map(g => g.id));
        return { id: it.id, label: it.label.trim(), material: (it.material || '').trim(), preview: it.preview || 'card', groups: it.groups.map(g => {
          if (g._new) { g.id = uniq(g.label, gIds, 'option'); delete g._new; }
          const xIds = new Set(g.choices.filter(x => !x._new).map(x => x.id));
          return { id: g.id, label: g.label.trim(), swatch: !!g.swatch, choices: g.choices.map(x => {
            if (x._new) { x.id = uniq(x.label, xIds, 'choice'); delete x._new; }
            if (x._off) hidden[`${it.id}/${g.id}/${x.id}`] = true;
            return { id: x.id, label: x.label.trim(), ...(g.swatch && x.color ? { color: x.color } : {}) }; }) }; }) }; }) };
    });
    return { clean, items, hidden };
  }
  return { html, bind, problem, finalize };
}

async function setupPage(eventId) {
  $app.innerHTML = staffLoading('Loading event…');
  await loadCatalog(true);
  let ev = null, brand = {};
  try { const s = await getDoc(doc(db, 'events', eventId)); ev = s.exists() ? s.data() : null; } catch (e) {}
  if (!ev) { $app.innerHTML = `${staffHead('event setup', 'setup', 'Not found')}<main class="wrap"><h1>event not <em>found</em></h1></main>`; bindStaffHead(); return; }
  try { const b = await getDoc(brandRef(eventId)); brand = b.exists() ? b.data() : {}; } catch (e) {}
  const st = { name: ev.name || '', date: ev.date || '', open: ev.open !== false, engravers: [...(ev.engravers || [])], pickupNote: ev.pickupNote || 'at the engraving table' };
  // Working copy of the menu, carrying this event's on/off switches.
  const cat = JSON.parse(JSON.stringify(CAT));
  cat.categories.forEach(c => { c._open = true; c.items.forEach(it => { it._on = offered(ev, it.id); it.groups.forEach(g => g.choices.forEach(x => { x._off = (ev.hidden || {})[`${it.id}/${g.id}/${x.id}`] === true; })); }); });
  const keys = cat.categories.flatMap(c => c.items.flatMap(it => [it.id, ...(it.groups[0]?.choices || []).map(x => `${it.id}_${x.id}`)]));
  await Promise.all(keys.filter(k => photoLib[k] === undefined).map(k => getDoc(doc(db, 'photos', k)).then(s => { photoLib[k] = s.exists() ? (s.data().data || null) : null; }).catch(() => { photoLib[k] = null; })));
  photoRerender = null; setPov(null);
  let savedEngravers = [...st.engravers], dirty = false, catDirty = false, saving = false, savedName = st.name, savedOpen = st.open, reuseOpen = false;
  const legacy = Object.keys(ev.photos || {}).length;
  leaveGuard = () => dirty;
  const markDirty = () => { dirty = true; const d = document.getElementById('dirty'), s = document.getElementById('save'); if (d) d.textContent = 'Unsaved changes'; if (s) s.disabled = false; };
  const tree = menuTree(cat, { changed: shared => { if (shared) catDirty = true; markDirty(); }, rerender: id => render(id) });

  const chipsHTML = () => st.engravers.map((e, i) => `<span>${esc(e)}<button type="button" data-rm="${i}" aria-label="Remove ${esc(e)}">×</button></span>`).join('') || '<em class="note">No staff yet.</em>';
  const brandPreview = () => `<div class="phonebox" aria-label="Preview of the page guests see after ordering"><div class="pb-band">${brandCorners(brand)}<img class="logo" src="logo.png" alt=""><div class="ev">order K7Q2</div></div>
    <div class="pb-body"><div class="eyebrow">you're in line</div><div class="pb-big">2</div><div class="pb-line"></div><div class="pb-line short"></div>${brandBottom(brand)}</div></div>`;
  const brandSlots = () => BRAND_SLOTS.map(([k, l]) => `<div class="bslot"><span class="lbl">${l}</span>
    <div class="bthumb">${brand[k] ? `<img src="${esc(brand[k])}" alt="">` : '<span>none</span>'}</div>
    <label class="btn out bup">${brand[k] ? 'Replace' : 'Upload'}<input type="file" accept="image/*" data-up="${k}" class="vhfile"></label>
    ${brand[k] ? `<button type="button" class="linkbtn" data-rmb="${k}">Remove</button>` : ''}</div>`).join('');

  function render(focusId) {
    const y = scrollY;
    $app.innerHTML = `${staffHead('event setup', 'setup', savedName)}<main class="wrap setup">
      <div class="evhead"><h1>${esc(savedName)}</h1><span class="chip ${savedOpen ? 'on' : ''}">${savedOpen ? 'Open' : 'Closed'}</span></div>
      <div class="btnrow three"><a class="btn" href="#/board/${encodeURIComponent(eventId)}">Open board</a><button class="btn out" id="reuse" type="button" aria-expanded="${reuseOpen}">Reuse this event setup</button></div>
      ${reuseOpen ? `<form id="reuseform" class="card"><div class="two"><div class="field"><label class="lbl" for="r-name">New event name</label><input id="r-name" required value="${esc(savedName)}"></div>
          <div class="field"><label class="lbl" for="r-date">Date</label><input id="r-date" type="date" required value="${todayStr()}"></div></div>
          <button class="btn">Create event</button></form>` : ''}

      <section class="card step"><h2><span class="n">1</span>details</h2>
        <div class="two"><div class="field"><label class="lbl" for="s-name">Event name</label><input id="s-name" value="${esc(st.name)}"></div>
          <div class="field"><label class="lbl" for="s-date">Date</label><input id="s-date" type="date" value="${esc(st.date)}"></div></div>
        <div class="field"><label class="lbl" for="s-pick">Pickup spot</label><input id="s-pick" value="${esc(st.pickupNote)}" placeholder="at the engraving table"></div></section>

      <section class="card step"><h2><span class="n">2</span>staff</h2>
        <div class="chips" id="chips">${chipsHTML()}</div>
        <div class="addrow"><label class="vh" for="s-eng">Add a staff name</label><input id="s-eng" placeholder="First name" autocapitalize="words"><button class="btn out" id="addeng" type="button">Add</button></div></section>

      <section class="card step"><h2><span class="n">3</span>menu</h2>
        <p class="hint">Switch = on or off at this event. Names, photos and anything you add apply to every event.</p>
        ${tree.html()}</section>

      <section class="card step"><h2><span class="n">4</span>branding</h2>
        <div class="brandgrid"><div class="bslots">${brandSlots()}</div>${brandPreview()}</div></section>

      <section class="card step"><h2><span class="n">5</span>open or close</h2>
        <div class="openseg" role="radiogroup" aria-label="Event status">
          <button type="button" role="radio" aria-checked="${st.open}" data-open="1"><b>Open</b><small>Guests order. Staff PIN works.</small></button>
          <button type="button" role="radio" aria-checked="${!st.open}" data-open="0"><b>Closed</b><small>Form closed. PIN stops working.</small></button></div></section>

      <section class="card step"><h2><span class="n">6</span>after the event</h2>
        <button class="btn out" id="export" type="button">Export orders</button>
        ${legacy ? `<button class="linkbtn" id="clearlegacy" type="button" style="margin-left:12px">Remove ${legacy} old photo link${legacy === 1 ? '' : 's'}</button>` : ''}</section>
    </main>
    <div class="savebar"><span id="dirty">${dirty ? 'Unsaved changes' : 'All changes saved'}</span><button class="btn out" id="pov" type="button">Preview from Client's POV</button><button class="btn" id="save" type="button" ${dirty ? '' : 'disabled'}>Save</button></div>`;
    bind(); scrollTo(0, y);
    if (focusId) { const el = document.getElementById(focusId); if (el) { el.focus(); if (el.setSelectionRange && el.value) el.setSelectionRange(el.value.length, el.value.length); } }
  }
  async function setBrand(k, val) {
    const next = { ...brand }; if (val) next[k] = val; else delete next[k];
    try { await setDoc(brandRef(eventId), { ...next, updatedAt: serverTimestamp() }); delete next.updatedAt; brand = next; render(); toast(val ? 'Image saved' : 'Image removed'); }
    catch (err) { toast('Could not save the image: ' + (err.code || err.message)); }
  }
  function bind() {
    bindStaffHead(); tree.bind();
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
    document.querySelectorAll('[data-open]').forEach(b => b.onclick = () => { st.open = b.dataset.open === '1'; document.querySelectorAll('[data-open]').forEach(x => x.setAttribute('aria-checked', String((x.dataset.open === '1') === st.open))); markDirty(); });
    document.querySelectorAll('[data-up][type=file]').forEach(inp => inp.onchange = async () => { const f = inp.files[0]; if (!f) return; let data; try { data = await fileToLogo(f); } catch (err) { toast("That image couldn't be read. Try a PNG or JPG."); return; } setBrand(inp.dataset.up, data); });
    document.querySelectorAll('[data-rmb]').forEach(b => b.onclick = () => setBrand(b.dataset.rmb, null));
    document.getElementById('reuse').onclick = () => { reuseOpen = !reuseOpen; render(reuseOpen ? 'r-name' : null); };
    const rf = document.getElementById('reuseform');
    if (rf) rf.onsubmit = async e => { e.preventDefault();
      if (dirty && !confirm('Reuse copies the last saved setup. Continue without your unsaved changes?')) return;
      const b = rf.querySelector('.btn'); b.disabled = true;
      try { const s = await getDoc(doc(db, 'events', eventId)); const id = await createEvent(document.getElementById('r-name').value.trim(), document.getElementById('r-date').value, { id: eventId, ...s.data() }); dirty = false; location.hash = `#/admin/${encodeURIComponent(id)}`; }
      catch (err) { b.disabled = false; toast('Could not create: ' + (err.code || err.message)); } };
    document.getElementById('export').onclick = async () => { try { await exportOrders(eventId, ev); } catch (err) { toast('Export failed: ' + (err.code || err.message)); } };
    const cl = document.getElementById('clearlegacy');
    if (cl) cl.onclick = async () => { try { await updateDoc(doc(db, 'events', eventId), { photos: {} }); ev.photos = {}; toast('Old photo links removed'); render(); } catch (err) { toast('Could not remove: ' + (err.code || err.message)); } };
    document.getElementById('save').onclick = save;
    // Previewing counts as a save.
    document.getElementById('pov').onclick = async () => { if (dirty) { await save(); if (dirty) return; } setPov(eventId); location.hash = `#/e/${encodeURIComponent(eventId)}`; };
  }
  async function save() {
    if (saving || !dirty) return;
    if (!st.name.trim() || !st.date) { toast('The event needs a name and a date.'); return; }
    if (!st.engravers.length) { toast('Add at least one staff name.'); return; }
    const prob = tree.problem(); if (prob) { toast(prob); return; }
    saving = true; const b = document.getElementById('save'); b.disabled = true; b.textContent = 'Saving…';
    try {
      // Removing a staff name hides their column, so don't allow it while they hold a piece.
      const removed = savedEngravers.filter(e => !st.engravers.includes(e));
      if (removed.length) {
        const busy = (await getDocs(collection(db, 'events', eventId, 'orders'))).docs.map(d => d.data()).find(o => o.status === 'progress' && removed.includes(o.engraver));
        if (busy) { toast(`${busy.engraver} has ${busy.name}'s piece. Move it before removing them.`); return; }
      }
      const { clean, items, hidden } = tree.finalize();
      if (catDirty) { await setDoc(doc(db, 'config', 'catalog'), { categories: clean, updatedAt: serverTimestamp(), by: user.email }); CAT = { categories: clean }; catLoading = Promise.resolve(); catDirty = false; }
      await updateDoc(doc(db, 'events', eventId), { name: st.name.trim(), date: st.date, pickupNote: st.pickupNote.trim() || 'at the engraving table', open: st.open,
        engravers: st.engravers, items, hidden, updatedAt: serverTimestamp() });
      savedEngravers = [...st.engravers]; savedName = st.name.trim(); savedOpen = st.open; dirty = false; render(); toast('Saved');
    } catch (err) { toast('Could not save: ' + (err.code || err.message)); }
    finally { saving = false; const s = document.getElementById('save'); if (s) { s.textContent = 'Save'; s.disabled = !dirty; } }
  }
  const leave = e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  addEventListener('beforeunload', leave); unsubs.push(() => removeEventListener('beforeunload', leave));
  render();
}

// ---------- photo library ----------
// Phone photos shrink to a small JPEG stored in Firestore (the free plan has no file storage).
async function loadPicture(file) {
  if (window.createImageBitmap) { try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) {} }
  const src = URL.createObjectURL(file);
  try { return await new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = () => rej(new Error('unreadable image')); img.src = src; }); }
  finally { setTimeout(() => URL.revokeObjectURL(src), 60000); }
}
async function fileToJpeg(file, max = 720) {
  const img = await loadPicture(file), w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const s = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  let out = c.toDataURL('image/jpeg', 0.72);
  if (out.length > 600000) out = c.toDataURL('image/jpeg', 0.5);
  return out;
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
      <p class="hint">${n} of ${slots.length} added. Guests see these as they choose; without one they see a drawn preview. Every event uses this library. Shoot in portrait with the piece centered.</p>
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
