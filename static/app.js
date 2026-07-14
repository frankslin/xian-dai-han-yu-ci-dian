'use strict';
/* ------------------------------------------------------------------ *
 * 现代汉语词典 第7版 — reader
 *
 * URL semantics (unchanged from the previous version of this app):
 *   ?page=N / ?p=N     logical/body page N  -> image index N+94
 *   ?id=N / ?image=N / ?img=N   raw image index N (front matter etc.)
 * The current page is always reflected back into the URL as ?page=
 * (once inside the body) or ?id= (front matter), via history.replaceState.
 * ------------------------------------------------------------------ */

// These two mirror data/toc.json's totalImages / bodyStartImage. Duplicated
// here (not fetched) so the very first image paints without waiting on a
// network round trip; toc.json remains the source of truth for the
// generator script and for the TOC/syllable bookmarks themselves.
const TOTAL_IMAGES = 1897;
const BODY_START_IMAGE = 95; // image index of logical/body page 1
const OFFSET = BODY_START_IMAGE - 1; // imageIndex = logicalPage + OFFSET
const DEFAULT_IMAGE = 5;

const $ = (id) => document.getElementById(id);
const assetBaseUrl = new URL('./', window.location.href);

const nav = $('nav'), controls = $('controls'), deck = $('deck'), stage = $('stage');
const slider = $('slider'), jump = $('jump'), pageProgress = $('pageProgress'), pageLabel = $('pageLabel');

let currentImageIndex = DEFAULT_IMAGE;
let animating = false;
let TOC = null; // { totalImages, bodyStartImage, sections:[{name,image}], syllables:[{name,image}] }
let barsHidden = false;

/* ---------------------------- image paths ---------------------------- */
function pad(num, size) {
  num = String(num);
  while (num.length < size) num = '0' + num;
  return num;
}
function getImagePath(index) {
  const i = parseInt(index, 10);
  const ext = (i >= 5 && i <= 1894) ? '.png' : '.jpg';
  return new URL('images/' + pad(i, 4) + ext, assetBaseUrl).href;
}
function preload(i) {
  if (i >= 1 && i <= TOTAL_IMAGES) { const im = new Image(); im.src = getImagePath(i); }
}

/* ---------------------------- URL <-> page ---------------------------- */
function parsePositiveIntegerParam(value) {
  if (!/^\d+$/.test(value || '')) return null;
  const n = Number(value);
  return (Number.isInteger(n) && n >= 1) ? n : null;
}
function getInitialImageIndexFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const rawLogical = params.get('page') || params.get('p');
  const logicalPage = parsePositiveIntegerParam(rawLogical);
  if (logicalPage !== null) {
    const mapped = logicalPage + OFFSET;
    if (mapped >= 1 && mapped <= TOTAL_IMAGES) return mapped;
  }
  const rawImage = params.get('id') || params.get('image') || params.get('img');
  const imageIndex = parsePositiveIntegerParam(rawImage);
  if (imageIndex !== null && imageIndex >= 1 && imageIndex <= TOTAL_IMAGES) return imageIndex;
  return null;
}
function syncPageIdParamInUrl() {
  if (!window.history || typeof window.history.replaceState !== 'function') return;
  const url = new URL(window.location.href);
  const logicalPage = currentImageIndex - OFFSET;
  if (logicalPage >= 1) {
    const nextPage = String(logicalPage);
    const currentPage = url.searchParams.get('page');
    if (currentPage === nextPage && !url.searchParams.has('id') && !url.searchParams.has('image') && !url.searchParams.has('img') && !url.searchParams.has('p')) return;
    url.searchParams.set('page', nextPage);
    url.searchParams.delete('p'); url.searchParams.delete('id');
    url.searchParams.delete('image'); url.searchParams.delete('img');
  } else {
    const nextId = String(currentImageIndex);
    const currentId = url.searchParams.get('id');
    if (currentId === nextId && !url.searchParams.has('page') && !url.searchParams.has('p') && !url.searchParams.has('image') && !url.searchParams.has('img')) return;
    url.searchParams.set('id', nextId);
    url.searchParams.delete('image'); url.searchParams.delete('img');
    url.searchParams.delete('page'); url.searchParams.delete('p');
  }
  window.history.replaceState(null, '', url);
}
function getImageIndexFromNumericInput(value) {
  if (!/^\d+$/.test(value)) return null;
  const logicalPage = Number(value);
  if (!Number.isInteger(logicalPage) || logicalPage < 1) return null;
  const imageIndex = logicalPage + OFFSET;
  return imageIndex <= TOTAL_IMAGES ? imageIndex : null;
}
function getPageNumberByName(name) {
  if (!TOC) return null;
  const normalized = name.trim().toLowerCase();
  const hit = TOC.syllables.find((it) => it.name === name || it.name.toLowerCase() === normalized);
  return hit ? hit.image : null;
}

