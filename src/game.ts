// 纯逻辑，不碰 DOM。界面只读 state、调用这里的函数。
import {
  CORE_UPGRADES, DEF, DEFS, ERAS, FOOTPRINTS, LAST_ERA, MERGE_COUNT, NEXT, PLOT_COSTS, RES_INFO, RULES, SHOP,
  WORLD_PLOTS, familyOf, type Def, type Res, type ResKey,
} from './data';

export interface Building {
  id: number;
  def: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Status = 'ok' | 'noWorkers' | 'noInput' | 'housing' | 'housingBroken';
export type SpawnKind = 'support' | 'pressure' | 'neutral';
export type Card =
  | { kind: 'bundle'; tag: SpawnKind; def: string; count: number }
  | { kind: 'random'; items: string[] };

export interface State {
  plot: number;
  wp: number;
  size: number;
  owned: boolean[];
  era: number;
  turn: number;
  res: Record<ResKey, number>;
  pop: number;
  buildings: Building[];
  nextId: number;
  seen: string[]; // 曾经拥有过的建筑（用于永久解锁）
  won: boolean;
  over: boolean;
  fails: number;
  picks: number;
  rerolls: number; // 本回合剩余的免费重摇
  offer: Card[] | null;
  ap: number;
  log: string[];
  stats: { combos: number; sold: number; apRefund: number; apMove: number; apSell: number; apWasted: number; apPlot: number; rerolls: number; merges: number; skippedMerges: number; nonSupportPicks: number; plotsBought: number; warnedBeforeFail: number; lost: number };
}

export interface Check {
  key: ResKey;
  label: string;
  survival: boolean; // 生存类（粮食）：欠供会扣心
  ok: boolean; // 结算后不欠供
  warn: boolean; // 产出 < 消耗，在吃库存
  detail: string;
}

export interface Report {
  status: Record<number, Status>;
  mult: Record<number, number>;
  net: Record<ResKey, number>;
  produced: Record<ResKey, number>;
  demand: Record<ResKey, number>;
  housing: number;
  workersNeeded: number;
  popChange: number;
  starved: number;
  events: string[];
  checks: Check[];
  passed: boolean;
}

export const RES_KEYS = Object.keys(RES_INFO) as ResKey[];
const emptyRes = (): Record<ResKey, number> => Object.fromEntries(RES_KEYS.map((k) => [k, 0])) as Record<ResKey, number>;
const round1 = (n: number) => Math.round(n * 100) / 100;
export const defOf = (b: Building): Def => DEF[b.def];

// ---------- 随机与地图 ----------

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export const plotOf = (state: State, x: number, y: number) => Math.floor(y / state.plot) * state.wp + Math.floor(x / state.plot);
export const cellOwned = (state: State, x: number, y: number) =>
  x >= 0 && y >= 0 && x < state.size && y < state.size && state.owned[plotOf(state, x, y)];
export const coreOf = (state: State) => state.buildings.find((b) => familyOf(b.def).core)!;
export const coreLevel = (state: State) => defOf(coreOf(state)).lvl;
export const maxLevel = (state: State) => ERAS[state.era].maxLevel;

export function newGame(plot = 8, seed = Date.now()): State {
  const r = rng(seed);
  const wp = WORLD_PLOTS;
  const size = plot * wp;
  const mid = Math.floor(wp / 2);
  const owned = Array.from({ length: wp * wp }, () => false);
  owned[mid * wp + mid] = true;
  const state: State = {
    plot, wp, size, owned,
    era: 1,
    turn: 1,
    res: { ...emptyRes(), ...RULES.startRes } as Record<ResKey, number>,
    pop: RULES.startPop,
    buildings: [],
    nextId: 1,
    seen: [],
    won: false,
    over: false,
    fails: 0,
    picks: RULES.picksPerTurn,
    rerolls: RULES.rerollsPerTurn,
    offer: null,
    ap: RULES.apPerTurn,
    log: [`部落在一块 ${plot}×${plot} 的土地上点燃了村庄中心。`],
    stats: { combos: 0, sold: 0, apRefund: 0, apMove: 0, apSell: 0, apWasted: 0, apPlot: 0, rerolls: 0, merges: 0, skippedMerges: 0, nonSupportPicks: 0, plotsBought: 0, warnedBeforeFail: 0, lost: 0 },
  };
  const c = Math.floor(plot / 2) - 1;
  addBuilding(state, 'c1', mid * plot + c, mid * plot + c, 1, 1);
  for (const id of ['f1', 'f1', 'w1', 's1']) place(state, id, r);
  state.offer = genOffer(state, r);
  return state;
}

// ---------- 地块扩张 ----------

/** 可拥有的地块总数 = 核心等级（村庄中心 1 块，每升一级 +1） */
export const plotQuota = (state: State) => coreLevel(state);
export const ownedCount = (state: State) => state.owned.filter(Boolean).length;

export function plotCost(state: State): Res {
  const n = ownedCount(state) - 1;
  const scale = (state.plot / 8) ** 2;
  const base = PLOT_COSTS[Math.min(n, PLOT_COSTS.length - 1)];
  const extra = Math.max(0, n - (PLOT_COSTS.length - 1));
  const out: Res = {};
  for (const k of Object.keys(base) as ResKey[]) out[k] = Math.ceil(base[k]! * scale * 2 ** extra);
  return out;
}

/** 买地要花的行动力：第 2 块 apPlotBase，之后每块多 apPlotStep */
export const plotAp = (state: State) =>
  RULES.apPlotBase < 0 ? apPerTurn(state) : RULES.apPlotBase + RULES.apPlotStep * Math.max(0, ownedCount(state) - 1);

export function buyablePlots(state: State): number[] {
  const out: number[] = [];
  for (let i = 0; i < state.owned.length; i++) {
    if (state.owned[i]) continue;
    const px = i % state.wp, py = Math.floor(i / state.wp);
    const adj = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
      const nx = px + dx, ny = py + dy;
      return nx >= 0 && ny >= 0 && nx < state.wp && ny < state.wp && state.owned[ny * state.wp + nx];
    });
    if (adj) out.push(i);
  }
  return out;
}

