// Shared preview renderer: returns an SVG string for a product + options.
// Runs in Node (to bake PNGs) and in the browser (live preview as guests type).
(function (root) {
  const LEATHER = {
    black: { base: '#1b1918', hi: '#2c2826', engrave: '#b8a796', stitch: '#4a4440' },
    tan:   { base: '#a86b43', hi: '#c08156', engrave: '#4a2a17', stitch: '#e6c9a8' },
    blush: { base: '#d9aa98', hi: '#e8c2b2', engrave: '#7a4636', stitch: '#f6e3da' }
  };
  const TUMBLER = {
    black: { base: '#1d1d20', hi: '#3a3a40', engrave: '#d8d8d4' },
    white: { base: '#efece6', hi: '#ffffff', engrave: '#a9a6a0' },
    terracotta: { base: '#b9623f', hi: '#d27b56', engrave: '#e9e2da' }
  };

  const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function star(cx, cy, r, fill) {
    let d = '';
    for (let i = 0; i < 10; i++) {
      const a = Math.PI / 5 * i - Math.PI / 2;
      const rr = i % 2 ? r * 0.42 : r;
      d += (i ? 'L' : 'M') + (cx + rr * Math.cos(a)).toFixed(1) + ' ' + (cy + rr * Math.sin(a)).toFixed(1);
    }
    return `<path d="${d}Z" fill="${fill}"/>`;
  }
  function heart(cx, cy, s, fill) {
    return `<path transform="translate(${cx} ${cy}) scale(${s})" d="M0 6C-6-2-16 0-16 8c0 7 9 12 16 18 7-6 16-11 16-18 0-8-10-10-16-2z" fill="${fill}"/>`;
  }
  function addonMarks(addon, cx, cy, w, fill) {
    if (addon === 'stars') {
      const pts = [[-0.42, -0.62, 13], [0.36, -0.5, 9], [0.44, 0.48, 12], [-0.34, 0.56, 8], [-0.05, -0.85, 7], [0.1, 0.8, 7]];
      return pts.map(([x, y, r]) => star(cx + x * w, cy + y * w, r, fill)).join('');
    }
    if (addon === 'heart') return heart(cx, cy + w * 0.48, 1.1, fill);
    return '';
  }
  function nameSize(name, max, width) {
    const n = Math.max(String(name || '').length, 1);
    return Math.min(max, (width / n) * 1.9);
  }

  function bagTag({ color = 'black', addon = 'none', name = '', font = 'script' }) {
    const c = LEATHER[color] || LEATHER.black;
    const fam = font === 'serif' ? "'Simonetta', serif" : "'Great Vibes', cursive";
    const fs = nameSize(name, font === 'serif' ? 50 : 66, 190);
    const cx = 300, cy = 450;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800">
<defs>
 <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="1.6" numOctaves="2" seed="4"/><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .28 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>
 <linearGradient id="lsh" x1="0" x2="1"><stop offset="0" stop-color="${c.hi}"/><stop offset=".55" stop-color="${c.base}"/><stop offset="1" stop-color="${c.base}"/></linearGradient>
 <linearGradient id="brass" x1="0" x2="1"><stop offset="0" stop-color="#8a6a3a"/><stop offset=".45" stop-color="#e3c48a"/><stop offset="1" stop-color="#9a7642"/></linearGradient>
 <filter id="sh" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#3b2418" flood-opacity=".28"/></filter>
 <filter id="deboss"><feOffset dy="1.2"/><feGaussianBlur stdDeviation=".4"/></filter>
</defs>
<rect width="600" height="800" fill="#fff8f0"/>
<path d="M300 60 C 360 60 372 140 352 210" fill="none" stroke="url(#brass)" stroke-width="7" stroke-linecap="round"/>
<path d="M300 60 C 240 60 228 140 248 210" fill="none" stroke="url(#brass)" stroke-width="7" stroke-linecap="round"/>
<g filter="url(#sh)">
 <path d="M190 210 Q190 180 220 180 L380 180 Q410 180 410 210 L410 660 Q410 690 380 690 L220 690 Q190 690 190 660 Z" fill="url(#lsh)"/>
</g>
<path d="M190 210 Q190 180 220 180 L380 180 Q410 180 410 210 L410 660 Q410 690 380 690 L220 690 Q190 690 190 660 Z" fill="#000" filter="url(#grain)"/>
<path d="M204 214 Q204 194 224 194 L376 194 Q396 194 396 214 L396 656 Q396 676 376 676 L224 676 Q204 676 204 656 Z" fill="none" stroke="${c.stitch}" stroke-width="2" stroke-dasharray="7 6" opacity=".9"/>
<rect x="270" y="212" width="60" height="16" rx="8" fill="#0005"/>
<rect x="268" y="210" width="64" height="16" rx="8" fill="none" stroke="url(#brass)" stroke-width="3"/>
<g fill="${c.engrave}">
 <g filter="url(#deboss)" opacity=".5" fill="#000">${addonMarks(addon, cx, cy, 150, '#000')}${name ? `<text x="${cx}" y="${cy + fs * 0.3}" text-anchor="middle" font-family="${fam}" font-size="${fs.toFixed(0)}">${esc(name)}</text>` : ''}</g>
 ${addonMarks(addon, cx, cy, 150, c.engrave)}
 ${name ? `<text x="${cx}" y="${cy + fs * 0.3}" text-anchor="middle" font-family="${fam}" font-size="${fs.toFixed(0)}">${esc(name)}</text>` : ''}
</g>
</svg>`;
  }

  function tumbler({ color = 'black', addon = 'none', name = '', font = 'script' }) {
    const c = TUMBLER[color] || TUMBLER.black;
    const fam = font === 'serif' ? "'Simonetta', serif" : "'Great Vibes', cursive";
    const fs = nameSize(name, font === 'serif' ? 48 : 64, 170);
    const cx = 300, cy = 440;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800">
<defs>
 <linearGradient id="body" x1="0" x2="1"><stop offset="0" stop-color="${c.base}"/><stop offset=".22" stop-color="${c.hi}"/><stop offset=".4" stop-color="${c.base}"/><stop offset=".85" stop-color="${c.base}"/><stop offset="1" stop-color="#000" stop-opacity="${color === 'white' ? '.25' : '.9'}"/></linearGradient>
 <linearGradient id="steel" x1="0" x2="1"><stop offset="0" stop-color="#8d8f93"/><stop offset=".25" stop-color="#f4f4f2"/><stop offset=".55" stop-color="#b6b8bb"/><stop offset="1" stop-color="#6d6f73"/></linearGradient>
 <linearGradient id="engr" x1="0" x2="1"><stop offset="0" stop-color="${c.engrave}" stop-opacity=".75"/><stop offset=".3" stop-color="${c.engrave}"/><stop offset="1" stop-color="${c.engrave}" stop-opacity=".7"/></linearGradient>
 <filter id="sh" x="-40%" y="-20%" width="180%" height="140%"><feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#3b2418" flood-opacity=".26"/></filter>
</defs>
<rect width="600" height="800" fill="#fff8f0"/>
<ellipse cx="300" cy="712" rx="120" ry="14" fill="#3b2418" opacity=".12"/>
<g filter="url(#sh)">
 <path d="M188 214 L412 214 L392 690 Q390 706 372 706 L228 706 Q210 706 208 690 Z" fill="url(#body)"/>
</g>
<rect x="182" y="168" width="236" height="50" rx="10" fill="url(#steel)"/>
<rect x="182" y="208" width="236" height="10" fill="#0003"/>
<rect x="250" y="176" width="78" height="10" rx="5" fill="#1112"/>
<rect x="196" y="214" width="208" height="6" fill="url(#steel)" opacity=".6"/>
<g fill="url(#engr)">
 ${addonMarks(addon, cx, cy, 140, 'url(#engr)')}
 ${name ? `<text x="${cx}" y="${cy + fs * 0.3}" text-anchor="middle" font-family="${fam}" font-size="${fs.toFixed(0)}">${esc(name)}</text>` : ''}
</g>
</svg>`;
  }

  // Each inline SVG needs its own gradient/filter ids, or every copy on a page borrows the first one's colors.
  let seq = 0;
  function renderPreview(opts) {
    const svg = opts.item === 'tumbler' ? tumbler(opts) : bagTag(opts);
    const u = 'p' + (++seq) + '_';
    return svg.replace(/id="([\w-]+)"/g, 'id="' + u + '$1"').replace(/url\(#([\w-]+)\)/g, 'url(#' + u + '$1)');
  }
  const api = { renderPreview, LEATHER, TUMBLER };
  if (typeof module !== 'undefined') module.exports = api; else root.EngravePreview = api;
})(this);
