// v10 可操作测试版：界面只调 ./game 的规则函数，数值全在 ./data
import './ui.css';
import { CORE_LEVELS, ERAS, FAMILY, MATERIALS, RES_INFO, RULES, rowOf, type Row } from './data';
import {
  apPerTurn, buyPlot, buyablePlots, byId, cardItems, chooseCard, economy, endTurn, fits, groupOf, levelCap, moveCost,
  mergeCap, move, nameOfB, newGame, planMerge, ownedCount, plotAp, plotQuota, previewMove, resourceRatios, rotate, rowOfB, sellBuilding, sellWarehouse,
  type Building, type State,
} from './game';

const SAVE_KEY = 'merge-civ-v10-save';
let s: State = load() ?? newGame();
let sel: number | null = null;
let toast = '';
let toastT = 0;

function load(): State | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    const x = raw ? (JSON.parse(raw) as State) : null;
    return x && Array.isArray(x.buildings) && typeof x.rs === 'number' ? x : null;
  } catch { return null; }
}
const save = () => { try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch { /* 忽略 */ } };
const say = (t: string) => { toast = t; toastT = Date.now(); };

const NAMES: Record<string, string> = { housing: '住房', food: '粮食', happy: '幸福', goods: '生活用品', ...Object.fromEntries(MATERIALS.map((k) => [k, RES_INFO[k].name])) };
const ICONS: Record<string, string> = { housing: '🏠', food: '🌾', happy: '😊', goods: '🧺', ...Object.fromEntries(MATERIALS.map((k) => [k, RES_INFO[k].icon])) };
const hue = (fam: string) => { let h = 0; for (const c of fam) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const color = (b: { fam: string; core?: boolean }) => (b.core ? '#e8c35a' : `hsl(${hue(b.fam)} 55% 68%)`);
const round = () => Math.floor((s.turn - 1) / RULES.turnsPerRound) + 1;
const fmt = (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1));
const rowText = (r: Row) => Object.entries(r).filter(([, v]) => v).map(([k, v]) => `${ICONS[k] ?? k}${v! > 0 ? '+' : ''}${fmt(v!)}`).join(' ');

// ---------- 渲染 ----------
const app = document.getElementById('app')!;
let cell = 24;
let view = { x0: 0, y0: 0, w: 0, h: 0 };

function computeView() {
  // 已有地块 + 外面一圈可买的地
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  const mark = (i: number) => { const px = i % s.wp, py = Math.floor(i / s.wp); x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py); };
  s.owned.forEach((o, i) => o && mark(i));
  buyablePlots(s).forEach(mark);
  view = { x0: x0 * s.plot, y0: y0 * s.plot, w: (x1 - x0 + 1) * s.plot, h: (y1 - y0 + 1) * s.plot };
  const room = Math.min(window.innerWidth - (window.innerWidth > 900 ? 380 : 24), window.innerHeight - 150);
  cell = Math.max(8, Math.min(36, Math.floor(room / Math.max(view.w, view.h))));
}

