// v10 数值表（全部是占位值，调平衡只改这个文件）。
// 规则来源：《合并文明 · 核心循环设计 v10》+ 2026-11-27 讨论补充：
//  - 回合制；人口每回合自然增长，不管玩家做什么
//  - 资源：人口、粮食、住房、原料（分开记）、幸福；对局内没有金币、没有工人
//  - 村庄中心不合并，"安居人口"达到门槛自动升级；其他建筑等级不超过它
//  - 新建筑给得充足，落地不花行动力；行动力只用于移动、旋转、买地
//  - 放不下的进仓库，每回合自动落地；仓库里可以卖出换行动力
//  - 输赢只看幸福度（生命值）

export type ResKey = 'food' | 'wood' | 'stone' | 'copper' | 'iron' | 'coal' | 'power';
/** 原料 = 除粮食以外的可储存资源 */
export const MATERIALS: ResKey[] = ['wood', 'stone', 'copper', 'iron', 'coal', 'power'];
export const RES_KEYS: ResKey[] = ['food', ...MATERIALS];

export const RES_INFO: Record<ResKey, { name: string; icon: string }> = {
  food: { name: '粮食', icon: '🌾' },
  wood: { name: '木', icon: '🪵' },
  stone: { name: '石', icon: '🪨' },
  copper: { name: '铜', icon: '🟤' },
  iron: { name: '铁', icon: '⚙️' },
  coal: { name: '煤', icon: '⚫' },
  power: { name: '电', icon: '⚡' },
};

/** 第 n 级建筑占地（下标 0 = Lv1）。Lv10–12 是占位，设计文档里还没定 */
export const FOOTPRINTS: [number, number][] = [
  [1, 1], [1, 2], [2, 2], [2, 3], [3, 3], [3, 4], [4, 4], [4, 5], [5, 5], [5, 6], [6, 6], [6, 7],
];
export const MAX_LEVEL = FOOTPRINTS.length;

/**
 * 一座 Lv1 建筑的收支行。正数 = 产出，负数 = 消耗。
 * housing = 住房容量；happy = 幸福（作坊产品为正，矿山自带的负幸福为负）。
 */
export interface Row {
  food?: number;
  housing?: number;
  happy?: number;
  wood?: number;
  stone?: number;
  copper?: number;
  iron?: number;
  coal?: number;
  power?: number;
}
export type RowKey = keyof Row;

export interface Family {
  id: string;
  name: string;
  icon: string;
  era: number; // 从哪个时代开始进卡池
  row: Row; // Lv1 的收支
  names?: string[]; // 各级名字（缺省 = 名字 + LvN）
}

export const FAMILIES: Family[] = [
  { id: 'house', name: '住房', icon: '🏠', era: 1, row: { housing: 3 }, names: ['窝棚', '小屋', '住房', '土坯房', '石屋', '联排屋', '木筋楼', '宅邸', '公寓', '大楼', '高楼', '摩天楼'] },
  { id: 'field', name: '田地', icon: '🌾', era: 1, row: { food: 4 }, names: ['浆果丛', '小块田', '田地', '灌溉田', '庄园', '梯田', '领主庄园', '轮作农场', '农场', '大农场', '机械农场', '农业公司'] },
  { id: 'pasture', name: '畜栏', icon: '🐄', era: 2, row: { food: 6, wood: -1 } },
  { id: 'lumber', name: '伐木场', icon: '🪓', era: 1, row: { wood: 3 } },
  { id: 'quarry', name: '采石场', icon: '⛏️', era: 1, row: { stone: 3 } },
  { id: 'copper', name: '铜矿', icon: '🟤', era: 2, row: { copper: 3, happy: -1 } },
  { id: 'iron', name: '铁矿', icon: '⛰️', era: 3, row: { iron: 3, happy: -1 } },
  { id: 'coal', name: '煤矿', icon: '⚫', era: 4, row: { coal: 3, happy: -1 } },
  { id: 'plant', name: '电厂', icon: '⚡', era: 5, row: { coal: -2, power: 3, happy: -1 } },
  // 幸福作坊：每个最多吃 1–2 种原料
  { id: 'altar', name: '祭坛', icon: '🗿', era: 1, row: { wood: -1, happy: 3 } },
  { id: 'theatre', name: '剧场', icon: '🎭', era: 2, row: { wood: -1, stone: -1, happy: 4 } },
  { id: 'bronze', name: '青铜作坊', icon: '🏺', era: 2, row: { copper: -2, happy: 5 } },
  { id: 'smith', name: '铁匠铺', icon: '⚒️', era: 3, row: { iron: -2, happy: 6 } },
  { id: 'kiln', name: '瓷窑', icon: '🏮', era: 4, row: { coal: -1, stone: -1, happy: 7 } },
  { id: 'factory', name: '工厂', icon: '🏭', era: 5, row: { iron: -1, power: -1, happy: 9 } },
];
export const FAMILY: Record<string, Family> = Object.fromEntries(FAMILIES.map((f) => [f.id, f]));

