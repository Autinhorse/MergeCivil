// 数据基准：Rex 的《建筑定义.xlsx》原始社会 → 青铜时代 → 铁器时代三段。
// 和表的差异（都是为了让三段能自洽地跑起来，详见设计文档“规则基准”一节）：
//  1. 田地的来源改为小块田地（表里写成了浆果树丛）。
//  2. 祭坛/图腾柱/神庙/圣殿（幸福感）、陶窑链、砖窑链暂不进原型：它们的产物在前三段没有消费者。
//  3. 城市核心不参与 3 合 1，而是原地升级（花一次性费用），核心等级决定时代和可买地块数。
//  4. 解锁条件“场上需要先有某建筑”改成“曾经拥有过就永久解锁”，前置建筑被合掉也不会丢资格。
//  5. 地图统一为平地，没有地形加成（2026-11-26 Rex 决定）。

export type ResKey = 'food' | 'wood' | 'stone' | 'copper' | 'bronze' | 'ironore' | 'iron' | 'gold';
export type Res = Partial<Record<ResKey, number>>;

export const RES_INFO: Record<ResKey, { name: string; icon: string; era: number }> = {
  food: { name: '粮食', icon: '🌾', era: 1 },
  wood: { name: '木材', icon: '🪵', era: 1 },
  stone: { name: '石头', icon: '🪨', era: 1 },
  copper: { name: '铜矿', icon: '🟤', era: 1 },
  bronze: { name: '青铜', icon: '🥉', era: 1 },
  ironore: { name: '铁矿', icon: '⛏️', era: 2 },
  iron: { name: '铁器', icon: '⚔️', era: 2 },
  gold: { name: '金币', icon: '🪙', era: 2 },
};

/** 第 n 级建筑的占地（下标 0 = 1 级） */
export const FOOTPRINTS: [number, number][] = [
  [1, 1], [1, 2], [2, 2], [2, 3], [3, 3], [3, 4], [4, 4], [4, 5], [5, 5],
];
export const MERGE_COUNT = 3;

export interface Family {
  id: string;
  name: string;
  color: string;
  core?: boolean;
  housing?: boolean;
}

export const FAMILIES: Family[] = [
  { id: 'core', name: '城市核心', color: '#f2c14e', core: true, housing: true },
  { id: 'house', name: '住房', color: '#e8a76b', housing: true },
  { id: 'field', name: '农田', color: '#f0d36b' },
  { id: 'pasture', name: '牧场', color: '#d6c27a' },
  { id: 'fish', name: '渔猎', color: '#7fb8c9' },
  { id: 'lumber', name: '伐木', color: '#a77b52' },
  { id: 'stone', name: '采石', color: '#a9a9b5' },
  { id: 'copper', name: '铜矿', color: '#b4785a' },
  { id: 'bronze', name: '青铜冶炼', color: '#c9925a' },
  { id: 'ironore', name: '铁矿', color: '#7d8796' },
  { id: 'iron', name: '铁匠', color: '#5f6b7a' },
  { id: 'market', name: '市集', color: '#d4a5c9' },
  { id: 'post', name: '驿站', color: '#c7a6e0' },
];

export interface Def {
  id: string;
  name: string;
  icon: string;
  family: string;
  lvl: number; // 1 起，决定占地
  era: number; // 表里的年代（1 原始 / 2 青铜 / 3 铁器），仅用于显示
  from?: string; // 由哪个建筑 3 合 1 而来
  unlock?: string; // 曾经拥有过这个建筑后才会进卡池
  workers: number;
  consume: Res; // 每回合开工投入
  produce: Res;
  housing?: number;
  aura?: { range: number; bonus: number }; // 驿站：周围 range 格内的生产建筑 +bonus
}

// 原料类建筑（粮、木、石、矿）的入门产出在表格数值上乘这个系数（地图统一为平地后补回原来的地形加成）。
export const RAW_OUTPUT = 1.4;
const RAW_FAMILIES = new Set(['field', 'pasture', 'fish', 'lumber', 'stone', 'copper', 'ironore']);

/**
 * 合并规则（2026-11-26 定）：
 *  1. 合成只增产、不加新原料：产出 = 3 座原建筑之和 × MERGE_GAIN，工人 = 3 座之和 × MERGE_WORKERS，
 *     投入 = 3 座原建筑投入之和。青铜、铁器的维护费只放在住房和城市核心上。
 *  2. 合并不换资源：采石场 → 切石场 → 石料作坊…一路产石头；青铜矿场等入门建筑由卡牌发放。
 * 所以表里每条链只保留入门建筑的数值，更高级的按规则推出来。
 */
