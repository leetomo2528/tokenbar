'use strict';

const api = window.tokenbar;

const el = (id) => document.getElementById(id);

function fmt(n) {
  return (n || 0).toLocaleString('ko-KR');
}

function compact(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
  return String(n);
}

function money(v) {
  return '$' + (v || 0).toFixed(v < 1 ? 3 : 2);
}

function totalOf(b) {
  if (!b) return 0;
  return b.input + b.output + b.cacheWrite + b.cacheRead;
}

function timeAgo(ts) {
  if (!ts) return '기록 없음';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '방금 전';
  if (min < 60) return min + '분 전';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + '시간 전';
  return Math.floor(hr / 24) + '일 전';
}

function clock(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return hh + ':' + mm;
}

const SEGMENTS = [
  { key: 'input', label: '입력', color: 'var(--in)' },
  { key: 'output', label: '출력', color: 'var(--out)' },
  { key: 'cacheWrite', label: '캐시 쓰기', color: 'var(--cw)' },
  { key: 'cacheRead', label: '캐시 읽기', color: 'var(--cr)' },
];

function renderBreakdown(b) {
  const host = el('breakdown');
  const total = totalOf(b);
  if (!total) {
    host.innerHTML = '<div class="model-empty">윈도우 내 기록 없음</div>';
    return;
  }

  const track = SEGMENTS.map((s) => {
    const pct = ((b[s.key] || 0) / total) * 100;
    return `<div class="bar-seg" style="width:${pct}%;background:${s.color}"></div>`;
  }).join('');

  const legend = SEGMENTS.map((s) => `
    <div class="legend-item">
      <span class="swatch" style="background:${s.color}"></span>
      <span>${s.label}</span>
      <span class="legend-val">${compact(b[s.key])}</span>
    </div>`).join('');

  host.innerHTML = `<div class="bar-track">${track}</div><div class="legend">${legend}</div>`;
}

function renderModels(byModel) {
  const host = el('models');
  const names = Object.keys(byModel || {});
  if (!names.length) {
    host.innerHTML = '<div class="model-empty">—</div>';
    return;
  }
  names.sort((a, b) => totalOf(byModel[b]) - totalOf(byModel[a]));
  host.innerHTML = names.map((name) => {
    const short = name.replace(/^claude-/, '').replace(/-\d{8}$/, '');
    return `
      <div class="model">
        <span class="model-name" title="${name}">${short}</span>
        <span class="model-val">${compact(totalOf(byModel[name]))}</span>
      </div>`;
  }).join('');
}

function render(snap) {
  if (!snap) return;

  const empty = el('empty');
  if (!snap.ok || !snap.hasData) {
    empty.hidden = false;
    el('empty-path').textContent = snap.root || '';
    return;
  }
  empty.hidden = true;

  const w = snap.window;

  el('window-tokens').textContent = compact(totalOf(w));
  el('window-calls').textContent = fmt(w.calls) + '회';
  el('window-cost').textContent = '약 ' + money(w.cost);

  el('window-range').textContent =
    clock(snap.windowStart) + ' – 현재 (' + snap.windowHours + '시간)';

  renderBreakdown(w);

  el('today-tokens').textContent = compact(totalOf(snap.today));
  el('today-cost').textContent = '약 ' + money(snap.today.cost);
  el('week-tokens').textContent = compact(totalOf(snap.week));
  el('week-cost').textContent = '약 ' + money(snap.week.cost);

  renderModels(snap.byModel);

  el('last-activity').textContent = '마지막 호출 ' + timeAgo(snap.lastActivity);
}

el('quit').addEventListener('click', () => api.close());

api.onUpdate(render);
api.getUsage().then(render);