/* ---------------------------- labels ---------------------------- */
function getPageLabel(index) {
  if (!TOC) return '';
  let label = '正文', best = 0;
  for (const b of TOC.sections) {
    if (b.image <= index && b.image >= best) { best = b.image; label = b.name; }
  }
  return label;
}
function getLogicalPageNumber(index) { return index - OFFSET; }
function formatDisplayPage(index) {
  return index >= BODY_START_IMAGE ? ('正文第 ' + getLogicalPageNumber(index) + ' 页') : ('前置第 ' + index + ' 页');
}
function formatShortPage(index) {
  return index >= BODY_START_IMAGE ? ('第 ' + getLogicalPageNumber(index) + ' 页') : ('前置 ' + index);
}

/* ---------------------------- viewer ---------------------------- */
function leafEl(i, extraClass) {
  const d = document.createElement('div');
  d.className = 'leaf' + (extraClass ? ' ' + extraClass : '');
  const img = document.createElement('img');
  img.decoding = 'async';
  img.src = getImagePath(i);
  img.alt = '现代汉语词典第 ' + i + ' 页';
  d.appendChild(img);
  if (extraClass) { const shade = document.createElement('div'); shade.className = 'leafshade'; d.appendChild(shade); }
  return d;
}
function updateUI() {
  pageLabel.textContent = getPageLabel(currentImageIndex) || '…';
  pageProgress.textContent = formatDisplayPage(currentImageIndex) + ' · ' + currentImageIndex + '/' + TOTAL_IMAGES;
  if (document.activeElement !== slider) slider.value = currentImageIndex;
  if (document.activeElement !== jump) jump.value = currentImageIndex;
  $('edgePrev').disabled = currentImageIndex <= 1;
  $('edgeNext').disabled = currentImageIndex >= TOTAL_IMAGES;
  $('firstBtn').disabled = currentImageIndex <= 1;
  $('lastBtn').disabled = currentImageIndex >= TOTAL_IMAGES;
  renderToc();
}
function showImage() {
  deck.innerHTML = '';
  deck.appendChild(leafEl(currentImageIndex));
  updateUI();
  syncPageIdParamInUrl();
}
function goto(i) {
  i = Math.max(1, Math.min(TOTAL_IMAGES, Math.round(i)));
  if (i === currentImageIndex) return;
  currentImageIndex = i;
  showImage();
  focusStage();
}
function flip(dir) {
  if (animating) return;
  const dest = currentImageIndex + dir;
  if (dest < 1 || dest > TOTAL_IMAGES) return;
  animating = true;
  preload(dest);
  const closingClass = dir > 0 ? 'closing' : 'closing-back';
  const openingClass = dir > 0 ? 'opening' : 'opening-back';
  deck.innerHTML = '';
  deck.appendChild(leafEl(currentImageIndex, closingClass));
  setTimeout(() => {
    deck.innerHTML = '';
    deck.appendChild(leafEl(dest, openingClass));
  }, 260);
  setTimeout(() => {
    currentImageIndex = dest;
    showImage();
    animating = false;
    preload(currentImageIndex + dir);
  }, 560);
}
function focusStage() { if (stage) stage.focus({ preventScroll: true }); }

/* ---------------------------- TOC panel ---------------------------- */
const tocListEl = $('tocList');
function renderToc() {
  if (!TOC || !tocListEl) return;
  const currentLabel = getPageLabel(currentImageIndex);
  tocListEl.innerHTML = '';
  for (const b of TOC.sections) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toc-item' + (b.name === currentLabel ? ' active' : '');
    btn.innerHTML = '<span>' + b.name + '</span><span class="tp">' + formatShortPage(b.image) + '</span>';
    btn.addEventListener('click', () => { goto(b.image); if (window.matchMedia('(max-width:640px)').matches) closePanel(); });
    tocListEl.appendChild(btn);
  }
}

