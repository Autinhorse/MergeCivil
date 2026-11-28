// v10 地图模拟器：真实格子、落地规则、移动凑合并、连锁、仓库、买地，三种水平的机器人。
// 用法：
//   npm run sim10                      → 三种机器人各跑 N 局（默认 20），并和“无限行动力”对比
//   npm run sim10 -- expert 3          → 熟练机器人、种子 3，逐回合打印
//   SET=apBase=6,popPerTurn=0.1 npm run sim10   → 临时改 RULES 里的数值（数字/true/false）
//   BOTS=normal,expert N=40 TURNS=250 npm run sim10
//   NOINF=1 跳过无限行动力对比；CSV=out.csv 把每局结果写成表
import { writeFileSync } from 'node:fs';
import { CORE, CORE_LEVELS, ERAS, FAMILIES, FAMILY, MATERIALS, MERGE, RES_INFO, RULES, startBase, lv1Row } from '../src/v10/data';
import {
  buyPlot, buyablePlots, cardItems, resourceLights, resourceRatios, hooks, footprint, ownedBounds, byId, cellOwned, type Item, cells, chooseCard, economy, endTurn, fits, freeCells, groupOf, levelCap, moveCost, move, needs,
  newGame, occupancy, ownedCount, plotAp, plotQuota, previewMove, sellWarehouse, touching, type Building, type Card, type State,
} from '../src/v10/game';

// ---------- 命令行改数值 ----------
const R = RULES as unknown as Record<string, unknown>;
if (process.env.SET)
  for (const kv of process.env.SET.split(',')) {
    const [k0, v] = kv.split('=');
    // CORE.xxx 改村庄中心相关参数（比如 CORE.plotsPerLevel=2），其余改 RULES
    const [obj, k] = k0.startsWith('CORE.') ? [CORE as unknown as Record<string, unknown>, k0.slice(5)] : k0.startsWith('MERGE.') ? [MERGE as unknown as Record<string, unknown>, k0.slice(6)] : [R, k0];
    if (k0.startsWith('W.')) { const f = FAMILY[k0.slice(2)]; if (!f) throw new Error(`没有建筑 ${k0}`); f.weight = Number(v); continue; } // W.house=2 改出现权重
    if (!(k in obj)) throw new Error(`没有参数 ${k0}`);
    obj[k] = v === 'true' ? true : v === 'false' ? false : isNaN(Number(v)) ? v : Number(v);
  }

// FAMS_OFF=pasture,theatre 去掉某些建筑种类（试“减少建筑种类”）
if (process.env.FAMS_OFF) {
  const off = new Set(process.env.FAMS_OFF.split(','));
  for (let i = FAMILIES.length - 1; i >= 0; i--) if (off.has(FAMILIES[i].id)) FAMILIES.splice(i, 1);
}

type Bot = 'novice' | 'normal' | 'expert';
const BOT_NAME: Record<Bot, string> = { novice: '新手（随便挑卡，不挪建筑，只靠落地合并）', normal: '普通（按缺口挑卡，挪 1 座就能合的最便宜先合）', expert: '熟练（挑卡凑合并、预览连锁、两步布局、存行动力买地）' };

// ---------- 找合并走法 ----------
interface MoveOpt { id: number; x: number; y: number; rot: boolean; cost: number; group: number }

/** 所有“挪 1 座就能凑成 3 座相邻”的走法（不管行动力够不够） */
/**
 * 所有“挪 1 座就能凑成 3 座”的走法。2026-11-28 提速（Rex）：按“种类:等级”缓存每座建筑的最好走法，
 * 移动/合并/落地以后只重算附近有变动的种类；每个大回合开始（新建筑落地后）整体重算一次。
 * 结果和每次全量重算完全一样（顺序也一样）。
 */