export function buyPlot(state: State, i: number): string | null {
  if (!buyablePlots(state).includes(i)) return '只能买和现有土地相邻的地块';
  if (ownedCount(state) >= plotQuota(state)) return `城市核心升级后才能买更多地（现在最多 ${plotQuota(state)} 块）`;
  const cost = plotCost(state);
  if (!canAfford(state, cost)) return '资源不够';
  const ap = plotAp(state);
  if (state.ap < ap) return `行动力不够（买这块地要 ${ap} 点）`;
  pay(state, cost);
  state.ap -= ap;
  state.stats.apPlot += ap;
  state.owned[i] = true;
  state.stats.plotsBought++;
  state.log.unshift(`第 ${state.turn} 回合：买下一块地（共 ${ownedCount(state)} 块）`);
  return null;
}

export function ownedBounds(state: State) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  state.owned.forEach((o, i) => {
    if (!o) return;
    const px = i % state.wp, py = Math.floor(i / state.wp);
    x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
  });
  return { px0: x0, py0: y0, pw: x1 - x0 + 1, ph: y1 - y0 + 1, x0: x0 * state.plot, y0: y0 * state.plot, w: (x1 - x0 + 1) * state.plot, h: (y1 - y0 + 1) * state.plot };
}

// ---------- 占地 ----------

export function occupancy(state: State): Int32Array {
  const occ = new Int32Array(state.size * state.size);
  for (const b of state.buildings)
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) occ[y * state.size + x] = b.id;
  return occ;
}

export function fits(state: State, x: number, y: number, w: number, h: number, ignore: Set<number> = new Set(), occ = occupancy(state)): boolean {
  if (x < 0 || y < 0 || x + w > state.size || y + h > state.size) return false;
  for (let yy = y; yy < y + h; yy++)
    for (let xx = x; xx < x + w; xx++) {
      if (!cellOwned(state, xx, yy)) return false;
      const id = occ[yy * state.size + xx];
      if (id && !ignore.has(id)) return false;
    }
  return true;
}

export type Spot = { x: number; y: number; w: number; h: number };

/** 找能放下 w×h（可旋转）的位置。prefer 给了就按它打分（越小越好），否则随机 */
export function findSpot(state: State, w: number, h: number, ignore: Set<number>, prefer: ((s: Spot) => number) | null, r: () => number): Spot | null {
  const occ = occupancy(state);
  const bd = ownedBounds(state);
  let best: Spot | null = null;
  let bestScore = Infinity;
  const shapes = w === h ? [[w, h]] : [[w, h], [h, w]];
  for (const [ww, hh] of shapes)
    for (let y = bd.y0; y <= bd.y0 + bd.h - hh; y++)
      for (let x = bd.x0; x <= bd.x0 + bd.w - ww; x++)
        if (fits(state, x, y, ww, hh, ignore, occ)) {
          const s = { x, y, w: ww, h: hh };
          const score = prefer ? prefer(s) : r();
          if (score < bestScore) {
            bestScore = score;
            best = s;
          }
        }
  return best;
}

function addBuilding(state: State, def: string, x: number, y: number, w: number, h: number): Building {
  const b: Building = { id: state.nextId++, def, x, y, w, h };
  state.buildings.push(b);
  if (!state.seen.includes(def)) state.seen.push(def);
  return b;
}

/** 随机找空地放 */
function place(state: State, def: string, r: () => number = Math.random): Building | null {
  const [w, h] = FOOTPRINTS[DEF[def].lvl - 1];
  const spot = findSpot(state, w, h, new Set(), null, r);
  if (!spot) return null;
  return addBuilding(state, def, spot.x, spot.y, spot.w, spot.h);
}

export const byId = (state: State, id: number) => state.buildings.find((b) => b.id === id);

// ---------- 光环 ----------