/** 合并系数：3 座合 1 座，正数（产出、住房、作坊幸福）×3×PRODUCE_GAIN，负数（消耗、矿山负幸福）×3×CONSUME_GAIN */
export const MERGE = {
  count: 3,
  maxGroup: 9, // 一次最多合几座；合满 9 座直接升 2 级
  produceGain: 1.3,
  consumeGain: 1.2,
};

/** 某种建筑第 lvl 级的收支行（由 Lv1 按合并规则推出） */
export function rowOf(family: string, lvl: number): Row {
  const base = FAMILY[family].row;
  const out: Row = {};
  for (const [k, v] of Object.entries(base) as [RowKey, number][]) {
    const g = v > 0 ? MERGE.produceGain : MERGE.consumeGain;
    out[k] = v * Math.pow(MERGE.count * g, lvl - 1);
  }
  return out;
}
export const nameOf = (family: string, lvl: number) => FAMILY[family].names?.[lvl - 1] ?? `${FAMILY[family].name} Lv${lvl}`;

/** 时代（每人幸福需求不再跟时代走，改成按回合增长，见 RULES.happyBase / happyPerTurn） */
export interface Era {
  name: string;
}
export const ERAS: Era[] = [{ name: '' }, { name: '原始' }, { name: '青铜' }, { name: '铁器' }, { name: '古典' }, { name: '工业' }];

/**
 * 村庄中心：不合并，安居人口（住得下且吃得饱）达到门槛就自动升级。
 * era = 升到这一级后所在的时代；cost = 进入新时代要扣的原料（够了才升）。
 * 其他建筑等级不超过村庄中心等级 + CORE.levelCapOffset。
 */
export interface CoreLevel {
  name: string;
  settled: number; // 升到这一级需要的安居人口
  era: number;
  housing: number; // 村庄中心自带住房
  cost?: Partial<Record<ResKey, number>>;
}
export const CORE_LEVELS: CoreLevel[] = [
  { name: '', settled: 0, era: 1, housing: 0 },
  { name: '村庄中心', settled: 0, era: 1, housing: 5 },
  { name: '部落议事棚', settled: 8, era: 1, housing: 8 },
  { name: '氏族长屋', settled: 20, era: 2, housing: 12, cost: { wood: 30, stone: 20 } },
  { name: '城邦议事厅', settled: 45, era: 2, housing: 18 },
  { name: '卫城', settled: 90, era: 3, housing: 25, cost: { stone: 120, copper: 80 } },
  { name: '元老院', settled: 170, era: 3, housing: 35 },
  { name: '王城要塞', settled: 300, era: 4, housing: 50, cost: { copper: 200, iron: 200 } },
  { name: '市政宫', settled: 500, era: 4, housing: 70 },
  { name: '市政厅', settled: 800, era: 5, housing: 100, cost: { iron: 500, coal: 500 } },
  { name: '议会大厦', settled: 1200, era: 5, housing: 140 },
  { name: '首都', settled: 1800, era: 5, housing: 200 },
  { name: '世界之都', settled: 2700, era: 5, housing: 280 },
];
export const CORE = {
  levelCapOffset: 0, // 0 = 其他建筑最高等级 = 村庄中心等级
  plotsPerLevel: 1, // 可拥有地块数 = 村庄中心等级 × 这个数
};