type Rect = { x: number; y: number; w: number; h: number };
const mmCache = new WeakMap<State, { snap: Map<number, string>; opt: Map<number, MoveOpt | null>; owned: number; members: Map<string, string> }>();
const rectKey = (b: Building) => `${b.fam}:${b.lvl}:${b.x}:${b.y}:${b.w}:${b.h}`;
function resetMergeCache(s: State) { mmCache.delete(s); }
function mergeMoves(s: State): MoveOpt[] {
  const cap = levelCap(s);
  const kinds = new Map<string, Building[]>();
  for (const b of s.buildings) if (!b.core && b.lvl + 1 <= cap) { const k = `${b.fam}:${b.lvl}`; (kinds.get(k) ?? kinds.set(k, []).get(k)!).push(b); }
  // 跟上次比：哪些建筑新增/挪动/消失了
  let cache = mmCache.get(s);
  const snap = new Map<number, string>(s.buildings.map((b) => [b.id, rectKey(b)]));
  const changed: Rect[] = [];
  if (cache) {
    for (const b of s.buildings) if (cache.snap.get(b.id) !== snap.get(b.id)) { changed.push(b); const o = cache.snap.get(b.id); if (o) { const [, , x, y, w, h] = o.split(':').map(Number); changed.push({ x, y, w, h }); } }
    for (const [id, k] of cache.snap) if (!snap.has(id)) { const [, , x, y, w, h] = k.split(':').map(Number); changed.push({ x, y, w, h }); }
  } else cache = { snap, opt: new Map(), owned: -1, members: new Map() };
  // 买了地（能放的地方变了）就整体重算
  const full = !mmCache.has(s) || cache.owned !== ownedCount(s);
  const members = new Map([...kinds].map(([k, l]) => [k, l.map((b) => b.id).join(',')]));
  const oldMembers = cache.members;
  mmCache.set(s, { snap, opt: cache.opt, owned: ownedCount(s), members });
  const near = (a: Rect, b: Rect, m: number) => a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;
  let occ: Int32Array | null = null;
  const out: MoveOpt[] = [];
  for (const list of kinds.values()) {
    if (list.length < MERGE.count) continue;
    const F = Math.max(list[0].w, list[0].h) + 1;
    const kk = `${list[0].fam}:${list[0].lvl}`;
    const dirty = full || oldMembers.get(kk) !== members.get(kk) || list.some((o) => !cache!.opt.has(o.id) || changed.some((c) => near(o, c, F)));
    for (const m of list) {
      if (!dirty) { const o = cache.opt.get(m.id); if (o) out.push(o); continue; }
      occ ??= occupancy(s);
      let best: MoveOpt | null = null;
      if (groupOf(s, m).length >= MERGE.count) best = { id: m.id, x: m.x, y: m.y, rot: false, cost: 0, group: groupOf(s, m).length }; // 已经连好：原地点一下就合（自动补齐的零头）
      else {
        const ign = new Set([m.id]);
        const shapes: [number, number, boolean][] = m.w === m.h ? [[m.w, m.h, false]] : [[m.w, m.h, false], [m.h, m.w, true]];
        for (const o of list) {
          if (o === m) continue;
          for (const [w, h, rot] of shapes)
            for (let y = o.y - h; y <= o.y + o.h; y++)
              for (let x = o.x - w; x <= o.x + o.w; x++) {
                const sp = { x, y, w, h };
                if (!touching(sp, o) || !fits(s, x, y, w, h, ign, occ)) continue;
                const old = { x: m.x, y: m.y, w: m.w, h: m.h };
                Object.assign(m, sp);
                const g = groupOf(s, m).length;
                Object.assign(m, old);
                if (g >= MERGE.count && (!best || g > best.group)) best = { id: m.id, x, y, rot, cost: moveCost(m), group: g };
              }
        }
      }
      cache.opt.set(m.id, best);
      if (best) out.push(best);
    }
  }
  return out;
}
function setupMove(s: State): MoveOpt | null {
  const cap = levelCap(s);
  const kinds = new Map<string, Building[]>();
  for (const b of s.buildings) if (!b.core && b.lvl + 1 <= cap) { const k = `${b.fam}:${b.lvl}`; (kinds.get(k) ?? kinds.set(k, []).get(k)!).push(b); }
  const occ = occupancy(s);
  let best: MoveOpt | null = null;
  for (const list of kinds.values()) {
    if (list.length < MERGE.count || list.some((b) => groupOf(s, b).length >= 2)) continue;
    const m = list.reduce((a, b) => (cells(a) <= cells(b) ? a : b));
    for (const o of list) {
      if (o === m) continue;
      for (let y = o.y - m.h; y <= o.y + o.h; y++)
        for (let x = o.x - m.w; x <= o.x + o.w; x++)
          if (touching({ x, y, w: m.w, h: m.h }, o) && fits(s, x, y, m.w, m.h, new Set([m.id]), occ)) {
            const c = moveCost(m);
            if (!best || c < best.cost) best = { id: m.id, x, y, rot: false, cost: c, group: 2 };
          }
    }
  }
  return best;
}

// ---------- 机器人 ----------
interface TurnLog { apBlocked: boolean; plotBlocked: boolean; quotaBlocked: boolean }

function pickCard(s: State, bot: Bot): number {
  const offer = s.offer!;
  if (bot === 'novice') return Math.floor(((s.turn * 7919 + s.seed) % 997) / 997 * offer.length);
  // 熟练：按缺口打分，再加“落地就能凑成 3 座”的分
  const ns = needs(s);
  const need = new Map(ns.map((n) => [n.fam, n.lv1]));
  // 覆盖的缺口（每种建筑最多算到它的缺口为止）+ 一点“落地凑成 3 座”的分
  const score = (c: Card) => {
    const its = cardItems(c);
    const val = new Map<string, number>();
    const add = new Map<string, number>();
    for (const it of its) {
      val.set(it.fam, (val.get(it.fam) ?? 0) + Math.pow(MERGE.count * MERGE.produceGain, it.lvl - startBase(it.fam)));
      const k = `${it.fam}:${it.lvl}`;
      add.set(k, (add.get(k) ?? 0) + 1);
    }
    let v = 0;
    for (const [fam, x] of val) v += Math.min(need.get(fam) ?? 0, x);
    for (const [k, n] of add) {
      const have = s.buildings.filter((b) => `${b.fam}:${b.lvl}` === k).length;
      if (bot === 'expert') v += Math.floor((have % MERGE.count + n) / MERGE.count) * 0.3;
    }
    return v;
  };
  const sc = offer.map(score);
  return sc.indexOf(Math.max(...sc));
}

