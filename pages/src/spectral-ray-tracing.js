/* Live figures for /spectral-ray-tracing. Everything below is the game's own
   physics re-stated small enough to read: the same CIE fit, the same Cauchy
   form anchored at the sodium D line, the same Fresnel split and the same
   depth-first ray stack. Numbers that are the game's constants are named so. */
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;

  /* ---------------------------------------------------- spectrum -> sRGB */
  const SPEC_LO = 398, SPEC_HI = 706;                     // the game's band, nm
  const gauss = (x, a, m, s1, s2) => { const t = (x - m) * (x < m ? 1 / s1 : 1 / s2); return a * Math.exp(-0.5 * t * t); };
  function cieXYZ(l) {                                    // Wyman/Sloan/Shirley fit of CIE 1931
    return [gauss(l, 1.056, 599.8, 37.9, 31.0) + gauss(l, 0.362, 442.0, 16.0, 26.7) + gauss(l, -0.065, 501.1, 20.4, 26.2),
            gauss(l, 0.821, 568.8, 46.9, 40.5) + gauss(l, 0.286, 530.9, 16.3, 31.1),
            gauss(l, 1.217, 437.0, 11.8, 36.0) + gauss(l, 0.681, 459.0, 26.0, 13.8)];
  }
  const xyzToRGB = (X, Y, Z) => [3.2406 * X - 1.5372 * Y - 0.4986 * Z,
                                 -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
                                  0.0557 * X - 0.2040 * Y + 1.0570 * Z];
  function toGamut(r, g, b) { const w = Math.min(r, g, b); if (w < 0) { r -= w; g -= w; b -= w; } return [r, g, b]; }
  function waveRGBraw(l) { const [X, Y, Z] = cieXYZ(l); const [r, g, b] = toGamut(...xyzToRGB(X, Y, Z)); return [Math.max(0, r), Math.max(0, g), Math.max(0, b)]; }
  let NORM = [1, 1, 1];
  { let sr = 0, sg = 0, sb = 0, n = 0;
    for (let l = SPEC_LO; l <= SPEC_HI; l += 0.5) { const c = waveRGBraw(l); sr += c[0]; sg += c[1]; sb += c[2]; n++; }
    NORM = [n / sr, n / sg, n / sb]; }
  const waveRGB = l => { const c = waveRGBraw(l); return [c[0] * NORM[0], c[1] * NORM[1], c[2] * NORM[2]]; };
  const srgb = v => { v = clamp(v, 0, 1); return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; };
  const css = (c, k = 1) => `rgb(${(srgb(c[0] * k) * 255) | 0},${(srgb(c[1] * k) * 255) | 0},${(srgb(c[2] * k) * 255) | 0})`;

  /* ---------------------------------------------------- optics */
  /* Cauchy, anchored so `A` is the index at the sodium D line (589.3 nm),
     which is what the game calls `ior`; `B` is what it calls `disp`. */
  const iorAt = (A, B, lam) => { const um = lam * 1e-3; return A + B / (um * um) - B / (0.5893 * 0.5893); };
  function fresnel(n1, n2, cosi) {
    const eta = n1 / n2, sin2t = eta * eta * (1 - cosi * cosi);
    if (sin2t > 1) return { R: 1, T: 0, cost: 0, tir: true, eta };
    const cost = Math.sqrt(1 - sin2t);
    const Rs = ((n1 * cosi - n2 * cost) / (n1 * cosi + n2 * cost)) ** 2;
    const Rp = ((n1 * cost - n2 * cosi) / (n1 * cost + n2 * cosi)) ** 2;
    const R = clamp((Rs + Rp) * 0.5, 0, 1);
    return { R, T: 1 - R, Rs, Rp, cost, tir: false, eta };
  }
  const vdc = i => { let r = 0, f = 0.5; while (i > 0) { r += f * (i & 1); i >>= 1; f *= 0.5; } return r; };
  const vdc3 = i => { let r = 0, f = 1 / 3; while (i > 0) { r += f * (i % 3); i = (i / 3) | 0; f /= 3; } return r; };

  /* ---------------------------------------------------- canvas plumbing */
  const figs = [];
  function fig(id, aspect, draw) {
    const c = $(id); if (!c) return null;
    const ctx = c.getContext('2d');
    const f = { c, ctx, draw, aspect, w: 0, h: 0 };
    f.render = () => {
      const dpr = Math.min(2, devicePixelRatio || 1);
      // a wide-and-short figure squashes to nothing on a phone: cap the aspect there
      const w = c.clientWidth || 600, h = Math.round(w / (w < 520 ? Math.min(aspect, 1.7) : aspect));
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      f.w = w; f.h = h;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#07080d'; ctx.fillRect(0, 0, w, h);
      draw(ctx, w, h, f);
    };
    figs.push(f);
    return f;
  }
  const MONO = '10px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  function label(ctx, t, x, y, col = '#8d97ab', align = 'left') { ctx.font = MONO; ctx.fillStyle = col; ctx.textAlign = align; ctx.fillText(t, x, y); }
  function grid(ctx, x0, y0, x1, y1) { ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 1; ctx.strokeRect(x0 + .5, y0 + .5, x1 - x0, y1 - y0); }
  function bindRange(id, outId, fmt, onChange) {
    const el = $(id); if (!el) return () => 0;
    const out = outId ? $(outId) : null;
    const upd = () => { if (out) out.textContent = fmt(parseFloat(el.value)); onChange && onChange(); };
    el.addEventListener('input', upd); upd();
    return () => parseFloat(el.value);
  }

  /* ================================================== 1. the spectrum strip */
  let specLam = 550;
  const spectrum = fig('fig-spectrum', 3.2, (ctx, w, h) => {
    const top = 14, stripY = h - 46, stripH = 26, L = 24, R = w - 12;
    const xOf = l => L + (l - 380) / (720 - 380) * (R - L);
    // CIE curves above the strip
    const plotH = stripY - top - 24, base = top + plotH;
    grid(ctx, L, top, R, base);
    const cols = ['#ff7a8a', '#8cf5b0', '#8ab8ff'];
    for (let ch = 0; ch < 3; ch++) {
      ctx.beginPath();
      for (let l = 380; l <= 720; l += 1) { const v = cieXYZ(l)[ch]; const x = xOf(l), y = base - clamp(v / 1.8, 0, 1) * plotH; l === 380 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
      ctx.strokeStyle = cols[ch]; ctx.lineWidth = 1.2; ctx.stroke();
    }
    label(ctx, 'x̄', R - 40, top + 12, cols[0]); label(ctx, 'ȳ', R - 26, top + 12, cols[1]); label(ctx, 'z̄', R - 12, top + 12, cols[2]);
    label(ctx, 'CIE 1931 observer (Wyman–Sloan–Shirley fit)', L + 4, top + 12);
    // the strip: what one wavelength looks like, after normalisation
    for (let x = L; x < R; x++) {
      const l = 380 + (x - L) / (R - L) * 340;
      const inBand = l >= SPEC_LO && l <= SPEC_HI;
      const c = waveRGB(l);
      ctx.fillStyle = css(c, inBand ? 0.55 : 0.12);
      ctx.fillRect(x, stripY, 1, stripH);
    }
    grid(ctx, L, stripY, R, stripY + stripH);
    for (const l of [400, 450, 500, 550, 600, 650, 700]) { label(ctx, l + '', xOf(l), h - 6, '#8d97ab', 'center'); ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.fillRect(xOf(l), stripY + stripH, 1, 4); }
    label(ctx, SPEC_LO + '–' + SPEC_HI + ' nm is what the game samples', L + 4, stripY - 4);
    // marker
    const mx = xOf(specLam), c = waveRGB(specLam);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(mx + .5, top); ctx.lineTo(mx + .5, stripY + stripH); ctx.stroke();
    ctx.fillStyle = css(c, 0.8); ctx.fillRect(R - 66, stripY - 40, 54, 30); ctx.strokeStyle = 'rgba(255,255,255,.4)'; ctx.strokeRect(R - 66 + .5, stripY - 40 + .5, 54, 30);
    const [X, Y, Z] = cieXYZ(specLam);
    const s = $('spec-out'); if (s) s.textContent = `${specLam} nm  ·  XYZ ${X.toFixed(2)} ${Y.toFixed(2)} ${Z.toFixed(2)}  ·  linear RGB ${c.map(v => v.toFixed(2)).join(' ')}`;
  });
  bindRange('spec-lam', null, v => v, () => { specLam = parseFloat($('spec-lam').value); spectrum && spectrum.render(); });

  /* ================================================== 2. Snell + Fresnel at one face */
  let snellDeg = 40, snellN = 1.39, snellLeaving = false;
  const snell = fig('fig-snell', 2.4, (ctx, w, h) => {
    const cx = w * 0.5, cy = h * 0.5, len = Math.min(w, h) * 0.42;
    // glass below the interface
    ctx.fillStyle = 'rgba(127,216,255,.06)'; ctx.fillRect(0, cy, w, h - cy);
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(0, cy + .5); ctx.lineTo(w, cy + .5); ctx.stroke();
    ctx.setLineDash([3, 4]); ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.beginPath(); ctx.moveTo(cx + .5, cy - len); ctx.lineTo(cx + .5, cy + len); ctx.stroke(); ctx.setLineDash([]);
    label(ctx, snellLeaving ? 'glass  n = ' + snellN.toFixed(2) : 'air  n = 1.00', 10, cy - 8);
    label(ctx, snellLeaving ? 'air  n = 1.00' : 'glass  n = ' + snellN.toFixed(2), 10, cy + 14);
    const th = snellDeg * Math.PI / 180;
    const n1 = snellLeaving ? snellN : 1, n2 = snellLeaving ? 1 : snellN;
    const F = fresnel(n1, n2, Math.cos(th));
    // incoming (from upper-left, towards the point), reflected, refracted
    const ray = (dx, dy, alpha, wdt, colr) => { ctx.strokeStyle = colr || `rgba(255,255,255,${alpha})`; ctx.lineWidth = wdt; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + dx * len, cy + dy * len); ctx.stroke(); };
    ray(-Math.sin(th), -Math.cos(th), 0.95, 2.2);
    ray(Math.sin(th), -Math.cos(th), 0.15 + F.R * 0.85, 0.8 + F.R * 1.6);
    if (!F.tir) { const st = F.eta * Math.sin(th); ray(st, F.cost, 0.15 + F.T * 0.85, 0.8 + F.T * 1.6, `rgba(127,216,255,${0.2 + F.T * 0.8})`); }
    // arcs and labels
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, 34, -Math.PI / 2 - th, -Math.PI / 2); ctx.stroke();
    label(ctx, 'θi ' + snellDeg.toFixed(0) + '°', cx - 44 - Math.sin(th) * 20, cy - 40, '#e9edf5', 'right');
    if (!F.tir) {
      const tt = Math.asin(F.eta * Math.sin(th));
      ctx.beginPath(); ctx.arc(cx, cy, 34, Math.PI / 2 - tt, Math.PI / 2); ctx.stroke();
      label(ctx, 'θt ' + (tt * 180 / Math.PI).toFixed(1) + '°', cx + 44 + Math.sin(tt) * 20, cy + 46, '#7fd8ff');
    } else {
      label(ctx, 'total internal reflection', cx + 12, cy + 24, '#ffcf5c');
    }
    const crit = snellLeaving ? Math.asin(1 / snellN) * 180 / Math.PI : null;
    label(ctx, `reflected ${(F.R * 100).toFixed(1)}%   transmitted ${(F.T * 100).toFixed(1)}%` + (crit ? `   critical angle ${crit.toFixed(1)}°` : ''), 10, h - 8, '#cfd8e8');
  });
  bindRange('snell-deg', 'snell-deg-out', v => v.toFixed(0) + '°', () => { snellDeg = parseFloat($('snell-deg').value); snell && snell.render(); });
  bindRange('snell-n', 'snell-n-out', v => v.toFixed(2), () => { snellN = parseFloat($('snell-n').value); snell && snell.render(); });
  const lv = $('snell-leaving'); if (lv) lv.addEventListener('change', () => { snellLeaving = lv.checked; snell && snell.render(); });

  /* ================================================== 3. Fresnel curves */
  let fresN = 1.39;
  const fres = fig('fig-fresnel', 2.6, (ctx, w, h) => {
    const L = 34, R = w - 12, T = 14, B = h - 22;
    grid(ctx, L, T, R, B);
    const xOf = d => L + d / 90 * (R - L), yOf = r => B - r * (B - T);
    for (const r of [0.25, 0.5, 0.75]) { ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(L, yOf(r), R - L, 1); label(ctx, (r * 100) + '%', L - 4, yOf(r) + 3, '#8d97ab', 'right'); }
    for (const d of [0, 30, 60, 90]) label(ctx, d + '°', xOf(d), h - 7, '#8d97ab', 'center');
    const curve = (fn, col, dash) => { ctx.setLineDash(dash || []); ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.beginPath();
      for (let d = 0; d <= 90; d += 0.5) { const v = fn(d * Math.PI / 180); const x = xOf(d), y = yOf(clamp(v, 0, 1)); d === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); } ctx.stroke(); ctx.setLineDash([]); };
    curve(t => fresnel(1, fresN, Math.cos(t)).Rs, 'rgba(255,255,255,.35)');
    curve(t => fresnel(1, fresN, Math.cos(t)).Rp, 'rgba(255,255,255,.35)', [2, 3]);
    curve(t => fresnel(1, fresN, Math.cos(t)).R, '#7fd8ff');
    curve(t => fresnel(fresN, 1, Math.cos(t)).R, '#ffcf5c');
    const crit = Math.asin(1 / fresN) * 180 / Math.PI;
    ctx.fillStyle = 'rgba(255,207,92,.35)'; ctx.fillRect(xOf(crit), T, 1, B - T);
    label(ctx, 'critical ' + crit.toFixed(1) + '°', xOf(crit) - 5, B - 30, '#ffcf5c', 'right');
    label(ctx, 'entering glass (Rs, Rp thin; average blue)', L + 6, T + 12, '#7fd8ff');
    label(ctx, 'leaving glass', L + 6, T + 24, '#ffcf5c');
    label(ctx, 'Brewster ' + (Math.atan(fresN) * 180 / Math.PI).toFixed(0) + '°: Rp = 0', xOf(Math.atan(fresN) * 180 / Math.PI) + 4, B - 6, '#8d97ab');
  });
  bindRange('fres-n', 'fres-n-out', v => v.toFixed(2), () => { fresN = parseFloat($('fres-n').value); fres && fres.render(); });

  /* ================================================== 4. Cauchy dispersion */
  let cA = 1.39, cB = 0.060;
  const cauchy = fig('fig-cauchy', 2.6, (ctx, w, h) => {
    const L = 40, R = w - 12, T = 14, B = h - 22;
    grid(ctx, L, T, R, B);
    const nLo = 1.30, nHi = 1.65;
    const xOf = l => L + (l - SPEC_LO) / (SPEC_HI - SPEC_LO) * (R - L), yOf = n => B - (n - nLo) / (nHi - nLo) * (B - T);
    for (const n of [1.35, 1.40, 1.45, 1.50, 1.55, 1.60]) { ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(L, yOf(n), R - L, 1); label(ctx, n.toFixed(2), L - 4, yOf(n) + 3, '#8d97ab', 'right'); }
    for (const l of [400, 500, 589, 700]) label(ctx, l + '', xOf(l), h - 7, '#8d97ab', 'center');
    ctx.save(); ctx.beginPath(); ctx.rect(L, T, R - L, B - T); ctx.clip();
    // the game's range, as a band
    ctx.fillStyle = 'rgba(127,216,255,.05)';
    ctx.beginPath();
    for (let l = SPEC_LO; l <= SPEC_HI; l += 2) { const y = yOf(iorAt(1.34, 0.045, l)); l === SPEC_LO ? ctx.moveTo(xOf(l), y) : ctx.lineTo(xOf(l), y); }
    for (let l = SPEC_HI; l >= SPEC_LO; l -= 2) ctx.lineTo(xOf(l), yOf(iorAt(1.44, 0.075, l)));
    ctx.closePath(); ctx.fill();
    label(ctx, 'shaded: every crystal the arena can generate', L + 6, T + 12);
    // the curve, coloured by wavelength
    for (let l = SPEC_LO; l < SPEC_HI; l += 2) {
      ctx.strokeStyle = css(waveRGB(l + 1), 0.9); ctx.lineWidth = 2; ctx.beginPath();
      ctx.moveTo(xOf(l), yOf(iorAt(cA, cB, l))); ctx.lineTo(xOf(l + 2), yOf(iorAt(cA, cB, l + 2))); ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.fillRect(xOf(589.3), T, 1, B - T);
    label(ctx, 'sodium D  n = A', xOf(589.3) + 4, B - 6, '#cfd8e8');
    const o = $('cauchy-out'); if (o) o.textContent = `n(400) = ${iorAt(cA, cB, 400).toFixed(4)}   n(589) = ${cA.toFixed(4)}   n(700) = ${iorAt(cA, cB, 700).toFixed(4)}   spread ${(iorAt(cA, cB, 400) - iorAt(cA, cB, 700)).toFixed(4)}`;
  });
  bindRange('cauchy-a', 'cauchy-a-out', v => v.toFixed(2), () => { cA = parseFloat($('cauchy-a').value); cauchy && cauchy.render(); });
  bindRange('cauchy-b', 'cauchy-b-out', v => v.toFixed(3), () => { cB = parseFloat($('cauchy-b').value); cauchy && cauchy.render(); });

  /* ================================================== 5. Beer–Lambert */
  const beer = fig('fig-beer', 4.2, (ctx, w, h) => {
    const L = 34, R = w - 12, T = 12, B = h - 20;
    grid(ctx, L, T, R, B);
    const xOf = t => L + t / 3 * (R - L), yOf = p => B - p * (B - T);
    for (const p of [0.5, 1]) { ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(L, yOf(p), R - L, 1); label(ctx, (p * 100) + '%', L - 4, yOf(p) + 3, '#8d97ab', 'right'); }
    for (const t of [0, 1, 2, 3]) label(ctx, t + (t === 3 ? ' world units' : ''), xOf(t), h - 6, '#8d97ab', 'center');
    ctx.strokeStyle = '#7fd8ff'; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let t = 0; t <= 3; t += 0.02) { const x = xOf(t), y = yOf(Math.exp(-0.55 * t)); t === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.stroke();
    label(ctx, 'power × e^(−0.55·d) inside glass; a crystal is 0.2–0.5 units across', L + 6, T + 12);
  });

  /* ================================================== 6. the beam has a waist */
  let waistOff = 1.08;
  const waist = fig('fig-waist', 3.4, (ctx, w, h) => {
    const cx = w * 0.62, cy = h * 0.5, S = h * 0.36;      // pixels per hull radius
    const HULL_R = 1, WAIST = 0.0101 / 0.046;             // BEAM_WAIST / HULL_R
    const off = waistOff * (1 + WAIST);
    // hull
    ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy + off * S, HULL_R * S, 0, Math.PI * 2); ctx.stroke();
    label(ctx, 'hull, radius 0.046', cx + S + 6, cy + off * S + 3);
    // 16 rays across the waist on the base-3 van der Corput sequence
    let hit = 0;
    for (let k = 0; k < 16; k++) {
      const o = (vdc3(k + 1) * 2 - 1) * WAIST;
      const y = cy + o * S;
      const dy = (y - (cy + off * S)) / S;
      const hits = Math.abs(dy) <= HULL_R;
      if (hits) hit++;
      const xEnd = hits ? cx - Math.sqrt(Math.max(0, HULL_R * HULL_R - dy * dy)) * S : w;
      ctx.strokeStyle = hits ? 'rgba(255,255,255,.9)' : 'rgba(255,255,255,.22)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(10, y); ctx.lineTo(xEnd, y); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(127,216,255,.5)'; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(30, cy - WAIST * S); ctx.lineTo(30, cy + WAIST * S); ctx.stroke(); ctx.setLineDash([]);
    label(ctx, 'waist 0.0101, 16 rays', 36, cy - WAIST * S - 6, '#7fd8ff');
    const o = $('waist-out'); if (o) o.textContent = `${hit} of 16 rays land → ${(hit / 16 * 100).toFixed(0)}% of full damage`;
  });
  bindRange('waist-off', 'waist-off-out', v => v.toFixed(2), () => { waistOff = parseFloat($('waist-off').value); waist && waist.render(); });

  /* ================================================== 7. the line, drawn */
  let lineSig = 0.5;
  const line = fig('fig-line', 3.6, (ctx, w, h) => {
    const L = 34, R = w - 12, T = 12, B = h - 20;
    grid(ctx, L, T, R, B);
    const xOf = r => L + (r + 3) / 6 * (R - L);
    // s0 = physical sigma in pixels (slider), sp = 0.42 px pixel footprint
    const s0 = lineSig, sp = 0.42, se = Math.sqrt(s0 * s0 + sp * sp);
    const raw = r => Math.exp(-0.5 * r * r / (s0 * s0));                  // point-sampled
    const conv = r => (s0 / se) * Math.exp(-0.5 * r * r / (se * se));     // what the shader draws
    const yOf = v => B - clamp(v, 0, 1.05) / 1.05 * (B - T);
    ctx.strokeStyle = 'rgba(255,255,255,.3)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let r = -3; r <= 3; r += 0.02) { const x = xOf(r), y = yOf(raw(r)); r === -3 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); } ctx.stroke();
    ctx.strokeStyle = '#7fd8ff'; ctx.lineWidth = 1.6; ctx.beginPath();
    for (let r = -3; r <= 3; r += 0.02) { const x = xOf(r), y = yOf(conv(r)); r === -3 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); } ctx.stroke();
    // pixel columns, to show what a sample sees
    for (let px = -3; px <= 3; px++) { ctx.fillStyle = 'rgba(255,255,255,.06)'; ctx.fillRect(xOf(px - 0.5), T, 1, B - T); }
    for (const r of [-2, -1, 0, 1, 2]) label(ctx, r + ' px', xOf(r), h - 6, '#8d97ab', 'center');
    label(ctx, 'grey: physical core, σ = ' + s0.toFixed(2) + ' px  ·  blue: convolved with the pixel, peak × σ/σ′ (same area)', L + 6, T + 12);
  });
  bindRange('line-sig', 'line-sig-out', v => v.toFixed(2) + ' px', () => { lineSig = parseFloat($('line-sig').value); line && line.render(); });

  /* ================================================== 8. the tracer */
  const TR = { rays: 96, ior: 1.39, disp: 0.060, jitter: true, aim: null, walls: 0.86, mirror: true, seed: 7 };
  function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function makePrism(seed, w, h) {
    const r = rng(seed * 7919 + 13);
    const faces = 5 + Math.floor(r() * 4), base = r() * Math.PI * 2, rad = Math.min(w, h) * 0.24;
    const verts = [];
    for (let k = 0; k < faces; k++) { const a = base + (k + (r() - 0.5) * 0.45) * (Math.PI * 2 / faces); const rr = rad * (0.60 + r() * 0.40); verts.push([Math.cos(a) * rr, Math.sin(a) * rr]); }
    return { x: w * 0.55, y: h * 0.5, verts };
  }
  function inside(P, x, y) {
    let c = false; const v = P.verts;
    for (let i = 0, j = v.length - 1; i < v.length; j = i++) {
      const xi = v[i][0] + P.x, yi = v[i][1] + P.y, xj = v[j][0] + P.x, yj = v[j][1] + P.y;
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c;
    }
    return c;
  }
  /* nearest hit along a ray: the four mirrored walls, or one face of the prism */
  function sceneHit(P, w, h, ox, oy, dx, dy) {
    let best = null;
    const wall = (t, nx, ny) => { if (t > 1e-6 && (!best || t < best.t)) best = { t, nx, ny, kind: 2 }; };
    if (dx > 0) wall((w - ox) / dx, -1, 0); if (dx < 0) wall(-ox / dx, 1, 0);
    if (dy > 0) wall((h - oy) / dy, 0, -1); if (dy < 0) wall(-oy / dy, 0, 1);
    const v = P.verts;
    for (let i = 0, j = v.length - 1; i < v.length; j = i++) {
      const ax = v[j][0] + P.x, ay = v[j][1] + P.y, bx = v[i][0] + P.x, by = v[i][1] + P.y;
      const ex = bx - ax, ey = by - ay, den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((ax - ox) * ey - (ay - oy) * ex) / den, u = ((ax - ox) * dy - (ay - oy) * dx) / den;
      if (t > 1e-6 && u >= 0 && u <= 1 && (!best || t < best.t)) { const l = Math.hypot(ex, ey); best = { t, nx: ey / l, ny: -ex / l, kind: 0 }; }
    }
    return best;
  }
  const tracer = fig('fig-tracer', 1.9, (ctx, w, h, f) => {
    const P = f.prism = (f.prism && f.prism.seed === TR.seed && f.prism.w === w) ? f.prism : Object.assign(makePrism(TR.seed, w, h), { seed: TR.seed, w });
    // the crystal
    ctx.beginPath(); P.verts.forEach((v, i) => i ? ctx.lineTo(v[0] + P.x, v[1] + P.y) : ctx.moveTo(v[0] + P.x, v[1] + P.y)); ctx.closePath();
    ctx.fillStyle = 'rgba(90,120,200,.10)'; ctx.fill(); ctx.strokeStyle = 'rgba(180,200,255,.35)'; ctx.lineWidth = 1; ctx.stroke();
    // the walls
    ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    // the muzzle
    const mx = w * 0.10, my = h * 0.5;
    /* First frame: aim a little above the crystal's centre, so the opening
       shot enters a face off-axis and the fan is there before anybody drags. */
    if (TR.aim === null) TR.aim = Math.atan2(P.y - my, P.x - mx) + 0.10;
    const dx = Math.cos(TR.aim), dy = Math.sin(TR.aim);
    ctx.globalCompositeOperation = 'lighter';
    const N = TR.rays, pw = 1 / N, gain = 7 / N;
    let segs = 0;
    for (let k = 0; k < N; k++) {
      const u = N === 1 ? 0.5 : (k + (TR.jitter ? (vdc(k + 1) - 0.5) * 0.9 : 0)) / (N - 1);
      const lam = SPEC_LO + clamp(u, 0, 1) * (SPEC_HI - SPEC_LO);
      const col = waveRGB(lam);
      const stack = [[mx, my, dx, dy, pw, 0, inside(P, mx, my)]];
      while (stack.length) {
        const [x, y, ux, uy, p, depth, inGlass] = stack.pop();
        if (p < pw * 0.006 || depth > 9 || segs > 20000) continue;
        const hit = sceneHit(P, w, h, x, y, ux, uy); if (!hit) continue;
        const hx = x + ux * hit.t, hy = y + uy * hit.t;
        let pp = p;
        if (inGlass) pp *= Math.exp(-hit.t / (Math.min(w, h) * 0.3) * 0.55);      // Beer–Lambert, scaled to the figure
        if (hit.t < 0.4) { segs++; } else {
        ctx.strokeStyle = css(col, (p + pp) * 0.5 / pw * gain); ctx.lineWidth = 0.9;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(hx, hy); ctx.stroke(); segs++; }
        if (hit.kind === 2) {                                                        // mirror (or, walls off, a black wall)
          if (!TR.mirror) continue;
          const d = ux * hit.nx + uy * hit.ny, rx = ux - 2 * d * hit.nx, ry = uy - 2 * d * hit.ny;
          if (pp * TR.walls > pw * 0.010) stack.push([hx + rx * 1e-3, hy + ry * 1e-3, rx, ry, pp * TR.walls, depth + 1, inGlass]);
          continue;
        }
        const nG = iorAt(TR.ior, TR.disp, lam);                                       // the crystal
        let nx = hit.nx, ny = hit.ny, cosi = -(ux * nx + uy * ny);
        if (cosi < 0) { nx = -nx; ny = -ny; cosi = -cosi; }
        cosi = clamp(cosi, 0, 1);
        const n1 = inGlass ? nG : 1, n2 = inGlass ? 1 : nG;
        const F = fresnel(n1, n2, cosi);
        const rx = ux + 2 * cosi * nx, ry = uy + 2 * cosi * ny;
        if (pp * F.R > pw * 0.010) stack.push([hx + rx * 1e-3, hy + ry * 1e-3, rx, ry, pp * F.R, depth + 1, inGlass]);
        if (!F.tir && pp * F.T > pw * 0.010) {
          const tx = F.eta * ux + (F.eta * cosi - F.cost) * nx, ty = F.eta * uy + (F.eta * cosi - F.cost) * ny;
          stack.push([hx + tx * 1e-3, hy + ty * 1e-3, tx, ty, pp * F.T, depth + 1, !inGlass]);
        }
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    // the ship
    ctx.save(); ctx.translate(mx, my); ctx.rotate(TR.aim);
    ctx.fillStyle = '#e9edf5'; ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-7, 6); ctx.lineTo(-4, 0); ctx.lineTo(-7, -6); ctx.closePath(); ctx.fill();
    ctx.restore();
    const o = $('tracer-out'); if (o) o.textContent = `${N} rays · ${segs} segments · aim ${(TR.aim * 180 / Math.PI).toFixed(1)}° — drag on the picture to aim`;
  });
  if (tracer) {
    const c = tracer.c; let aiming = false;
    const aimTo = ev => { const r = c.getBoundingClientRect(); const x = ev.clientX - r.left, y = ev.clientY - r.top; TR.aim = Math.atan2(y - tracer.h * 0.5, x - tracer.w * 0.10); tracer.render(); };
    c.addEventListener('pointerdown', ev => { aiming = true; c.setPointerCapture(ev.pointerId); aimTo(ev); ev.preventDefault(); });
    c.addEventListener('pointermove', ev => { if (aiming) aimTo(ev); });
    c.addEventListener('pointerup', () => { aiming = false; });
    c.addEventListener('pointercancel', () => { aiming = false; });
    bindRange('tr-rays', 'tr-rays-out', v => v.toFixed(0), () => { TR.rays = parseInt($('tr-rays').value, 10); tracer.render(); });
    bindRange('tr-ior', 'tr-ior-out', v => v.toFixed(2), () => { TR.ior = parseFloat($('tr-ior').value); tracer.render(); });
    bindRange('tr-disp', 'tr-disp-out', v => v.toFixed(3), () => { TR.disp = parseFloat($('tr-disp').value); tracer.render(); });
    const j = $('tr-jitter'); if (j) j.addEventListener('change', () => { TR.jitter = j.checked; tracer.render(); });
    const mw = $('tr-mirror'); if (mw) mw.addEventListener('change', () => { TR.mirror = mw.checked; tracer.render(); });
    const nb = $('tr-new'); if (nb) nb.addEventListener('click', () => { TR.seed = (TR.seed * 31 + 7) % 10007; tracer.render(); });
  }

  /* ---------------------------------------------------- go */
  const all = () => figs.forEach(f => f.render());
  if ('ResizeObserver' in window) { const ro = new ResizeObserver(() => all()); figs.forEach(f => ro.observe(f.c)); }
  else addEventListener('resize', all);
  all();
})();
