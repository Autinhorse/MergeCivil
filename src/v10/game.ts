// v10 规则：纯逻辑，不碰界面。数值全部来自 ./data。
import {
  CORE, CORE_LEVELS, ERAS, RES_INFO, FAMILIES, FAMILY, FOOTPRINTS, MATERIALS, MERGE, RES_KEYS, RULES,
  META_SHOP, materialsOfEra, rowOf, lv1Row, startBase, nameOf, type ResKey, type Row,
} from './data';

export interface Spot { x: number; y: number; w: number; h: number }
export interface Building extends Spot { id: number; fam: string; lvl: number; core?: boolean }
export interface Item { fam: string; lvl: number }
export type Card =
  | { kind: 'bundle'; fam: string; lvl: number; count: number; reason: string }
  | { kind: 'mixed'; items: Item[] };

export interface Stats {
  apBase: number; apRefund: number; apSell: number; // 行动力收入
  apMove: number; apPlot: number; apWasted: number; // 行动力支出 / 浪费
  merges: number; landingMerges: number; combos: number;
  arrived: number; toWarehouse: number; lost: number; sold: number; plotsBought: number;
  gapTurns: Record<string, number>; // 各种缺口出现的回合数：housing / food / happy / 原料
  dangerTurns: number;
  coreTurn: number[]; // 升到第 n 级村庄中心的回合
  lvTurn: number[]; // 第一次出现第 n 级建筑的回合
  autoFilled?: number;
}

export interface State {
  seed: number;
  plot: number; wp: number; size: number;
  owned: boolean[];
  turn: number;
  pop: number;
  res: Record<ResKey, number>;
  buildings: Building[];
  nextId: number;
  coreLevel: number;
  era: number;
  eraTurn: number; // 进入当前时代的回合
  ap: number;
  warehouse: Item[];
  offer: Card[] | null;
  picksLeft: number; // 本（大）回合还剩几次选卡

  lastPlaced: Spot | null;
  mult: number; // 上回合幸福度决定的全城产出倍率
  happy: number; // 上回合结算的幸福度
  danger: number; // 连续低于失败线的回合
  over: boolean;
  log: string[];
  stats: Stats;
  rs: number; // 随机数状态（存在 state 里，复制局面不影响原局）
}

export interface Economy {
  mult: number;
  foodProd: number; foodNeed: number; hungry: number;
  goodsProd: number; goodsNeed: number; goodsShort: number;
  housing: number; homeless: number;
  happyProd: number; happyBuildings: number; happyNeed: number; happyPenalty: number; happy: number; happyRatio: number;
  settled: number;
  matProd: Record<ResKey, number>; matDemand: Record<ResKey, number>; matUsed: Record<ResKey, number>;
  run: Record<number, number>; // 每座建筑的开工率（0–1）
  stockAfter: Record<ResKey, number>;
}

// ---------- 基础 ----------

/** 用 state 里的随机数状态取一个 [0,1) 随机数 */
export function rand(s: { rs: number }) {
  s.rs = (s.rs * 1664525 + 1013904223) >>> 0;
  return s.rs / 2 ** 32;
}
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const zero = (): Record<ResKey, number> => Object.fromEntries(RES_KEYS.map((k) => [k, 0])) as Record<ResKey, number>;
export const cells = (s: { w: number; h: number }) => s.w * s.h;
export const footprint = (lvl: number) => FOOTPRINTS[Math.min(lvl, FOOTPRINTS.length) - 1];
export const levelCap = (s: State) => Math.min(FOOTPRINTS.length, s.coreLevel + CORE.levelCapOffset);
export const apPerTurn = (s: State) => RULES.apBase + RULES.apPerEra * (s.era - 1);
/** 第 turn 回合的人口增长 = 固定部分 + 按回合加的部分 + 当前人口 × popRate（按比例增长） */
export const popGrowth = (turn: number, pop = 0) => RULES.popBase + RULES.popPerTurn * turn + RULES.popRate * pop;
export const core = (s: State) => s.buildings.find((b) => b.core)!;
export const rowOfB = (b: Building): Row => (b.core ? { housing: CORE_LEVELS[b.lvl].housing, happy: CORE_LEVELS[b.lvl].housing * RULES.coreHappy } : rowOf(b.fam, b.lvl));
export const nameOfB = (b: Building) => (b.core ? CORE_LEVELS[b.lvl].name : nameOf(b.fam, b.lvl));
export const byId = (s: State, id: number) => s.buildings.find((b) => b.id === id);
export const shownMaterials = (s: State) => materialsOfEra(s.era);

/** 每人幸福需求：按回合慢慢涨，和时代无关 */
export const happyPerPerson = (s: State) => Math.min(RULES.happyMax, RULES.happyBase + RULES.happyPerTurn * s.turn);

// ---------- 地图 ----------

export const plotOf = (s: State, x: number, y: number) => Math.floor(y / s.plot) * s.wp + Math.floor(x / s.plot);
export const cellOwned = (s: State, x: number, y: number) => x >= 0 && y >= 0 && x < s.size && y < s.size && s.owned[plotOf(s, x, y)];
export const ownedCount = (s: State) => s.owned.filter(Boolean).length;
export const plotQuota = (s: State) => s.coreLevel * CORE.plotsPerLevel;
export const plotAp = (s: State) => RULES.plotApBase + RULES.plotApStep * Math.max(0, ownedCount(s) - 1);

