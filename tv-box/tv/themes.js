// TV themes: Light (default), Dark, Nature (photos), and four animated ones: Tech, Rain, Jungle, Aurora.
// Rain and Jungle also have ambient sound (ambience.js).
// Applied as <html data-theme>.
// Nature photos are bundled on the box: /themes/nature/list.json = [{src, credit}] (the installer writes it).
// Until those exist, Nature shows painted scenes drawn here, so it always works offline.
// The animated themes share one half-resolution canvas at 30 fps and stop whenever the TV page isn't showing.
window.TVTheme = (() => {
  const LIST = [
    { k: 'light', name: 'Light', sw: 'linear-gradient(135deg,#FBFAF7,#E9E5DC)' },
    { k: 'dark', name: 'Dark', sw: 'linear-gradient(135deg,#2A2927,#121211)' },
    { k: 'nature', name: 'Nature', sw: 'linear-gradient(160deg,#9CC3D9 0%,#E7C9A0 45%,#4E7A5A 46%,#22402F 100%)' },
    { k: 'tech', name: 'Tech', sw: 'radial-gradient(circle at 30% 70%,#3B7BFF 0,#0D1424 45%,#06080D 100%)' },
    { k: 'rain', name: 'Rain', sw: 'linear-gradient(170deg,#3A4C5E 0%,#18222C 55%,#0A0F15 100%)' },
    { k: 'jungle', name: 'Jungle', sw: 'radial-gradient(circle at 60% 35%,#BFE8A8 0,#2F7A4A 30%,#12301F 62%,#06110A 100%)' },
    { k: 'aurora', name: 'Aurora', sw: 'linear-gradient(160deg,#7A5AE0 0%,#2BD9A8 42%,#0B1C24 70%,#050B12 100%)' },
  ];
  const KEY = 'tv-theme';
  const screen = document.getElementById('screen');
  const room = screen.querySelector('.room');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Layers sit just above the room, below everything else.
  const bg = document.createElement('div'); bg.className = 'bg';
  const phA = document.createElement('div'), phB = document.createElement('div');
  phA.className = phB.className = 'ph';
  const scrim = document.createElement('div'); scrim.className = 'scrim';
  bg.append(phA, phB, scrim);
  const fx = document.createElement('canvas'); fx.className = 'fx'; fx.width = 960; fx.height = 540;
  const credit = document.createElement('div'); credit.className = 'credit';
  room.after(bg, fx);
  screen.appendChild(credit);

  let cur = 'light', busy = false;

  // ---------- Nature ----------
  // Painted fallback scenes: sky, sun, three ridgelines, a lake glint. Calm, photographic in palette.
  function ridge(seed, base, amp, w = 1920) {
    // Soft ridgeline: random peaks joined with quadratic curves through their midpoints.
    let r = seed, x = -80;
    const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
    const pts = [];
    while (x < w + 200) { pts.push([x, base - rnd() * amp]); x += 140 + rnd() * 220; }
    let d = `M-100 1080 L${pts[0][0]} ${pts[0][1].toFixed(0)}`;
    for (let i = 1; i < pts.length; i++) {
      const [px, py] = pts[i - 1], [cx, cy] = pts[i];
      d += ` Q${px.toFixed(0)} ${py.toFixed(0)} ${((px + cx) / 2).toFixed(0)} ${((py + cy) / 2).toFixed(0)}`;
    }
    return d + ` L${w + 200} 1080 Z`;
  }
  function scene(p, seed) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice">
      <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.sky[0]}"/><stop offset=".62" stop-color="${p.sky[1]}"/><stop offset="1" stop-color="${p.sky[2]}"/></linearGradient>
      <radialGradient id="g" cx="${p.sun[0]}" cy="${p.sun[1]}" r=".35"><stop offset="0" stop-color="${p.glow}" stop-opacity=".9"/><stop offset="1" stop-color="${p.glow}" stop-opacity="0"/></radialGradient>
      <linearGradient id="h" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".2"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
      <rect width="1920" height="1080" fill="url(#s)"/><rect width="1920" height="1080" fill="url(#g)"/>
      <path d="${ridge(seed, 640, 220)}" fill="${p.r[0]}"/><rect y="560" width="1920" height="260" fill="url(#h)" opacity=".5"/>
      <path d="${ridge(seed + 7, 760, 170)}" fill="${p.r[1]}"/><rect y="700" width="1920" height="200" fill="url(#h)" opacity=".35"/>
      <path d="${ridge(seed + 13, 900, 140)}" fill="${p.r[2]}"/></svg>`;
    return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
  }
  const PAINTED = [
    { src: scene({ sky: ['#7FA7C9', '#E9C9A3', '#F2D7B5'], sun: ['.68', '.52'], glow: '#FFE2B0', r: ['#8C8FA6', '#4F6A6B', '#23382F'] }, 11), credit: '' },
    { src: scene({ sky: ['#35506E', '#C98E77', '#E8B48E'], sun: ['.3', '.58'], glow: '#FFC79A', r: ['#5E5A73', '#3A4253', '#1A2027'] }, 29), credit: '' },
    { src: scene({ sky: ['#A9CFE0', '#DDEBE4', '#EEF3EA'], sun: ['.5', '.3'], glow: '#FFFFFF', r: ['#86A99A', '#4E7A5A', '#264534'] }, 47), credit: '' },
  ];
  let photos = null, pi = 0, front = phA, natTimer = 0;
  async function loadPhotos() {
    if (photos) return photos;
    try {
      const r = await fetch('/themes/nature/list.json', { cache: 'no-store' });
      const j = r.ok ? await r.json() : [];
      photos = Array.isArray(j) && j.length ? j.map((p) => ({ src: `url("${encodeURI(p.src)}")`, credit: p.credit || '' })) : PAINTED;
    } catch (e) { photos = PAINTED; }
    pi = Math.floor(Math.random() * photos.length);
    return photos;
  }
  function showPhoto() {
    const p = photos[pi % photos.length];
    const back = front === phA ? phB : phA;
    const img = new Image();
    const go = () => {
      back.style.backgroundImage = p.src;
      back.style.animation = 'none'; void back.offsetWidth; back.style.animation = '';
      back.classList.add('on'); front.classList.remove('on'); front = back;
      credit.textContent = p.credit ? `Photo · ${p.credit}` : '';
    };
    const m = p.src.match(/^url\("(?!data:)(.*)"\)$/);
    if (m) { img.onload = go; img.onerror = () => { pi++; }; img.src = decodeURI(m[1]); } else go();
  }
  async function startNature() {
    await loadPhotos();
    if (cur !== 'nature') return;
    bg.classList.add('on');
    showPhoto();
    clearInterval(natTimer);
    natTimer = setInterval(() => { if (!busy && !document.hidden) { pi++; showPhoto(); } }, 60000);
  }
  function stopNature() { clearInterval(natTimer); bg.classList.remove('on'); credit.textContent = ''; }

  // ---------- Animated themes (Tech, Aurora, Rain, Jungle) ----------
  // One shared half-resolution canvas and one 30 fps loop. Each theme is { seed(), draw(dt) }.
  // Glows are small sprites painted once and stamped with drawImage, so a frame is a few hundred
  // cheap blits or strokes: no blur filters, no per-frame gradients.
  const ctx = fx.getContext('2d');
  const W = 960, H = 540, TAU = 6.283;
  let raf = 0, last = 0, t = 0;
  const seeded = {};
  function sprite(w, h, paint) { const c = document.createElement('canvas'); c.width = w; c.height = h; paint(c.getContext('2d'), w, h); return c; }
  function glow(size, stops) {
    return sprite(size, size, (g, w) => {
      const r = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
      stops.forEach(([o, c]) => r.addColorStop(o, c));
      g.fillStyle = r; g.fillRect(0, 0, w, w);
    });
  }

  // Tech: flowing light lines and a quiet constellation.
  let dots = [];
  const tech = {
    seed() {
      dots = Array.from({ length: 64 }, () => ({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - .5) * .25, vy: -(.08 + Math.random() * .22), r: .6 + Math.random() * 1.2 }));
    },
    draw(dt) {
      // Flowing lines: a few slow sine ribbons across the lower half.
      ctx.lineWidth = 1.2;
      for (let i = 0; i < 6; i++) {
        const hue = 205 + i * 9, y0 = 300 + i * 26;
        ctx.strokeStyle = `hsla(${hue},90%,62%,${0.16 - i * 0.015})`;
        ctx.beginPath();
        for (let x = 0; x <= W; x += 16) {
          const y = y0 + Math.sin(x * .006 + t * (1.2 + i * .15) + i) * (28 + i * 6) + Math.sin(x * .013 - t * 1.7 + i * 2) * 10;
          x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.stroke();
      }
      // Drifting points, linked when close.
      for (const d of dots) {
        d.x += d.vx * dt; d.y += d.vy * dt;
        if (d.y < -10) { d.y = H + 10; d.x = Math.random() * W; }
        if (d.x < -10) d.x = W + 10; else if (d.x > W + 10) d.x = -10;
      }
      ctx.lineWidth = .6;
      for (let i = 0; i < dots.length; i++) {
        const a = dots[i];
        for (let j = i + 1; j < dots.length; j++) {
          const b = dots[j], dx = a.x - b.x, dy = a.y - b.y, q = dx * dx + dy * dy;
          if (q < 6400) { ctx.strokeStyle = `rgba(120,170,255,${(1 - q / 6400) * .22})`; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
        }
      }
      ctx.fillStyle = 'rgba(170,205,255,.75)';
      for (const d of dots) { ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, TAU); ctx.fill(); }
    },
  };

  // Aurora: two curtains of northern lights swaying over a still, starry night. Serene.
  // Each curtain is a row of soft vertical rays (one sprite, stretched), bright at the hem and
  // fading upward from green through teal to violet.
  let rays = [], stars = [];
  const aurora = {
    seed() {
      const ray = (hem, mid, top) => sprite(16, 128, (g, w, h) => {
        const v = g.createLinearGradient(0, 0, 0, h);
        v.addColorStop(0, top + '0)'); v.addColorStop(.35, top + '.28)'); v.addColorStop(.72, mid + '.55)');
        v.addColorStop(.93, hem + '.95)'); v.addColorStop(1, hem + '0)');
        g.fillStyle = v; g.fillRect(0, 0, w, h);
        g.globalCompositeOperation = 'destination-in';       // soften the sides so rays blend into a sheet
        const s = g.createLinearGradient(0, 0, w, 0);
        s.addColorStop(0, 'rgba(0,0,0,0)'); s.addColorStop(.5, 'rgba(0,0,0,1)'); s.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = s; g.fillRect(0, 0, w, h);
      });
      rays = [
        { img: ray('rgba(120,255,170,', 'rgba(40,220,170,', 'rgba(120,90,255,'), base: 250, amp: 46, len: 210, k: .0052, sp: .55, ph: 0, a: .5 },
        { img: ray('rgba(110,240,220,', 'rgba(60,170,230,', 'rgba(190,90,230,'), base: 330, amp: 38, len: 170, k: .0071, sp: -.4, ph: 2.4, a: .36 },
      ];
      stars = Array.from({ length: 70 }, () => ({ x: Math.random() * W, y: Math.random() * H * .8, r: Math.random() < .15 ? 1.5 : 1, p: Math.random() * TAU, s: .6 + Math.random() * 1.6 }));
    },
    draw() {
      for (const s of stars) {
        ctx.fillStyle = `rgba(215,235,255,${.2 + .3 * (1 + Math.sin(s.p + t * 6 * s.s)) / 2})`;
        ctx.fillRect(s.x, s.y, s.r, s.r);
      }
      ctx.globalCompositeOperation = 'lighter';
      for (const c of rays) {
        for (let x = -8; x < W; x += 7) {
          const hem = c.base + Math.sin(x * c.k + t * c.sp + c.ph) * c.amp + Math.sin(x * c.k * 2.7 - t * c.sp * 1.6 + c.ph) * c.amp * .35;
          const len = c.len * (.72 + .28 * Math.sin(x * .011 + t * .9 + c.ph));
          // Brightness ripples along the curtain: two slow waves multiplied, so bands come and go.
          const b = (.55 + .45 * Math.sin(x * .019 - t * 1.4 + c.ph)) * (.6 + .4 * Math.sin(x * .047 + t * 2.3));
          ctx.globalAlpha = c.a * Math.max(.08, b);
          ctx.drawImage(c.img, x, hem - len, 16, len);
        }
      }
    },
  };

  // Rain: a wet evening seen from indoors. Soft city lights out of focus, three depths of falling rain,
  // ripples where it lands, and now and then far-off lightning (the thunder follows a moment later).
  let bokeh = [], drops = [], ripples = [], rainSheen = null, flashAt = 0, flash = 0;
  const rain = {
    seed() {
      const disc = (rgb) => glow(64, [[0, `rgba(${rgb},.5)`], [.72, `rgba(${rgb},.55)`], [.86, `rgba(${rgb},.8)`], [1, `rgba(${rgb},0)`]]);
      const soft = (rgb) => glow(32, [[0, `rgba(${rgb},.6)`], [1, `rgba(${rgb},0)`]]);
      const cols = ['255,190,110', '255,214,160', '150,205,225', '235,120,100', '190,205,255'], softs = cols.map(soft);
      const lamps = [disc('255,190,110'), disc('255,214,160'), disc('150,205,225'), disc('235,120,100'), disc('190,205,255')];
      bokeh = Array.from({ length: 18 }, (_, i) => {
        const far = Math.random();
        return { img: lamps[i % lamps.length], soft: softs[i % softs.length], x: Math.random() * W, y: 190 + Math.random() * 210, s: 26 + far * 86, a: .09 + (1 - far) * .15, p: Math.random() * TAU, f: .5 + Math.random() * 1.5 };
      });
      const layer = (n, len, v, a, w) => ({ len, v, a, w, d: Array.from({ length: n }, () => ({ x: Math.random() * (W + 120), y: Math.random() * H, k: .8 + Math.random() * .4 })) });
      drops = [layer(150, 8, 8, .16, .7), layer(90, 15, 13, .24, 1), layer(30, 30, 21, .3, 1.4)];
      ripples = Array.from({ length: 30 }, () => ({ x: 0, y: 0, age: 1 }));
      rainSheen = sprite(8, 128, (g, w, h) => {              // wet ground catching the light
        const v = g.createLinearGradient(0, 0, 0, h);
        v.addColorStop(0, 'rgba(150,180,210,0)'); v.addColorStop(1, 'rgba(150,180,210,.13)');
        g.fillStyle = v; g.fillRect(0, 0, w, h);
      });
      flashAt = t + 5 + Math.random() * 8;
    },
    draw(dt) {
      ctx.globalCompositeOperation = 'lighter';
      for (const b of bokeh) {
        ctx.globalAlpha = b.a * (.75 + .25 * Math.sin(t * 3 * b.f + b.p));
        ctx.drawImage(b.img, b.x - b.s / 2, b.y - b.s / 2, b.s, b.s);
        ctx.globalAlpha *= .5;                                 // its smeared reflection on the wet ground
        ctx.drawImage(b.soft, b.x - b.s * .3, 452, b.s * .6, 120);
      }
      ctx.globalAlpha = 1;
      ctx.drawImage(rainSheen, 0, 430, W, 110);
      // Lightning, far away: two soft pulses of light. Thunder rolls in after it.
      if (t > flashAt) {
        flash = 1; flashAt = t + 9 + Math.random() * 13;       // roughly every 50 to 120 seconds
        if (window.TVAmbience) window.TVAmbience.thunder(1.2 + Math.random() * 1.6);
      }
      if (flash > .01) {
        const f = flash > .55 && flash < .8 ? flash * .35 : flash;   // the dip between the two pulses
        ctx.fillStyle = `rgba(175,200,255,${f * .13})`; ctx.fillRect(0, 0, W, H);
        flash *= Math.pow(.86, dt);
      }
      ctx.globalCompositeOperation = 'source-over';
      const wind = -.2 + .1 * Math.sin(t * 1.3);               // the slant drifts with the gusts
      let ri = 0;
      for (const L of drops) {
        ctx.beginPath();
        for (const d of L.d) {
          d.y += L.v * d.k * dt; d.x += L.v * d.k * wind * dt;
          if (d.y > H) {
            if (L.w >= 1 && Math.random() < .6) {              // it lands: start a ripple
              for (let n = 0; n < ripples.length; n++, ri = (ri + 1) % ripples.length) if (ripples[ri].age >= 1) { const r = ripples[ri]; r.x = d.x; r.y = 468 + Math.random() * 68; r.age = 0; break; }
            }
            d.y = -L.len - Math.random() * 60; d.x = Math.random() * (W + 120);
          }
          ctx.moveTo(d.x, d.y); ctx.lineTo(d.x + L.len * wind, d.y - L.len);
        }
        ctx.lineWidth = L.w; ctx.strokeStyle = `rgba(190,215,240,${L.a})`; ctx.stroke();
      }
      ctx.lineWidth = 1;
      for (const r of ripples) {
        if (r.age >= 1) continue;
        r.age += .045 * dt;
        const depth = (r.y - 440) / 100;                       // nearer the viewer: bigger, flatter rings
        ctx.strokeStyle = `rgba(200,222,245,${(1 - r.age) * .34})`;
        ctx.beginPath(); ctx.ellipse(r.x, r.y, (3 + r.age * 16) * depth, (1 + r.age * 4.5) * depth, 0, 0, TAU); ctx.stroke();
      }
    },
  };

  // Jungle: under the canopy. Leaves and vines never stop swaying, light shafts breathe through the mist,
  // motes drift, leaves fall, and a blue butterfly wanders across.
  let leaves = [], vines = [], mist = [], motes = [], fallers = [], shafts = [], fly = null, shaftImg = null, mistImg = null, moteImg = null;
  const jungle = {
    seed() {
      const S = 300;
      // Leaf sprites point right from a stem at (0, S/2); they are rotated around that point to sway.
      const frond = (col, rib) => sprite(S, S, (g) => {         // a palm frond: tapered leaflets, all leaning toward the tip
        g.translate(0, S / 2); g.fillStyle = col;
        for (let i = 1; i <= 19; i++) {
          const u = i / 20, x = 16 + u * 262, y = u * u * 44, len = Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.08)), .6) * 92 + 12;
          for (const side of [-1, 1]) {
            const an = side * (1.02 - u * .35), dx = Math.cos(an), dy = Math.sin(an), mx = x + dx * len * .5, my = y + dy * len * .5, w = 6.5;
            g.beginPath(); g.moveTo(x, y);
            g.quadraticCurveTo(mx - dy * w, my + dx * w, x + dx * len, y + dy * len + 3);
            g.quadraticCurveTo(mx + dy * w, my - dx * w, x, y); g.fill();
          }
        }
        g.lineCap = 'round'; g.lineWidth = 3.5; g.strokeStyle = rib; g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(140, 0, 280, 44); g.stroke();
      });
      const split = (col, rib) => sprite(S, S, (g) => {         // a broad split leaf
        g.translate(0, S / 2); g.fillStyle = col;
        g.beginPath(); g.moveTo(58, 0); g.bezierCurveTo(40, -128, 262, -118, 290, 0); g.bezierCurveTo(262, 118, 40, 128, 58, 0); g.fill();
        g.globalCompositeOperation = 'destination-out';
        for (let i = 0; i < 5; i++) for (const side of [-1, 1]) {
          const x = 96 + i * 38, r = 92 - Math.abs(i - 1.6) * 16;
          g.beginPath(); g.moveTo(x - 6, side * 22); g.lineTo(x + 30, side * (r + 30)); g.lineTo(x + 44, side * (r + 30)); g.closePath(); g.fill();
        }
        g.globalCompositeOperation = 'source-over';
        g.strokeStyle = col; g.lineWidth = 5; g.lineCap = 'round'; g.beginPath(); g.moveTo(0, 0); g.lineTo(62, 0); g.stroke();
        g.strokeStyle = rib; g.lineWidth = 2.5; g.beginPath(); g.moveTo(58, 0); g.lineTo(272, 0); g.stroke();
      });
      const blade = (col, rib) => sprite(S, S, (g) => {         // a long banana-style leaf
        g.translate(0, S / 2); g.fillStyle = col;
        g.beginPath(); g.moveTo(30, 0); g.bezierCurveTo(70, -62, 220, -56, 296, 10); g.bezierCurveTo(210, 62, 70, 52, 30, 0); g.fill();
        g.strokeStyle = col; g.lineWidth = 5; g.lineCap = 'round'; g.beginPath(); g.moveTo(0, 0); g.lineTo(34, 0); g.stroke();
        g.strokeStyle = rib; g.lineWidth = 2.5; g.beginPath(); g.moveTo(30, 0); g.quadraticCurveTo(160, -4, 290, 9); g.stroke();
      });
      const far = ['#1B4733', '#2B6548'], near = ['#0A2015', '#1B4A30'];
      const F = { fb: frond(...far), ff: frond(...near), sb: split(...far), sf: split(...near), bb: blade(...far), bf: blade(...near) };
      const leaf = (img, x, y, deg, sc, amp, flip = 1) => ({ img, x, y, a: deg * Math.PI / 180, sc, amp: amp * Math.PI / 180, flip, sp: .7 + Math.random() * .8, p: Math.random() * TAU });
      leaves = [
        // Far layer: paler, smaller, slower.
        leaf(F.fb, 150, -25, 70, .62, 3), leaf(F.sb, 400, -40, 84, .46, 4), leaf(F.fb, 800, -25, 110, .62, 3, -1), leaf(F.sb, 580, -45, 98, .4, 4, -1),
        leaf(F.bb, -20, 300, 8, .6, 3), leaf(F.bb, 980, 290, 174, .6, 3, -1), leaf(F.fb, 190, 565, -70, .55, 4), leaf(F.fb, 770, 565, -110, .55, 4, -1),
        // Near layer: darker shapes framing the corners.
        leaf(F.ff, -30, -15, 30, 1, 4), leaf(F.sf, 245, -50, 72, .66, 5), leaf(F.bf, -40, 165, 16, .74, 5),
        leaf(F.ff, 990, -15, 150, 1, 4, -1), leaf(F.sf, 715, -50, 108, .66, 5, -1), leaf(F.bf, 1000, 165, 164, .74, 5, -1),
        leaf(F.sf, -40, 575, -38, .9, 4), leaf(F.ff, 80, 600, -64, .72, 4),
        leaf(F.sf, 1000, 575, -142, .9, 4, -1), leaf(F.ff, 880, 600, -116, .72, 4, -1),
      ];
      jungle.nearFrom = 8;
      vines = [[70, 150], [205, 105], [395, 70], [585, 60], [742, 95], [880, 140], [930, 90]].map(([x, len]) => ({ x, len: len + Math.random() * 40, p: Math.random() * TAU, sp: .6 + Math.random() * .7 }));
      shaftImg = sprite(96, 256, (g, w, h) => {
        const v = g.createLinearGradient(0, 0, 0, h);
        v.addColorStop(0, 'rgba(215,255,200,.55)'); v.addColorStop(.7, 'rgba(190,240,190,.16)'); v.addColorStop(1, 'rgba(190,240,190,0)');
        g.fillStyle = v; g.fillRect(0, 0, w, h);
        g.globalCompositeOperation = 'destination-in';
        const s = g.createLinearGradient(0, 0, w, 0);
        s.addColorStop(0, 'rgba(0,0,0,0)'); s.addColorStop(.5, 'rgba(0,0,0,1)'); s.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = s; g.fillRect(0, 0, w, h);
      });
      shafts = [{ x: 560, w: 150, a: .34, p: 0 }, { x: 670, w: 90, a: .26, p: 2 }, { x: 420, w: 110, a: .22, p: 4 }, { x: 790, w: 70, a: .2, p: 1 }];
      mistImg = glow(128, [[0, 'rgba(205,235,215,.5)'], [.5, 'rgba(190,225,205,.2)'], [1, 'rgba(180,220,200,0)']]);
      mist = Array.from({ length: 5 }, (_, i) => ({ x: Math.random() * W, y: 250 + i * 52, w: 520 + Math.random() * 300, h: 110 + Math.random() * 60, v: (i % 2 ? -1 : 1) * (.1 + Math.random() * .14), a: .16 + Math.random() * .1 }));
      moteImg = glow(24, [[0, 'rgba(250,255,200,1)'], [.3, 'rgba(215,255,150,.5)'], [1, 'rgba(180,255,120,0)']]);
      motes = Array.from({ length: 30 }, () => ({ x: Math.random() * W, y: Math.random() * H, s: 4 + Math.random() * 9, p: Math.random() * TAU, f: .5 + Math.random() * 1.4, vx: (Math.random() - .5) * .3, vy: -.04 - Math.random() * .16 }));
      fallers = Array.from({ length: 4 }, () => ({ x: Math.random() * W, y: Math.random() * H, p: Math.random() * TAU, v: .5 + Math.random() * .5 }));
      fly = { x: -20, y: 300, dir: 1, p: 0 };
    },
    leaf(l) {
      const a = l.a + Math.sin(t * 4.5 * l.sp + l.p) * l.amp + Math.sin(t * 11 * l.sp + l.p * 2) * l.amp * .3;
      const c = Math.cos(a) * l.sc, s = Math.sin(a) * l.sc;
      ctx.setTransform(c, s, -s * l.flip, c * l.flip, l.x, l.y);
      ctx.drawImage(l.img, 0, -150);
    },
    draw(dt) {
      ctx.globalCompositeOperation = 'lighter';
      for (const s of shafts) {                                // light through the canopy, slowly breathing
        ctx.globalAlpha = s.a * (.6 + .4 * Math.sin(t * 2.2 + s.p));
        ctx.setTransform(1, 0, -.42, 1, s.x + Math.sin(t * .9 + s.p) * 24, -20);
        ctx.drawImage(shaftImg, 0, 0, s.w, 590);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      for (const m of mist) {
        m.x += m.v * dt; if (m.x > W + m.w / 2) m.x = -m.w / 2; else if (m.x < -m.w / 2) m.x = W + m.w / 2;
        ctx.globalAlpha = m.a; ctx.drawImage(mistImg, m.x - m.w / 2, m.y - m.h / 2, m.w, m.h);
      }
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = .7;
      for (let i = 0; i < jungle.nearFrom; i++) jungle.leaf(leaves[i]);
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1;
      // Hanging vines with a few small leaves.
      ctx.strokeStyle = '#123322'; ctx.fillStyle = '#18442D'; ctx.lineWidth = 2;
      for (const v of vines) {
        const sw = Math.sin(t * 5 * v.sp + v.p) * 14 + Math.sin(t * 13 * v.sp + v.p) * 4;
        ctx.beginPath(); ctx.moveTo(v.x, -4); ctx.quadraticCurveTo(v.x + sw * .2, v.len * .55, v.x + sw, v.len); ctx.stroke();
        for (let j = 1; j <= 4; j++) {
          const u = j / 4, x = v.x + sw * u * u, y = v.len * u;
          ctx.beginPath(); ctx.ellipse(x + (j % 2 ? 6 : -6), y, 7, 3.2, (j % 2 ? .5 : -.5) + sw * .02, 0, TAU); ctx.fill();
        }
      }
      // Falling leaves, tumbling.
      ctx.fillStyle = '#2C6A44';
      for (const f of fallers) {
        f.y += f.v * dt; f.p += .05 * dt;
        if (f.y > H + 10) { f.y = -10; f.x = Math.random() * W; }
        ctx.globalAlpha = .7;
        ctx.beginPath(); ctx.ellipse(f.x + Math.sin(f.p) * 26, f.y, 6, 2.6 + Math.abs(Math.cos(f.p * 1.7)) * 1.4, f.p * 1.3, 0, TAU); ctx.fill();
      }
      // Drifting motes of light.
      ctx.globalCompositeOperation = 'lighter';
      for (const m of motes) {
        m.x += (m.vx + Math.sin(t * 3 * m.f + m.p) * .25) * dt; m.y += m.vy * dt;
        if (m.y < -10) { m.y = H + 10; m.x = Math.random() * W; }
        if (m.x < -10) m.x = W + 10; else if (m.x > W + 10) m.x = -10;
        ctx.globalAlpha = .25 + .55 * (.5 + .5 * Math.sin(t * 7 * m.f + m.p));
        ctx.drawImage(moteImg, m.x - m.s / 2, m.y - m.s / 2, m.s, m.s);
      }
      ctx.globalCompositeOperation = 'source-over';
      // A blue butterfly wanders across, then another comes back the other way.
      fly.p += dt;
      fly.x += fly.dir * (.9 + .5 * Math.sin(fly.p * .05)) * dt;
      fly.y += (Math.sin(fly.p * .043) * .9 + Math.sin(fly.p * .11) * .6) * dt;
      fly.y = Math.max(60, Math.min(H - 60, fly.y));
      if (fly.x > W + 30 || fly.x < -30) { fly.dir = -fly.dir; fly.y = 120 + Math.random() * 300; }
      const flap = Math.abs(Math.sin(fly.p * .42)), wy = 3 + flap * 11;
      ctx.globalAlpha = .95;
      for (const side of [-1, 1]) {
        ctx.fillStyle = side < 0 ? '#3FA9FF' : '#2A8BF0';
        ctx.beginPath(); ctx.moveTo(fly.x, fly.y);
        ctx.quadraticCurveTo(fly.x + side * 3 - fly.dir * 10, fly.y - wy * 1.2, fly.x - fly.dir * 13, fly.y - wy * .5);
        ctx.quadraticCurveTo(fly.x - fly.dir * 11, fly.y + wy * .5, fly.x, fly.y + 2); ctx.fill();
        ctx.beginPath(); ctx.moveTo(fly.x, fly.y);
        ctx.quadraticCurveTo(fly.x + fly.dir * 11, fly.y - wy * 1.3, fly.x + fly.dir * 14, fly.y - wy * .4);
        ctx.quadraticCurveTo(fly.x + fly.dir * 10, fly.y + wy * .4, fly.x, fly.y + 2); ctx.fill();
      }
      ctx.fillStyle = '#081208'; ctx.fillRect(fly.x - 1, fly.y - 1, 2, 4);
      ctx.globalAlpha = 1;
      for (let i = jungle.nearFrom; i < leaves.length; i++) jungle.leaf(leaves[i]);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    },
  };

  const FX = { tech, aurora, rain, jungle };
  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (now - last < 33) return;              // ~30 fps is plenty for a background
    const dt = Math.min(3, (now - last) / 33); last = now; t += .006 * dt;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);
    FX[cur].draw(dt);
  }
  function runFx() {
    cancelAnimationFrame(raf); raf = 0;
    if (!FX[cur] || busy || document.hidden) return;
    if (reduce) { last = 0; frame(performance.now()); cancelAnimationFrame(raf); raf = 0; return; }   // one still frame
    last = performance.now() - 40; raf = requestAnimationFrame(frame);
  }
  function startFx() { if (!seeded[cur]) { FX[cur].seed(); seeded[cur] = true; } fx.classList.add('on'); runFx(); }
  function stopFx() { cancelAnimationFrame(raf); raf = 0; fx.classList.remove('on'); }

  // ---------- Apply ----------
  function apply(k, save = true) {
    if (!LIST.some((x) => x.k === k)) k = 'light';
    if (k === 'light') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = k;
    if (k !== 'nature') stopNature();
    if (!FX[k]) stopFx();
    cur = k;
    if (k === 'nature') startNature();
    if (FX[k]) startFx();
    if (window.TVAmbience) window.TVAmbience.sync();
    if (save) try { localStorage.setItem(KEY, k); } catch (e) {}
    return k;
  }
  // Pause while a service is taking over the screen (and whenever the page is hidden).
  function setBusy(b) {
    busy = !!b;
    bg.style.animationPlayState = busy ? 'paused' : '';
    [phA, phB].forEach((p) => (p.style.animationPlayState = busy ? 'paused' : ''));
    runFx();
    if (window.TVAmbience) window.TVAmbience.sync();
  }
  document.addEventListener('visibilitychange', runFx);

  let saved = 'light';
  try { saved = localStorage.getItem(KEY) || 'light'; } catch (e) {}
  apply(saved, false);
  return { LIST, apply, setBusy, get current() { return cur; }, get busy() { return busy; } };
})();