/* ---------------------------- panel (目录 / 查字) ---------------------------- */
function openPanel(tab) {
  document.body.classList.add('panel-open');
  if (tab) setPanelTab(tab);
}
function closePanel() { document.body.classList.remove('panel-open'); }
function togglePanel(tab) {
  const isOpen = document.body.classList.contains('panel-open');
  const currentTab = $('panel').dataset.tab;
  if (isOpen && currentTab === tab) closePanel();
  else openPanel(tab);
}
function setPanelTab(tab) {
  $('panel').dataset.tab = tab;
  $('tabToc').classList.toggle('on', tab === 'toc');
  $('tabDict').classList.toggle('on', tab === 'dict');
  $('tocView').classList.toggle('active', tab === 'toc');
  $('dictView').classList.toggle('active', tab === 'dict');
  if (tab === 'dict') { ensureDict(); requestAnimationFrame(() => $('dictInput').focus()); }
}

/* ---------------------------- dictionary lookup ---------------------------- */
// data/dict.json rows: [headword, pinyinDisplay, plainPinyin, approxImagePage, text]
let dictData = null, dictPromise = null, dictError = false;
function ensureDict() {
  if (dictPromise) return dictPromise;
  const results = $('dictResults');
  results.innerHTML = '<p class="shint">字典数据加载中…</p>';
  dictPromise = fetch('data/dict.json').then((r) => {
    if (!r.ok) throw new Error('http ' + r.status);
    return r.json();
  }).then((d) => { dictData = d; renderDictResults($('dictInput').value); return d; })
    .catch(() => { dictError = true; renderDictResults($('dictInput').value); });
  return dictPromise;
}
function normalizeQueryPinyin(q) {
  return q.trim().toLowerCase().replace(/[1-5]$/, '').replace(/v/g, 'ü').replace(/[\s'’·]/g, '');
}
function isCjk(ch) { return /[㐀-鿿]/.test(ch); }

function quickJumpCandidate(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const numeric = getImageIndexFromNumericInput(trimmed);
  if (numeric !== null) return { image: numeric, label: '第 ' + trimmed + ' 页', exact: true };
  const named = getPageNumberByName(trimmed);
  if (named !== null) return { image: named, label: '“' + trimmed + '” 音节/目录', exact: true };
  return null;
}

let dictSeq = 0;
function renderDictResults(rawQuery) {
  const seq = ++dictSeq;
  const query = (rawQuery || '').trim();
  const results = $('dictResults');
  $('dictSearch').classList.remove('detail');
  if (!query) { results.innerHTML = '<p class="shint">输入汉字、词语或拼音（如 miao、xian4）来查找并跳转到大致页码；也可以直接输入正文页码或章节名，如 999、附录。</p>'; return; }

  const frag = [];
  const quick = quickJumpCandidate(query);
  if (quick) {
    frag.push(
      '<button class="hit" data-jump="' + quick.image + '">' +
      '<span class="hrow"><span class="hw">跳转到' + quick.label + '</span><span class="hpg">精确</span></span>' +
      '<span class="hprev">第 ' + quick.image + ' 张扫描页</span></button>'
    );
  }

  if (dictError) {
    frag.push('<p class="shint">字典数据加载失败，仅支持精确跳转。</p>');
    results.innerHTML = frag.join('');
    bindHitHandlers(results);
    return;
  }
  if (!dictData) {
    frag.push('<p class="shint">字典数据加载中…</p>');
    results.innerHTML = frag.join('');
    return;
  }

  const hasCjk = isCjk(query);
  const looksAlpha = /^[a-zA-Zü'’\s1-5]+$/.test(query);
  const pyQuery = looksAlpha ? normalizeQueryPinyin(query) : '';

  const headExact = [], headPrefix = [], pyExact = [], pyPrefix = [];
  const LIMIT_SCAN_HINT = 5000;
  for (let i = 0; i < dictData.length; i++) {
    const row = dictData[i];
    const head = row[0];
    if (hasCjk) {
      if (head === query) headExact.push(row);
      else if (head.startsWith(query)) headPrefix.push(row);
    }
    if (pyQuery) {
      const py = row[2];
      if (py === pyQuery) pyExact.push(row);
      else if (py.startsWith(pyQuery)) pyPrefix.push(row);
    }
    if (headExact.length + headPrefix.length + pyExact.length + pyPrefix.length > 300) break;
  }
  const seen = new Set();
  const ordered = [...headExact, ...pyExact, ...headPrefix, ...pyPrefix].filter((row) => {
    const key = row[0] + '' + row[1] + '' + row[3];
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  const shown = ordered.slice(0, 60);

  if (!shown.length && !quick) {
    frag.push('<p class="sempty">没有找到匹配的字词。</p>');
  } else if (shown.length) {
    frag.push('<div class="scount">共 ' + ordered.length + ' 条' + (ordered.length > shown.length ? '，显示前 ' + shown.length + ' 条' : '') + '</div>');
    for (const row of shown) {
      const [head, py, , page, text] = row;
      frag.push(
        '<button class="hit" data-head="' + esc(head) + '" data-py="' + esc(py) + '" data-page="' + page + '" data-text="' + esc(text) + '">' +
        '<span class="hrow"><span class="hw">' + esc(head) + '</span><span class="hpy">' + esc(py) + '</span><span class="hpg">约第 ' + page + ' 页</span></span>' +
        '<span class="hprev">' + esc(text) + '</span></button>'
      );
    }
  }
  if (seq !== dictSeq) return;
  results.innerHTML = frag.join('');
  bindHitHandlers(results);
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function bindHitHandlers(container) {
  container.querySelectorAll('.hit').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.jump) { goto(+btn.dataset.jump); return; }
      showDictDetail(btn.dataset.head, btn.dataset.py, +btn.dataset.page, btn.dataset.text);
    });
  });
}
function showDictDetail(head, py, page, text) {
  $('dictSearch').classList.add('detail');
  $('dictDetail').innerHTML =
    '<div class="entry">' +
    '<span class="ehw">' + esc(head) + '</span><span class="epy">' + esc(py) + '</span>' +
    '<div class="epage"><span class="badge">约第 ' + page + ' 页</span></div>' +
    '<div class="etext">' + esc(text) + '</div>' +
    '<div class="enote">页码由拼音音节位置估算得出，可能与实际印刷页码相差一两页；如未命中，可在附近翻页查找。</div>' +
    '<button class="btn egoto" id="dictGotoBtn">跳转到该页 →</button>' +
    '</div>';
  $('dictGotoBtn').addEventListener('click', () => goto(page));
  goto(page);
}
function backToDictResults() { $('dictSearch').classList.remove('detail'); }

/* ---------------------------- zoom ---------------------------- */
function openZoom() { $('zoomImg').src = getImagePath(currentImageIndex); $('zoom').classList.add('open'); }
function closeZoom() { $('zoom').classList.remove('open'); }

/* ---------------------------- help modal ---------------------------- */
function openHelp() { $('helpModal').classList.add('open'); $('helpModal').setAttribute('aria-hidden', 'false'); $('helpCloseBtn').focus(); }
function closeHelp() { $('helpModal').classList.remove('open'); $('helpModal').setAttribute('aria-hidden', 'true'); $('helpOpenBtn').focus(); }

/* ---------------------------- bars / invert ---------------------------- */
function toggleBars() {
  barsHidden = !barsHidden;
  nav.classList.toggle('hidden', barsHidden);
  controls.classList.toggle('hidden', barsHidden);
}
function applyInvert(on) {
  document.body.classList.toggle('invert', on);
  localStorage.setItem('invert', on ? '1' : '0');
}

/* ---------------------------- wire up ---------------------------- */
$('edgePrev').addEventListener('click', () => flip(-1));
$('edgeNext').addEventListener('click', () => flip(1));
$('firstBtn').addEventListener('click', () => goto(1));
$('lastBtn').addEventListener('click', () => goto(TOTAL_IMAGES));
$('prevBtn').addEventListener('click', () => flip(-1));
$('nextBtn').addEventListener('click', () => flip(1));
$('zoomBtn').addEventListener('click', openZoom);
$('zoomClose').addEventListener('click', closeZoom);
slider.addEventListener('input', () => { pageProgress.textContent = formatDisplayPage(+slider.value) + ' · ' + slider.value + '/' + TOTAL_IMAGES; });
slider.addEventListener('change', () => goto(+slider.value));
jump.addEventListener('change', () => goto(+jump.value));
jump.addEventListener('keydown', (e) => { if (e.key === 'Enter') { goto(+jump.value); jump.blur(); } });
jump.addEventListener('focus', () => jump.select());

$('tabToc').addEventListener('click', () => setPanelTab('toc'));
$('tabDict').addEventListener('click', () => setPanelTab('dict'));
$('tocOpenBtn').addEventListener('click', () => openPanel('toc'));
$('dictOpenBtn').addEventListener('click', () => togglePanel('dict'));
$('panelClose').addEventListener('click', closePanel);
$('panelScrim').addEventListener('click', closePanel);
$('dictBackBtn').addEventListener('click', backToDictResults);

let dictDebounce = null;
$('dictInput').addEventListener('input', () => {
  clearTimeout(dictDebounce);
  const v = $('dictInput').value;
  dictDebounce = setTimeout(() => renderDictResults(v), 90);
});
$('dictInput').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const quick = quickJumpCandidate($('dictInput').value);
  if (quick) goto(quick.image);
});

