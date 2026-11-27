import './style.css';
import { DEF, ERAS, FOOTPRINTS, MERGE_COUNT, PLOT_SIZES, RES_INFO, RULES, SHOP, familyOf, type Res, type ResKey } from './data';
import {
  apPerTurn, auraTargets, buyablePlots, buyPlot, byId, canAfford, cardItems, cellOwned, chooseCard, coreLevel, defOf, sell, sellRefund,
  endTurn, groupOf, maxLevel, moveCost, multOf, newGame, nextCore, ownedBounds, ownedCount, plotAp, plotCost, plotQuota,
  previewCard, previewMove, reroll, resolveTurn, rotate, move, summon, upgradeCore, type Card, type MoveResult, type State,
} from './game';

const SAVE_KEY = 'merge-civ-save-v9';
let state: State = load() ?? newGame(8);
let toast = '';
const BOARD_PX = () => Math.min(window.innerHeight * 0.74, window.innerWidth * 0.9 - 70, 660);

function load(): State | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    const s = raw ? (JSON.parse(raw) as State) : null;
    return s && Array.isArray(s.seen) ? s : null;
  } catch {
    return null;
  }
}
function save() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
  } catch {
    /* 存档失败不影响游戏 */
  }
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const fmt = (n: number) => (Math.abs(n) >= 10 || Number.isInteger(n) ? Math.round(n).toString() : n.toFixed(1));
const fmtRes = (c: Res) => (Object.keys(c) as ResKey[]).map((k) => `${RES_INFO[k].icon}${fmt(c[k]!)}`).join(' ');
const fmtSigned = (n: number) => (n > 0 ? `+${fmt(n)}` : fmt(n));

document.querySelector('#app')!.innerHTML = `
  <header id="top"></header>
  <main>
    <section id="boardWrap">
      <div id="boardBox"><div id="board"></div><div id="mergePreview"></div><div id="plotBtns"></div></div>
      <div class="under"><div id="trash">💰 拖到这里卖出（返还格数÷4 行动力）</div><div id="plotCost"></div></div>
    </section>
    <aside id="side">
      <div id="coreCard"></div>
      <div id="cards"></div>
      <div id="apBar"></div>
      <div id="checks"></div>
      <button id="nextTurn">结束回合 ▶ <small>(空格)</small></button>
      <h3>花资源召唤基础建筑</h3>
      <div id="shop"></div>
      <h3>城市日志</h3>
      <ol id="log"></ol>
      <div class="row">
        <select id="sizeSel">${PLOT_SIZES.map((n) => `<option value="${n}">单块地 ${n}×${n}</option>`).join('')}</select>
        <button id="restart" class="ghost">重新开始</button>
      </div>
      <details id="help"><summary>怎么玩</summary>
        <p><b>目标</b>：升级城市核心。村庄中心 → 部落议事棚 → 氏族长屋 → 城邦议事厅（进入青铜时代，要先炼出青铜）→ 卫城（进入铁器时代，原型通关）。核心每升一级，可以多买一块地。</p>
        <p><b>选卡</b>：每回合 1 次 3 选 1。卡会标出实际能放下几座。“补缺口”通常是你最缺的。</p>
        <p><b>3 合 1</b>：把同种建筑挪到一起，挨着连成 3 个（直线、直角、T 形、十字都行）就自动合成高一级；一次最多合 9 个，合满 9 个直接升 2 级。新建筑会盖在你最后放下的位置，尽量挨着同种建筑。合成后如果又和旁边凑成 3 个，会连锁再合。</p>
        <p><b>行动力</b>：移动、旋转花费 = 建筑格数。合并返还一次移动，每多合 1 个再返还一次，连锁那一步返还翻倍。卖出建筑返还格数 ÷ 4（不足 4 格不返还）。</p>
        <p><b>买地</b>：除了资源，还要花行动力：第 2 块地 5 点，之后每块多 2 点。行动力不能跨回合攒，买地那回合要少挪建筑。</p>
        <p><b>评估</b>：原料可以用库存补；库存也不够，相关建筑停工。<b>只有断粮饿死人才扣心</b>，扣光 3 颗心游戏结束；扣心后下回合多给选卡。</p>
        <p>空房不耗维护；人口增长受口粮余量限制；工人优先派去种粮。</p>
      </details>
    </aside>
  </main>
  <div id="tip"></div>
  <div id="toast"></div>
`;