function rectDist(a: Spot, b: Spot) {
  const dx = Math.max(0, a.x - (b.x + b.w - 1), b.x - (a.x + a.w - 1));
  const dy = Math.max(0, a.y - (b.y + b.h - 1), b.y - (a.y + a.h - 1));
  return Math.max(dx, dy);
}
/** 生产建筑吃到的驿站光环（多个驿站不叠加，取最高） */
export function auraBonus(state: State, b: Building): number {
  const d = defOf(b);
  if (d.aura || d.housing || !Object.keys(d.produce).length) return 0;
  let best = 0;
  for (const p of state.buildings) {
    const a = defOf(p).aura;
    if (a && rectDist(p, b) <= a.range) best = Math.max(best, a.bonus);
  }
  return best;
}
export function auraTargets(state: State, post: Building): Building[] {
  const a = defOf(post).aura;
  if (!a) return [];
  return state.buildings.filter((b) => b !== post && auraBonus(state, b) > 0 && rectDist(post, b) <= a.range);
}
export const multOf = (state: State, b: Building) => 1 + auraBonus(state, b);

// ---------- 召唤 / 合并 / 移动 ----------

export function canAfford(state: State, cost: Res): boolean {
  return (Object.keys(cost) as ResKey[]).every((k) => state.res[k] >= (cost[k] ?? 0) - 1e-9);
}
function pay(state: State, cost: Res) {
  for (const k of Object.keys(cost) as ResKey[]) state.res[k] = round1(state.res[k] - (cost[k] ?? 0));
}

export function summon(state: State, def: string): string | null {
  const cost = SHOP[def];
  if (!cost) return '不能直接召唤';
  if (!canAfford(state, cost)) return '资源不够';
  const [w, h] = FOOTPRINTS[DEF[def].lvl - 1];
  if (!findSpot(state, w, h, new Set(), null, Math.random)) return '没有空地了，先合并腾出空间';
  pay(state, cost);
  place(state, def);
  return null;
}

export function mates(state: State, target: Building, exclude: Set<number>): Building[] {
  return state.buildings.filter((b) => b.def === target.def && !exclude.has(b.id)).sort((a, b) => rectDist(a, target) - rectDist(b, target));
}

export const mergeTarget = (b: Building): Def | null => (NEXT[b.def] ? DEF[NEXT[b.def]] : null);
/** 移动/旋转花费 = 占地格数 */
export const cellsOf = (b: { w: number; h: number }) => b.w * b.h;
export const moveCost = (b: Building) => cellsOf(b);
/** 卖出返还：格数的 1/4（不足 4 格返还 0） */
export const sellRefund = (b: Building) => Math.floor(cellsOf(b) / 4);
export const apPerTurn = (state: State) => RULES.apPerTurn + (state.era - 1) * RULES.apPerEra;

/** 两个矩形是否有一条边贴着 */
export function touching(a: Spot, b: Spot): boolean {
  const ox = a.x < b.x + b.w && b.x < a.x + a.w;
  const oy = a.y < b.y + b.h && b.y < a.y + a.h;
  return (ox && (a.y + a.h === b.y || b.y + b.h === a.y)) || (oy && (a.x + a.w === b.x || b.x + b.w === a.x));
}

/** 和 b 连在一起（边相邻、同一种）的建筑，按离 b 的远近（广度优先）排序，含 b 自己 */
export function groupOf(state: State, b: Building): Building[] {
  const same = state.buildings.filter((x) => x.def === b.def);
  const out = [b];
  const seen = new Set([b.id]);
  for (let i = 0; i < out.length; i++)
    for (const o of same)
      if (!seen.has(o.id) && touching(out[i], o)) {
        seen.add(o.id);
        out.push(o);
      }
  return out;
}

export type AutoMerge = { used: Building[]; from: Def; next: Def; spot: Spot; refund: number; combo: number };

/** 连锁奖励：第 combo 次连锁（0 = 第一次合并）的返还倍数 */
export function comboMult(combo: number): number {
  if (combo <= 0) return 1;
  if (RULES.comboMode === 'double') return 2;
  if (RULES.comboMode === 'ramp') return 1 + combo;
  return 1;
}

function lexLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/** 新建筑放哪：优先压住 anchor（最后放下的建筑）的格子、挨着同种建筑；放不下就从 anchor 往外一圈圈顺时针找 */
export function placeMerged(state: State, anchor: Spot, next: Def, ignore: Set<number>): Spot | null {
  const [w0, h0] = FOOTPRINTS[next.lvl - 1];
  const shapes = w0 === h0 ? [[w0, h0]] : [[w0, h0], [h0, w0]];
  const occ = occupancy(state);
  const bd = ownedBounds(state);
  const same = state.buildings.filter((b) => b.def === next.id && !ignore.has(b.id));
  const cx = anchor.x + anchor.w / 2, cy = anchor.y + anchor.h / 2;
  let best: Spot | null = null;
  let bestKey: number[] | null = null;
  for (const [w, h] of shapes)
    for (let y = bd.y0; y <= bd.y0 + bd.h - h; y++)
      for (let x = bd.x0; x <= bd.x0 + bd.w - w; x++) {
        if (!fits(state, x, y, w, h, ignore, occ)) continue;
        const s = { x, y, w, h };
        const ox = Math.max(0, Math.min(x + w, anchor.x + anchor.w) - Math.max(x, anchor.x));
        const oy = Math.max(0, Math.min(y + h, anchor.y + anchor.h) - Math.max(y, anchor.y));
        const ring = ox * oy > 0 ? 0 : rectDist(s, anchor);
        const adj = same.filter((o) => touching(s, o)).length;
        // 顺时针：从正上方开始按角度
        const ang = (Math.atan2(x + w / 2 - cx, -(y + h / 2 - cy)) + 2 * Math.PI) % (2 * Math.PI);
        const key = [ring, -(ox * oy), -adj, ang];
        if (!bestKey || lexLess(key, bestKey)) {
          best = s;
          bestKey = key;
        }
      }
  return best;
}