export function ownedBounds(s: State) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  s.owned.forEach((o, i) => {
    if (!o) return;
    const px = i % s.wp, py = Math.floor(i / s.wp);
    x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
  });
  return { x0: x0 * s.plot, y0: y0 * s.plot, w: (x1 - x0 + 1) * s.plot, h: (y1 - y0 + 1) * s.plot };
}

export function occupancy(s: State): Int32Array {
  const occ = new Int32Array(s.size * s.size);
  for (const b of s.buildings) for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) occ[y * s.size + x] = b.id;
  return occ;
}

export function fits(s: State, x: number, y: number, w: number, h: number, ignore: Set<number> = new Set(), occ = occupancy(s)): boolean {
  if (x < 0 || y < 0 || x + w > s.size || y + h > s.size) return false;
  for (let yy = y; yy < y + h; yy++)
    for (let xx = x; xx < x + w; xx++) {
      if (!cellOwned(s, xx, yy)) return false;
      const id = occ[yy * s.size + xx];
      if (id && !ignore.has(id)) return false;
    }
  return true;
}

export function freeCells(s: State): number {
  return ownedCount(s) * s.plot * s.plot - s.buildings.reduce((a, b) => a + cells(b), 0);
}

export function rectDist(a: Spot, b: Spot) {
  const dx = Math.max(0, a.x - (b.x + b.w - 1), b.x - (a.x + a.w - 1));
  const dy = Math.max(0, a.y - (b.y + b.h - 1), b.y - (a.y + a.h - 1));
  return Math.max(dx, dy);
}
export function touching(a: Spot, b: Spot): boolean {
  const ox = a.x < b.x + b.w && b.x < a.x + a.w;
  const oy = a.y < b.y + b.h && b.y < a.y + a.h;
  return (ox && (a.y + a.h === b.y || b.y + b.h === a.y)) || (oy && (a.x + a.w === b.x || b.x + b.w === a.x));
}
function lexLess(a: number[], b: number[]) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}
const sameKind = (a: { fam: string; lvl: number; core?: boolean }, b: { fam: string; lvl: number; core?: boolean }) => !a.core && !b.core && a.fam === b.fam && a.lvl === b.lvl;

/**
 * 落地规则（v9）：从 anchor（最后放下的建筑，没有就用村庄中心）往外一圈圈顺时针找空位，
 * 优先挨着同种同级建筑；cover=true 时优先压住 anchor 原来的格子（合并结果用）。
 */
export function landingSpot(s: State, item: Item, anchor: Spot, ignore: Set<number> = new Set(), cover = false): Spot | null {
  const [w0, h0] = footprint(item.lvl);
  const shapes = w0 === h0 ? [[w0, h0]] : [[w0, h0], [h0, w0]];
  const occ = occupancy(s);
  const bd = ownedBounds(s);
  const same = RULES.landNextToSame ? s.buildings.filter((b) => !ignore.has(b.id) && sameKind(b, item)) : [];
  const cx = anchor.x + anchor.w / 2, cy = anchor.y + anchor.h / 2;
  let best: Spot | null = null;
  let bestKey: number[] | null = null;
  for (const [w, h] of shapes)
    for (let y = bd.y0; y <= bd.y0 + bd.h - h; y++)
      for (let x = bd.x0; x <= bd.x0 + bd.w - w; x++) {
        if (!fits(s, x, y, w, h, ignore, occ)) continue;
        const sp = { x, y, w, h };
        const ox = Math.max(0, Math.min(x + w, anchor.x + anchor.w) - Math.max(x, anchor.x));
        const oy = Math.max(0, Math.min(y + h, anchor.y + anchor.h) - Math.max(y, anchor.y));
        const overlap = ox * oy;
        const ring = overlap > 0 ? 0 : rectDist(sp, anchor);
        const adj = same.filter((o) => touching(sp, o)).length;
        const ang = (Math.atan2(x + w / 2 - cx, -(y + h / 2 - cy)) + 2 * Math.PI) % (2 * Math.PI);
        const key = cover ? [ring, -overlap, -adj, ang] : [adj > 0 ? 0 : 1, ring, -adj, ang];
        if (!bestKey || lexLess(key, bestKey)) { best = sp; bestKey = key; }
      }
  return best;
}

function addBuilding(s: State, item: Item, sp: Spot): Building {
  const b: Building = { id: s.nextId++, fam: item.fam, lvl: item.lvl, ...sp };
  s.buildings.push(b);
  if (s.stats && !s.stats.lvTurn[item.lvl]) s.stats.lvTurn[item.lvl] = s.turn;
  return b;
}

const warehouseUsed = (s: State) => s.warehouse.reduce((a, it) => a + cells({ w: footprint(it.lvl)[0], h: footprint(it.lvl)[1] }), 0);
const itemCells = (it: Item) => { const [w, h] = footprint(it.lvl); return w * h; };

function toWarehouse(s: State, it: Item): boolean {
  if (warehouseUsed(s) + itemCells(it) <= RULES.warehouseCells) {
    s.warehouse.push(it);
    s.stats.toWarehouse++;
    return true;
  }
  s.stats.lost++;
  return false;
}

/** 新建筑落地（不花行动力）；放不下进仓库，仓库满了就丢掉。返回落地的建筑 */
export function land(s: State, it: Item, noMerge = false): Building | null {
  const anchor = s.lastPlaced ?? core(s);
  const sp = landingSpot(s, it, anchor);
  if (!sp) { toWarehouse(s, it); return null; }
  const b = addBuilding(s, it, sp);
  s.lastPlaced = sp;
  if (RULES.mergeOnLanding && !noMerge) autoMerge(s, b, true);
  return b;
}