// 调参脚本可以在导入前通过 globalThis.__TUNE 覆盖这几个系数
const TUNE: Record<string, number> = (globalThis as { __TUNE?: Record<string, number> }).__TUNE ?? {};
export const MERGE_GAIN = TUNE.gain ?? 1.2;
export const MERGE_WORKERS = TUNE.workers ?? 0.8; // 合成后工人 = 3 座之和 × 这个系数
export const HOUSING_GAIN = TUNE.housing ?? 1.2; // 住房合成：容量 = 3 座之和 × 这个系数
const r1 = (n: number) => Math.round(n * 10) / 10;
const scale = (r: Res, k: number): Res => Object.fromEntries(Object.entries(r).map(([key, v]) => [key, r1(v! * k)])) as Res;

type Base = Partial<Def> & Pick<Def, 'id' | 'name' | 'icon' | 'family' | 'lvl' | 'era'>;
const DEFS_: Def[] = [];
/** 入门建筑：数值来自表格 */
const entry = (o: Base): Def => {
  const def: Def = { workers: 0, consume: {}, produce: {}, ...o };
  if (RAW_FAMILIES.has(def.family)) def.produce = scale(def.produce, RAW_OUTPUT);
  DEFS_.push(def);
  return def;
};
/** 合成出来的建筑：数值按合并规则从上一级推出；extra 是住房/核心额外的维护（表里的值） */
const merged = (prev: Def, o: Pick<Def, 'id' | 'name' | 'icon'> & { era: number; consume?: Res; aura?: Def['aura'] }): Def => {
  const def: Def = {
    ...o,
    family: prev.family,
    lvl: prev.lvl + 1,
    from: prev.id,
    workers: Math.round(prev.workers * MERGE_COUNT * MERGE_WORKERS),
    produce: scale(prev.produce, MERGE_COUNT * MERGE_GAIN),
    consume: o.consume ?? scale(prev.consume, MERGE_COUNT),
  };
  if (prev.housing) def.housing = Math.round(prev.housing * MERGE_COUNT * HOUSING_GAIN);
  DEFS_.push(def);
  return def;
};
const chain = (first: Def, rest: (Pick<Def, 'id' | 'name' | 'icon'> & { era: number; consume?: Res; aura?: Def['aura'] })[]) =>
  rest.reduce<Def>((prev, o) => merged(prev, o), first);

// 住房和核心的维护（表里的值）：青铜、铁器只在这里出现
const M4: Res = { wood: 10, stone: 6, bronze: 1 };
const M5: Res = { stone: 35, bronze: 5, iron: 3 };

// 城市核心：原地升级，不合并（容量和维护直接用表里的值）
entry({ id: 'c1', name: '村庄中心', icon: '🔥', family: 'core', lvl: 1, era: 1, housing: 5 });
entry({ id: 'c2', name: '部落议事棚', icon: '🛖', family: 'core', lvl: 2, era: 1, from: 'c1', consume: { wood: 1 }, housing: 10 });
entry({ id: 'c3', name: '氏族长屋', icon: '🏚️', family: 'core', lvl: 3, era: 1, from: 'c2', consume: { wood: 3, stone: 2 }, housing: 40 });
entry({ id: 'c4', name: '城邦议事厅', icon: '🏛️', family: 'core', lvl: 4, era: 2, from: 'c3', consume: M4, housing: 140 });
entry({ id: 'c5', name: '卫城', icon: '🏯', family: 'core', lvl: 5, era: 3, from: 'c4', consume: M5, housing: 500 });

// 住房：容量按合并规则，维护用表里的值
chain(entry({ id: 'h1', name: '窝棚', icon: '⛺', family: 'house', lvl: 1, era: 1, housing: 5 }), [
  { id: 'h2', name: '小住房', icon: '🏠', era: 1, consume: { wood: 2, stone: 2 } },
  { id: 'h3', name: '住房', icon: '🏡', era: 1, consume: { wood: 4, stone: 4 } },
  { id: 'h4', name: '土坯房', icon: '🏘️', era: 2, consume: M4 },
  { id: 'h5', name: '石屋', icon: '🏰', era: 3, consume: M5 },
]);