/** 以 anchor（刚放下的建筑）为起点，看能不能自动合并 */
export function planAutoMerge(state: State, anchor: Building, combo = 0): AutoMerge | null {
  if (familyOf(anchor.def).core || !NEXT[anchor.def]) return null;
  const group = groupOf(state, anchor);
  if (group.length < MERGE_COUNT) return null;
  const used = group.slice(0, RULES.maxMergeGroup);
  const from = defOf(anchor);
  let next = DEF[NEXT[anchor.def]];
  if (next.lvl > maxLevel(state)) return null;
  // 一次合 9 个直接升 2 级（有下下级、且本时代允许）
  if (used.length >= RULES.maxMergeGroup && NEXT[next.id] && DEF[NEXT[next.id]].lvl <= maxLevel(state)) next = DEF[NEXT[next.id]];
  const ignore = new Set(used.map((u) => u.id));
  const spot = placeMerged(state, anchor, next, ignore);
  if (!spot) return null;
  const refund = cellsOf(anchor) * (1 + used.length - MERGE_COUNT) * comboMult(combo);
  return { used, from, next, spot, refund, combo };
}

/** 执行自动合并（含连锁），返回每一步 */
export function autoMerge(state: State, anchor: Building): AutoMerge[] {
  const steps: AutoMerge[] = [];
  let cur: Building | null = anchor;
  for (let combo = 0; cur && combo < 10; combo++) {
    const plan = planAutoMerge(state, cur, combo);
    if (!plan) break;
    const ignore = new Set(plan.used.map((u) => u.id));
    state.buildings = state.buildings.filter((u) => !ignore.has(u.id));
    cur = addBuilding(state, plan.next.id, plan.spot.x, plan.spot.y, plan.spot.w, plan.spot.h);
    state.ap += plan.refund;
    state.stats.merges++;
    if (combo > 0) state.stats.combos++;
    state.stats.apRefund += plan.refund;
    state.log.unshift(
      `第 ${state.turn} 回合：${plan.used.length} 个${plan.from.name}合成了 ${plan.next.icon} ${plan.next.name}${combo ? `（连锁 ×${combo + 1}）` : ''}${plan.refund ? `，返还 ${plan.refund} 点行动力` : ''}`,
    );
    steps.push(plan);
  }
  return steps;
}

export type MoveResult = { err: string | null; merges: AutoMerge[] };

/** 移动（可同时旋转）。放下后检查自动合并；原地放下不花行动力，但也会检查合并 */
export function move(state: State, id: number, x: number, y: number, rot = false): MoveResult {
  const b = byId(state, id);
  if (!b) return { err: '找不到建筑', merges: [] };
  const w = rot ? b.h : b.w, h = rot ? b.w : b.h;
  const same = b.x === x && b.y === y && !rot;
  if (!same) {
    if (state.ap < moveCost(b)) return { err: `行动力不够：移动它要 ${moveCost(b)} 点`, merges: [] };
    if (!fits(state, x, y, w, h, new Set([id]))) return { err: '放不下：这里空间不够', merges: [] };
    state.ap -= moveCost(b);
    Object.assign(b, { x, y, w, h });
    state.stats.apMove += moveCost(b);
  }
  return { err: null, merges: autoMerge(state, b) };
}

export function rotate(state: State, id: number): MoveResult {
  const b = byId(state, id);
  if (!b || b.w === b.h) return { err: null, merges: [] };
  if (!fits(state, b.x, b.y, b.h, b.w, new Set([id]))) return { err: '旁边没有空间旋转', merges: [] };
  return move(state, id, b.x, b.y, true);
}

/** 预览：如果把 id 放到 (x, y)，会发生哪些合并（不改动状态） */
export function previewMove(state: State, id: number, x: number, y: number, rot = false): MoveResult {
  const copy = JSON.parse(JSON.stringify(state)) as State;
  return move(copy, id, x, y, rot);
}

/** 卖出建筑：按格数 1/4 返还行动力 */
export function sell(state: State, id: number): string | null {
  const b = byId(state, id);
  if (!b) return '找不到建筑';
  if (familyOf(b.def).core) return '城市核心不能卖';
  const r = sellRefund(b);
  state.ap += r;
  state.stats.sold++;
  state.stats.apSell += r;
  state.buildings = state.buildings.filter((x) => x.id !== id);
  return null;
}
/** 兼容旧名字 */
export const demolish = sell;

// ---------- 城市核心 ----------

export function nextCore(state: State): { def: Def; cost: Res; era: number; goal: string } | null {
  const cur = coreOf(state);
  const n = DEFS.find((x) => x.family === 'core' && x.from === cur.def);
  if (!n) return null;
  const u = CORE_UPGRADES[n.id];
  const cost: Res = {};
  for (const k of Object.keys(u.cost) as ResKey[]) cost[k] = Math.ceil(u.cost[k]! * RULES.coreCostMult);
  return { def: n, ...u, cost };
}