/**
 * 低级零头自动补齐（2026-11-27 Rex 定）：比当前发卡等级低 autoFillGap 级及以上的建筑，
 * 每个大回合开始时把零头（1 或 2 座）补到 3 座，不自动合并，等玩家自己挪过去合。这些等级以后不再出现在卡里。
 */
export function autoFillLow(s: State) {
  if (!RULES.autoFillGap) return;
  const top = bundleLevel(s, arrivalValue(s)) - RULES.autoFillGap;
  if (top < 1) return;
  const cnt = new Map<string, number>();
  for (const b of s.buildings) if (!b.core && b.lvl <= top) cnt.set(`${b.fam}:${b.lvl}`, (cnt.get(`${b.fam}:${b.lvl}`) ?? 0) + 1);
  for (const [k, n] of cnt) {
    const r = n % MERGE.count;
    if (!r) continue;
    const [fam, lvl] = k.split(':');
    for (let i = r; i < MERGE.count; i++) { s.stats.arrived++; s.stats.autoFilled = (s.stats.autoFilled ?? 0) + 1; land(s, { fam, lvl: Number(lvl) }, true); }
  }
}

// ---------- 合并 ----------

export function groupOf(s: State, b: Building): Building[] {
  const same = s.buildings.filter((x) => sameKind(x, b));
  const out = [b];
  const seen = new Set([b.id]);
  for (let i = 0; i < out.length; i++)
    for (const o of same)
      if (!seen.has(o.id) && touching(out[i], o)) { seen.add(o.id); out.push(o); }
  return out;
}

export interface MergeStep { used: number; fam: string; from: number; to: number; spot: Spot; refund: number; combo: number }

export function planMerge(s: State, anchor: Building, combo: number, landing: boolean): (MergeStep & { ids: number[] }) | null {
  if (anchor.core) return null;
  const group = groupOf(s, anchor);
  if (group.length < MERGE.count) return null;
  let to = anchor.lvl + 1;
  const cap = levelCap(s);
  if (to > cap) return null;
  // 一次合满 maxGroup 座直接升 2 级；升不了 2 级就只合 3 座，剩下的留在原地
  const jump = group.length >= MERGE.maxGroup && to + 1 <= cap;
  if (jump) to++;
  const used = group.slice(0, jump ? MERGE.maxGroup : MERGE.count);
  const ids = used.map((u) => u.id);
  const spot = landingSpot(s, { fam: anchor.fam, lvl: to }, anchor, new Set(ids), true);
  if (!spot) return null;
  const pay = RULES.mergeRefund && (!landing || RULES.refundOnLanding);
  const refund = pay ? cells(anchor) * (1 + used.length - MERGE.count) * (combo > 0 ? RULES.comboMult : 1) : 0;
  return { ids, used: used.length, fam: anchor.fam, from: anchor.lvl, to, spot, refund, combo };
}

/** 以 anchor 为起点自动合并（含连锁） */
export function autoMerge(s: State, anchor: Building, landing = false): MergeStep[] {
  const steps: MergeStep[] = [];
  let cur: Building | null = anchor;
  const leftovers: Building[] = [];
  for (let combo = 0; cur && combo < 12; combo++) {
    const p = planMerge(s, cur, combo, landing);
    if (!p) break;
    const ids = new Set(p.ids);
    if (combo === 0) leftovers.push(...groupOf(s, cur).filter((b) => !ids.has(b.id)));
    s.buildings = s.buildings.filter((u) => !ids.has(u.id));
    cur = addBuilding(s, { fam: p.fam, lvl: p.to }, p.spot);
    s.lastPlaced = p.spot;
    s.ap += p.refund;
    s.stats.apRefund += p.refund;
    if (landing && combo === 0) s.stats.landingMerges++;
    else s.stats.merges++;
    if (combo > 0) s.stats.combos++;
    steps.push(p);
  }
  // 一组超过 3 座时剩下的：还连着 3 座就接着合
  for (const b of leftovers) if (s.buildings.includes(b) && groupOf(s, b).length >= MERGE.count) steps.push(...autoMerge(s, b, landing));
  return steps;
}

/** 把所有已经连成 3 座的组合掉（村庄中心升级、等级上限提高后调用） */
function mergeAll(s: State) {
  for (let guard = 0; guard < 50; guard++) {
    const b = s.buildings.find((x) => !x.core && groupOf(s, x).length >= MERGE.count && planMerge(s, x, 0, true));
    if (!b) return;
    autoMerge(s, b, true);
  }
}

// ---------- 玩家操作（花行动力） ----------

export const moveCost = (b: Building) => cells(b) * RULES.moveCostPerCell;
export const sellRefund = (it: { lvl: number }) => {
  const [w, h] = footprint(it.lvl);
  return Math.max(RULES.sellMin, Math.floor(w * h * RULES.sellRatio));
};

export type MoveResult = { err: string | null; merges: MergeStep[] };