const LIGHTS = process.env.LIGHTS !== '0';
const PICK = process.env.PICK ?? 'priority'; // priority = Rex 的规则；old = 合并次数×10+返还−花费
const PRI_RED = Number(process.env.PRI_RED ?? 100), PRI_RED_BASE = Number(process.env.PRI_RED_BASE ?? 20), PRI_YELLOW = Number(process.env.PRI_YELLOW ?? 10);
const LIGHT_RED = Number(process.env.LIGHT_RED ?? 30), LIGHT_YELLOW = Number(process.env.LIGHT_YELLOW ?? 10);
function doMerges(s: State, bot: Bot, tl: TurnLog) {
  if (bot === 'novice') return;
  for (let guard = 0; guard < 60; guard++) {
    const opts = mergeMoves(s);
    const ok = opts.filter((o) => o.cost <= s.ap);
    if (!ok.length) {
      if (opts.length) tl.apBlocked = true;
      // 熟练：剩下的行动力做两步布局（留够下一步的钱：下回合还能接着合）
      if (bot === 'expert') {
        const sm = setupMove(s);
        if (sm && sm.cost <= s.ap - plotReserve(s)) { move(s, sm.id, sm.x, sm.y, sm.rot); continue; }
      }
      return;
    }
    let pick: MoveOpt;
    if (bot === 'normal') pick = ok.reduce((a, b) => (a.cost <= b.cost ? a : b));
    else {
      // 熟练：预览最便宜的几个，选“合并次数 × 10 + 返还 − 花费”最高的。
      // 2026-11-28 Rex：资源有黄/红时，优先合能补这项资源的建筑（红 +LIGHT_RED，黄 +LIGHT_YELLOW）
      const lights = LIGHTS ? resourceLights(s) : {};
      const bad = Object.entries(lights).filter(([, v]) => v !== 'g');
      const fix = (c: MoveOpt) => {
        if (!bad.length) return 0;
        const b = byId(s, c.id)!;
        const row = lv1Row(b.fam, b.lvl + 1) as Record<string, number | undefined>;
        let v = 0;
        for (const [k, l] of bad) if ((row[k] ?? 0) > 0) v += l === 'r' ? LIGHT_RED : LIGHT_YELLOW;
        return v;
      };
      if (PICK === 'priority') {
        // 2026-11-28 Rex 的规则：① 净赚行动力（返还 > 花费）最多的 ② 不亏的 ③ 都亏时：红色资源按缺口大小、黄色按离变红多近打分，分高的先合；
        // 都是绿的（没分）就挑亏得最少的
        const ratios = resourceRatios(s);
        const urgency = (c: MoveOpt) => {
          const b = byId(s, c.id)!;
          const row = lv1Row(b.fam, b.lvl + 1) as Record<string, number | undefined>;
          let u = 0;
          for (const [k, r] of Object.entries(ratios)) {
            if ((row[k] ?? 0) <= 0) continue;
            if (r < 1) u += PRI_RED * (1 - r) + PRI_RED_BASE; // 红：差得越多越优先
            else if (r < RULES.lightGreen) u += PRI_YELLOW * (RULES.lightGreen - r) / (RULES.lightGreen - 1); // 黄：越接近变红越高
          }
          return u;
        };
        const pool = [...ok].sort((a, b) => fix(b) - fix(a) || a.cost - b.cost).slice(0, 16);
        const ev = pool.map((c) => {
          const pv = previewMove(s, c.id, c.x, c.y, c.rot);
          return { c, net: pv.merges.reduce((a, m) => a + m.refund, 0) - c.cost, n: pv.merges.length, u: urgency(c) };
        });
        const gain = ev.filter((x) => x.net > 0).sort((a, b) => b.net - a.net || b.n - a.n);
        const even = ev.filter((x) => x.net === 0).sort((a, b) => b.u - a.u || b.n - a.n);
        const loss = ev.filter((x) => x.net < 0).sort((a, b) => b.u - a.u || b.net - a.net);
        const best = gain[0] ?? even[0] ?? loss[0];
        { const pc = ((s.stats as unknown as { pick?: Record<string, number> }).pick ??= {}); const tier = gain.length ? 'gain' : even.length ? 'even' : best.u > 0 ? 'lossFix' : 'loss'; pc[tier] = (pc[tier] ?? 0) + 1; pc.opts = (pc.opts ?? 0) + ev.length; pc.n = (pc.n ?? 0) + 1; if (ev.some((x) => x.u > 0)) pc.anyU = (pc.anyU ?? 0) + 1; }
        // 亏行动力、又不补任何红黄资源的合并：留够买地的钱才做
        if (!gain.length && !even.length && best.u <= 0 && best.c.cost > s.ap - plotReserve(s)) return;
        move(s, best.c.id, best.c.x, best.c.y, best.c.rot);
        continue;
      }
      const cand = [...ok].sort((a, b) => fix(b) - fix(a) || a.cost - b.cost).slice(0, 8);
      let bestV = -Infinity;
      pick = cand[0];
      for (const c of cand) {
        const pv = previewMove(s, c.id, c.x, c.y, c.rot);
        const v = pv.merges.length * 10 + pv.merges.reduce((a, m) => a + m.refund, 0) - c.cost + fix(c);
        if (v > bestV) { bestV = v; pick = c; }
      }
      if (pick.cost > s.ap - plotReserve(s) && bestV < 10) return;
    }
    move(s, pick.id, pick.x, pick.y, pick.rot);
  }
}