function render() {
  computeView();
  const e = economy(s);
  const ratios = resourceRatios(s, e);
  const cap = RULES.warehouseSlots + RULES.warehouseSlotsPerEra * (s.era - 1);
  const lights = Object.entries(ratios).map(([k, r]) => {
    const c = r >= RULES.lightGreen ? 'g' : r >= 1 ? 'y' : 'r';
    const stock = (MATERIALS as string[]).includes(k) ? ` · 存 ${fmt(s.res[k as keyof typeof s.res])}` : '';
    return `<div class="light ${c}" title="供给 ÷ 需求 = ${r.toFixed(2)}${stock}"><span>${ICONS[k]} ${NAMES[k]}</span><b>${r > 99 ? '99+' : r.toFixed(2)}</b></div>`;
  }).join('');
  const offerItems = s.offer ? s.offer.flatMap(cardItems) : [];
  const offerGroups = new Map<string, number>();
  for (const it of offerItems) { const k = `${it.fam}|${it.lvl}`; offerGroups.set(k, (offerGroups.get(k) ?? 0) + 1); }
  const offerHtml = [...offerGroups].map(([k, n]) => { const [fam, l] = k.split('|'); return `<span class="chip" style="--c:${color({ fam })}">${FAMILY[fam].icon} ${FAMILY[fam].name} Lv${l} ×${n}</span>`; }).join('');
  const b = sel != null ? byId(s, sel) : undefined;
  const selHtml = b ? selPanel(b, e.run[b.id] ?? 1) : '<p class="dim">点一下建筑看详情；拖动建筑移动（花行动力），3 座同种同级连在一起自动合并。选中后按 R 旋转。</p>';
  const tiers = s.mult < 1 ? `<span class="neg">产出 ×${s.mult}</span>` : '产出 ×1';
  app.innerHTML = `
  <header>
    <div class="era">${ERAS[s.era].name} · ${CORE_LEVELS[s.coreLevel].name} Lv${s.coreLevel}</div>
    <div class="stat"><span>大回合</span><b>${round()}</b><i>小回合 ${s.turn}</i></div>
    <div class="stat"><span>人口</span><b>${fmt(s.pop)}</b><i>安居 ${fmt(e.settled)}${CORE_LEVELS[s.coreLevel + 1] ? ` / 升级 ${fmt(CORE_LEVELS[s.coreLevel + 1].settled * (s.coreLevel + 1 >= 3 ? RULES.coreSettledMult : 1))}` : ''}</i></div>
    <div class="stat"><span>行动力</span><b>${s.ap}</b><i>每大回合 +${apPerTurn(s) * RULES.turnsPerRound}</i></div>
    <div class="stat"><span>幸福（人均）</span><b class="${e.happyRatio < 0 ? 'neg' : ''}">${e.happyRatio.toFixed(2)}</b><i>${tiers}${s.danger ? ` · <span class="neg">危险 ${s.danger}/${RULES.failTurns}</span>` : ''}</i></div>
    <div class="stat"><span>地块</span><b>${ownedCount(s)}/${plotQuota(s)}</b><i>最高合到 Lv${mergeCap(s)}</i></div>
    <div class="btns"><button id="newGame">新开一局</button></div>
  </header>
  <div class="lights">${lights}</div>
  <main>
    <div id="boardBox" style="width:${view.w * cell}px;height:${view.h * cell}px;--cell:${cell}px">${boardHtml()}</div>
    <aside>
      <section>
        <h3>发建筑 <small>本大回合还剩 ${s.picksLeft} 次</small></h3>
        <div class="offer">${offerHtml || '<span class="dim">本大回合已发完</span>'}</div>
        <button id="take" ${s.offer ? '' : 'disabled'}>领取这批建筑</button>
        <button id="end" class="primary" ${s.over ? 'disabled' : ''}>结束回合 ▶</button>
        ${s.offer ? '<p class="dim small">结束回合时没领的会自动领。</p>' : ''}
      </section>
      <section>
        <h3>仓库 <small>${s.warehouse.length}/${cap} 座 · 有空地会自动落地</small></h3>
        <div class="wh">${s.warehouse.map((it, i) => `<button class="chip" data-sell="${i}" style="--c:${color(it)}" title="点击卖出">${FAMILY[it.fam].icon} Lv${it.lvl} ✕</button>`).join('') || '<span class="dim">空</span>'}</div>
      </section>
      <section><h3>选中</h3>${selHtml}</section>
      <section class="log"><h3>记录</h3>${s.log.slice(0, 12).map((l) => `<div>${l}</div>`).join('')}</section>
    </aside>
  </main>
  ${s.over ? `<div class="over">Game Over · 坚持到第 ${round()} 个大回合 <button id="newGame2">再来一局</button></div>` : ''}
  <div id="toast" class="${toast && Date.now() - toastT < 2500 ? 'show' : ''}">${toast}</div>`;
  bind();
}

function selPanel(b: Building, run: number) {
  const g = b.core ? [] : groupOf(s, b);
  const row = rowOfB(b);
  const next = !b.core && b.lvl < mergeCap(s) ? rowOf(b.fam, b.lvl + 1) : null;
  return `<div class="selb"><b>${b.core ? '🏛️' : FAMILY[b.fam].icon} ${nameOfB(b)}</b> Lv${b.lvl}
    <div>收支：${rowText(row)}${run < 0.999 ? ` <span class="neg">开工 ${(run * 100).toFixed(0)}%</span>` : ''}</div>
    ${next ? `<div class="dim">合成 Lv${b.lvl + 1}：${rowText(next)}</div>` : ''}
    ${b.core ? '' : `<div>移动/旋转 ${moveCost(b)} 点 · 相连同种同级 ${g.length} 座</div>
    <button id="rot">旋转 (R)</button> <button id="mergeHere" ${g.length >= 3 ? '' : 'disabled'}>原地合并</button> ${RULES.allowMapSell ? '<button id="sellB">卖出</button>' : ''}`}</div>`;
}