const tagName: Record<string, string> = { support: '补缺口', pressure: '扩张', neutral: '普通' };

function render() {
  const preview = resolveTurn(state, true);

  // 顶栏
  const resHtml = (Object.keys(RES_INFO) as ResKey[])
    .filter((k) => RES_INFO[k].era <= state.era || state.res[k] > 0 || preview.demand[k] > 0)
    .map((k) => {
      const n = preview.net[k];
      const cls = n < 0 ? 'neg' : n > 0 ? 'pos' : '';
      return `<div class="res"><span>${RES_INFO[k].icon} ${RES_INFO[k].name}</span><b>${Math.floor(state.res[k])}</b><i class="${cls}">${fmtSigned(n)}/回合</i></div>`;
    })
    .join('');
  const workerCls = preview.workersNeeded > state.pop ? 'neg' : '';
  const popCls = preview.popChange < 0 ? 'neg' : preview.popChange > 0 ? 'pos' : '';
  const used = state.buildings.reduce((a, b) => a + b.w * b.h, 0);
  $('#top').innerHTML = `
    <div class="era">${ERAS[state.era].name} · 第 ${state.turn} 回合</div>
    <div class="res"><span>👥 人口 / 住房</span><b>${state.pop} / ${preview.housing}</b><i class="${popCls}">${fmtSigned(preview.popChange)}/回合</i></div>
    <div class="res"><span>🛠️ 岗位</span><b class="${workerCls}">${preview.workersNeeded}</b><i>可用工人 ${state.pop}</i></div>
    <div class="res"><span>🗺️ 土地</span><b>${used} / ${ownedCount(state) * state.plot * state.plot}</b><i>${ownedCount(state)}/${plotQuota(state)} 块</i></div>
    ${resHtml}`;

  // 棋盘
  const bd = ownedBounds(state);
  const cellPx = Math.min(72, BOARD_PX() / Math.max(bd.w, bd.h));
  const board = $('#board');
  board.style.gridTemplateColumns = `repeat(${bd.w}, ${cellPx}px)`;
  board.style.gridTemplateRows = `repeat(${bd.h}, ${cellPx}px)`;
  board.style.setProperty('--cell', `${cellPx}px`);
  let cells = '';
  for (let y = bd.y0; y < bd.y0 + bd.h; y++)
    for (let x = bd.x0; x < bd.x0 + bd.w; x++) {
      if (!cellOwned(state, x, y)) continue;
      cells += `<div class="cell" style="grid-area:${y - bd.y0 + 1}/${x - bd.x0 + 1}"></div>`;
    }
  const plotsHtml = state.owned
    .map((o, i) => {
      if (!o) return '';
      const px = (i % state.wp) - bd.px0, py = Math.floor(i / state.wp) - bd.py0;
      return `<div class="plotEdge" style="grid-area:${py * state.plot + 1}/${px * state.plot + 1}/span ${state.plot}/span ${state.plot}"></div>`;
    })
    .join('');
  const blds = state.buildings
    .map((b) => {
      const d = defOf(b);
      const s = preview.status[b.id];
      const bad = s === 'noWorkers' || s === 'noInput' || s === 'housingBroken';
      const m = preview.mult[b.id] ?? 1;
      const badge = m > 1.01 ? '<span class="bonus">★</span>' : m < 0.99 ? '<span class="bonus low">½</span>' : '';
      return `<div class="bld ${bad ? 'idle' : ''} ${familyOf(b.def).core ? 'core' : ''}" data-b="${b.id}"
        style="grid-area:${b.y - bd.y0 + 1}/${b.x - bd.x0 + 1}/span ${b.h}/span ${b.w};--c:${familyOf(b.def).color};--s:${Math.min(b.w, b.h)}">
        <span class="ic">${d.icon}</span><span class="nm">${d.name}</span>
        <span class="lv">${d.lvl}</span>${badge}
        ${bad ? `<span class="warn">${s === 'noWorkers' ? '人' : '料'}</span>` : ''}</div>`;
    })
    .join('');
  board.innerHTML = cells + plotsHtml + blds;

  // 买地按钮（显示地块主题）
  const cost = plotCost(state);
  const quotaOk = ownedCount(state) < plotQuota(state);
  const pap = plotAp(state);
  const afford = canAfford(state, cost) && quotaOk && state.ap >= pap;
  const plotPx = cellPx * state.plot;
  $('#plotBtns').innerHTML = buyablePlots(state)
    .map((i) => {
      const px = (i % state.wp) - bd.px0, py = Math.floor(i / state.wp) - bd.py0;
      const T = 34;
      let style: string;
      if (px < 0) style = `left:${-T - 4}px;top:${py * plotPx}px;width:${T}px;height:${plotPx}px`;
      else if (px >= bd.pw) style = `left:${bd.w * cellPx + 4}px;top:${py * plotPx}px;width:${T}px;height:${plotPx}px`;
      else if (py < 0) style = `left:${px * plotPx}px;top:${-T - 4}px;width:${plotPx}px;height:${T}px`;
      else if (py >= bd.ph) style = `left:${px * plotPx}px;top:${bd.h * cellPx + 4}px;width:${plotPx}px;height:${T}px`;
      else style = `left:${px * plotPx}px;top:${py * plotPx}px;width:${plotPx}px;height:${plotPx}px`;
      return `<button class="plotBuy" data-plot="${i}" style="${style}" ${afford ? '' : 'disabled'} title="买下这块地">＋</button>`;
    })
    .join('');
  $('#plotCost').innerHTML = quotaOk
    ? `买下一块地：${costHtml(cost)}${pap ? ` + ⚡${pap}` : ''}`
    : `<small>地块已满 ${ownedCount(state)}/${plotQuota(state)}，升级核心可以多买一块</small>`;

  // 城市核心
  const nc = nextCore(state);
  const core = defOf(state.buildings.find((b) => familyOf(b.def).core)!);
  $('#coreCard').innerHTML = state.over
    ? `<div class="wonder lost"><div class="wi">💀</div><div><b>游戏结束</b><p>断粮 ${state.fails} 次，坚持到第 ${state.turn - 1} 回合，到达${ERAS[state.era].name}。</p><button id="restart2">再来一局</button></div></div>`
    : state.won
      ? `<div class="wonder done"><div class="wi">🏆</div><div><b>卫城建成，原型通关！</b><p>用了 ${state.turn} 回合。可以继续玩，或者换种打法再来。</p></div></div>`
      : `<div class="wonder"><div class="wi">${core.icon}</div><div><b>城市核心：${core.name}（${core.lvl} 级）</b>
         <p>可拥有 ${plotQuota(state)} 块地 · 建筑最高 ${maxLevel(state)} 级</p>
         ${nc ? `<p>下一级：${nc.def.icon} ${nc.def.name}${nc.era > state.era ? `，进入<b>${ERAS[nc.era].name}</b>` : ''}</p>
         ${nc.goal ? `<p class="goal">${nc.goal}</p>` : ''}
         <p class="cost">${costHtml(nc.cost)}</p>
         <button id="coreBtn" ${canAfford(state, nc.cost) ? '' : 'disabled'}>升级核心</button>` : ''}</div></div>`;

  // 选卡
  $('#cards').innerHTML =
    state.over || !state.offer
      ? `<div class="cardsHead"><span>本回合选卡已用完</span></div>`
      : `<div class="cardsHead"><span>选一张卡（本回合还剩 <b>${state.picks}</b> 次）</span><button id="rerollBtn" ${state.rerolls > 0 || state.ap >= RULES.apReroll ? '' : 'disabled'}>🔄 重摇${state.rerolls > 0 ? `（免费 ${state.rerolls}）` : `（${RULES.apReroll} 行动力）`}</button><small>没选的回合结束时自动选“随机分配”</small></div>
         <div class="cardGrid">${state.offer.map((c, i) => cardHtml(c, i)).join('')}</div>`;

  // 行动力
  const maxAp = apPerTurn(state);
  const pips = Array.from({ length: Math.max(maxAp, state.ap) }, (_, i) => `<i class="${i < state.ap ? 'on' : ''}"></i>`).join('');
  $('#apBar').innerHTML = `<div class="apHead"><b>⚡ 行动力 ${state.ap}</b><small>移动/旋转花费 = 格数；合并返还一次移动，每多合 1 个再返还一次；卖出返还格数 ÷ 4</small></div><div class="pips">${pips}</div>`;
  $('#nextTurn').classList.toggle('urgent', state.ap <= 0 && !state.over);

  // 评估预览
  const hearts = Array.from({ length: RULES.maxFails }, (_, i) => (i < state.fails ? '💔' : '❤️')).join('');
  $('#checks').innerHTML = `<div class="ckHead"><span>回合末预览 <span class="hearts" title="断粮 ${RULES.maxFails} 次游戏结束">${hearts}</span></span><small>原料可以吃库存；库存也不够的建筑会停工。只有断粮会扣心。</small></div>
    ${preview.checks.map((c) => `<div class="ck ${!c.ok ? (c.survival ? 'bad' : 'stall') : c.warn ? 'warn' : 'ok'}"><span>${!c.ok ? (c.survival ? '💀' : '⛔') : c.warn ? '⚠️' : '✓'} ${c.label}</span><b>${c.detail}</b></div>`).join('')}
    ${preview.workersNeeded > state.pop ? `<div class="ck stall"><span>🛠️ 工人</span><b>缺 ${preview.workersNeeded - state.pop} 人，部分建筑没人干活</b></div>` : ''}`;

  // 商店
  $('#shop').innerHTML = Object.entries(SHOP)
    .map(([id, c]) => `<button class="buy" data-shop="${id}" style="--c:${familyOf(id).color}" ${canAfford(state, c) ? '' : 'disabled'}>${DEF[id].icon} ${DEF[id].name}<small>${costHtml(c)}</small></button>`)
    .join('');

  $('#log').innerHTML = state.log.slice(0, 30).map((l) => `<li>${l}</li>`).join('');
  $<HTMLSelectElement>('#sizeSel').value = String(state.plot);
  $('#toast').textContent = toast;
  $('#toast').classList.toggle('show', !!toast);
}

