// 用相同的随机种子对比两种打法：
//   A 紧凑：主要选补缺口和农田/伐木，能合就合，土地不够才买
//   B 早扩地：一有额度就买地，偏好牧场/渔猎/矿，合并前先看原料够不够，
//     也不会把最后 3 座采石场合成铜矿
// 用法：npm run sim            → 两种打法各跑 30 局
//       npm run sim -- A 3     → 打法 A、种子 3，打印过程
import { DEF, ERAS, NEXT, RES_INFO, RULES, type ResKey } from '../src/data';
import {
  buyablePlots, buyPlot, plotAp, canAfford, chooseCard, coreLevel, endTurn, groupOf, previewMove, touching, fits, occupancy, move, moveCost, maxLevel, newGame, nextCore,
  ownedCount, plotCost, plotQuota, previewCard, demolish, type Building, resolveTurn, summon, upgradeCore, reroll, type Card, type State,
} from '../src/game';

const PLOT = Number(process.env.PLOT ?? 8);

type Strategy = 'A' | 'B' | 'C';

function supplyOk(s: State, defId: string) {
  const d = DEF[defId];
  const p = resolveTurn(s, true);
  return (Object.keys(d.consume) as ResKey[]).every((k) => p.produced[k] - p.demand[k] >= d.consume[k]! * 0.5 || s.res[k] > d.consume[k]! * 15);
}

// 实验参数：CV=每级卡牌价值（逗号分隔），MH=发卡凑合并权重，GOAL=目标缺口回合数，WGAP=工人缺口阈值（需要/人口）
if (process.env.CV) RULES.cardValue = process.env.CV.split(',').map(Number);
if (process.env.FPP) RULES.foodPerPerson = Number(process.env.FPP);
if (process.env.POPG) RULES.popGrowth = Number(process.env.POPG);
if (process.env.HUP) {
  // 住房和核心的木、石维护乘 HUP
  const k = Number(process.env.HUP);
  for (const d of Object.values(DEF)) if (d.housing) for (const r of ['wood', 'stone'] as ResKey[]) if (d.consume[r]) d.consume[r] = d.consume[r]! * k;
}
if (process.env.CM) RULES.comboMode = process.env.CM as typeof RULES.comboMode;
if (process.env.AP) RULES.apPerTurn = Number(process.env.AP);
if (process.env.APE) RULES.apPerEra = Number(process.env.APE);
if (process.env.PICKS) RULES.picksPerTurn = Number(process.env.PICKS);
if (process.env.APP) { const [a, b] = process.env.APP.split(',').map(Number); RULES.apPlotBase = a; RULES.apPlotStep = b ?? 0; }
if (process.env.CORE) RULES.coreCostMult = Number(process.env.CORE);
if (process.env.MH) RULES.mergeHint = Number(process.env.MH);
const WGAP = Number(process.env.WGAP ?? 1e9);
const GOAL = Number(process.env.GOAL ?? 6);

const BASIC = new Set(['food', 'wood', 'stone']);
type TurnKind = 'calm' | 'merge' | 'fill' | 'card' | 'reroll' | 'stuck';
/** 缺口：欠供或库存撑不了几回合的资源 */
function gapsOf(s: State): string[] {
  const p = resolveTurn(s, true);
  const g: string[] = p.checks.filter((c) => !c.ok || c.warn).map((c) => c.key as string);
  if (p.workersNeeded > s.pop * WGAP) g.push('workers');
  // 目标缺口：下一次核心升级缺的资源，按现在的净产出 GOAL 回合内攒不够
  const n = nextCore(s);
  if (n)
    for (const [k, v] of Object.entries(n.cost) as [ResKey, number][]) {
      const lack = v - s.res[k];
      const net = p.produced[k] - p.demand[k];
      if (lack > 0 && (net <= 0 || lack / net > GOAL) && !g.includes(k)) g.push(k);
    }
  return g;
}
/** 缺口资源的净产出（工人缺口记成 -缺的人数） */
function netOf(s: State, keys: string[]): number[] {
  const p = resolveTurn(s, true);
  return keys.map((k) => (k === 'workers' ? s.pop - p.workersNeeded : p.produced[k as ResKey] - p.demand[k as ResKey]));
}
/** 至少一个缺口的净产出明显变好 */
function improved(a: number[], b: number[]): boolean {
  return a.some((x, i) => b[i] > x + Math.max(0.5, Math.abs(x) * 0.05));
}
/** 这张卡能不能补上缺口（产出缺的资源，且至少放得下一座） */
function helps(s: State, c: Card, gaps: string[]): boolean {
  const ids = c.kind === 'bundle' ? [c.def] : c.items;
  return previewCard(s, c).fit > 0 && ids.some((id) => Object.keys(DEF[id].produce).some((k) => gaps.includes(k)) || (gaps.includes('workers') && !!DEF[id].housing));
}