export function move(s: State, id: number, x: number, y: number, rot = false): MoveResult {
  const b = byId(s, id);
  if (!b) return { err: '找不到建筑', merges: [] };
  if (b.core) return { err: '村庄中心不能移动', merges: [] };
  const w = rot ? b.h : b.w, h = rot ? b.w : b.h;
  if (b.x === x && b.y === y && !rot) return { err: null, merges: autoMerge(s, b) };
  const c = moveCost(b);
  if (s.ap < c) return { err: `行动力不够：要 ${c} 点`, merges: [] };
  if (!fits(s, x, y, w, h, new Set([id]))) return { err: '放不下', merges: [] };
  s.ap -= c;
  s.stats.apMove += c;
  Object.assign(b, { x, y, w, h });
  s.lastPlaced = { x, y, w, h };
  return { err: null, merges: autoMerge(s, b) };
}

export const rotate = (s: State, id: number) => { const b = byId(s, id); return b ? move(s, id, b.x, b.y, true) : { err: '找不到建筑', merges: [] }; };

export function previewMove(s: State, id: number, x: number, y: number, rot = false): MoveResult {
  const copy = cloneState(s);
  return move(copy, id, x, y, rot);
}

export function buyablePlots(s: State): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.owned.length; i++) {
    if (s.owned[i]) continue;
    const px = i % s.wp, py = Math.floor(i / s.wp);
    if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
      const nx = px + dx, ny = py + dy;
      return nx >= 0 && ny >= 0 && nx < s.wp && ny < s.wp && s.owned[ny * s.wp + nx];
    })) out.push(i);
  }
  return out;
}

/** 买地：只花行动力 */
export function buyPlot(s: State, i: number): string | null {
  if (!buyablePlots(s).includes(i)) return '只能买相邻地块';
  if (ownedCount(s) >= plotQuota(s)) return `村庄中心升级后才能买更多地（现在最多 ${plotQuota(s)} 块）`;
  const c = plotAp(s);
  if (s.ap < c) return `行动力不够（要 ${c} 点）`;
  s.ap -= c;
  s.stats.apPlot += c;
  s.stats.plotsBought++;
  s.owned[i] = true;
  releaseWarehouse(s);
  return null;
}

/** 卖出仓库里的第 idx 件 */
export function sellWarehouse(s: State, idx: number): string | null {
  const it = s.warehouse[idx];
  if (!it) return '仓库里没有这件';
  s.warehouse.splice(idx, 1);
  const r = sellRefund(it);
  s.ap += r; s.stats.apSell += r; s.stats.sold++;
  return null;
}
/** 卖出地图上的建筑 */
export function sellBuilding(s: State, id: number): string | null {
  if (!RULES.allowMapSell) return '只能卖仓库里的建筑';
  const b = byId(s, id);
  if (!b) return '找不到建筑';
  if (b.core) return '村庄中心不能卖';
  s.buildings = s.buildings.filter((x) => x !== b);
  const r = sellRefund(b);
  s.ap += r; s.stats.apSell += r; s.stats.sold++;
  releaseWarehouse(s);
  return null;
}

/** 仓库自动落地（玩家不能选位置），大的先放 */
export function releaseWarehouse(s: State) {
  const items = [...s.warehouse].sort((a, b) => b.lvl - a.lvl);
  s.warehouse = [];
  for (const it of items) {
    const anchor = s.lastPlaced ?? core(s);
    const sp = landingSpot(s, it, anchor);
    if (!sp) { s.warehouse.push(it); continue; }
    const b = addBuilding(s, it, sp);
    s.lastPlaced = sp;
    if (RULES.mergeOnLanding) autoMerge(s, b, true);
  }
}

// ---------- 选卡 ----------

export const cardItems = (c: Card): Item[] => (c.kind === 'mixed' ? c.items : Array.from({ length: c.count }, () => ({ fam: c.fam, lvl: c.lvl })));
export const itemValue = (it: Item) => Math.pow(MERGE.count, it.lvl - baseLevel(it.fam));
export const cardValue = (c: Card) => cardItems(c).reduce((a, it) => a + itemValue(it), 0);
export const pool = (s: State) => FAMILIES.filter((f) => f.era <= s.era && f.start <= levelCap(s));
/** 这种建筑在卡里发几级：至少是它的起始级别 */
export const baseLevel = (fam: string) => startBase(fam);
export const famLevel = (s: State, fam: string, lvl: number) => {
  const st = FAMILY[fam]?.start ?? 1;
  // 发的这一级价值 ≈ 卡片等级 lvl 的价值
  return Math.max(st, Math.min(levelCap(s), Math.round(baseLevel(fam) + lvl - 1)));
};
/** 每人生活用品需求（goodsFromEra 时代以前不要） */
export const goodsPerPerson = (s: State) => (s.era >= RULES.goodsFromEra ? RULES.goodsBase + RULES.goodsPerTurn * s.turn : 0);