function boardHtml() {
  const parts: string[] = [];
  const px = (v: number, o: number) => (v - o) * cell;
  s.owned.forEach((o, i) => {
    if (!o) return;
    const x = (i % s.wp) * s.plot, y = Math.floor(i / s.wp) * s.plot;
    parts.push(`<div class="plot" style="left:${px(x, view.x0)}px;top:${px(y, view.y0)}px;width:${s.plot * cell}px;height:${s.plot * cell}px"></div>`);
  });
  const full = ownedCount(s) >= plotQuota(s);
  for (const i of buyablePlots(s)) {
    const x = (i % s.wp) * s.plot, y = Math.floor(i / s.wp) * s.plot;
    parts.push(`<button class="buy" data-plot="${i}" ${full || s.ap < plotAp(s) ? 'disabled' : ''} style="left:${px(x, view.x0)}px;top:${px(y, view.y0)}px;width:${s.plot * cell}px;height:${s.plot * cell}px">${full ? '村庄中心升级后可买' : `买地 ${plotAp(s)} 点`}</button>`);
  }
  const grp = new Set(sel != null && byId(s, sel) && !byId(s, sel)!.core ? groupOf(s, byId(s, sel)!).map((b) => b.id) : []);
  const e = economy(s);
  // 连成 3 座却没合的组：标出原因（到了等级上限 / 合成后的大建筑没地方放 / 系统补的零头要玩家点一下）
  const why = new Map<number, string>();
  for (const b of s.buildings) {
    if (b.core || why.has(b.id)) continue;
    const g = groupOf(s, b);
    if (g.length < 3) continue;
    const r = b.lvl + 1 > mergeCap(s) ? `cap|已到合并上限 Lv${mergeCap(s)}，村庄中心升级或进入新时代后自动合并` : planMerge(s, b, 0, false) ? 'go|可以合并：点一下选中后按“原地合并”' : 'room|合成后的建筑放不下，腾出空地后再合';
    for (const x of g) why.set(x.id, r);
  }
  for (const b of s.buildings) {
    const big = Math.min(b.w, b.h) * cell;
    const w = why.get(b.id)?.split('|');
    const idle = (e.run[b.id] ?? 1) < 0.999;
    parts.push(`<div class="bld ${b.id === sel ? 'sel' : ''} ${grp.has(b.id) ? 'grp' : ''} ${idle ? 'idle' : ''}" data-id="${b.id}" style="left:${px(b.x, view.x0)}px;top:${px(b.y, view.y0)}px;width:${b.w * cell}px;height:${b.h * cell}px;--c:${color(b)}">
      <span class="ic" style="font-size:${Math.max(12, Math.min(big * 0.55, 44))}px">${b.core ? '🏛️' : FAMILY[b.fam].icon}</span>
      ${big >= 36 ? `<span class="nm">${nameOfB(b)}</span>` : ''}<span class="lv">${b.lvl}</span>${w ? `<span class="why ${w[0]}" title="${w[1]}">${w[0] === 'go' ? '⇪' : w[0] === 'cap' ? '⏸' : '⛶'}</span>` : ''}</div>`);
  }
  parts.push('<div id="ghost"></div>');
  return parts.join('');
}

// ---------- 交互 ----------
let drag: { id: number; sx: number; sy: number; ox: number; oy: number; moved: boolean; rot: boolean; tx: number; ty: number } | null = null;

function bind() {
  const q = (id: string) => document.getElementById(id);
  q('newGame')?.addEventListener('click', (ev) => {
    const el = ev.currentTarget as HTMLButtonElement;
    if (s.over || s.turn <= 1 || el.dataset.sure) restart();
    else { el.dataset.sure = '1'; el.textContent = '再点一次确认放弃本局'; }
  });
  q('newGame2')?.addEventListener('click', restart);
  q('take')?.addEventListener('click', () => { act(() => chooseCard(s, 0)); });
  q('end')?.addEventListener('click', () => { act(() => { const lv = s.coreLevel; endTurn(s); if (s.coreLevel > lv) say(`村庄中心升到 Lv${s.coreLevel}！`); return null; }); });
  q('rot')?.addEventListener('click', () => sel != null && act(() => rotate(s, sel!).err, true));
  q('mergeHere')?.addEventListener('click', () => { const b = sel != null ? byId(s, sel) : null; if (b) act(() => reportMerge(move(s, b.id, b.x, b.y)), true); });
  q('sellB')?.addEventListener('click', () => { if (sel == null) return; const id = sel; sel = null; act(() => sellBuilding(s, id)); });
  document.querySelectorAll<HTMLElement>('[data-sell]').forEach((el) => el.addEventListener('click', () => act(() => sellWarehouse(s, Number(el.dataset.sell)))));
  document.querySelectorAll<HTMLElement>('[data-plot]').forEach((el) => el.addEventListener('click', () => act(() => buyPlot(s, Number(el.dataset.plot)))));
  document.querySelectorAll<HTMLElement>('.bld').forEach((el) => el.addEventListener('pointerdown', (ev) => {
    const b = byId(s, Number(el.dataset.id));
    if (!b) return;
    ev.preventDefault();
    const r = el.getBoundingClientRect();
    drag = { id: b.id, sx: ev.clientX, sy: ev.clientY, ox: ev.clientX - r.left, oy: ev.clientY - r.top, moved: false, rot: false, tx: b.x, ty: b.y };
  }));
}