$('helpOpenBtn').addEventListener('click', openHelp);
$('helpCloseBtn').addEventListener('click', closeHelp);
$('helpBackdrop').addEventListener('click', closeHelp);
$('invertBtn').addEventListener('click', () => applyInvert(!document.body.classList.contains('invert')));

$('tapzones').addEventListener('click', (e) => {
  const z = e.target.dataset.z;
  if (z === 'prev') flip(-1);
  else if (z === 'next') flip(1);
  else toggleBars();
});

document.addEventListener('keydown', (e) => {
  if ($('helpModal').classList.contains('open')) {
    if (e.key === 'Escape') { e.preventDefault(); closeHelp(); }
    return;
  }
  if (e.key === 'Escape') {
    if (e.target === $('dictInput') && document.body.classList.contains('panel-open')) { closePanel(); $('dictInput').blur(); return; }
    if ($('zoom').classList.contains('open')) { closeZoom(); return; }
    if (document.body.classList.contains('panel-open')) { closePanel(); return; }
    return;
  }
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') { e.preventDefault(); flip(1); }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); flip(-1); }
});

// touch swipe
let sx = 0, sy = 0, st = 0;
stage.addEventListener('touchstart', (e) => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; st = e.timeStamp; }, { passive: true });
stage.addEventListener('touchend', (e) => {
  const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
  if (e.timeStamp - st < 600 && Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.4) flip(dx < 0 ? 1 : -1);
}, { passive: true });