/** 核心原地扩建：在核心附近找一块位置，把压到的建筑挪到别的空地。成功返回挪动数，失败返回 -1 且不改动状态 */
function expandCoreInPlace(state: State, c: Building, def: string, w: number, h: number, dist: (s: Spot) => number): number {
  const all = new Set(state.buildings.map((b) => b.id));
  const cands: Spot[] = [];
  const shapes = w === h ? [[w, h]] : [[w, h], [h, w]];
  const bd = ownedBounds(state);
  const occ0 = occupancy(state);
  for (const [ww, hh] of shapes)
    for (let y = bd.y0; y <= bd.y0 + bd.h - hh; y++)
      for (let x = bd.x0; x <= bd.x0 + bd.w - ww; x++) if (fits(state, x, y, ww, hh, all, occ0)) cands.push({ x, y, w: ww, h: hh });
  cands.sort((a, b) => dist(a) - dist(b));
  const saved = state.buildings.map((b) => ({ b, x: b.x, y: b.y, w: b.w, h: b.h, def: b.def }));
  const over = (b: Building, s: Spot) => b.x < s.x + s.w && s.x < b.x + b.w && b.y < s.y + s.h && s.y < b.y + b.h;
  for (const s of cands.slice(0, 40)) {
    const blockers = state.buildings.filter((b) => b !== c && over(b, s)).sort((a, b) => b.w * b.h - a.w * a.h);
    Object.assign(c, { def, ...s });
    // 先把挡路的移出棋盘，再逐个找位置
    for (const b of blockers) Object.assign(b, { x: -100, y: -100 });
    let ok = true;
    for (const b of blockers) {
      const spot = findSpot(state, b.w, b.h, new Set([b.id]), (q: Spot) => Math.abs(q.x - s.x) + Math.abs(q.y - s.y), Math.random);
      if (!spot) { ok = false; break; }
      Object.assign(b, spot);
    }
    if (ok) return blockers.length;
    for (const o of saved) Object.assign(o.b, { x: o.x, y: o.y, w: o.w, h: o.h, def: o.def });
  }
  return -1;
}

export function upgradeCore(state: State): string | null {
  const n = nextCore(state);
  if (!n) return '已经是最高级';
  if (!canAfford(state, n.cost)) return '资源不够';
  const c = coreOf(state);
  const [w, h] = FOOTPRINTS[n.def.lvl - 1];
  const dist = (s: Spot) => Math.abs(s.x - c.x) + Math.abs(s.y - c.y);
  const spot = findSpot(state, w, h, new Set([c.id]), dist, Math.random);
  let pushed = 0;
  if (spot) Object.assign(c, { def: n.def.id, ...spot });
  else {
    // 没有空地：核心原地扩建，把挡路的建筑挪到别处（挪不下才拒绝）
    pushed = expandCoreInPlace(state, c, n.def.id, w, h, dist);
    if (pushed < 0) return `核心扩建需要 ${w}×${h}，挡路的建筑没地方挪，先拆掉或合并一些`;
  }
  pay(state, n.cost);
  if (pushed) state.log.unshift(`第 ${state.turn} 回合：核心扩建，挪开了 ${pushed} 座挡路的建筑`);
  if (!state.seen.includes(n.def.id)) state.seen.push(n.def.id);
  const prevEra = state.era;
  state.era = n.era;
  state.log.unshift(`第 ${state.turn} 回合：城市核心升级为 ${n.def.icon} ${n.def.name}，最多可拥有 ${plotQuota(state)} 块地`);
  if (state.era > prevEra) {
    state.log.unshift(`进入${ERAS[state.era].name}！建筑最高可以合到 ${maxLevel(state)} 级。`);
    state.ap += RULES.apPerEra;
  }
  // 核心升级送一套下个阶段的入门建筑（放不下的丢掉）
  const gift = CORE_UPGRADES[n.def.id]?.gift ?? [];
  const placed = gift.filter((id) => place(state, id)).map((id) => `${DEF[id].icon}${DEF[id].name}`);
  if (placed.length) state.log.unshift(`第 ${state.turn} 回合：核心升级送来 ${placed.join('、')}`);
  if (n.def.id === 'c5') {
    state.won = true;
    state.log.unshift(`你在第 ${state.turn} 回合建成了卫城，原型通关！`);
  }
  return null;
}

// ---------- 回合结算 ----------

const fmtN = (n: number) => (Math.abs(n) >= 10 || Number.isInteger(n) ? Math.round(n).toString() : n.toFixed(1));