/** 未来 needHorizon 回合的各项缺口，换算成“还差几座 Lv1 该种建筑” */
export function needs(s: State): { fam: string; lv1: number; reason: string; lvl: number }[] {
  let future = s.pop;
  for (let t = 0; t < Math.max(RULES.needHorizon, RULES.turnsPerRound); t++) future += popGrowth(s.turn + t, future);
  const e = economy(s, future);
  const out: { fam: string; lv1: number; reason: string; lvl: number }[] = [];
  const cardLvl = bundleLevel(s, arrivalValue(s));
  const add = (key: keyof Row, gap: number, reason: string) => {
    if (gap <= 0) return;
    for (const f of pool(s)) {
      // 换产出的链（伐木场 Lv8 起产煤）：这一级不产就往上找第一个产的等级，直接发那一级
      // 换产出的链（伐木场 Lv8 起产煤）：这一级不产就看往上第一个产的等级，但还是发卡片等级（玩家自己往上合）
      const L0 = famLevel(s, f.id, cardLvl);
      for (let L = L0; L <= levelCap(s); L++) {
        const v = lv1Row(f.id, L)[key] ?? 0;
        if (v > 0) { out.push({ fam: f.id, lv1: gap / v, reason, lvl: RULES.stageJump ? L : L0 }); break; }
      }
    }
  };
  // 住房、粮食、幸福：目标 = 需求 × needMargin（留一点富余）。都够了的话，就补“富余比例最低”的那一项，免得一直发同一种
  const M = RULES.needMargin;
  const cats: [keyof Row, number, number, string][] = [
    ['housing', future, e.housing, '住房'],
    ['food', e.foodNeed, e.foodProd, '粮食'],
    ['happy', e.happyNeed - e.happyBuildings, e.happyProd, '幸福'],
  ];
  if (e.goodsNeed > 0) cats.push(['goods', e.goodsNeed, e.goodsProd, '生活用品']);
  for (const [k, dem, sup, why] of cats) add(k, dem * M - sup, why);
  if (!out.length) {
    const [k, dem, , why] = cats.reduce((a, b) => (b[2] / Math.max(1, b[1]) < a[2] / Math.max(1, a[1]) ? b : a));
    add(k, Math.max(1, dem * 0.1), why);
  }
  // 补上面这些缺口的建筑自己也要吃原料（祭坛吃木）：按吃得最多的那种算进原料缺口
  const implied: Partial<Record<ResKey, number>> = {};
  for (const n of out) for (const [k, v] of Object.entries(lv1Row(n.fam, n.lvl))) if ((MATERIALS as string[]).includes(k) && v! < 0) implied[k as ResKey] = Math.max(implied[k as ResKey] ?? 0, n.lv1 * -v!);
  // 原料：净缺口；库存撑不过 3 回合时按整个缺口算，否则减半
  for (const k of MATERIALS) {
    const gap = e.matDemand[k] - e.matProd[k] + (implied[k] ?? 0) - Math.max(0, s.res[k]) / 10;
    if (gap > 0) add(k, s.res[k] < gap * 3 ? gap + 1 : gap / 2, `原料·${RES_INFO[k].name}`);
  }
  // 村庄中心进入新时代要原料
  const next = CORE_LEVELS[s.coreLevel + 1];
  if (next?.cost) for (const [k, v] of Object.entries(next.cost) as [ResKey, number][]) if (s.res[k] < v) add(k, Math.max(1, (v - s.res[k]) / (e.settled >= next.settled * (s.coreLevel + 1 >= 3 ? RULES.coreSettledMult : 1) * 0.7 ? 5 : 20)), `升级·${RES_INFO[k].name}`);
  // 同一种建筑按多个原因合并
  const m = new Map<string, { fam: string; lv1: number; reason: string; lvl: number }>();
  for (const n of out) {
    const o = m.get(n.fam);
    if (!o || n.lv1 > o.lv1) m.set(n.fam, n);
  }
  return [...m.values()].sort((a, b) => b.lv1 - a.lv1);
}

/** 本回合卡牌价值（几座 Lv1），按这回合的人口增长 */
export function arrivalValue(s: State) {
  // 这次选卡对应大回合里的第几个小回合：按那时的人口估算增长
  const k = RULES.turnsPerRound - Math.max(1, s.picksLeft);
  let pop = s.pop;
  for (let t = 0; t < k; t++) pop += popGrowth(s.turn + t, pop);
  return Math.max(RULES.arrivalMin, RULES.arrivalPerPop * popGrowth(s.turn + k, pop));
}
/** 价值 V 的卡发几级：保证同种至少 bundleMinCount 座 */
export function bundleLevel(s: State, V: number) {
  let lvl = 1;
  while (lvl + 1 <= levelCap(s) && V / Math.pow(MERGE.count, lvl) >= RULES.bundleMinCount) lvl++;
  return lvl;
}

/** 后面年代建筑种类多了，卡里多发几座（等级不变）。2026-11-27 Rex 提议：× (1 + arrivalPerFamily × (开放的种类 − 开局种类)) */
export const arrivalMore = (s: State) => 1 + RULES.arrivalPerFamily * Math.max(0, pool(s).length - RULES.arrivalBaseFamilies);