// trackpad / mouse horizontal swipe
let wheelAccum = 0, wheelLock = false, wheelT = null;
window.addEventListener('wheel', (e) => {
  if ($('zoom').classList.contains('open')) return;
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
  e.preventDefault();
  if (wheelLock) return;
  wheelAccum += e.deltaX;
  if (Math.abs(wheelAccum) >= 60) {
    flip(wheelAccum > 0 ? 1 : -1);
    wheelLock = true; wheelAccum = 0;
    clearTimeout(wheelT); wheelT = setTimeout(() => { wheelLock = false; }, 420);
  } else {
    clearTimeout(wheelT); wheelT = setTimeout(() => { wheelAccum = 0; }, 160);
  }
}, { passive: false });

/* ---------------------------- init ---------------------------- */
const initial = getInitialImageIndexFromUrl();
if (initial !== null) currentImageIndex = initial;
showImage();

if (localStorage.getItem('invert') === '1' ||
  (localStorage.getItem('invert') === null && matchMedia('(prefers-color-scheme: dark)').matches)) {
  applyInvert(true);
}

fetch('data/toc.json').then((r) => r.json()).then((d) => {
  TOC = d;
  slider.max = TOTAL_IMAGES; jump.max = TOTAL_IMAGES;
  updateUI();
}).catch(() => { pageLabel.textContent = '现代汉语词典'; });