// 粮食
chain(entry({ id: 'f1', name: '浆果树丛', icon: '🫐', family: 'field', lvl: 1, era: 1, workers: 1, produce: { food: 3 } }), [
  { id: 'f2', name: '小块田地', icon: '🌱', era: 1 },
  { id: 'f3', name: '田地', icon: '🌾', era: 1 },
  { id: 'f4', name: '灌溉农田', icon: '💧', era: 2 },
  { id: 'f5', name: '庄园农场', icon: '🏞️', era: 3 },
]);
chain(entry({ id: 'p3', name: '牧场', icon: '🐐', family: 'pasture', lvl: 3, era: 2, unlock: 'f3', workers: 5, consume: { wood: 3, stone: 2 }, produce: { food: 40 } }), [
  { id: 'p4', name: '畜栏', icon: '🐄', era: 2 },
  { id: 'p5', name: '大牧场', icon: '🐎', era: 3 },
]);
chain(entry({ id: 'x3', name: '渔猎营地', icon: '🎣', family: 'fish', lvl: 3, era: 2, unlock: 'w2', workers: 5, consume: { wood: 3, stone: 2 }, produce: { food: 40 } }), [
  { id: 'x4', name: '渔村', icon: '🛶', era: 2 },
  { id: 'x5', name: '渔港', icon: '⚓', era: 3 },
]);

// 木材
chain(entry({ id: 'w1', name: '收集木材', icon: '🪵', family: 'lumber', lvl: 1, era: 1, workers: 1, produce: { wood: 3 } }), [
  { id: 'w2', name: '伐木场', icon: '🪓', era: 1 },
  { id: 'w3', name: '木材工坊', icon: '🪚', era: 1 },
  { id: 'w4', name: '锯木坊', icon: '⚙️', era: 2 },
  { id: 'w5', name: '木工作坊', icon: '🏭', era: 3 },
]);

// 石头：一路合成都产石头
chain(entry({ id: 's1', name: '收集石头', icon: '🪨', family: 'stone', lvl: 1, era: 1, workers: 1, produce: { stone: 3 } }), [
  { id: 's2', name: '采石场', icon: '⛏️', era: 1 },
  { id: 'k3', name: '切石场', icon: '🧱', era: 1 },
  { id: 'k4', name: '石料作坊', icon: '🏗️', era: 2 },
  { id: 'k5', name: '大采石场', icon: '🏔️', era: 3 },
]);

// 铜矿：入门建筑由卡牌发放（有过采石场之后进卡池）
chain(entry({ id: 'cu3', name: '青铜矿场', icon: '🟤', family: 'copper', lvl: 3, era: 1, unlock: 's2', workers: 5, consume: { wood: 5, stone: 5 }, produce: { copper: 20 } }), [
  { id: 'cu4', name: '铜锡矿坑', icon: '🕳️', era: 2 },
  { id: 'cu5', name: '深层铜矿', icon: '🗻', era: 3 },
]);

// 青铜
chain(entry({ id: 'b3', name: '炼制工坊', icon: '🔥', family: 'bronze', lvl: 3, era: 2, unlock: 'cu3', workers: 5, consume: { copper: 20, wood: 3, stone: 2 }, produce: { bronze: 10 } }), [
  { id: 'b4', name: '青铜铸坊', icon: '🏺', era: 2 },
  { id: 'b5', name: '合金冶炼场', icon: '🧪', era: 3 },
]);

// 铁器时代（入门建筑去掉了表里的青铜维护，按规则 1 只放住房和核心）
chain(entry({ id: 'i4', name: '铁矿坑', icon: '⛰️', family: 'ironore', lvl: 4, era: 3, unlock: 'cu4', workers: 12, consume: { wood: 10, stone: 6 }, produce: { ironore: 140 } }), [
  { id: 'i5', name: '铁矿井', icon: '🏗️', era: 3 },
]);
chain(entry({ id: 't4', name: '铁匠铺', icon: '⚒️', family: 'iron', lvl: 4, era: 3, unlock: 'i4', workers: 12, consume: { ironore: 70, wood: 10, stone: 6 }, produce: { iron: 35 } }), [
  { id: 't5', name: '锻造坊', icon: '🗡️', era: 3 },
]);
chain(entry({ id: 'm4', name: '市集', icon: '🏪', family: 'market', lvl: 4, era: 3, unlock: 'h3', workers: 12, consume: { wood: 10, stone: 6 }, produce: { gold: 35 } }), [
  { id: 'm5', name: '集市广场', icon: '🎪', era: 3 },
]);
chain(entry({ id: 'y4', name: '驿站', icon: '🐴', family: 'post', lvl: 4, era: 3, unlock: 'm4', workers: 12, consume: { wood: 10, stone: 6 }, produce: { gold: 10 }, aura: { range: 2, bonus: 0.05 } }), [
  { id: 'y5', name: '驿馆', icon: '🏨', era: 3, aura: { range: 2, bonus: 0.1 } },
]);