/** 结算生产与消耗。dryRun 时在副本上跑，用来给界面预览 */
export function resolveTurn(state: State, dryRun = false): Report {
  const s: State = dryRun ? structuredClone(state) : state;
  const before = { ...s.res };
  const status: Record<number, Status> = {};
  const mult: Record<number, number> = {};
  const events: string[] = [];
  const produced = emptyRes();
  const demand = emptyRes();
  const lacking = new Set<ResKey>();

  const producers = s.buildings.filter((b) => !defOf(b).housing);
  const homes = s.buildings.filter((b) => defOf(b).housing);
  for (const b of producers) mult[b.id] = multOf(s, b);

  // 分配工人：先保粮食，再每次派给当前最缺的那种资源的生产建筑（同等情况大建筑优先）
  let freeWorkers = s.pop;
  let workersNeeded = 0;
  const staffed: Building[] = [];
  const balance = emptyRes();
  balance.food -= s.pop * RULES.foodPerPerson;
  const cap0 = homes.reduce((a, b) => a + defOf(b).housing!, 0);
  for (const b of homes) for (const [k, v] of Object.entries(defOf(b).consume)) balance[k as ResKey] -= v! * (cap0 ? Math.min(1, s.pop / cap0) : 0);
  const mainRes = (b: Building) => Object.keys(defOf(b).produce)[0] as ResKey;
  let unstaffed = [...producers];
  for (const b of producers) workersNeeded += defOf(b).workers;
  while (unstaffed.length) {
    const fit = unstaffed.filter((b) => defOf(b).workers <= freeWorkers);
    if (!fit.length) break;
    // 粮食是生存资源：粮食还不够吃时先保粮食
    const key = (b: Building) => (mainRes(b) === 'food' && balance.food < 0 ? -1e9 : 0) + balance[mainRes(b)];
    fit.sort((a, b) => key(a) - key(b) || defOf(b).lvl - defOf(a).lvl);
    const b = fit[0];
    const d = defOf(b);
    freeWorkers -= d.workers;
    staffed.push(b);
    unstaffed = unstaffed.filter((x) => x !== b);
    for (const [k, v] of Object.entries(d.produce)) balance[k as ResKey] += v! * mult[b.id];
    for (const [k, v] of Object.entries(d.consume)) {
      balance[k as ResKey] -= v!;
      demand[k as ResKey] += v!;
    }
  }
  for (const b of unstaffed) status[b.id] = 'noWorkers';

  // 生产：原料不够的先等别人产出，重试到没有进展为止
  let pending = staffed;
  for (let pass = 0; pending.length && pass < 10; pass++) {
    const waiting: Building[] = [];
    for (const b of pending) {
      const d = defOf(b);
      // 自产自用：投入里和产出相同的那部分，可以直接用本回合自己的产出（伐木场不会因为木材库存为 0 卡死）
      const need: Res = {};
      for (const k of Object.keys(d.consume) as ResKey[]) need[k] = Math.max(0, d.consume[k]! - (d.produce[k] ?? 0) * mult[b.id]);
      if (!canAfford(s, need)) {
        waiting.push(b);
        continue;
      }
      for (const k of Object.keys(d.produce) as ResKey[]) {
        const n = d.produce[k]! * mult[b.id];
        s.res[k] = round1(s.res[k] + n);
        produced[k] += n;
      }
      pay(s, d.consume);
      status[b.id] = 'ok';
    }
    if (waiting.length === pending.length) break;
    pending = waiting;
  }
  for (const b of pending)
    if (!status[b.id]) {
      status[b.id] = 'noInput';
      for (const k of Object.keys(defOf(b).consume) as ResKey[]) if (s.res[k] < defOf(b).consume[k]!) lacking.add(k);
    }

  // 住房维护按入住率收：空房不耗材料
  let housing = 0;
  const capacity = homes.reduce((a, b) => a + defOf(b).housing!, 0);
  const occ = capacity ? Math.min(1, s.pop / capacity) : 0;
  for (const b of homes) {
    const d = defOf(b);
    const upkeep: Res = {};
    for (const k of Object.keys(d.consume) as ResKey[]) {
      upkeep[k] = round1(d.consume[k]! * occ);
      demand[k] += upkeep[k]!;
    }
    if (canAfford(s, upkeep)) {
      pay(s, upkeep);
      housing += d.housing!;
      status[b.id] = 'housing';
    } else {
      for (const k of Object.keys(upkeep) as ResKey[]) if (s.res[k] < upkeep[k]!) lacking.add(k);
      housing += Math.floor(d.housing! / 2);
      status[b.id] = 'housingBroken';
    }
  }

  // 吃饭与人口：住房容量、人口、工人分开算
  const popBefore = s.pop;
  const eat = s.pop * RULES.foodPerPerson;
  demand.food += eat;
  let starved = 0;
  if (s.res.food >= eat) {
    s.res.food = round1(s.res.food - eat);
    if (s.pop > housing) {
      const leave = Math.ceil((s.pop - housing) / 2);
      s.pop -= leave;
      events.push(`住房不够，${leave} 人离开了城市。`);
    } else if (s.pop < housing) {
      // 新增人口受“口粮余量”限制：本回合产粮比消耗多出来的部分 + 少量库存
      const foodRoom = Math.floor(produced.food - demand.food + s.res.food * RULES.growthFromStock);
      const want = Math.max(RULES.popGrowthMin, Math.floor(s.pop * RULES.popGrowth));
      const grow = Math.max(0, Math.min(housing - s.pop, want, foodRoom));
      s.pop += grow;
    }
  } else {
    const deficit = eat - s.res.food;
    s.res.food = 0;
    starved = Math.max(1, Math.ceil(deficit / RULES.foodPerPerson / 2));
    s.pop = Math.max(0, s.pop - starved);
    lacking.add('food');
    events.push(`闹饥荒了！${starved} 人饿死或出走。`);
  }

  const net = emptyRes();
  for (const k of RES_KEYS) net[k] = round1(s.res[k] - before[k]);

  // 评估：只看实际欠供（库存可以补缺口）；产出 < 消耗但库存够，只是预警
  const checks: Check[] = [];
  for (const k of RES_KEYS) {
    if (demand[k] <= 0) continue;
    const p = round1(produced[k]);
    const dm = round1(demand[k]);
    const ok = !lacking.has(k);
    const warn = ok && p < dm;
    const runway = warn ? Math.floor(s.res[k] / (dm - p)) : 0;
    checks.push({
      key: k,
      label: `${RES_INFO[k].icon} ${RES_INFO[k].name}`,
      survival: k === 'food',
      ok,
      warn,
      detail: !ok ? `${k === 'food' ? '欠供，会饿死人' : '不够，有建筑停工'}！产 ${fmtN(p)} / 需 ${fmtN(dm)}` : warn ? `产 ${fmtN(p)} / 需 ${fmtN(dm)}，库存还能撑 ${runway} 回合` : `产 ${fmtN(p)} / 需 ${fmtN(dm)}`,
    });
  }
  // 扣心只看生存欠供：断粮饿死人。原料不够只会让建筑停工（停工本身就是损失）
  return { status, mult, net, produced, demand, housing, workersNeeded, popChange: s.pop - popBefore, starved, events, checks, passed: starved === 0 };
}