function sumEffect(items: string[]) {
  const prod: Res = {}, cons: Res = {};
  let workers = 0, housing = 0, cells = 0;
  for (const id of items) {
    const d = DEF[id];
    for (const [k, v] of Object.entries(d.produce)) prod[k as ResKey] = (prod[k as ResKey] ?? 0) + v!;
    for (const [k, v] of Object.entries(d.consume)) cons[k as ResKey] = (cons[k as ResKey] ?? 0) + v!;
    workers += d.workers;
    housing += d.housing ?? 0;
    const [w, h] = FOOTPRINTS[d.lvl - 1];
    cells += w * h;
  }
  return { prod, cons, workers, housing, cells };
}

function cardHtml(c: Card, i: number) {
  const items = cardItems(c);
  const e = sumEffect(items);
  const fit = previewCard(state, c);
  const lines = [
    Object.keys(e.prod).length ? `产出 ${fmtRes(e.prod)}` : '',
    e.housing ? `住房 +${e.housing}` : '',
    Object.keys(e.cons).length ? `投入 ${fmtRes(e.cons)}` : '',
    e.workers ? `工人 ${e.workers}` : '',
  ].filter(Boolean);
  const fitLine = `<div class="fit ${fit.fit < fit.total ? 'short' : ''}">${fit.fit < fit.total ? `⚠️ 只能放下 ${fit.fit}/${fit.total} 座` : `能放下全部 ${fit.total} 座`} · 占 ${e.cells} 格</div>`;
  let title: string, color = '#6b5d4b';
  if (c.kind === 'bundle') {
    const d = DEF[c.def];
    const [w, h] = FOOTPRINTS[d.lvl - 1];
    const fam = familyOf(c.def);
    color = fam.color;
    title = `<span class="tag t-${c.tag}">${tagName[c.tag]}</span><div class="ct"><span class="big">${d.icon}</span><b>${d.name} ×${c.count}</b><small>${d.lvl} 级 · ${w}×${h}${d.aura ? ` · 周围 ${d.aura.range} 格 +${d.aura.bonus * 100}%` : ''}</small></div>`;
  } else {
    const counts = new Map<string, number>();
    for (const id of items) counts.set(`${DEF[id].icon}${DEF[id].name}`, (counts.get(`${DEF[id].icon}${DEF[id].name}`) ?? 0) + 1);
    title = `<span class="tag t-random">碰运气</span><div class="ct"><span class="big">🎲</span><b>随机分配</b><small>${[...counts].map(([k, n]) => `${k}×${n}`).join('、')}</small></div>`;
  }
  return `<button class="card" data-card="${i}" style="--c:${color}">${title}<div class="ce">${lines.join('<br>')}</div>${fitLine}</button>`;
}