function scoreCard(c: Card, st: Strategy): number {
  if (c.kind === 'random') return 0.5;
  const fam = DEF[c.def].family;
  let v = c.tag === 'support' ? 2 : 0;
  if (st === 'A') v += ['field', 'lumber', 'house'].includes(fam) ? 1 : ['pasture', 'fish'].includes(fam) ? -1 : 0;
  else v += ['pasture', 'fish', 'copper', 'stone'].includes(fam) ? 1.5 : 0;
  return v;
}

/** 找一步“移动一个建筑就能凑成 3 个以上相邻”的走法；没有就返回 null */
function findMergeMove(s: State, st: Strategy): { id: number; x: number; y: number; rot: boolean; size: number; cost: number } | null {
  const occ = occupancy(s);
  let best: { id: number; x: number; y: number; rot: boolean; size: number; cost: number } | null = null;
  const byDef = new Map<string, Building[]>();
  for (const b of s.buildings) if (NEXT[b.def] && !DEF[b.def].family.startsWith('core')) (byDef.get(b.def) ?? byDef.set(b.def, []).get(b.def)!).push(b);
  for (const [def, list] of byDef) {
    if (list.length < 3) continue;
    const next = DEF[NEXT[def]];
    if (next.lvl > maxLevel(s) || (st === 'B' && !supplyOk(s, next.id))) continue;
    // 已经连成 3 个：原地放下就合（不花行动力）
    for (const b of list) {
      const g = groupOf(s, b).length;
      if (g >= 3 && (!best || g > best.size || (g === best.size && best.cost > 0))) best = { id: b.id, x: b.x, y: b.y, rot: false, size: g, cost: 0 };
    }
    for (const m of list) {
      const cost = moveCost(m);
      if (s.ap < cost) continue;
      const ign = new Set([m.id]);
      const shapes: [number, number, boolean][] = m.w === m.h ? [[m.w, m.h, false]] : [[m.w, m.h, false], [m.h, m.w, true]];
      for (const o of list) {
        if (o === m) continue;
        for (const [w, h, rot] of shapes)
          for (let y = o.y - h; y <= o.y + o.h; y++)
            for (let x = o.x - w; x <= o.x + o.w; x++) {
              const spot = { x, y, w, h };
              if (!touching(spot, o) || !fits(s, x, y, w, h, ign, occ)) continue;
              const old = { x: m.x, y: m.y, w: m.w, h: m.h };
              Object.assign(m, spot);
              const g = groupOf(s, m).length;
              Object.assign(m, old);
              if (g < 3) continue;
              if (st === 'C') {
                // 连锁型：用预览算出这一步总共能合几次、返还多少，优先连锁
                const pv = previewMove(s, m.id, x, y, rot);
                const score = pv.merges.length * 100 + pv.merges.reduce((a, q) => a + q.refund, 0) - cost;
                if (!best || score > best.size) best = { id: m.id, x, y, rot, size: score, cost };
              } else if (!best || g > best.size || (g === best.size && cost < best.cost)) best = { id: m.id, x, y, rot, size: g, cost };
            }
      }
    }
  }
  return best;
}