// ---------- 选卡 ----------

/** 卡池：没超过本时代等级上限、前置满足（曾经拥有过）的非核心建筑，且不低于上限两级 */
export function pool(state: State): Def[] {
  const cap = maxLevel(state);
  return DEFS.filter(
    (x) => x.family !== 'core' && x.lvl <= cap && x.lvl >= cap - 2 && (!x.unlock || state.seen.includes(x.unlock)) && (!x.from || state.seen.includes(x.from)),
  );
}

export const cardValue = (state: State) => RULES.cardValue[Math.min(coreLevel(state), RULES.cardValue.length - 1)];

function weightedPick<T>(items: T[], w: number[], r: () => number): T {
  const total = w.reduce((a, b) => a + b, 0);
  let x = r() * total;
  for (let i = 0; i < items.length; i++) if ((x -= w[i]) <= 0) return items[i];
  return items[items.length - 1];
}

/** 按局面挑一种建筑 */
export function pickDef(state: State, kind: SpawnKind, r: () => number, avoid: Set<string> = new Set()): Def {
  let defs = pool(state).filter((x) => !avoid.has(x.family));
  if (!defs.length) defs = pool(state);
  if (kind === 'neutral') return defs[Math.floor(r() * defs.length)];
  if (kind === 'pressure') {
    const w = defs.map((x) => (x.housing ? 3 : 0.5 + Object.values(x.consume).reduce((a, b) => a + b!, 0) / Math.max(1, x.lvl * 3)));
    return weightedPick(defs, w, r);
  }
  // support：缺工人补住房；否则补欠供/在吃库存的资源；都不缺补核心升级需要的资源
  const p = resolveTurn(state, true);
  const need: Record<string, number> = {};
  // 住房满了才补住房；有空房但缺工人，说明人口被口粮卡住，补粮食
  if (state.pop >= p.housing * 0.9) need.__house = 10;
  else if (p.workersNeeded > state.pop) need.food = (need.food ?? 0) + 8;
  for (const c of p.checks) {
    const urgent = c.survival && (!c.ok || (c.warn && state.res[c.key] < (p.demand[c.key] - p.produced[c.key]) * 4));
    need[c.key] = (need[c.key] ?? 0) + (urgent ? 30 : !c.ok ? 10 : c.warn ? 5 : 0);
  }
  const n = nextCore(state);
  // 核心升级（时代目标）缺的资源；完全没有产出的资源加重
  if (n)
    for (const [k, v] of Object.entries(n.cost))
      if (state.res[k as ResKey] < v!) {
        const none = !(p.produced[k as ResKey] > 0);
        need[k] = (need[k] ?? 0) + (none ? 12 : 3);
        // 产这种资源的建筑还缺原料链（铁 ← 铁矿石）：原料也加重
        if (none)
          for (const d of DEFS)
            if (d.produce[k as ResKey])
              for (const ck of Object.keys(d.consume)) if (!(p.produced[ck as ResKey] > 0) && !state.res[ck as ResKey]) need[ck] = Math.max(need[ck] ?? 0, 12);
      }
  // 合并导向：对口建筑里，手上差 1 个就能凑满 3 个的权重最高，差 2 个的次之
  const have = (id: string) => state.buildings.filter((b) => b.def === id).length % MERGE_COUNT;
  const w = defs.map((x) => {
    const base = x.housing ? need.__house ?? 0 : need[Object.keys(x.produce)[0]] ?? 0;
    const h = have(x.id);
    return 0.2 + base * (base > 0 ? (h === MERGE_COUNT - 1 ? RULES.mergeHint : h > 0 ? (1 + RULES.mergeHint) / 2 : 1) : 1);
  });
  return weightedPick(defs, w, r);
}