function costHtml(c: Res) {
  return (Object.keys(c) as ResKey[]).map((k) => `<span class="${state.res[k] >= (c[k] ?? 0) ? '' : 'neg'}">${RES_INFO[k].icon}${fmt(c[k]!)}</span>`).join(' ');
}

let toastTimer = 0;
function flash(msg: string, kind: 'bad' | 'good' = 'bad') {
  toast = msg;
  $('#toast').className = kind;
  $('#toast').textContent = toast;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast = '';
    $('#toast').classList.remove('show');
  }, 2400);
}
function commit() {
  save();
  render();
}

// ---------- 按钮 ----------

document.addEventListener('click', (e) => {
  const el = e.target as HTMLElement;
  const shop = el.closest<HTMLElement>('[data-shop]');
  if (shop) {
    const err = summon(state, shop.dataset.shop!);
    if (err) flash(err);
    return commit();
  }
  if (el.closest('[data-card]')) {
    const res = chooseCard(state, Number(el.closest<HTMLElement>('[data-card]')!.dataset.card));
    if (typeof res === 'string') flash(res);
    else if (res.lost) flash(`有 ${res.lost} 个建筑没地方放，丢掉了`);
    return commit();
  }
  if (el.closest('#rerollBtn')) {
    const err = reroll(state);
    if (err) flash(err);
    return commit();
  }
  if (el.closest('#coreBtn')) {
    const era = state.era;
    const err = upgradeCore(state);
    commit();
    if (err) flash(err);
    else flash(state.era > era ? `进入${ERAS[state.era].name}！` : '城市核心升级了，可以多买一块地', 'good');
    return;
  }
  if (el.closest('#restart2')) {
    state = newGame(Number($<HTMLSelectElement>('#sizeSel').value));
    return commit();
  }
  if (el.closest('[data-plot]')) {
    const err = buyPlot(state, Number(el.closest<HTMLElement>('[data-plot]')!.dataset.plot));
    if (err) flash(err);
    return commit();
  }
  if (el.closest('#nextTurn')) {
    if (state.over) return flash('游戏已结束，请重新开始');
    const rep = endTurn(state);
    commit();
    if (state.over) flash('💀 游戏结束');
    else if (!rep.passed) flash(`💀 断粮，${rep.starved} 人饿死（${state.fails}/${RULES.maxFails}），下回合多给选卡`);
    else {
      const stalls = rep.checks.filter((c) => !c.ok).map((c) => c.label);
      flash(stalls.length ? `✅ 粮食够吃，但${stalls.join('、')}不够，有建筑停工` : '✅ 本回合运转正常', stalls.length ? 'bad' : 'good');
    }
    return;
  }
  const restart = el.closest<HTMLElement>('#restart');
  if (restart) {
    if (restart.dataset.confirm) {
      state = newGame(Number($<HTMLSelectElement>('#sizeSel').value));
      commit();
    } else {
      restart.dataset.confirm = '1';
      restart.textContent = '再点一次确认';
      setTimeout(() => {
        delete restart.dataset.confirm;
        restart.textContent = '重新开始';
      }, 2500);
    }
  }
});