export function genOffer(s: State): Card[] {
  const r = () => rand(s);
  const V0 = arrivalValue(s);
  const minLvl = RULES.oldLevelFillOnly ? Math.min(levelCap(s), RULES.eraCardLevel[s.era] ?? 1) : 1;
  const lvl = Math.max(minLvl, bundleLevel(s, V0));
  const V = V0 * arrivalMore(s);
  const countAt = (fam: string, L: number) => Math.max(1, Math.round(V / Math.pow(MERGE.count, L - baseLevel(fam))));
  /** 旧时代等级只补齐：这种建筑低于 minLvl 的等级里，差几座凑满 3 座就补几座 */
  const fill = (fam: string): Item[] => {
    const out: Item[] = [];
    // fillRemainders：比这张卡等级低的各级，差几座凑满 3 座就补几座（不管时代）
    const upTo = RULES.fillRemainders ? lvl : minLvl;
    for (let L = 1; L < upTo; L++) {
      const n = s.buildings.filter((b) => !b.core && b.fam === fam && b.lvl === L).length % MERGE.count;
      if (n > 0) for (let i = n; i < MERGE.count; i++) out.push({ fam, lvl: L });
    }
    return out;
  };
  const ns = needs(s);
  const fams = pool(s);
  const cards: Card[] = [];
  const used = new Set<string>();
  // 前几张：最大的几个缺口；没缺口就随机
  for (let i = 0; i < RULES.cardChoices - 1; i++) {
    const n = ns.find((x) => !used.has(x.fam));
    const fam = n?.fam ?? fams.filter((f) => !used.has(f.id))[Math.floor(r() * Math.max(1, fams.length - used.size))]?.id ?? fams[0].id;
    used.add(fam);
    const f = fill(fam);
    const L = Math.max(n?.lvl ?? 0, famLevel(s, fam, lvl)), count = countAt(fam, L);
    if (f.length) cards.push({ kind: 'mixed', items: [...f, ...Array.from({ length: count }, () => ({ fam, lvl: L }))] });
    else cards.push({ kind: 'bundle', fam, lvl: L, count, reason: n?.reason ?? '随机' });
  }
  // 最后一张：按缺口比例混合
  const items: Item[] = [];
  const w = ns.length ? ns.map((n) => n.lv1) : fams.map(() => 1);
  const ids = ns.length ? ns.map((n) => n.fam) : fams.map((f) => f.id);
  const lvOf = ns.length ? ns.map((n) => n.lvl) : fams.map(() => 0);
  const total = w.reduce((a, b) => a + b, 0);
  // 按价值发：起始级别高的建筑一座顶好几座
  for (let left = V; left > 0 || !items.length; ) {
    let x = r() * total, k = 0;
    while (k < w.length - 1 && (x -= w[k]) > 0) k++;
    const L = Math.max(lvOf[k], famLevel(s, ids[k], lvl));
    items.push({ fam: ids[k], lvl: L });
    left -= itemValue({ fam: ids[k], lvl: L });
  }
  if (minLvl > 1 || RULES.fillRemainders) for (const fam of new Set(items.map((x) => x.fam))) items.unshift(...fill(fam));
  cards.push({ kind: 'mixed', items });
  return cards;
}

export function chooseCard(s: State, idx: number): string | null {
  if (!s.offer) return '本回合已经选过了';
  const c = s.offer[idx];
  if (!c) return '没有这张卡';
  s.picksLeft = Math.max(0, s.picksLeft - 1);
  s.offer = null;
  const items = cardItems(c).sort((a, b) => b.lvl - a.lvl);
  for (const it of items) { s.stats.arrived++; land(s, it); }
  if (s.picksLeft > 0) s.offer = genOffer(s); // 大回合里还有选卡机会
  return null;
}

// ---------- 结算 ----------

const tierMult = (ratio: number) => {
  let m = RULES.tiers[RULES.tiers.length - 1].mult;
  for (const t of RULES.tiers) if (ratio >= t.min) { m = t.mult; break; }
  return m;
};

/**
 * 计算一回合的收支（不改状态）。pop 可以传下回合的人口做预测。
 * 生产顺序：先算不吃原料的建筑，再算吃原料的（同一层按比例分原料，电厂这种既吃又产的先于用电的）。
 */