export const RULES = {
  // 地图
  plotSize: 8,
  worldPlots: 5, // 世界是 5×5 块地
  // 人口：每回合 +（popBase + popPerTurn × 回合数），不管玩家做什么
  startPop: 4,
  popBase: 1,
  popPerTurn: 0.08,
  foodPerPerson: 1,
  // 幸福度（生命值）：= 作坊幸福 + 建筑自带幸福 − 人口 × 每人需求 − 扣分
  // 每人幸福需求按回合慢慢涨（2026-11-27 Rex 定）：= happyBase + happyPerTurn × 回合数，最多 happyMax
  happyBase: 1,
  happyPerTurn: 0.01, // 第 100 回合每人要 2，第 200 回合要 3
  happyMax: 99,
  homelessPenalty: 1, // 每个无家可归的人扣多少
  hungerPenalty: 1, // 每个吃不饱的人扣多少
  /** 分档。happyPerPop=true 时门槛按“幸福度 ÷ 人口”算（设计文档示意是绝对值 -10，人口上千后会太严，先按人均） */
  happyPerPop: true,
  tiers: [
    { min: 0, mult: 1 },
    { min: -0.1, mult: 0.9 },
    { min: -0.25, mult: 0.75 },
  ],
  failLine: -0.4, // 低于这条线算危险回合
  failTurns: 2, // 连续几回合低于失败线 Game Over
  // 行动力：每回合 apBase + apPerEra × (时代 − 1)，可以存一点到下回合
  apBase: 5,
  apPerEra: 1,
  apCarryMax: 5, // 回合末最多留多少到下回合
  moveCostPerCell: 1, // 移动/旋转 = 占地格数 × 这个数
  plotApBase: 4, // 买第 2 块地花几点行动力
  plotApStep: 1, // 之后每块多几点
  // 合并返还：被合建筑格数 ×（1 + 多合的座数）；连锁合并返还 × comboMult
  mergeRefund: true,
  comboMult: 2,
  mergeOnLanding: true, // 新建筑落地凑够 3 座就自动合并
  refundOnLanding: false, // 落地触发的合并给不给返还
  landNextToSame: true, // 新建筑优先落在同种同级建筑旁边（v9 规则）
  // 新建筑：每回合 1 次 cardChoices 选 1，每张卡的价值 ≈ arrivalPerPop × 本回合人口增长（单位 = 几座 Lv1）
  cardChoices: 3,
  arrivalPerPop: 1.5,
  arrivalMin: 3, // 每张卡至少值几座 Lv1
  bundleMinCount: 3, // 卡里同种建筑至少几座：价值不够就降级发
  // 仓库：放不下的新建筑进仓库，每回合开始按落地规则自动放出（玩家不能选位置）
  warehouseCells: 6,
  sellRatio: 0.5, // 卖出返还 = max(sellMin, floor(格数 × sellRatio))；应低于合并返还
  sellMin: 1,
  allowMapSell: true, // 地图上的建筑也能卖
  // 开局
  startRes: { wood: 10, stone: 5 } as Partial<Record<ResKey, number>>,
  startBuildings: ['field', 'field', 'lumber', 'altar'],
};

/** 关卡间商店：用金币买开局建筑。价格按“相当于几座 Lv1”，最高比村庄中心低 1 级 */
export const META_SHOP = {
  goldPerLv1: 10,
  price: (lvl: number) => META_SHOP.goldPerLv1 * Math.pow(MERGE.count, lvl - 1),
  maxLevelBelowCore: 1,
};

/** 某个时代会用到的原料（资源栏只显示这些） */
export function materialsOfEra(era: number): ResKey[] {
  const used = new Set<ResKey>();
  for (const f of FAMILIES) if (f.era <= era) for (const k of Object.keys(f.row)) if ((MATERIALS as string[]).includes(k)) used.add(k as ResKey);
  for (const c of CORE_LEVELS) if (c.era <= era + 1 && c.cost) for (const k of Object.keys(c.cost)) used.add(k as ResKey);
  return MATERIALS.filter((m) => used.has(m));
}