let hovered = 0;
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLSelectElement)) {
    e.preventDefault();
    $<HTMLButtonElement>('#nextTurn').click();
  } else if (e.key === 'r' || e.key === 'R') {
    if (drag) {
      const b = byId(state, drag.id)!;
      drag.rot = !drag.rot;
      const [w, h] = drag.rot ? [b.h, b.w] : [b.w, b.h];
      sizeGhost(w, h);
      [drag.gx, drag.gy] = [0, 0];
    } else if (hovered) tryRotate(hovered);
  }
});

/** 移动/旋转之后：报错，或者报合并结果 */
function report(r: MoveResult) {
  if (r.err) return flash(r.err);
  if (!r.merges.length) return;
  const last = r.merges[r.merges.length - 1];
  const ap = r.merges.reduce((a, m) => a + m.refund, 0);
  const n = r.merges[0].used.length;
  flash(`${n > 3 ? `${n} 合 1！` : ''}合成 ${last.next.icon} ${last.next.name}${r.merges.length > 1 ? `，连锁 ×${r.merges.length}` : ''}${ap ? `，返还 ⚡${ap}` : ''}`);
  warnAfterMerge(byId(state, state.buildings[state.buildings.length - 1].id)!.id);
}

function tryRotate(id: number) {
  const b = byId(state, id);
  if (!b || b.w === b.h) return;
  report(rotate(state, id));
  commit();
}