export function economy(s: State, pop = s.pop): Economy {
  const mult = s.mult;
  const stock = { ...s.res };
  const matProd = zero(), matDemand = zero(), matUsed = zero();
  const run: Record<number, number> = {};
  let foodProd = 0, goodsProd = 0, housing = 0, happyProd = 0, happyBuildings = 0;
  const isMat = (k: string) => (MATERIALS as string[]).includes(k);
  const consumers: Building[] = [];
  for (const b of s.buildings) {
    const row = rowOfB(b);
    const ins = Object.entries(row).filter(([k, v]) => isMat(k) && v! < 0);
    if (ins.length) { consumers.push(b); continue; }
    run[b.id] = 1;
    for (const [k, v] of Object.entries(row) as [keyof Row, number][]) {
      if (k === 'housing') housing += v;
      else if (k === 'food') foodProd += v * mult;
      else if (k === 'goods') goodsProd += v * mult;
      else if (k === 'happy') { if (v > 0) happyProd += v * mult; else happyBuildings += v; }
      else if (isMat(k)) { matProd[k as ResKey] += v * mult; stock[k as ResKey] += v * mult; }
    }
  }
  // 分层：产出别人要吃的原料的消费者（电厂）先算
  const producesInput = (b: Building) => Object.entries(rowOfB(b)).some(([k, v]) => isMat(k) && v! > 0);
  // 用电的产原料建筑（Lv9+ 矿）排在电厂后面；电厂吃的煤不够就先用库存（差一回合）
  const usesPower = (b: Building) => (rowOfB(b).power ?? 0) < 0;
  const layers = [
    consumers.filter((b) => producesInput(b) && !usesPower(b)),
    consumers.filter((b) => producesInput(b) && usesPower(b)),
    consumers.filter((b) => !producesInput(b)),
  ];
  for (const layer of layers) {
    const dem = zero();
    for (const b of layer) for (const [k, v] of Object.entries(rowOfB(b))) if (isMat(k) && v! < 0) dem[k as ResKey] += -v!;
    const ratio: Partial<Record<ResKey, number>> = {};
    for (const k of MATERIALS) if (dem[k] > 0) ratio[k] = Math.min(1, Math.max(0, stock[k]) / dem[k]);
    for (const b of layer) {
      const row = rowOfB(b);
      let r = 1;
      for (const [k, v] of Object.entries(row)) if (isMat(k) && v! < 0) r = Math.min(r, ratio[k as ResKey]!);
      run[b.id] = r;
      for (const [k, v] of Object.entries(row) as [keyof Row, number][]) {
        if (isMat(k) && v < 0) { matDemand[k as ResKey] += -v; matUsed[k as ResKey] += -v * r; }
      }
    }
    for (const b of layer) {
      const r = run[b.id];
      for (const [k, v] of Object.entries(rowOfB(b)) as [keyof Row, number][]) {
        if (isMat(k) && v < 0) stock[k as ResKey] -= -v * r;
        else if (isMat(k) && v > 0) { matProd[k as ResKey] += v * r * mult; stock[k as ResKey] += v * r * mult; }
        else if (k === 'food') foodProd += v * r * mult;
        else if (k === 'goods') goodsProd += v * r * mult;
        else if (k === 'happy') { if (v > 0) happyProd += v * r * mult; else happyBuildings += v; }
        else if (k === 'housing') housing += v;
      }
    }
  }
  const foodNeed = pop * RULES.foodPerPerson;
  const fed = Math.min(pop, foodProd / RULES.foodPerPerson);
  const hungry = Math.max(0, pop - fed);
  const homeless = Math.max(0, pop - housing);
  const happyNeed = pop * happyPerPerson(s);
  const goodsNeed = pop * goodsPerPerson(s);
  // 生活用品不够：缺的那部分按“缺几个人的份”扣幸福
  const goodsShort = goodsNeed > 0 ? Math.max(0, pop * (1 - goodsProd / goodsNeed)) : 0;
  const happyPenalty = homeless * RULES.homelessPenalty + hungry * RULES.hungerPenalty + goodsShort * RULES.goodsPenalty;
  const happy = happyProd + happyBuildings - happyNeed - happyPenalty;
  const happyRatio = RULES.happyPerPop ? happy / Math.max(1, pop) : happy;
  const settled = Math.floor(Math.min(pop, housing, fed));
  for (const k of MATERIALS) stock[k] = Math.max(0, Math.round(stock[k] * 100) / 100);
  stock.food = 0;
  return { mult, foodProd, foodNeed, hungry, goodsProd, goodsNeed, goodsShort, housing, homeless, happyProd, happyBuildings, happyNeed, happyPenalty, happy, happyRatio, settled, matProd, matDemand, matUsed, run, stockAfter: stock };
}

/** 村庄中心升级：换大占地；压到的建筑按落地规则挪走（挪不下进仓库） */
function upgradeCore(s: State) {
  const c = core(s);
  const lvl = s.coreLevel + 1;
  const [w0, h0] = footprint(lvl);
  const shapes = w0 === h0 ? [[w0, h0]] : [[w0, h0], [h0, w0]];
  const bd = ownedBounds(s);
  const occ = occupancy(s);
  let best: Spot | null = null, bestKey: number[] | null = null;
  for (const [w, h] of shapes)
    for (let y = bd.y0; y <= bd.y0 + bd.h - h; y++)
      for (let x = bd.x0; x <= bd.x0 + bd.w - w; x++) {
        let ok = true, blocked = 0;
        for (let yy = y; yy < y + h && ok; yy++)
          for (let xx = x; xx < x + w; xx++) {
            if (!cellOwned(s, xx, yy)) { ok = false; break; }
            const id = occ[yy * s.size + xx];
            if (id && id !== c.id) blocked++;
          }
        if (!ok) continue;
        const sp = { x, y, w, h };
        const key = [blocked, rectDist(sp, c), Math.abs(x - c.x) + Math.abs(y - c.y)];
        if (!bestKey || lexLess(key, bestKey)) { best = sp; bestKey = key; }
      }
  if (!best) return false;
  const sp = best;
  const over = (b: Spot) => b.x < sp.x + sp.w && sp.x < b.x + b.w && b.y < sp.y + sp.h && sp.y < b.y + b.h;
  const pushed = s.buildings.filter((b) => b !== c && over(b));
  s.buildings = s.buildings.filter((b) => !pushed.includes(b));
  Object.assign(c, sp, { lvl });
  s.coreLevel = lvl;
  const prevEra = s.era;
  s.era = CORE_LEVELS[lvl].era;
  if (s.era > prevEra) s.eraTurn = s.turn;
  s.stats.coreTurn[lvl] = s.turn;
  s.log.unshift(`第 ${s.turn} 回合：村庄中心升级为 ${CORE_LEVELS[lvl].name}${s.era > prevEra ? `，进入${ERAS[s.era].name}时代` : ''}${pushed.length ? `，挪开 ${pushed.length} 座建筑` : ''}`);
  for (const b of pushed.sort((a, b) => b.lvl - a.lvl)) land(s, { fam: b.fam, lvl: b.lvl });
  mergeAll(s);
  return true;
}

export interface TurnReport { econ: Economy; growth: number; coreUp: boolean; over: boolean }