/** 把两个落单的同种建筑挪到一起（为下一步合并做准备），花行动力 */
function setupMove(s: State, st: Strategy): boolean {
  const byDef = new Map<string, Building[]>();
  for (const b of s.buildings) if (NEXT[b.def] && DEF[b.def].family !== 'core') (byDef.get(b.def) ?? byDef.set(b.def, []).get(b.def)!).push(b);
  const occ = occupancy(s);
  for (const [def, list] of [...byDef].sort((a, b) => DEF[a[0]].lvl - DEF[b[0]].lvl)) {
    if (list.length < 3 || DEF[NEXT[def]].lvl > maxLevel(s) || (st === 'B' && !supplyOk(s, NEXT[def]))) continue;
    // 已经有一对的话，就把第三个挪过来（findMergeMove 会处理）；这里只处理全都落单的情况
    if (list.some((b) => groupOf(s, b).length >= 2)) continue;
    const m = list[0];
    if (s.ap < moveCost(m) * 2) continue; // 留够下一步合并的行动力
    const o = list[1];
    for (let y = o.y - m.h; y <= o.y + o.h; y++)
      for (let x = o.x - m.w; x <= o.x + o.w; x++) {
        const spot = { x, y, w: m.w, h: m.h };
        if (touching(spot, o) && fits(s, x, y, m.w, m.h, new Set([m.id]), occ)) {
          move(s, m.id, x, y);
          return true;
        }
      }
  }
  return false;
}

function doMerges(s: State, st: Strategy) {
  for (let guard = 0; guard < 80; guard++) {
    const mv = findMergeMove(s, st);
    if (mv) {
      move(s, mv.id, mv.x, mv.y, mv.rot);
      continue;
    }
    if (!setupMove(s, st)) return;
  }
}

function freeRatio(s: State) {
  const used = s.buildings.reduce((a, b) => a + b.w * b.h, 0);
  return 1 - used / (ownedCount(s) * s.plot * s.plot);
}