// ---------- 拖拽 ----------

let drag: { id: number; ghost: HTMLElement; gx: number; gy: number; rot: boolean; sx: number; sy: number } | null = null;
let lastTap = { id: 0, t: 0 };

function pitch() {
  const r = $('#board').getBoundingClientRect();
  const bd = ownedBounds(state);
  return { r, p: r.width / bd.w, x0: bd.x0, y0: bd.y0 };
}
function sizeGhost(w: number, h: number) {
  if (!drag) return;
  const { p } = pitch();
  drag.ghost.style.width = `${w * p - 6}px`;
  drag.ghost.style.height = `${h * p - 6}px`;
}

document.addEventListener('pointerdown', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-b]');
  if (!el || e.button !== 0 || state.over) return;
  e.preventDefault();
  const id = Number(el.dataset.b);
  const b = byId(state, id)!;
  const { r, p, x0, y0 } = pitch();
  const gx = Math.min(b.w - 1, Math.max(0, Math.floor((e.clientX - r.left) / p) + x0 - b.x));
  const gy = Math.min(b.h - 1, Math.max(0, Math.floor((e.clientY - r.top) / p) + y0 - b.y));
  const ghost = el.cloneNode(true) as HTMLElement;
  ghost.classList.add('ghost');
  ghost.style.setProperty('--cell', $('#board').style.getPropertyValue('--cell'));
  document.body.appendChild(ghost);
  drag = { id, ghost, gx, gy, rot: false, sx: e.clientX, sy: e.clientY };
  sizeGhost(b.w, b.h);
  moveGhost(e);
  el.classList.add('dragging');
  hideTip();
  lastPreviewKey = '';
  if (!familyOf(b.def).core)
    for (const o of state.buildings.filter((x) => x.def === b.def && x.id !== b.id)) document.querySelector(`[data-b="${o.id}"]`)?.classList.add('target');
});