function restart() { s = newGame(); sel = null; say('新的一局'); save(); render(); }

function reportMerge(r: { err: string | null; merges: { from: number; to: number; refund: number }[] }) {
  if (r.err) return r.err;
  if (r.merges.length) say(r.merges.map((m) => `合并 Lv${m.from}→Lv${m.to}${m.refund ? `，返还 ${m.refund} 点` : ''}`).join('；'));
  return null;
}
function act(f: () => string | null | undefined, keepSel = false) {
  const err = f();
  if (err) say(err);
  if (!keepSel && sel != null && !byId(s, sel)) sel = null;
  if (sel != null && !byId(s, sel)) sel = null;
  save();
  render();
}

function ghostAt(ev: PointerEvent) {
  if (!drag) return;
  const b = byId(s, drag.id)!;
  const box = document.getElementById('boardBox')!.getBoundingClientRect();
  const w = drag.rot ? b.h : b.w, h = drag.rot ? b.w : b.h;
  const x = Math.round((ev.clientX - drag.ox - box.left) / cell) + view.x0;
  const y = Math.round((ev.clientY - drag.oy - box.top) / cell) + view.y0;
  drag.tx = x; drag.ty = y;
  const g = document.getElementById('ghost')!;
  const ok = fits(s, x, y, w, h, new Set([b.id]));
  const c = moveCost(b);
  let label = ok ? `${c} 点` : '放不下';
  if (ok) { const p = previewMove(s, b.id, x, y, drag.rot); if (p.err) label = p.err; else if (p.merges.length) label = `${c} 点 · 合并→Lv${p.merges[p.merges.length - 1].to}`; else if (b.lvl + 1 > mergeCap(s) && wouldTouch3(b, x, y, w, h)) label = `${c} 点 · 已到等级上限，暂不合并`; }
  Object.assign(g.style, { display: 'flex', left: `${(x - view.x0) * cell}px`, top: `${(y - view.y0) * cell}px`, width: `${w * cell}px`, height: `${h * cell}px` });
  g.className = ok && s.ap >= c ? 'ok' : 'bad';
  g.textContent = label;
  document.querySelector<HTMLElement>(`.bld[data-id="${b.id}"]`)?.classList.add('dragging');
}

function wouldTouch3(b: Building, x: number, y: number, w: number, h: number) {
  const tmp = { ...b, x, y, w, h };
  const others = s.buildings.filter((o) => o.id !== b.id);
  const copy = { ...s, buildings: [...others, tmp] } as State;
  return groupOf(copy, tmp).length >= 3;
}
window.addEventListener('pointermove', (ev) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) < 5) return;
  const b = byId(s, drag.id);
  if (!b || b.core) return;
  drag.moved = true;
  ghostAt(ev);
});
window.addEventListener('pointerup', () => {
  if (!drag) return;
  const d = drag; drag = null;
  if (!d.moved) { sel = sel === d.id ? null : d.id; render(); return; }
  sel = d.id;
  const b = byId(s, d.id)!;
  if (d.tx === b.x && d.ty === b.y && !d.rot) { render(); return; }
  act(() => reportMerge(move(s, d.id, d.tx, d.ty, d.rot)), true);
});
window.addEventListener('keydown', (ev) => {
  if (ev.key !== 'r' && ev.key !== 'R') return;
  if (drag?.moved) { drag.rot = !drag.rot; return; }
  if (sel != null) act(() => rotate(s, sel!).err, true);
});
window.addEventListener('resize', () => render());
setInterval(() => { const t = document.getElementById('toast'); if (t && Date.now() - toastT > 2500) t.classList.remove('show'); }, 500);

// 调试：控制台里可以用 window.game 看局面
(window as unknown as { game: () => State }).game = () => s;
render();