/** 熟练机器人想买地时，留着不花的行动力 */
function plotReserve(s: State) {
  return wantsPlot(s, 'expert') && ownedCount(s) < plotQuota(s) ? Math.min(RULES.apCarryMax, plotAp(s)) : 0;
}
function wantsPlot(s: State, bot: Bot) {
  const total = ownedCount(s) * s.plot * s.plot;
  return freeCells(s) / total < (bot === 'expert' ? 0.3 : 0.15) || s.warehouse.length > 0;
}

function tryPlot(s: State, bot: Bot, tl: TurnLog) {
  if (!wantsPlot(s, bot)) return;
  if (ownedCount(s) >= plotQuota(s)) { tl.quotaBlocked = true; return; }
  if (s.ap < plotAp(s)) { tl.plotBlocked = true; return; }
  const plots = buyablePlots(s);
  if (plots.length) buyPlot(s, plots[0]);
}

function trySell(s: State, bot: Bot) {
  if (bot === 'novice') return;
  // 仓库里的东西本回合落不了地：普通在仓库满时卖，熟练直接卖
  const used = s.warehouse.length;
  if (bot === 'normal' && used < 3) return;
  while (s.warehouse.length) sellWarehouse(s, 0);
}

// ---------- 一局 ----------
const TURNS = Number(process.env.TURNS ?? 200);

interface Result {
  rounds: number;
  endReason: { ap: number; none: number; other: number; apLeftWhenNone: number }; lvHist: number[]; buildings: number; freeCells: number;
  maxLv: Record<string, number>;
  bot: Bot; seed: number; turns: number; died: boolean; pop: number; coreLevel: number; era: number; plots: number;
  stats: State['stats'];
  apBlockedTurns: number; plotBlockedTurns: number; quotaBlockedTurns: number;
  cause: string; deathMix: Record<string, number>;
}

/**
 * 腾位置（2026-11-27 Rex）：新建筑放不下时，找一块 w×h 的地方，把压在上面的小建筑挪到别处空地，
 * 行动力 = 被挪建筑的格数。选总花费最少、行动力付得起的那块。只挪普通建筑，不挪村庄中心。
 */
const MAKE_ROOM = process.env.MAKE_ROOM !== '0';
function makeRoom(s: State, it: Item): boolean {
  const roomStats = ((s.stats as unknown as { room?: Record<string, number> }).room ??= { tries: 0, ok: 0, moved: 0, ap: 0 });
  roomStats.tries++;
  if (s.ap <= 0) return false;
  // 局面没变（建筑位置、行动力、地块都一样）时，同一级建筑上次腾不出来，这次也腾不出来
  let h = s.ap * 31 + ownedCount(s);
  for (const b of s.buildings) h = (h * 33 + b.id * 7 + b.x * 131 + b.y * 17 + b.w) | 0;
  const fk = `${it.lvl}:${h}`;
  const failed = ((s as unknown as { _roomFail?: Set<string> })._roomFail ??= new Set());
  if (failed.has(fk)) return false;
  if (failed.size > 5000) failed.clear();
  const [w0, h0] = footprint(it.lvl);
  const shapes = w0 === h0 ? [[w0, h0]] : [[w0, h0], [h0, w0]];
  const bd = ownedBounds(s);
  const N = s.size;
  const occ = new Int32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (!cellOwned(s, x, y)) occ[y * N + x] = -2;
  for (const b of s.buildings) for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) occ[y * N + x] = b.id;
  const cost = new Map(s.buildings.map((b) => [b.id, b.core ? Infinity : moveCost(b)]));
  // 1) 列出所有候选块和它的花费（被压建筑格数），按花费从小到大
  const cands: { x: number; y: number; w: number; h: number; c: number; ids: number[] }[] = [];
  for (const [w, h] of shapes)
    for (let y = bd.y0; y <= bd.y0 + bd.h - h; y++)
      for (let x = bd.x0; x <= bd.x0 + bd.w - w; x++) {
        const ids = new Set<number>();
        let c = 0, ok = true;
        for (let yy = y; yy < y + h && ok; yy++)
          for (let xx = x; xx < x + w; xx++) {
            const id = occ[yy * N + xx];
            if (id === -2) { ok = false; break; }
            if (id && !ids.has(id)) { ids.add(id); c += cost.get(id)!; if (c > s.ap) { ok = false; break; } }
          }
        if (ok && ids.size) cands.push({ x, y, w, h, c, ids: [...ids] });
      }
  cands.sort((a, b) => a.c - b.c);
  // 2) 从便宜的试起：被挪的建筑都要在这块以外找到空地
  const free = (o: Int32Array, x: number, y: number, w: number, h: number) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (o[yy * N + xx]) return false;
    return true;
  };
  for (const cd of cands.slice(0, 40)) {
    const o2 = occ.slice();
    for (const id of cd.ids) { const b = byId(s, id)!; for (let yy = b.y; yy < b.y + b.h; yy++) for (let xx = b.x; xx < b.x + b.w; xx++) o2[yy * N + xx] = 0; }
    for (let yy = cd.y; yy < cd.y + cd.h; yy++) for (let xx = cd.x; xx < cd.x + cd.w; xx++) o2[yy * N + xx] = -1;
    const plan: { id: number; x: number; y: number; rot: boolean }[] = [];
    let ok = true;
    for (const id of [...cd.ids].sort((a, b) => cells(byId(s, b)!) - cells(byId(s, a)!))) {
      const b = byId(s, id)!;
      let spot: { x: number; y: number; rot: boolean } | null = null;
      for (const rot of b.w === b.h ? [false] : [false, true]) {
        const bw = rot ? b.h : b.w, bh = rot ? b.w : b.h;
        for (let yy = bd.y0; yy <= bd.y0 + bd.h - bh && !spot; yy++)
          for (let xx = bd.x0; xx <= bd.x0 + bd.w - bw; xx++) if (free(o2, xx, yy, bw, bh)) { spot = { x: xx, y: yy, rot }; break; }
        if (spot) break;
      }
      if (!spot) { ok = false; break; }
      const bw = spot.rot ? b.h : b.w, bh = spot.rot ? b.w : b.h;
      for (let yy = spot.y; yy < spot.y + bh; yy++) for (let xx = spot.x; xx < spot.x + bw; xx++) o2[yy * N + xx] = id;
      plan.push({ id, ...spot });
    }
    if (!ok) continue;
    for (const p of plan) {
      if (!byId(s, p.id)) continue; // 前面挪动触发了合并，这座已经合掉了
      const r = move(s, p.id, p.x, p.y, p.rot);
      if (r.err) return false;
      roomStats.moved++;
    }
    roomStats.ok++;
    roomStats.ap += cd.c;
    return true;
  }
  failed.add(fk);
  return false;
}