function moveGhost(e: PointerEvent) {
  if (!drag) return;
  const { p } = pitch();
  drag.ghost.style.left = `${e.clientX - (drag.gx + 0.5) * p + 3}px`;
  drag.ghost.style.top = `${e.clientY - (drag.gy + 0.5) * p + 3}px`;
}

/** 拖动时：预览放下后会合并哪些建筑、新建筑落在哪 */
let lastPreviewKey = '';
function dropCell(e: PointerEvent, d: { gx: number; gy: number; rot: boolean }) {
  const { r, p, x0, y0 } = pitch();
  const x = Math.floor((e.clientX - r.left) / p) + x0 - (d.rot ? d.gy : d.gx);
  const y = Math.floor((e.clientY - r.top) / p) + y0 - (d.rot ? d.gx : d.gy);
  return { x, y };
}
function showMergePreview(e: PointerEvent) {
  const box = $('#mergePreview');
  const clear = () => {
    box.style.display = 'none';
    document.querySelectorAll('.willMerge').forEach((el) => el.classList.remove('willMerge'));
  };
  const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
  if (!drag || !under?.closest('#board')) return clear();
  const c = dropCell(e, drag);
  const key = `${drag.id}:${c.x}:${c.y}:${drag.rot}`;
  if (key === lastPreviewKey) return;
  lastPreviewKey = key;
  clear();
  const pv = previewMove(state, drag.id, c.x, c.y, drag.rot);
  if (pv.err || !pv.merges.length) return;
  const first = pv.merges[0];
  for (const u of first.used) document.querySelector(`[data-b="${u.id}"]`)?.classList.add('willMerge');
  const last = pv.merges[pv.merges.length - 1];
  const ap = pv.merges.reduce((a, m) => a + m.refund, 0);
  const { p, x0, y0 } = pitch();
  box.className = 'ok';
  box.style.cssText = `display:block;left:${(last.spot.x - x0) * p}px;top:${(last.spot.y - y0) * p}px;width:${last.spot.w * p}px;height:${last.spot.h * p}px`;
  box.innerHTML = `<span>${first.used.length} 合 1 → ${last.next.icon} ${last.next.name}${pv.merges.length > 1 ? `<br>连锁 ×${pv.merges.length}` : ''}${ap ? `<br>返还 ⚡${ap}` : ''}</span>`;
}

document.addEventListener('pointermove', (e) => {
  if (drag) {
    moveGhost(e);
    return showMergePreview(e);
  }
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-b]');
  if (b) {
    hovered = Number(b.dataset.b);
    showTip(hovered, e);
  } else {
    hovered = 0;
    hideTip();
  }
});

document.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const { id, ghost, gx, gy, rot, sx, sy } = drag;
  ghost.remove();
  drag = null;
  $('#mergePreview').style.display = 'none';
  if (!rot && Math.hypot(e.clientX - sx, e.clientY - sy) < 6) {
    const now = performance.now();
    if (lastTap.id === id && now - lastTap.t < 400) {
      lastTap = { id: 0, t: 0 };
      return tryRotate(id);
    }
    lastTap = { id, t: now };
    return render();
  }
  const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
  document.querySelectorAll('.willMerge').forEach((el) => el.classList.remove('willMerge'));
  if (under?.closest('#trash')) {
    const b = byId(state, id)!;
    const refund = sellRefund(b);
    const err = sell(state, id);
    if (err) flash(err);
    else flash(`卖掉了 ${defOf(b).name}${refund ? `，返还 ⚡${refund}` : '（不足 4 格，不返还）'}`);
  } else if (under?.closest('#board')) {
    const c = dropCell(e, { gx, gy, rot });
    report(move(state, id, c.x, c.y, rot));
  }
  commit();
});

