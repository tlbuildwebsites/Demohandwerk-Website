/* =========================================================
   Demohandwerk – Seiten-Skript
   ========================================================= */
(function () {
  'use strict';
  document.documentElement.classList.remove('no-js');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Hintergrund-Videos: bei reduzierter Bewegung anhalten ---------- */
  document.querySelectorAll('video[autoplay]').forEach((v) => {
    if (reduceMotion) { v.removeAttribute('autoplay'); v.pause(); }
  });

  /* ---------- Navigation ---------- */
  const header = document.querySelector('.site-header');
  const toggle = document.querySelector('.nav-toggle');
  const nav = document.getElementById('hauptnavigation');
  function closeNav() {
    document.body.classList.remove('nav-open');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  }
  if (toggle && nav) {
    toggle.addEventListener('click', () => {
      const open = !document.body.classList.contains('nav-open');
      document.body.classList.toggle('nav-open', open);
      toggle.setAttribute('aria-expanded', String(open));
    });
    nav.addEventListener('click', (e) => { if (e.target.closest('a')) closeNav(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNav(); });
    window.matchMedia('(min-width: 1081px)').addEventListener('change', (m) => { if (m.matches) closeNav(); });
  }
  function onScrollHeader() { if (header) header.classList.toggle('is-scrolled', window.scrollY > 10); }
  window.addEventListener('scroll', onScrollHeader, { passive: true });
  onScrollHeader();

  /* ---------- Einblenden ---------- */
  const reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !reduceMotion) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); } });
    }, { rootMargin: '0px 0px -8% 0px' });
    reveals.forEach((el) => io.observe(el));
  } else reveals.forEach((el) => el.classList.add('is-in'));

  /* ---------- Zahlen, die hochzählen ---------- */
  const counters = document.querySelectorAll('[data-count]');
  function runCounter(el) {
    const end = parseInt(el.getAttribute('data-count'), 10);
    if (reduceMotion) { el.textContent = end.toLocaleString('de-CH'); return; }
    const dur = 1600, t0 = performance.now();
    function step(now) {
      const t = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      el.textContent = Math.round(end * e).toLocaleString('de-CH');
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  if ('IntersectionObserver' in window) {
    const co = new IntersectionObserver((entries) => {
      entries.forEach((en) => { if (en.isIntersecting) { runCounter(en.target); co.unobserve(en.target); } });
    }, { threshold: 0.6 });
    counters.forEach((el) => { el.textContent = '0'; co.observe(el); });
  } else counters.forEach(runCounter);

  /* ---------- Zeitstrahl ---------- */
  document.querySelectorAll('.timeline').forEach((tl) => {
    if (!('IntersectionObserver' in window) || reduceMotion) { tl.classList.add('is-in'); return; }
    const o = new IntersectionObserver((en) => { if (en[0].isIntersecting) { tl.classList.add('is-in'); o.disconnect(); } }, { threshold: 0.35 });
    o.observe(tl);
  });

  /* ---------- Vorher-Nachher-Regler ---------- */
  document.querySelectorAll('.ba').forEach((ba) => {
    const range = ba.querySelector('input[type="range"]');
    if (!range) return;
    const set = (v) => { ba.style.setProperty('--pos', v + '%'); range.setAttribute('aria-valuetext', Math.round(v) + ' % Vorher sichtbar'); };
    range.addEventListener('input', () => set(range.value));
    set(range.value);
  });

  /* ---------- Formular (Demo) ---------- */
  document.querySelectorAll('form[data-demo]').forEach((form) => {
    const success = form.parentElement.querySelector('.form-success');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!form.checkValidity()) { form.reportValidity(); return; }
      if (success) {
        success.classList.add('is-visible');
        success.setAttribute('tabindex', '-1');
        success.focus();
        success.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      }
      form.reset();
      form.querySelectorAll('.upload__list').forEach((l) => { l.textContent = 'Noch keine Dateien gewählt'; });
    });
  });
  document.querySelectorAll('.upload').forEach((up) => {
    const input = up.querySelector('input[type="file"]');
    const list = up.querySelector('.upload__list');
    if (!input || !list) return;
    input.addEventListener('change', () => {
      const names = Array.from(input.files || []).map((f) => f.name);
      list.textContent = names.length ? names.length + ' Datei(en): ' + names.join(', ') : 'Noch keine Dateien gewählt';
    });
    ['dragenter', 'dragover'].forEach((ev) => up.addEventListener(ev, () => up.classList.add('is-drag')));
    ['dragleave', 'drop'].forEach((ev) => up.addEventListener(ev, () => up.classList.remove('is-drag')));
  });

  /* ---------- Jahr im Footer ---------- */
  document.querySelectorAll('[data-year]').forEach((el) => { el.textContent = new Date().getFullYear(); });

  /* ---------- Scroll-Geschichte ---------- */
  const story = document.querySelector('.story');
  if (!story) return;
  const track = story.querySelector('.story__track');
  const stage = story.querySelector('.story__stage');
  const canvas = story.querySelector('canvas');
  const cards = Array.from(story.querySelectorAll('.step-card'));
  const checkItems = Array.from(story.querySelectorAll('.checklist li'));
  const badge = story.querySelector('[data-stage-label]');
  const counterEl = story.querySelector('[data-stage-count]');
  const checkCount = story.querySelector('[data-check-count]');
  const bar = story.querySelector('.checklist__bar i');
  const names = cards.map((c) => c.getAttribute('data-name'));

  function goStatic() { story.classList.add('is-static'); }
  if (reduceMotion || !window.DemoHouse || !window.THREE || !window.DH_TEX) { goStatic(); return; }

  // Leistungsstufe grob abschätzen – wird zur Laufzeit bei Bedarf weiter gesenkt
  const mobileMQ = window.matchMedia('(max-width: 900px)');
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4;
  let tier = 'medium';
  if (mobileMQ.matches) tier = cores >= 8 && mem >= 6 ? 'medium' : 'low';
  else if (cores <= 4 || mem <= 4) tier = 'low';
  try { const saved = sessionStorage.getItem('dh-tier'); if (saved && saved !== 'high') tier = saved; } catch (e) { /* egal */ }

  let house = null;
  try {
    house = window.DemoHouse.create(canvas, {
      tier,
      // Platz für die Textkarte links und die Checkliste rechts lassen
      viewShift: (w) => (mobileMQ.matches ? 0 : -Math.min(110, w * 0.07)),
      distance: mobileMQ.matches ? 1.12 : 1.06,
      onFrame: updateUI,
      onReady: () => story.classList.add('is-ready'),
      onTier: (t) => { try { sessionStorage.setItem('dh-tier', t); } catch (e) { /* egal */ } }
    });
  } catch (err) { house = null; }
  if (!house) { goStatic(); return; }

  /* Scroll → Fortschritt
     Jede Etappe hat 175 % (Handy 150 %) Bildschirmhöhe Scrollweg.
     In den ersten 72 % wird gebaut, danach «rastet» das Bild ein und bleibt stehen. */
  const BUILD = 0.72;
  let start = 0, end = 1;
  function measure() {
    const top = track.getBoundingClientRect().top + window.scrollY;
    const header = document.querySelector('.site-header');
    const hh = header ? header.offsetHeight : 0;
    start = Math.max(0, top - hh - window.innerHeight);
    end = top + track.offsetHeight - window.innerHeight;
  }
  function rawProgress() { return Math.max(0, Math.min(8, (window.scrollY - start) / Math.max(1, end - start) * 8)); }
  function mapProgress(raw) {
    if (raw >= 8) return 8;
    const k = Math.floor(raw), f = raw - k;
    if (k === 7) return 7 + f; // letzte Etappe: Kamerafahrt läuft über die ganze Strecke
    return k + Math.min(1, f / BUILD) * 0.999;
  }
  function scrollForProgress(p) {
    const k = Math.floor(p), f = p - k;
    const raw = k + (k === 7 ? f : f * BUILD);
    return start + (raw / 8) * (end - start);
  }

  // UI folgt dem geglätteten Fortschritt aus der 3D-Szene
  let shown = -2, lastCount = -1;
  function updateUI(p) {
    story.classList.toggle('is-started', p > 0.25);
    const stageIdx = Math.min(7, Math.floor(p));
    if (badge) badge.textContent = names[stageIdx] || '';
    if (counterEl) counterEl.textContent = String(stageIdx + 1).padStart(2, '0');
    // Text erst, wenn die Etappe zur Hälfte gebaut ist
    const cardIdx = p < 0.5 ? -1 : Math.min(7, Math.floor(p - 0.5));
    if (cardIdx !== shown) {
      cards.forEach((c, i) => {
        const vis = i === cardIdx;
        if (c.classList.contains('is-visible') && !vis) {
          c.classList.add('is-leaving');
          setTimeout(() => c.classList.remove('is-leaving'), 600);
        }
        c.classList.toggle('is-visible', vis);
        c.setAttribute('aria-hidden', vis ? 'false' : 'true');
        c.querySelectorAll('a').forEach((a) => { a.tabIndex = vis ? 0 : -1; });
      });
      shown = cardIdx;
    }
    let done = 0;
    checkItems.forEach((li, i) => {
      const isDone = p >= i + 0.97;
      if (isDone) done++;
      li.classList.toggle('is-done', isDone);
      li.classList.toggle('is-current', !isDone && i === stageIdx);
    });
    if (checkCount && done !== lastCount) { checkCount.textContent = done + '/8'; lastCount = done; }
    if (bar) bar.style.width = (p / 8 * 100).toFixed(1) + '%';
  }

  function onScroll() { house.setProgress(mapProgress(rawProgress())); }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => { measure(); house.resize(); onScroll(); });
  window.addEventListener('load', () => { measure(); onScroll(); });

  // Klick in der Checkliste: zur fertig gebauten Etappe springen
  checkItems.forEach((li, i) => {
    const btn = li.querySelector('button');
    if (!btn) return;
    btn.addEventListener('click', () => {
      measure();
      window.scrollTo({ top: scrollForProgress(i + 0.99), behavior: 'smooth' });
    });
  });

  // Rendern nur, wenn die Geschichte sichtbar ist (spart Akku)
  if ('IntersectionObserver' in window) {
    const vis = new IntersectionObserver((en) => {
      if (en[0].isIntersecting) { measure(); house.resize(); onScroll(); house.start(); } else house.stop();
    }, { rootMargin: '300px 0px' });
    vis.observe(story);
  } else house.start();
  measure();
  onScroll();
  updateUI(0);
})();