function play(bot: Bot, seed: number, verbose = false): Result {
  hooks.noSpot = MAKE_ROOM && bot !== 'novice' ? makeRoom : undefined;
  const s = newGame({ seed });
  let apBlockedTurns = 0, plotBlockedTurns = 0, quotaBlockedTurns = 0;
  const recent: TurnLog[] = [];
  let lastEcon = economy(s);
  const endReason = { ap: 0, none: 0, other: 0, apLeftWhenNone: 0 };
  let rounds = 0;
  for (; s.turn <= TURNS && !s.over; rounds++) {
    const tl: TurnLog = { apBlocked: false, plotBlocked: false, quotaBlocked: false };
    resetMergeCache(s); // 每个大回合开始（新建筑落地后）整体重算一次
    trySell(s, bot);
    if (bot === 'expert') tryPlot(s, bot, tl);
    while (s.offer) {
      const i = pickCard(s, bot);
      if (process.env.PROBE) { const pk = ((s as unknown as { _picked?: Record<string, number> })._picked ??= {}); for (const it of cardItems(s.offer[i])) pk[it.fam] = (pk[it.fam] ?? 0) + Math.pow(3, it.lvl - 1); }
      chooseCard(s, i); doMerges(s, bot, tl);
    }
    tryPlot(s, bot, tl);
    if (bot !== 'novice') doMerges(s, bot, tl);
    {
      const left = mergeMoves(s);
      if (left.length && left.every((o) => o.cost > s.ap)) endReason.ap++;
      else if (!left.length) { endReason.none++; endReason.apLeftWhenNone += s.ap; }
      else endReason.other++;
    }
    if (tl.apBlocked) apBlockedTurns++;
    if (tl.plotBlocked) plotBlockedTurns++;
    if (tl.quotaBlocked) quotaBlockedTurns++;
    recent.push(tl);
    if (recent.length > 10) recent.shift();
    if (verbose) {
      const e = economy(s);
      const mats = MATERIALS.filter((k) => e.matDemand[k] > 0 || e.matProd[k] > 0).map((k) => `${RES_INFO[k].name}${Math.round(e.matProd[k])}/${Math.round(e.matDemand[k])}(${Math.round(s.res[k])})`).join(' ');
      console.log(`T${s.turn} ${CORE_LEVELS[s.coreLevel].name}L${s.coreLevel} ${ERAS[s.era].name} 地${ownedCount(s)} 人${Math.round(s.pop)} 住${Math.round(e.housing)} 粮${Math.round(e.foodProd)}/${Math.round(e.foodNeed)} 幸福${Math.round(e.happy)}(${(e.happyRatio).toFixed(2)}) ×${s.mult} 行动力剩${s.ap} 空格${freeCells(s)} 仓库${s.warehouse.length} 建筑${s.buildings.length} ${mats}${tl.apBlocked ? ' [行动力不够合并]' : ''}${tl.plotBlocked ? ' [行动力不够买地]' : ''}${tl.quotaBlocked ? ' [地块额度满]' : ''}`);
    }
    lastEcon = economy(s);
    endTurn(s);
  }
  // 输因：最后 10 回合里有没有“行动力不够”
  let cause = '存活到上限';
  const deathMix: Record<string, number> = {};
  if (s.over) {
    const e = lastEcon;
    const short = Math.max(0, e.happyNeed - e.happyProd - e.happyBuildings);
    const total = short + e.homeless * RULES.homelessPenalty + e.hungry * RULES.hungerPenalty + e.goodsShort * RULES.goodsPenalty || 1;
    deathMix['幸福供不上'] = short / total;
    deathMix['无家可归'] = (e.homeless * RULES.homelessPenalty) / total;
    deathMix['缺粮'] = (e.hungry * RULES.hungerPenalty) / total;
    deathMix['缺生活用品'] = (e.goodsShort * RULES.goodsPenalty) / total;
    const ap = recent.filter((x) => x.apBlocked || x.plotBlocked).length;
    const quota = recent.filter((x) => x.quotaBlocked).length;
    cause = ap >= 3 ? '行动力不够' : quota >= 3 ? '地块额度满（村庄中心没升级）' : '建筑/原料跟不上';
  }
  if (process.env.PROBE_ALL) {
    const m: Record<string, Record<number, number>> = {};
    for (const b of s.buildings) if (!b.core) ((m[b.fam] ??= {})[b.lvl] = (m[b.fam][b.lvl] ?? 0) + 1);
    console.log('PROBEALL ' + JSON.stringify(m));
  }
  if (process.env.PROBE) {
    const e = economy(s);
    const dist = (fam: string) => { const h: Record<number, number> = {}; for (const b of s.buildings) if (b.fam === fam && !b.core) h[b.lvl] = (h[b.lvl] ?? 0) + 1; return JSON.stringify(h); };
    const offered: Record<string, number> = (s as unknown as { _picked?: Record<string, number> })._picked ?? {};
    console.log(`PROBE seed${seed} T${s.turn} pop ${Math.round(s.pop)} housing ${Math.round(e.housing)} food ${Math.round(e.foodProd)} happyProd ${Math.round(e.happyProd)} need ${Math.round(e.happyNeed)} house ${dist('house')} field ${dist('field')} pasture ${dist('pasture')} picked ${JSON.stringify(offered)}`);
  }
  const lvHist: number[] = [];
  for (const b of s.buildings) if (!b.core) lvHist[b.lvl] = (lvHist[b.lvl] ?? 0) + 1;
  const maxLv: Record<string, number> = {};
  for (const b of s.buildings) if (!b.core) maxLv[b.fam] = Math.max(maxLv[b.fam] ?? 0, b.lvl);
  return { rounds, endReason, lvHist, buildings: s.buildings.length - 1, freeCells: freeCells(s), maxLv, bot, seed, turns: s.turn, died: s.over, pop: Math.round(s.pop), coreLevel: s.coreLevel, era: s.era, plots: ownedCount(s), stats: s.stats, apBlockedTurns, plotBlockedTurns, quotaBlockedTurns, cause, deathMix };
}