export const DEFS: Def[] = DEFS_;

export const DEF: Record<string, Def> = Object.fromEntries(DEFS.map((x) => [x.id, x]));
/** 3 合 1 之后变成什么 */
export const NEXT: Record<string, string> = Object.fromEntries(DEFS.filter((x) => x.from && x.family !== 'core').map((x) => [x.from!, x.id]));
export const familyOf = (id: string) => FAMILIES.find((f) => f.id === DEF[id].family)!;

export interface Era {
  name: string;
  maxLevel: number; // 本时代能合成/拿到的最高等级
}
export const ERAS: Era[] = [
  { name: '', maxLevel: 0 },
  { name: '原始社会', maxLevel: 3 },
  { name: '青铜时代', maxLevel: 4 },
  { name: '铁器时代', maxLevel: 5 },
];
export const LAST_ERA = 3;

/** 核心升级：一次性费用 + 升到几级进入哪个时代。升到卫城即原型通关。 */
export const CORE_UPGRADES: Record<string, { cost: Res; era: number; goal: string; gift?: string[] }> = {
  c2: { cost: { wood: 30, stone: 10 }, era: 1, goal: '' },
  c3: { cost: { wood: 120, stone: 80 }, era: 1, goal: '', gift: (globalThis as { __GIFT3?: string[] }).__GIFT3 ?? ['cu3', 'cu3', 'b3'] },
  c4: { cost: { wood: 300, stone: 250, bronze: 40 }, era: 2, goal: '时代目标：用旧城产出第一批青铜', gift: (globalThis as { __GIFT4?: string[] }).__GIFT4 ?? ['i4', 't4'] },
  c5: { cost: { stone: 800, bronze: 200, iron: 60 }, era: 3, goal: '时代目标：打出第一批铁器' },
};

export const PLOT_SIZES = [6, 8, 10];
export const WORLD_PLOTS = 5;
/** 第 2、3、4… 块地的价格；超出列表后每块 ×2 */
export const PLOT_COSTS: Res[] = [
  { wood: 60, stone: 30 },
  { wood: 200, stone: 150 },
  { wood: 500, stone: 400, bronze: 30 },
  { stone: 1200, bronze: 100, gold: 200 },
];

/** 基础建筑可以花资源直接召唤 */
export const SHOP: Record<string, Res> = {
  f1: { wood: 4 },
  w1: { food: 4 },
  s1: { wood: 4, food: 2 },
  h1: { food: 5 },
};

export const RULES = {
  foodPerPerson: 1,
  startRes: { food: 20, wood: 20, stone: 5 } as Res,
  startPop: 4,
  popGrowth: 0.2,
  popGrowthMin: 2,
  growthFromStock: 0.05, // 人口增长可以动用多少比例的粮食库存
  // 选卡
  picksPerTurn: 1,
  apPlotBase: 5, // 买第 2 块地花的行动力；-1 表示花掉一整回合的行动力
  apPlotStep: 2, // 之后每块地多花几点
  coreCostMult: 1, // 核心升级费用倍数
  mergeHint: 4, // 发补缺口卡时，差 1 个就能凑满 3 个的对口建筑权重乘几
  rerollsPerTurn: 1, // 每回合免费重摇卡几次
  apReroll: 2, // 免费次数用完后，重摇一次花多少行动力
  cardValue: [0, 2, 3, 5, 10, 24], // 按核心等级：每张卡价值多少个 1 级建筑
  randomCardBonus: 1.3,
  maxFails: 3,
  // 行动力
  apPerTurn: 5,
  apPerEra: 1,
  maxMergeGroup: 9, // 一次最多合几个；合满这么多直接升 2 级
  // 连锁合并奖励：none = 照常返还；double = 连锁那一步返还翻倍；ramp = 第 n 次连锁返还 ×(n+1)
  comboMode: 'double' as 'none' | 'double' | 'ramp',
};