function play(st: Strategy, seed: number, verbose = false) {
  const s = newGame(PLOT, seed);
  const eraTurn: number[] = [];
  const stuckKeys: Record<string, number> = {};
  type Ep = { start: number; merge: boolean; card: boolean; reroll: boolean };
  const open: Record<string, Ep> = {};
  const eps: { key: string; dur: number; by: string }[] = [];
  const closeEp = (k: string, t: number) => {
    const e = open[k];
    eps.push({ key: k, dur: t - e.start, by: e.merge ? 'merge' : e.reroll ? 'reroll' : e.card ? 'card' : 'self' });
    delete open[k];
  };
  const kindsBy = { basic: { calm: 0, merge: 0, fill: 0, card: 0, reroll: 0, stuck: 0 }, adv: { calm: 0, merge: 0, fill: 0, card: 0, reroll: 0, stuck: 0 } } as Record<'basic' | 'adv', Record<TurnKind, number>>;
  const tryBuy = () => {
    if (ownedCount(s) < plotQuota(s) && canAfford(s, plotCost(s)) && s.ap >= plotAp(s) && (st === 'B' || freeRatio(s) < 0.15)) {
      const plots = buyablePlots(s);
      if (plots.length) buyPlot(s, plots[0]);
    }
  };
  const tryUpgrade = () => {
    const n = nextCore(s);
    if (n && canAfford(s, n.cost)) {
      const era = s.era;
      let err = upgradeCore(s);
      if (err && (err.includes('空地') || err.includes('挪'))) {
        const c = s.buildings.find((b) => DEF[b.def].family === 'core')!;
        // 腾地方：等级最低的先拆，同级拆离核心近的
        const d = (b: { x: number; y: number }) => Math.abs(b.x - c.x) + Math.abs(b.y - c.y);
        const near = s.buildings.filter((b) => b !== c && DEF[b.def].lvl < maxLevel(s)).sort((a, b) => DEF[a.def].lvl - DEF[b.def].lvl || d(a) - d(b));
        for (const v of near.slice(0, 12)) {
          demolish(s, v.id);
          err = upgradeCore(s);
          if (!err) break;
        }
      }
      if (!err && s.era > era) eraTurn[s.era] = s.turn;
    }
  };
  for (let t = 0; t < 120; t++) {
    tryUpgrade();
    if (s.won) break;
    tryBuy();
    // 回合分类：先看缺口，先合并，合并不够再选卡，卡里没有对症的就重摇
    // 回合分类：先看缺口，先合并，合并不够再选卡，卡里没有对口的就重摇
    const gaps0 = gapsOf(s);
    const sets = { basic: gaps0.filter((k) => BASIC.has(k)), adv: gaps0.filter((k) => !BASIC.has(k)) };
    const snap = () => ({ basic: netOf(s, sets.basic), adv: netOf(s, sets.adv) });
    const n0 = snap();
    doMerges(s, st);
    const n1 = snap();
    let rerolled = false;
    while (s.picks > 0 && s.offer) {
      const gaps = gapsOf(s);
      for (let k = 0; gaps.length && k < 3 && !s.offer.some((c) => helps(s, c, gaps)); k++) {
        if (reroll(s)) break;
        rerolled = true;
      }
      const scores = s.offer.map((c) => {
        const f = previewCard(s, c);
        return (scoreCard(c, st) + 1 + (helps(s, c, gaps) ? 3 : 0)) * (f.fit / Math.max(1, f.total));
      });
      const best = scores.indexOf(Math.max(...scores));
      // 放不下才临时合并腾地方；平时把合并留到“看缺口再合”
      const f = previewCard(s, s.offer[best]);
      if (f.fit < f.total) doMerges(s, st);
      chooseCard(s, best);
    }
    const n2 = snap();
    doMerges(s, st); // 选完卡把凑齐的合掉
    const n3 = snap();
    // 缺口事件：从出现到消失算一次，记下期间靠什么改善
    const nowKeys = [...sets.basic, ...sets.adv];
    for (const k of Object.keys(open)) if (!nowKeys.includes(k)) { closeEp(k, t); }
    const idx = (k: string) => (BASIC.has(k) ? ['basic', sets.basic.indexOf(k)] : ['adv', sets.adv.indexOf(k)]) as ['basic' | 'adv', number];
    for (const k of nowKeys) {
      const ep = (open[k] ??= { start: t, merge: false, card: false, reroll: false });
      const [c, i] = idx(k);
      const up = (a: number[], b: number[]) => b[i] > a[i] + Math.max(0.5, Math.abs(a[i]) * 0.05);
      if (up(n0[c], n1[c]) || up(n2[c], n3[c])) ep.merge = true;
      if (up(n1[c], n2[c])) { ep.card = true; if (rerolled) ep.reroll = true; }
    }
    if (t < 40)
      for (const cat of ['basic', 'adv'] as const) {
        if (!sets[cat].length) { kindsBy[cat].calm++; continue; }
        const kind: TurnKind = improved(n0[cat], n1[cat])
          ? 'merge'
          : improved(n2[cat], n3[cat]) && improved(n0[cat], n3[cat])
            ? (rerolled ? 'reroll' : 'fill')
            : improved(n0[cat], n3[cat])
              ? (rerolled ? 'reroll' : 'card')
              : 'stuck';
        kindsBy[cat][kind]++;
        if (kind === 'stuck') for (const k of sets[cat]) stuckKeys[k] = (stuckKeys[k] ?? 0) + 1;
      }
    tryUpgrade();
    if (s.won) break;
    tryBuy();
    // 太挤就拆掉最小、最不缺的建筑
    if (freeRatio(s) < 0.12) {
      const p0 = resolveTurn(s, true);
      // 先拆闲置的：没人干活的、多余的空房
      for (const b of [...s.buildings]) if (p0.status[b.id] === 'noWorkers' && DEF[b.def].lvl <= 3) demolish(s, b.id);
      let spare = p0.housing - s.pop * 1.3;
      for (const b of s.buildings.filter((x) => DEF[x.def].family === 'house').sort((a, b) => DEF[a.def].lvl - DEF[b.def].lvl))
        if (spare > (DEF[b.def].housing ?? 0)) { spare -= DEF[b.def].housing!; demolish(s, b.id); }
      const surplus = (id: string) => { const k = Object.keys(DEF[id].produce)[0] as ResKey; return k ? p0.produced[k] - p0.demand[k] : -1e9; };
      const victims = s.buildings.filter((b) => DEF[b.def].lvl === 1 && DEF[b.def].family !== 'core' && !DEF[b.def].housing).sort((a, b) => surplus(b.def) - surplus(a.def));
      for (const v of victims.slice(0, 3)) demolish(s, v.id);
      // 还是挤：拆掉产出富余资源、等级落后两级以上的建筑
      if (freeRatio(s) < 0.08) {
        const cap = maxLevel(s);
        const old = s.buildings.filter((b) => DEF[b.def].family !== 'core' && DEF[b.def].lvl <= cap - 2 && surplus(b.def) > 0).sort((a, b) => surplus(b.def) - surplus(a.def));
        for (const v of old.slice(0, 4)) demolish(s, v.id);
      }
    }
    const p = resolveTurn(s, true);
    for (const c of p.checks)
      if (!c.ok || c.warn) {
        const id = ({ food: 'f1', wood: 'w1', stone: 's1' } as Record<string, string>)[c.key];
        if (id) summon(s, id);
      }
    if (p.workersNeeded > s.pop || s.pop >= p.housing) summon(s, 'h1');
    if (verbose && s.turn <= 12) {
      const pp = resolveTurn(s, true);
      const cnt: Record<string, number> = {};
      for (const b of s.buildings) { const k = DEF[b.def].name + (pp.status[b.id] === 'noWorkers' ? '(缺人)' : pp.status[b.id] === 'noInput' ? '(缺料)' : ''); cnt[k] = (cnt[k] ?? 0) + 1; }
      console.log('T', s.turn, 'pop', s.pop, '/', pp.housing, 'need', pp.workersNeeded, pp.checks.map((c) => c.label + c.detail).join(' | '), JSON.stringify(cnt));
    }
    if (process.env.TRACE) {
      const pp = resolveTurn(s, true);
      const cnt = (pre: string) => s.buildings.filter((b) => b.def.startsWith(pre)).map((b) => b.def).join('');
      console.log('TR', s.turn, '核心', coreLevel(s), 'bronze', Math.round(s.res.bronze), '+', Math.round(pp.produced.bronze), '-', Math.round(pp.demand.bronze), 'copper', Math.round(s.res.copper), '+', Math.round(pp.produced.copper), '-', Math.round(pp.demand.copper), 'pop', s.pop, 'need', pp.workersNeeded, cnt('b'), cnt('cu'), 'gaps', gapsOf(s).join(','));
    }
    endTurn(s);
    if (verbose && s.turn % 5 === 0)
      console.log(s.turn, ERAS[s.era].name, '核心', coreLevel(s), '地', ownedCount(s), 'pop', s.pop, 'fails', s.fails,
        Object.entries(s.res).filter(([, v]) => v).map(([k, v]) => `${RES_INFO[k as ResKey].name}${Math.round(v)}`).join(' '));
    if (s.over) break;
  }
  if (verbose) { const cnt: Record<string, number> = {}; for (const b of s.buildings) cnt[b.def] = (cnt[b.def] ?? 0) + 1; console.log('END', JSON.stringify(cnt), 'free', freeRatio(s).toFixed(2), 'seen', [...s.seen].join(','), 'offer', JSON.stringify(s.offer?.map((c: any) => c.label ?? c))); }
  for (const k of Object.keys(open)) eps.push({ key: k, dur: 99, by: 'open' });
  return { eps, stuckKeys, kindsBy, won: s.won, turn: s.turn, fails: s.fails, eraTurn, ...s.stats, plots: ownedCount(s), over: s.over };
}