// ---------- 汇总 ----------
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const f1 = (n: number) => n.toFixed(1);
const pct = (n: number) => `${Math.round(n * 100)}%`;

function summary(rs: Result[], label: string) {
  const T = rs.map((r) => r.turns);
  const turnsTotal = T.reduce((a, b) => a + b, 0);
  const per = (f: (r: Result) => number) => f1(rs.reduce((a, r) => a + f(r), 0) / turnsTotal);
  console.log(`\n■ ${label}`);
  console.log(`  存活回合：平均 ${f1(avg(T))}（${Math.min(...T)}–${Math.max(...T)}），Game Over ${rs.filter((r) => r.died).length}/${rs.length}；最终人口平均 ${Math.round(avg(rs.map((r) => r.pop)))}，村庄中心平均 Lv${f1(avg(rs.map((r) => r.coreLevel)))}，地块 ${f1(avg(rs.map((r) => r.plots)))}`);
  const lv = [3, 5, 7, 9].map((L) => { const got = rs.filter((r) => r.stats.coreTurn[L]); return `Lv${L}（${ERAS[CORE_LEVELS[L].era].name}）${got.length}/${rs.length}${got.length ? ` 第${Math.round(avg(got.map((r) => r.stats.coreTurn[L])))}回合` : ''}`; });
  console.log(`  村庄中心升级：${lv.join('，')}`);
  console.log(`  行动力/回合：收入 基础 ${per((r) => r.stats.apBase)} + 合并返还 ${per((r) => r.stats.apRefund)} + 卖出 ${per((r) => r.stats.apSell)}；支出 移动 ${per((r) => r.stats.apMove)} + 买地 ${per((r) => r.stats.apPlot)}；浪费 ${per((r) => r.stats.apWasted)}`);
  console.log(`  “行动力不够”回合：合并 ${pct(avg(rs.map((r) => r.apBlockedTurns / r.turns)))}，买地 ${pct(avg(rs.map((r) => r.plotBlockedTurns / r.turns)))}；地块额度满 ${pct(avg(rs.map((r) => r.quotaBlockedTurns / r.turns)))}`);
  {
    const lw = (k: string) => f1(avg(rs.map((r) => r.stats.lostWhy?.[k] ?? 0)));
    const rm = (k: string) => f1(avg(rs.map((r) => (r.stats as unknown as { room?: Record<string, number> }).room?.[k] ?? 0)));
    console.log(`  腾位置（每局）：放不下 ${rm('tries')} 次，腾成 ${rm('ok')} 次，挪了 ${rm('moved')} 座，花行动力 ${rm('ap')}`);
    const wp = rs.map((r) => (r.stats as unknown as { whPeak?: number }).whPeak ?? 0);
    const we: Record<string, number> = {};
    for (const r of rs) { const e = (r.stats as unknown as { whPeakEra?: number }).whPeakEra; if (e) we[ERAS[e].name] = (we[ERAS[e].name] ?? 0) + 1; }
    console.log(`  仓库峰值：平均 ${f1(avg(wp))} 座，最多 ${Math.max(...wp)} 座；峰值出现的时代 ${Object.entries(we).map(([k, v]) => `${k}${v}局`).join('，')}`);
    console.log(`  丢弃原因（每局）：共 ${f1(avg(rs.map((r) => r.stats.lost)))} 座 = 地块额度满/没地可买 ${lw('quota')} + 有地可买但行动力不够 ${lw('ap')} + 买得起但没先买 ${lw('notBought')}；其中空格总数其实够、只是碎了放不下 ${lw('fragmented')}，建筑比仓库还大 ${lw('tooBigForWarehouse')}`);
  }
  {
    const nm: Record<string, string> = { housing: '住房', food: '粮食', happy: '幸福', goods: '生活用品', ...Object.fromEntries(MATERIALS.map((k) => [k, RES_INFO[k].name])) };
    const parts: string[] = [];
    for (const k of Object.keys(nm)) {
      let g = 0, y = 0, r = 0;
      for (const x of rs) { const c = (x.stats as unknown as { lights?: Record<string, Record<string, number>> }).lights?.[k]; if (c) { g += c.g; y += c.y; r += c.r; } }
      const n = g + y + r;
      if (n) parts.push(`${nm[k]} ${pct(g / n)}/${pct(y / n)}/${pct(r / n)}`);
    }
    console.log(`  资源绿/黄/红回合占比：${parts.join('，')}`);
    const pk = (k: string) => f1(avg(rs.map((r) => (r.stats as unknown as { pick?: Record<string, number> }).pick?.[k] ?? 0)));
    console.log(`  合并选择（每局）：决策 ${pk('n')} 次，平均每次可选 ${f1(Number(pk('opts')) / Math.max(1, Number(pk('n'))))} 种；选了净赚 ${pk('gain')}，不亏 ${pk('even')}，亏但补红黄 ${pk('lossFix')}，亏且全绿 ${pk('loss')}；有能补红黄的选项 ${pk('anyU')} 次`);
    const segs: [string, string][] = [['a', '1–10'], ['b', '11–30'], ['c', '31–60'], ['d', '61+']];
    const pp = segs.map(([k, lab]) => {
      const tot = [0, 0, 0, 0];
      for (const x of rs) { const r = (x.stats as unknown as { pressure?: Record<string, number[]> }).pressure?.[k]; if (r) r.forEach((v, i) => (tot[i] += v)); }
      return tot[0] ? `大回合 ${lab}：有黄 ${pct(tot[1] / tot[0])} 有红 ${pct(tot[2] / tot[0])} 两红 ${pct(tot[3] / tot[0])}` : '';
    }).filter(Boolean);
    console.log(`  压力曲线：${pp.join('；')}`);
  }
  console.log(`  ★ 每局一共出现建筑 ${f1(avg(rs.map((r) => r.stats.arrived + RULES.startBuildings.length)))} 座（开局 ${RULES.startBuildings.length} + 选卡 ${f1(avg(rs.map((r) => r.stats.arrived - (r.stats.autoFilled ?? 0))))} + 自动补齐 ${f1(avg(rs.map((r) => r.stats.autoFilled ?? 0)))}），合并 ${f1(avg(rs.map((r) => r.stats.merges + r.stats.landingMerges)))} 次（每大回合 ${f1(avg(rs.map((r) => (r.stats.merges + r.stats.landingMerges) / Math.max(1, r.rounds))))}；手动 ${f1(avg(rs.map((r) => r.stats.merges)))} + 落地自动 ${f1(avg(rs.map((r) => r.stats.landingMerges)))}），局末剩 ${f1(avg(rs.map((r) => r.buildings)))} 座`);
  console.log(`  每局：手动合并 ${f1(avg(rs.map((r) => r.stats.merges)))}，落地自动合并 ${f1(avg(rs.map((r) => r.stats.landingMerges)))}，连锁 ${f1(avg(rs.map((r) => r.stats.combos)))}，来了 ${f1(avg(rs.map((r) => r.stats.arrived)))} 座，进仓库 ${f1(avg(rs.map((r) => r.stats.toWarehouse)))}，丢掉 ${f1(avg(rs.map((r) => r.stats.lost)))}，卖出 ${f1(avg(rs.map((r) => r.stats.sold)))}`);
  const keys = ['housing', 'food', 'happy', ...MATERIALS];
  const nm: Record<string, string> = { housing: '住房', food: '粮食', happy: '幸福', ...Object.fromEntries(MATERIALS.map((k) => [k, RES_INFO[k].name])) };
  console.log(`  缺口出现的回合占比：${keys.map((k) => `${nm[k]} ${pct(avg(rs.map((r) => (r.stats.gapTurns[k] ?? 0) / r.turns)))}`).join('，')}`);
  const roundsTotal = rs.reduce((a, r) => a + r.rounds, 0);
  const er = (k: 'ap' | 'none' | 'other') => pct(rs.reduce((a, r) => a + r.endReason[k], 0) / roundsTotal);
  const noneTurns = rs.reduce((a, r) => a + r.endReason.none, 0);
  console.log(`  大回合结束时（每 ${RULES.turnsPerRound} 小回合一次，平均每局 ${f1(roundsTotal / rs.length)} 个大回合）：还有能合的但行动力不够 ${er('ap')}，没有挪 1 座就能合的了 ${er('none')}（这时平均还剩 ${f1(rs.reduce((a, r) => a + r.endReason.apLeftWhenNone, 0) / Math.max(1, noneTurns))} 点行动力），其他 ${er('other')}`);
  const maxL = Math.max(...rs.map((r) => r.lvHist.length - 1));
  console.log(`  局末各级建筑数量（平均）：${Array.from({ length: maxL }, (_, i) => i + 1).map((L) => `Lv${L} ${f1(avg(rs.map((r) => r.lvHist[L] ?? 0)))}`).join('，')}；共 ${f1(avg(rs.map((r) => r.buildings)))} 座，空格 ${f1(avg(rs.map((r) => r.freeCells)))}`);
  const K = RULES.turnsPerRound;
  const rd = (t: number) => Math.ceil((t - 1) / K);
  const lvr = [6, 8, 10].map((L) => { const got = rs.filter((r) => r.stats.lvTurn[L]); return `Lv${L} ${got.length}/${rs.length}${got.length ? ` 第 ${f1(avg(got.map((r) => rd(r.stats.lvTurn[L]))))} 大回合（${Math.min(...got.map((r) => rd(r.stats.lvTurn[L])))}–${Math.max(...got.map((r) => rd(r.stats.lvTurn[L])))}）` : ''}`; });
  console.log(`  第一次合出：${lvr.join('，')}；每局自动补齐 ${f1(avg(rs.map((r) => r.stats.autoFilled ?? 0)))} 座`);
  const top = rs.map((r) => Math.max(0, ...Object.values(r.maxLv)));
  console.log(`  局末最高建筑等级：平均 Lv${f1(avg(top))}，合到 Lv8+ 的局 ${top.filter((x) => x >= 8).length}/${rs.length}，Lv10+ 的局 ${top.filter((x) => x >= 10).length}/${rs.length}`);
  const fams = [...new Set(rs.flatMap((r) => Object.keys(r.maxLv)))];
  console.log(`  结束时各类建筑最高等级（平均 / 最高）：${fams.map((f) => { const xs = rs.map((r) => r.maxLv[f] ?? 0); return `${FAMILY[f].name} ${f1(avg(xs))}/${Math.max(...xs)}`; }).join('，')}`);
  const dead = rs.filter((r) => r.died);
  if (dead.length) {
    const causes: Record<string, number> = {};
    for (const r of dead) causes[r.cause] = (causes[r.cause] ?? 0) + 1;
    console.log(`  输因：${Object.entries(causes).map(([k, v]) => `${k} ${v}`).join('，')}`);
    const mix = ['幸福供不上', '无家可归', '缺粮', '缺生活用品'].map((k) => `${k} ${pct(avg(dead.map((r) => r.deathMix[k] ?? 0)))}`);
    console.log(`  死前一回合幸福缺口构成：${mix.join('，')}`);
  }
}

