const $ = (s, root = document) => root.querySelector(s);

function parseCsv(csvText) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const c = csvText[i];
    const next = csvText[i + 1];

    if (inQuotes) {
      if (c === '"' && next === '"') {
        cur += '"';
        i++;
        continue;
      }
      if (c === '"') {
        inQuotes = false;
        continue;
      }
      cur += c;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === ',') {
      row.push(cur);
      cur = '';
      continue;
    }
    if (c === '\n') {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
      continue;
    }
    if (c === '\r') continue;

    cur += c;
  }

  row.push(cur);
  rows.push(row);
  return rows.map((r) => r.map((v) => v.trim())).filter((r) => r.some(Boolean));
}

function yenFormat(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (s.includes('¥')) return s;
  const num = Number(String(s).replace(/[^\d.]/g, ''));
  if (!Number.isFinite(num) || num <= 0) return s;
  return `¥${Math.round(num).toLocaleString('ja-JP')}`;
}

async function setupPriceFromSheet() {
  const grid = $('[data-price-grid]');
  const note = $('[data-price-note]');
  if (!grid) return;

  const sheetId = '1-U1K8W2xqMlGOb2bEZUyRbNWg810XaNkfGoTuuTd_XY';
  const sheetName = 'Price';
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;

  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const csvText = await res.text();
    const rows = parseCsv(csvText);
    if (rows.length < 2) throw new Error('no rows');

    const header = rows[0].map((h) => h.toLowerCase());
    const idxName =
      header.findIndex((h) => h.includes('プラン') || h.includes('name') || h.includes('plan')) ?? -1;
    const idxPrice =
      header.findIndex((h) => h.includes('価格') || h.includes('料金') || h.includes('price')) ?? -1;
    const idxDesc =
      header.findIndex((h) => h.includes('説明') || h.includes('detail') || h.includes('desc')) ?? -1;

    const get = (r, i, fallback) => (i >= 0 && i < r.length ? r[i] : fallback);

    const plans = rows
      .slice(1)
      .map((r) => ({
        name: get(r, idxName, r[0] ?? '').trim(),
        price: get(r, idxPrice, r[1] ?? '').trim(),
        desc: get(r, idxDesc, r[2] ?? '').trim(),
      }))
      .filter((p) => p.name || p.price || p.desc)
      .slice(0, 3);

    if (plans.length === 0) throw new Error('no plans');

    grid.innerHTML = plans
      .map(
        (p) => `
          <div class="price-card">
            <h3>${escapeHtml(p.name || 'プラン')}</h3>
            <p class="price">${escapeHtml(yenFormat(p.price) || '—')}</p>
            <p class="price-desc">${escapeHtml(p.desc || '')}</p>
          </div>
        `,
      )
      .join('');

    if (note) note.textContent = '※ 料金はスプレッドシートの内容を反映しています。';
  } catch {
    if (note) {
      note.textContent =
        '※ 料金を自動取得できませんでした。スプレッドシートを「リンクを知っている全員が閲覧可」または「ウェブに公開」にしてください。';
    }
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function setYear() {
  const el = $('[data-year]');
  if (el) el.textContent = String(new Date().getFullYear());
}

function setupHeaderElevate() {
  const header = $('.header');
  if (!header) return;

  let ticking = false;
  const update = () => {
    ticking = false;
    header.dataset.elevate = window.scrollY > 8 ? 'true' : 'false';
  };

  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(update);
  };

  update();
  window.addEventListener('scroll', onScroll, { passive: true });
}

function setupMobileNav() {
  const toggle = $('.nav__toggle');
  const menu = $('#navMenu');
  if (!toggle || !menu) return;

  const setOpen = (open) => {
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    menu.dataset.open = open ? 'true' : 'false';
  };

  const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';

  setOpen(false);

  toggle.addEventListener('click', () => setOpen(!isOpen()));

  menu.addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest('a') : null;
    if (!a) return;
    if (a.getAttribute('href')?.startsWith('#')) setOpen(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (isOpen()) setOpen(false);
  });

  document.addEventListener('click', (e) => {
    if (!isOpen()) return;
    const t = e.target;
    if (!(t instanceof Node)) return;
    if (menu.contains(t) || toggle.contains(t)) return;
    setOpen(false);
  });
}

function setupDemoForm() {
  const form = $('.form');
  if (!(form instanceof HTMLFormElement)) return;

  form.addEventListener('submit', (e) => {
    e.preventDefault();

    const lines = [
      'これはデモのフォームです（送信はされません）。',
      '',
      '実運用では、フォーム送信や問い合わせ先に差し替えてください。',
    ];

    window.alert(lines.join('\n'));
  });
}

function setupScrollReveal() {
  const els = Array.from(document.querySelectorAll('.reveal'));
  if (!els.length) return;

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    els.forEach((el) => el.classList.add('is-visible'));
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.1 },
  );

  els.forEach((el) => io.observe(el));
}

function setupStickyBooking() {
  const btn = document.querySelector('[data-sticky-booking]');
  if (!btn) return;

  const booking = document.querySelector('#booking');
  if (!booking) return;

  let bookingVisible = false;
  const io = new IntersectionObserver(
    (entries) => {
      bookingVisible = entries.some((e) => e.isIntersecting);
      update();
    },
    { threshold: 0.15 },
  );
  io.observe(booking);

  const update = () => {
    const shouldShow = window.scrollY > 120 && !bookingVisible;
    btn.classList.toggle('sticky-booking--visible', shouldShow);
  };

  window.addEventListener('scroll', update, { passive: true });
  update();
}

function setupGallerySwiper() {
  if (typeof Swiper === 'undefined') return;
  const el = document.querySelector('[data-gallery-swiper]');
  if (!el) return;

  const paginationEl = el.querySelector('.swiper-pagination');

  // eslint-disable-next-line no-new
  new Swiper(el, {
    loop: true,
    slidesPerView: 1,
    spaceBetween: 16,
    centeredSlides: true,
    speed: 600,
    autoplay: {
      delay: 4000,
      disableOnInteraction: false,
    },
    pagination: paginationEl
      ? { el: paginationEl, clickable: true }
      : false,
    breakpoints: {
      768: {
        slidesPerView: 1.2,
      },
      1024: {
        slidesPerView: 1.5,
      },
    },
  });
}

setYear();
setupHeaderElevate();
setupMobileNav();
setupDemoForm();
setupPriceFromSheet();
setupScrollReveal();
setupStickyBooking();
setupGallerySwiper();