function warnAfterMerge(id: number) {
  const b = byId(state, id)!;
  const d = defOf(b);
  const s = resolveTurn(state, true).status[id];
  if (s === 'noInput' || s === 'housingBroken') flash(`注意：${d.name} 每回合要投入 ${fmtRes(d.consume)}，现在不够，会停工`);
  else if (s === 'noWorkers') flash(`注意：${d.name} 需要 ${d.workers} 个工人，人手不够`);
}

// ---------- 提示框 ----------

const tip = $('#tip');
function showTip(id: number, e: PointerEvent) {
  const b = byId(state, id);
  if (!b) return hideTip();
  const d = defOf(b);
  const fam = familyOf(b.def);
  const s = resolveTurn(state, true).status[id];
  const stText: Record<string, string> = {
    ok: '✅ 正常生产', noWorkers: '⚠️ 人手不够，没开工', noInput: '⛔ 原料不够，停工', housing: '✅ 正常居住', housingBroken: '⚠️ 维护不足，只能住一半人',
  };
  const m = multOf(state, b);
  const nextId = (DEF as Record<string, (typeof DEF)[string]>)[Object.keys(DEF).find((k) => DEF[k].from === b.def && DEF[k].family !== 'core') ?? ''];
  const count = groupOf(state, b).length;
  let nextLine = fam.core ? '用右侧“升级核心”升级' : '这条链在原型里到顶了';
  if (!fam.core && nextId) {
    const [w, h] = FOOTPRINTS[nextId.lvl - 1];
    nextLine = nextId.lvl <= maxLevel(state) ? `合成 → ${nextId.icon} ${nextId.name}（${w}×${h}），挨着的同种 ${count}/${MERGE_COUNT}（直线、直角都行，最多 9 个，9 个直接升 2 级）` : `${ERAS[Math.min(3, nextId.lvl - 2)].name}才能合成 → ${nextId.icon} ${nextId.name}`;
  }
  const aura = d.aura ? `🐴 周围 ${d.aura.range} 格的生产建筑 +${d.aura.bonus * 100}%（多个驿站不叠加），现在覆盖 ${auraTargets(state, b).length} 座` : '';
  const lines = [
    `<b>${d.icon} ${d.name}</b> <small>${fam.name} · ${d.lvl} 级 · ${b.w}×${b.h}</small>`,
    Object.keys(d.produce).length ? `产出：${fmtRes(d.produce)}${Math.abs(m - 1) > 0.01 ? ` × ${m.toFixed(2)}` : ''}` : '',
    d.housing ? `住房：${d.housing} 人` : '',
    Object.keys(d.consume).length ? `每回合投入：${fmtRes(d.consume)}${d.housing ? '（按入住率收，空房不收）' : ''}` : '',
    d.workers ? `工人：${d.workers}` : '',
    aura,
    s ? stText[s] : '',
    nextLine,
    `⚡ 移动/旋转 ${moveCost(b)} 点${fam.core ? '' : ` · 卖出返还 ${sellRefund(b)} 点`}`,
  ].filter(Boolean);
  tip.innerHTML = lines.join('<br>');
  tip.style.display = 'block';
  tip.style.left = `${Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8)}px`;
  tip.style.top = `${Math.min(e.clientY + 14, window.innerHeight - tip.offsetHeight - 8)}px`;
}
function hideTip() {
  tip.style.display = 'none';
}

void coreLevel;
render();
window.addEventListener('resize', () => render());