const [botArg, seedArg] = process.argv.slice(2);
if (seedArg) {
  const r = play(botArg as Bot, Number(seedArg), true);
  console.log(JSON.stringify({ ...r, stats: { ...r.stats, coreTurn: r.stats.coreTurn } }));
} else {
  const N = Number(process.env.N ?? 20);
  const bots = (process.env.BOTS?.split(',') ?? ['novice', 'normal', 'expert']) as Bot[];
  const all: (Result & { inf: boolean })[] = [];
  console.log(`v10 模拟：${N} 局 × ${bots.length} 种机器人，最多 ${TURNS} 回合${process.env.SET ? `，改动 ${process.env.SET}` : ''}`);
  for (const bot of bots) {
    const rs = Array.from({ length: N }, (_, i) => play(bot, i + 1));
    all.push(...rs.map((r) => ({ ...r, inf: false })));
    summary(rs, `${bot} · ${BOT_NAME[bot]}`);
    if (!process.env.NOINF) {
      // 对照：同样的种子，行动力无限。存活回合差得越多，说明“行动力不够”越是主要输因
      const save = { apBase: RULES.apBase, apCarryMax: RULES.apCarryMax };
      RULES.apBase = 999; RULES.apCarryMax = 0;
      const inf = Array.from({ length: N }, (_, i) => play(bot, i + 1));
      Object.assign(RULES, save);
      all.push(...inf.map((r) => ({ ...r, inf: true })));
      const a = avg(rs.map((r) => r.turns)), b = avg(inf.map((r) => r.turns));
      console.log(`  对照·无限行动力：存活平均 ${f1(b)} 回合，Game Over ${inf.filter((r) => r.died).length}/${N}（比正常多活 ${f1(b - a)} 回合，${b > a * 1.2 ? '行动力是主要限制' : '行动力不是主要限制'}）`);
    }
  }
  if (process.env.CSV) {
    const head = 'bot,inf_ap,seed,turns,died,cause,pop,core,era,plots,apBase,apRefund,apSell,apMove,apPlot,apWasted,merges,landingMerges,combos,arrived,toWarehouse,lost,sold,apBlockedTurns,plotBlockedTurns,quotaBlockedTurns';
    const rows = all.map((r) => [r.bot, r.inf ? 1 : 0, r.seed, r.turns, r.died ? 1 : 0, r.cause, r.pop, r.coreLevel, r.era, r.plots, r.stats.apBase, r.stats.apRefund, r.stats.apSell, r.stats.apMove, r.stats.apPlot, r.stats.apWasted, r.stats.merges, r.stats.landingMerges, r.stats.combos, r.stats.arrived, r.stats.toWarehouse, r.stats.lost, r.stats.sold, r.apBlockedTurns, r.plotBlockedTurns, r.quotaBlockedTurns].join(','));
    writeFileSync(process.env.CSV, [head, ...rows].join('\n'));
    console.log(`\n每局结果写到了 ${process.env.CSV}`);
  }
}