const [stArg, seedArg] = process.argv.slice(2);
if (seedArg) {
  console.log(play(stArg as Strategy, Number(seedArg), true));
} else {
  const N = Number(process.env.N ?? 30);
  for (const st of (stArg ? [stArg] : ['A', 'B']) as Strategy[]) {
    const rs = Array.from({ length: N }, (_, i) => play(st, i + 1));
    const wins = rs.filter((r) => r.won);
    console.log('   没通关的种子：', rs.map((r, i) => (r.won ? 0 : i + 1)).filter(Boolean).join(','));
    const avg = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : '-');
    const reached = (e: number) => rs.filter((r) => r.eraTurn[e]);
    console.log(`打法 ${st}${st === 'A' ? '（紧凑、见合就合）' : st === 'B' ? '（早扩地、先看原料再合）' : '（追连锁）'}：通关 ${wins.length}/${N}，通关平均 ${avg(wins.map((r) => r.turn))} 回合`);
    console.log(`   进青铜 ${reached(2).length}/${N}（平均第 ${avg(reached(2).map((r) => r.eraTurn[2]))} 回合），进铁器 ${reached(3).length}/${N}（平均第 ${avg(reached(3).map((r) => r.eraTurn[3]))} 回合），Game Over ${rs.filter((r) => r.over).length}`);
    console.log(`   每局平均：合并 ${avg(rs.map((r) => r.merges))} 次，主动不合 ${avg(rs.map((r) => r.skippedMerges))} 次，选非补缺口卡 ${avg(rs.map((r) => r.nonSupportPicks))} 次，买地 ${avg(rs.map((r) => r.plotsBought))} 块`);
    console.log(`   [${PLOT}x${PLOT} 平地] 卡牌放不下丢掉 ${avg(rs.map((r) => r.lost))} 个/局，结束时 ${avg(rs.map((r) => r.turn))} 回合`);
    for (const cat of ['basic', 'adv'] as const) {
      const K = { calm: 0, merge: 0, fill: 0, card: 0, reroll: 0, stuck: 0 } as Record<TurnKind, number>;
      for (const r of rs) for (const k of Object.keys(K) as TurnKind[]) K[k] += r.kindsBy[cat][k];
      const all = Object.values(K).reduce((a, b) => a + b, 0), gapT = all - K.calm;
      const pc = (n: number, d: number) => `${Math.round((n / Math.max(1, d)) * 100)}%`;
      console.log(`   ${cat === 'basic' ? '基础缺口（粮木石）' : '进阶缺口（铜青铜铁金）'}：出现在 ${pc(gapT, all)} 的回合；其中 直接合并改善 ${pc(K.merge, gapT)}，选卡补齐再合并 ${pc(K.fill, gapT)}，选卡改善 ${pc(K.card, gapT)}，重摇后改善 ${pc(K.reroll, gapT)}，没改善 ${pc(K.stuck, gapT)}`);
    }
    for (const cat of ['basic', 'adv'] as const) {
      const E = rs.flatMap((r) => r.eps).filter((e) => BASIC.has(e.key) === (cat === 'basic'));
      const n = E.length || 1;
      const by = (b: string) => `${Math.round((E.filter((e) => e.by === b).length / n) * 100)}%`;
      const quick = `${Math.round((E.filter((e) => e.dur <= 3).length / n) * 100)}%`;
      console.log(`   ${cat === 'basic' ? '基础' : '进阶'}缺口事件 ${(E.length / N).toFixed(1)} 次/局：有合并参与 ${by('merge')}，靠重摇 ${by('reroll')}，只靠选卡 ${by('card')}，自己消失 ${by('self')}，到最后没解决 ${by('open')}；3 回合内解决 ${quick}`);
    }
    const per = (f: (r: (typeof rs)[number]) => number) => (rs.reduce((a, r) => a + f(r), 0) / rs.reduce((a, r) => a + r.turn, 0)).toFixed(1);
    console.log(`   行动力（每回合平均）：移动花 ${per((r) => r.apMove)}，合并返还 ${per((r) => r.apRefund)}，卖出返还 ${per((r) => r.apSell)}，买地 ${per((r) => r.apPlot)}，回合末没用完 ${per((r) => r.apWasted)}；每局合并 ${avg(rs.map((r) => r.merges))} 次，其中连锁 ${avg(rs.map((r) => r.combos))} 次，卖出 ${avg(rs.map((r) => r.sold))} 座`);
    console.log(`   每局重摇 ${avg(rs.map((r) => r.rerolls))} 次`);
    console.log('   （回合分类只统计前 40 回合）');
    const SK: Record<string, number> = {};
    for (const r of rs) for (const [k, v] of Object.entries(r.stuckKeys)) SK[k] = (SK[k] ?? 0) + v;
    console.log('   没改善的缺口（回合数）：', JSON.stringify(SK));
    console.log(`   欠供失败共 ${rs.reduce((a, r) => a + r.fails, 0)} 次，其中结算前预览已经能看到的 ${rs.reduce((a, r) => a + r.warnedBeforeFail, 0)} 次`);
  }
}