export function genOffer(state: State, r: () => number = Math.random): Card[] {
  const V = cardValue(state);
  const cards: Card[] = [];
  const used = new Set<string>();
  for (const tag of ['support', 'pressure', 'neutral'] as SpawnKind[]) {
    const def = pickDef(state, tag, r, used);
    used.add(def.family);
    let count = Math.max(1, Math.round((V / Math.pow(MERGE_COUNT, def.lvl - 1)) * (0.8 + r() * 0.4)));
    // 补缺口卡至少把手上的同种建筑补到能合并
    if (tag === 'support') {
      const h = state.buildings.filter((b) => b.def === def.id).length % MERGE_COUNT;
      if (h > 0) count = Math.max(count, MERGE_COUNT - h);
    }
    cards.push({ kind: 'bundle', tag, def: def.id, count });
  }
  const items: string[] = [];
  let left = V * RULES.randomCardBonus;
  for (let guard = 0; left >= 1 && guard < 50; guard++) {
    const def = pickDef(state, 'neutral', r);
    const v = Math.pow(MERGE_COUNT, def.lvl - 1);
    if (v > left && items.length) continue;
    items.push(def.id);
    left -= v;
  }
  cards.push({ kind: 'random', items });
  return cards;
}

export const cardItems = (card: Card): string[] => (card.kind === 'random' ? card.items : Array.from({ length: card.count }, () => card.def));

/** 预览：这张卡实际能放下几座 */
export function previewCard(state: State, card: Card): { fit: number; total: number } {
  const s = structuredClone(state);
  const items = [...cardItems(card)].sort((a, b) => DEF[b].lvl - DEF[a].lvl);
  const r = rng(1);
  let fit = 0;
  for (const it of items) if (place(s, it, r)) fit++;
  return { fit, total: items.length };
}

export function chooseCard(state: State, idx: number, r: () => number = Math.random): { placed: number; lost: number } | string {
  if (state.over) return '游戏已结束';
  if (state.picks <= 0 || !state.offer) return '本回合没有选卡机会了';
  const card = state.offer[idx];
  if (!card) return '没有这张卡';
  if (card.kind === 'bundle' && card.tag !== 'support') state.stats.nonSupportPicks++;
  const items = [...cardItems(card)].sort((a, b) => DEF[b].lvl - DEF[a].lvl);
  let placed = 0, lost = 0;
  for (const it of items) (place(state, it, r) ? placed++ : lost++);
  state.stats.lost += lost;
  const desc = card.kind === 'random' ? `随机分配（${items.length} 个）` : `${DEF[card.def].name} ×${card.count}`;
  state.log.unshift(`第 ${state.turn} 回合：选了 ${desc}${lost ? `，${lost} 个没地方放丢掉了` : ''}`);
  state.picks -= 1;
  state.offer = state.picks > 0 ? genOffer(state, r) : null;
  return { placed, lost };
}

/** 重摇当前的选卡：先用免费次数，用完了花行动力 */
export function reroll(state: State, r: () => number = Math.random): string | null {
  if (state.over) return '游戏已结束';
  if (state.picks <= 0 || !state.offer) return '本回合没有选卡机会了';
  if (state.rerolls > 0) state.rerolls -= 1;
  else if (state.ap >= RULES.apReroll) state.ap -= RULES.apReroll;
  else return `行动力不够：重摇要 ${RULES.apReroll} 点`;
  state.stats.rerolls++;
  state.offer = genOffer(state, r);
  return null;
}

/** 结束回合：没用完的选卡自动选随机分配；结算、评估；发下一回合的选卡和行动力 */
export function endTurn(state: State, r: () => number = Math.random): Report {
  while (state.picks > 0 && state.offer) chooseCard(state, state.offer.length - 1, r);
  state.stats.apWasted += state.ap;
  const pre = resolveTurn(state, true);
  const popBeforeEnd = state.pop;
  const rep = resolveTurn(state);
  const t = state.turn;
  for (const e of rep.events) state.log.unshift(`第 ${t} 回合：${e}`);
  let bonus = 0;
  const stalled = rep.checks.filter((c) => !c.ok && !c.survival).map((c) => c.label);
  if (rep.passed) state.log.unshift(`第 ${t} 回合评估：✅ 粮食够吃${stalled.length ? `（${stalled.join('、')}不够，有建筑停工）` : ''}`);
  else {
    if (!pre.passed) state.stats.warnedBeforeFail++;
    state.fails += 1;
    bonus = rep.starved >= Math.max(3, popBeforeEnd * 0.1) ? 2 : 1;
    state.log.unshift(`第 ${t} 回合评估：❌ 断粮，${rep.starved} 人饿死或出走，失败 ${state.fails}/${RULES.maxFails}，下回合多 ${bonus} 次选卡`);
  }
  if (state.fails >= RULES.maxFails || state.pop <= 0) {
    state.over = true;
    state.log.unshift(`游戏结束，坚持到第 ${t} 回合。`);
  }
  state.turn += 1;
  state.picks = RULES.picksPerTurn + bonus;
  state.rerolls = RULES.rerollsPerTurn;
  state.offer = state.over ? null : genOffer(state, r);
  state.ap = apPerTurn(state);
  state.log = state.log.slice(0, 80);
  return rep;
}