/** 结束回合：没选卡自动选第一张；结算；村庄中心检查升级；人口增长；发下一回合的行动力、仓库落地、新卡 */
/** 结束（大）回合：没选完的卡自动选第一张；连续结算 turnsPerRound 个小回合；然后一次发下一个大回合的行动力和卡 */
export function endTurn(s: State): TurnReport {
  while (s.offer) chooseCard(s, 0);
  let rep: TurnReport | null = null;
  for (let i = 0; i < RULES.turnsPerRound && !s.over; i++) rep = resolveSmallTurn(s);
  const keep = Math.min(s.ap, RULES.apCarryMax);
  s.stats.apWasted += s.ap - keep;
  const base = apPerTurn(s) * RULES.turnsPerRound;
  s.ap = keep + base;
  s.stats.apBase += base;
  releaseWarehouse(s);
  if (!s.over) autoFillLow(s);
  s.picksLeft = s.over ? 0 : RULES.turnsPerRound;
  s.offer = s.over ? null : genOffer(s);
  s.log = s.log.slice(0, 80);
  return rep!;
}

/** 一个小回合的结算：生产、幸福、失败线、村庄中心升级、人口增长 */
function resolveSmallTurn(s: State): TurnReport {
  const e = economy(s);
  for (const k of MATERIALS) s.res[k] = e.stockAfter[k];
  s.happy = e.happy;
  s.mult = tierMult(e.happyRatio);
  // 缺口统计
  const g = s.stats.gapTurns;
  if (e.homeless > 0) g.housing = (g.housing ?? 0) + 1;
  if (e.hungry > 0) g.food = (g.food ?? 0) + 1;
  if (e.goodsShort > 0) g.goods = (g.goods ?? 0) + 1;
  if (e.happyProd + e.happyBuildings < e.happyNeed) g.happy = (g.happy ?? 0) + 1;
  for (const k of MATERIALS) if (e.matDemand[k] > 0 && e.matUsed[k] < e.matDemand[k] - 1e-6) g[k] = (g[k] ?? 0) + 1;
  // 失败线
  if (e.happyRatio < RULES.failLine) { s.danger++; s.stats.dangerTurns++; } else s.danger = 0;
  if (s.danger >= RULES.failTurns) {
    s.over = true;
    s.log.unshift(`第 ${s.turn} 回合：幸福度连续 ${s.danger} 回合低于失败线，Game Over`);
  }
  // 村庄中心：安居人口够了、原料够了就自动升级
  let coreUp = false;
  const next = CORE_LEVELS[s.coreLevel + 1];
  if (!s.over && next && e.settled >= next.settled * (s.coreLevel + 1 >= 3 ? RULES.coreSettledMult : 1)) {
    const cost = next.cost ?? {};
    if ((Object.entries(cost) as [ResKey, number][]).every(([k, v]) => s.res[k] >= v)) {
      for (const [k, v] of Object.entries(cost) as [ResKey, number][]) s.res[k] -= v;
      coreUp = upgradeCore(s);
    }
  }
  const growth = popGrowth(s.turn, s.pop);
  s.pop += growth;
  s.turn++;
  return { econ: e, growth, coreUp, over: s.over };
}

// ---------- 开局 ----------

export interface NewGameOpts {
  seed?: number;
  /** 关卡间买的开局建筑（最高比村庄中心低 META_SHOP.maxLevelBelowCore 级，超出的会被降级） */
  loadout?: Item[];
}

export function newGame(opts: NewGameOpts = {}): State {
  const seed = opts.seed ?? Date.now();
  const plot = RULES.plotSize, wp = RULES.worldPlots, size = plot * wp;
  const mid = Math.floor(wp / 2);
  const owned = Array.from({ length: wp * wp }, () => false);
  owned[mid * wp + mid] = true;
  const s: State = {
    seed, plot, wp, size, owned,
    turn: 1,
    pop: RULES.startPop,
    res: { ...zero(), ...RULES.startRes } as Record<ResKey, number>,
    buildings: [], nextId: 1,
    coreLevel: 1, era: 1, eraTurn: 1,
    ap: 0, warehouse: [], offer: null, picksLeft: RULES.turnsPerRound, lastPlaced: null,
    mult: 1, happy: 0, danger: 0, over: false, log: [],
    stats: { apBase: 0, apRefund: 0, apSell: 0, apMove: 0, apPlot: 0, apWasted: 0, merges: 0, landingMerges: 0, combos: 0, arrived: 0, toWarehouse: 0, lost: 0, sold: 0, plotsBought: 0, gapTurns: {}, dangerTurns: 0, coreTurn: [], lvTurn: [] },
    rs: seed >>> 0,
  };
  const c0 = Math.floor(plot / 2) - 1;
  s.buildings.push({ id: s.nextId++, fam: 'core', lvl: 1, core: true, x: mid * plot + c0, y: mid * plot + c0, w: 1, h: 1 });
  s.stats.coreTurn[1] = 1;
  const items: Item[] = RULES.startBuildings.map((fam) => ({ fam, lvl: 1 }));
  for (const it of opts.loadout ?? []) items.push({ fam: it.fam, lvl: Math.max(1, Math.min(it.lvl, s.coreLevel - META_SHOP.maxLevelBelowCore)) });
  for (const it of items) land(s, it);
  s.lastPlaced = null;
  s.ap = apPerTurn(s) * RULES.turnsPerRound;
  s.stats.apBase += s.ap;
  s.offer = genOffer(s);
  s.log.unshift('部落在一块土地上点燃了村庄中心。');
  return s;
}

export const cloneState = (s: State): State => structuredClone(s);

export { FAMILY };
