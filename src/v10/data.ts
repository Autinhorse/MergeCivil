// v10 数值表（全部是占位值，调平衡只改这个文件）。
// 规则来源：《合并文明 · 核心循环设计 v10》+ 2026-11-27 讨论补充：
//  - 回合制；人口每回合自然增长，不管玩家做什么
//  - 资源：人口、粮食、住房、原料（分开记）、幸福；对局内没有金币、没有工人
//  - 村庄中心不合并，"安居人口"达到门槛自动升级；其他建筑等级不超过它
//  - 新建筑给得充足，落地不花行动力；行动力只用于移动、旋转、买地
//  - 放不下的进仓库，每回合自动落地；仓库里可以卖出换行动力
//  - 输赢只看幸福度（生命值）

export type ResKey = 'food' | 'goods' | 'wood' | 'stone' | 'copper' | 'iron' | 'coal' | 'power';
/** 原料 = 可储存、建筑之间互相吃的资源。粮食和生活用品按人头消耗、不储存 */
export const MATERIALS: ResKey[] = ['wood', 'stone', 'copper', 'iron', 'coal', 'power'];
export const RES_KEYS: ResKey[] = ['food', 'goods', ...MATERIALS];

export const RES_INFO: Record<ResKey, { name: string; icon: string }> = {
  food: { name: '粮食', icon: '🌾' },
  goods: { name: '生活用品', icon: '🧺' },
  wood: { name: '木', icon: '🪵' },
  stone: { name: '石', icon: '🪨' },
  copper: { name: '铜', icon: '🟤' },
  iron: { name: '铁', icon: '⚙️' },
  coal: { name: '煤', icon: '⚫' },
  power: { name: '电', icon: '⚡' },
};

/** 第 n 级建筑占地（下标 0 = Lv1）。Lv10–12 按《建筑定义.xlsx》“年代”sheet 的建议值 */
export const FOOTPRINTS: [number, number][] = [
  [1, 1], [1, 2], [2, 2], [2, 3], [3, 3], [3, 4], [4, 4], [4, 5], [5, 5], [5, 6], [6, 6], [6, 7],
];
export const MAX_LEVEL = FOOTPRINTS.length;

/**
 * 收支行（按“折合 Lv1”写，实际等级再按合并规则放大）。正数 = 产出，负数 = 消耗。
 * housing = 住房容量；happy = 幸福；goods = 生活用品。
 */
export interface Row {
  food?: number;
  goods?: number;
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
  start: number; // 起始等级：卡里最低发这一级（表里的“起始级别”）
  row: Row; // 收支（折合 Lv1）
  /** 合到某一级以后换产出（2026-11-27 新表：伐木场 Lv8 起产煤，采石场 Lv3 起产铜、Lv5 起产铁） */
  stages?: { from: number; row: Row }[];
  /** 自动吃原料：每级吃“这一级对应的原料”，见 tierInputs。数值 = [伐木链那份, 采石链那份]（折合 Lv1） */
  auto?: [number, number];
  names?: string[]; // 各级名字（下标 0 = Lv1）
  weight?: number; // 不选卡直接发时的出现权重（默认 1）
}

// 《建筑定义.xlsx》「建筑链 (修改)」16 条链（村庄中心单独规则）。各级名字照表；吃什么原料表里还没写，先用占位
const N = (...xs: string[]) => xs;
export const FAMILIES: Family[] = [
  { id: 'field', name: '田地', icon: '🌾', era: 1, start: 1, row: { food: 4 }, names: N('浆果树丛', '小块田地', '田地', '灌溉农田', '庄园农场', '梯田庄园', '领主庄园', '轮作农场', '机械化农场', '现代农业基地', '智能温室', '垂直生态农场') },
  { id: 'lumber', weight: 2, name: '伐木场', icon: '🪓', era: 1, start: 1, row: { wood: 3 }, stages: [{ from: 8, row: { coal: 3 } }], names: N('收集木材', '伐木场', '木材工坊', '锯木坊', '木工作坊', '皇家林场', '水力锯木厂', '煤矿', '竖井煤矿', '大煤矿', '机械化煤矿', '煤炭气化厂') },
  { id: 'house', weight: 1.5, name: '住房', icon: '🏠', era: 1, start: 1, row: { housing: 3 }, names: N('窝棚', '小住房', '住房', '土坯房', '石屋', '联排屋', '木筋楼', '市民宅邸', '工人公寓', '高层住宅', '智能社区', '生态穹顶城') },
  { id: 'quarry', weight: 2.5, name: '采石场', icon: '⛏️', era: 1, start: 1, row: { stone: 3 }, stages: [{ from: 3, row: { copper: 3 } }, { from: 5, row: { iron: 3 } }], names: N('收集石头', '采石场', '青铜矿场', '铜锡矿坑', '铁矿井', '深层铁矿', '矿业公会', '大铁矿山', '蒸汽铁矿', '露天铁矿场', '自动化铁矿', '太空铁矿站') },
  { id: 'altar', name: '祭坛', icon: '🗿', era: 1, start: 2, row: { happy: 3 }, auto: [1, 0], names: N('', '祭坛', '图腾柱', '神庙', '圣殿', '大神殿', '大教堂', '巴洛克教堂', '城市公园', '体育场', '主题乐园', '全息娱乐中心') },
  // 炼制工坊：Rex 定产生活用品
  { id: 'smelter', name: '炼制工坊', icon: '🔥', era: 2, start: 3, row: { goods: 5 }, auto: [0, 2], names: N('', '', '炼制工坊', '青铜铸坊', '铁匠铺', '兵器工坊', '铁匠行会', '精钢锻坊', '机械锻造厂', '重型机械厂', '精密制造厂', '智能锻造中心') },
  { id: 'kiln', name: '陶窑', icon: '🏺', era: 2, start: 3, row: { goods: 4 }, auto: [1, 1], names: N('', '', '陶窑', '制陶坊', '彩陶工坊', '瓷器作坊', '官窑', '瓷器工场', '供水站', '自来水厂', '净水厂', '海水淡化厂') },
  { id: 'pasture', name: '牧场', icon: '🐄', era: 2, start: 3, row: { food: 5 }, auto: [1, 0], names: N('', '', '牧场', '畜栏', '大牧场', '马场', '庄园牧场', '养殖场', '畜牧农场', '现代养殖场', '智能牧场', '细胞培育肉工厂') },
  { id: 'market', name: '市集', icon: '🏪', era: 3, start: 4, row: { goods: 5 }, auto: [1, 1], names: N('', '', '', '市集', '集市广场', '商业大街', '商人会馆', '交易大厅', '百货公司', '商业中心', '购物广场', '全息商城') },
  { id: 'herbal', name: '草药铺', icon: '🌿', era: 3, start: 4, row: { happy: 5 }, auto: [1, 1], names: N('', '', '', '草药铺', '医馆', '疗养浴场', '慈善医舍', '医院', '皇家医院', '综合医疗中心', '生物医药中心', '纳米医疗舱') },
  { id: 'academy', name: '学院', icon: '📚', era: 4, start: 5, row: { happy: 6 }, auto: [1, 1], names: N('', '', '', '', '学院', '图书馆', '经院', '大学', '理工学院', '研究型大学', '大学城', '量子研究院') },
  { id: 'theatre', name: '剧场', icon: '🎭', era: 4, start: 5, row: { happy: 6 }, auto: [1, 1], names: N('', '', '', '', '剧场', '圆形剧场', '大竞技场', '皇家剧院', '歌剧院', '音乐厅', '文化中心', '沉浸式剧场') },
  { id: 'textile', name: '纺织坊', icon: '🧵', era: 4, start: 5, row: { goods: 6 }, auto: [1, 1], names: N('', '', '', '', '纺织坊', '织布坊', '丝绸工坊', '纺织行会', '呢绒工场', '纺织厂', '服装厂', '智能纺织厂') },
  { id: 'bank', name: '银行', icon: '🏦', era: 6, start: 7, row: { goods: 8 }, auto: [1, 1], names: N('', '', '', '', '', '', '银行', '商业银行', '国家银行', '证券交易所', '金融中心', '数字货币中心') },
  { id: 'plant', weight: 5, name: '电厂', icon: '⚡', era: 8, start: 9, row: { coal: -2, power: 4 * 3 }, names: N('', '', '', '', '', '', '', '', '火力发电厂', '核电站', '太阳能电站', '轨道太阳能站') },
];
export const FAMILY: Record<string, Family> = Object.fromEntries(FAMILIES.map((f) => [f.id, f]));

/** 合并系数：3 座合 1 座，正数（产出、住房、作坊幸福）×3×PRODUCE_GAIN，负数（消耗、矿山负幸福）×3×CONSUME_GAIN */
export const MERGE = {
  count: 3,
  maxGroup: 9, // 一次最多合几座；合满 9 座直接升 2 级
  produceGain: 1.2,
  consumeGain: 1.2,
};

/**
 * 自动吃原料：建筑吃“它这一级对应的原料”，和伐木场、采石场换产出的等级对齐：
 *   伐木链那份：Lv1–7 吃木，Lv8 起吃煤；采石链那份：Lv1–2 吃石，Lv3–4 吃铜，Lv5 起吃铁。
 * 另外 Lv≥powerFromLevel 的建筑都要吃电（电厂自己除外）。
 */
export function tierInputs(lvl: number): [ResKey, ResKey] {
  return [lvl >= 8 ? 'coal' : 'wood', lvl >= 5 ? 'iron' : lvl >= 3 ? 'copper' : 'stone'];
}

/** 某种建筑第 lvl 级对应的“折合 Lv1”收支（含换产出、自动原料、用电） */
export function lv1Row(family: string, lvl: number): Row {
  const f = FAMILY[family];
  let row: Row = { ...f.row };
  for (const st of f.stages ?? []) if (lvl >= st.from) row = { ...st.row };
  if (f.auto) {
    const [a, b] = tierInputs(lvl);
    if (f.auto[0]) row[a] = (row[a] ?? 0) - f.auto[0];
    if (f.auto[1]) row[b] = (row[b] ?? 0) - f.auto[1];
  }
  if (lvl >= RULES.powerFromLevel && family !== 'plant') row.power = (row.power ?? 0) - RULES.powerDraw;
  return row;
}

/**
 * 起始级别高的链（银行 Lv7、电厂 Lv9）起始那一级顶几座 Lv1：= 3^((起始级别 − 1) × startScale)。
 * startScale 0 = 只顶 1 座；1 = 照合并倍率全算（一座 Lv7 银行顶 729 座）。返回“相当于从第几级开始放大”
 */
export function startBase(family: string): number {
  const st = FAMILY[family]?.start ?? 1;
  return 1 + (st - 1) * (1 - RULES.startScale);
}

/** 某种建筑第 lvl 级的收支行（折合 Lv1 按合并规则放大） */
export function rowOf(family: string, lvl: number): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(lv1Row(family, lvl)) as [RowKey, number][]) {
    const g = v > 0 ? MERGE.produceGain : MERGE.consumeGain;
    out[k] = v * Math.pow(MERGE.count * g, lvl - startBase(family)) * (v > 0 ? RULES.prodMult[k] ?? 1 : 1);
  }
  return out;
}
export const nameOf = (family: string, lvl: number) => FAMILY[family].names?.[lvl - 1] || `${FAMILY[family].name} Lv${lvl}`;

/** 时代：照《建筑定义.xlsx》「年代」sheet。第 k 个时代最高合到 Lv k+2 = 村庄中心等级 */
export interface Era {
  name: string;
}
export const ERAS: Era[] = [{ name: '' }, { name: '原始社会' }, { name: '青铜时代' }, { name: '铁器时代' }, { name: '古典时代' }, { name: '中世纪' }, { name: '文艺复兴' }, { name: '工业时代' }, { name: '现代' }, { name: '信息时代' }, { name: '未来时代' }];

/**
 * 村庄中心：不合并，安居人口（住得下且吃得饱）达到门槛就自动升级。
 * era = 升到这一级后所在的时代（= 等级 − 2，最少 1）；cost = 进入新时代要扣的原料（够了才升）。
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
  { name: '氏族长屋', settled: 20, era: 1, housing: 12, cost: { wood: 30, stone: 20 } },
  { name: '城邦议事厅', settled: 45, era: 2, housing: 18, cost: { wood: 60, copper: 40 } },
  { name: '卫城', settled: 90, era: 3, housing: 25, cost: { copper: 200 } },
  { name: '元老院', settled: 170, era: 4, housing: 35, cost: { iron: 300 } },
  { name: '王城要塞', settled: 300, era: 5, housing: 50, cost: { iron: 800, wood: 800 } },
  { name: '市政宫', settled: 500, era: 6, housing: 70, cost: { iron: 2000 } },
  { name: '市政大楼', settled: 800, era: 7, housing: 100, cost: { coal: 3000, iron: 3000 } },
  { name: '行政中心', settled: 1200, era: 8, housing: 140, cost: { coal: 8000 } },
  { name: '智慧城市中枢', settled: 1800, era: 9, housing: 200, cost: { power: 20000 } },
  { name: '星港都会核心', settled: 2700, era: 10, housing: 280, cost: { power: 60000 } },
];
export const CORE = {
  levelCapOffset: 0, // 0 = 其他建筑最高等级 = 村庄中心等级
  plotsPerLevel: 4, // 可拥有地块数 = 村庄中心等级 × 这个数
};

// 2026-11-28 基准（Rex 定）：随机落地、每种建筑只发它地图上最高两级、不选卡直接发 3 种、按固定比例随机、仓库按座数
export const RULES = {
  // 地图
  plotSize: 8,
  worldPlots: 7, // 世界是 5×5 块地
  // 人口：每回合 +（popBase + popPerTurn × 回合数），不管玩家做什么
  startPop: 4,
  popBase: 1,
  popPerTurn: 0.08,
  popRate: 0.025, // 按比例增长：每回合 + 当前人口 × popRate（比如 0.03 = 3%）
  foodPerPerson: 1,
  needMult: 2.5, // 每人需求（粮食/住房/幸福/生活用品）整体倍数，1 = 不变
  needMultFrom: 5, // 从第几个大回合开始加
  needMultRamp: 10, // 用几个大回合加满
  prodMult: { housing: 1, food: 1, happy: 1, power: 2, iron: 0.6 } as Record<string, number>, // 建筑基础产量倍数（按产出项，村庄中心不算）
  needMix: { housing: 1.5, food: 1.8, happy: 0.7, goods: 1.5 } as Record<string, number>, // needMult 多出来的部分按项再乘：幸福本来就最紧，少加；粮食最松，多加
  needPerLevel: 1.08, // 每人需求随村庄中心等级放大：× needPerLevel^(等级 − needFromLevel)。1 = 不变
  needFromLevel: 2, // 从村庄中心第几级开始放大
  // 幸福度（生命值）：= 作坊幸福 + 建筑自带幸福 − 人口 × 每人需求 − 扣分
  // 每人幸福需求按回合慢慢涨（2026-11-27 Rex 定）：= happyBase + happyPerTurn × 回合数，最多 happyMax
  happyBase: 1,
  happyPerTurn: 0.01, // 第 100 回合每人要 2，第 200 回合要 3
  happyMax: 99,
  // 生活用品（2026-11-27 新增）：从 goodsFromEra 时代起按人头消耗，每人 = goodsBase + goodsPerTurn × 回合；不够的人每人扣 goodsPenalty 幸福
  goodsFromEra: 2,
  goodsBase: 0.5,
  goodsPerTurn: 0.005,
  goodsPenalty: 1,
  goodsRamp: 30, // >0：进入时代后这么多小回合内需求从 0 涨到 goodsBase（0 = 一进时代就要满额）
  // 电力：Lv≥powerFromLevel 的建筑每座吃 powerDraw（折合 Lv1，再按合并放大），电不够就按比例减产
  powerFromLevel: 9,
  powerDraw: 0.5,
  // 祭坛从 Lv2 起（新表），开局村庄中心 Lv1 时没有幸福来源：先让村庄中心自带幸福 = 自带住房 × coreHappy（占位）
  coreHappy: 2,
  coreSettledMult: 3, // 村庄中心 L3 起的升级门槛（安居人口）× 这个数（L2 不变：祭坛 Lv2 才有，开局撑不住），调大 = 升级慢、整局变长
  // 起始级别高的链（银行 Lv7、电厂 Lv9）起始那一级顶 3^((起始级别 − 1) × startScale) 座 Lv1。0 = 顶 1 座，1 = 顶 729 座（Lv7）
  startScale: 0.5,
  // 发卡时缺“换产出才有”的原料（煤要伐木场 Lv8）：true = 直接发那一级；false = 照常发卡片等级，玩家自己合上去
  stageJump: true,
  lightGreen: 1.25,
  // 后台动态难度（玩家看不到）：每小回合，全绿 → 发卡量倍数 −ddaStep；有红 → +ddaStep；两项红 → +3×ddaStep；限制在 [ddaMin, ddaMax]
  ddaStep: 0,
  ddaMin: 0.4,
  ddaMax: 1.5,
  ddaFromRound: 10, // 资源红黄绿：供给/需求 ≥ 这个数算绿，≥1 黄，<1 红
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
  // 大回合（2026-11-27 Rex 提议）：几个小回合合成一个大回合。大回合开始时一次给齐这几个小回合的行动力和选卡次数，
  // 玩家操作完点结束，连续结算这几个小回合（人口增长、生产、幸福度按小回合算）。1 = 原来的每回合一结算
  turnsPerRound: 3,
  // 行动力：每回合 apBase + apPerEra × (时代 − 1)，可以存一点到下回合
  apBase: 24,
  apPerEra: 1,
  apCarryMax: 5, // 回合末最多留多少到下回合
  moveCostPerCell: 1, // 移动/旋转 = 占地格数 × 这个数
  plotApBase: 4, // 买第 2 块地花几点行动力
  plotApStep: 1, // 之后每块多几点
  // 合并返还：被合建筑格数 ×（1 + 多合的座数）；连锁合并返还 × comboMult
  mergeRefund: true,
  comboMult: 2,
  mergeOnLanding: true, // 新建筑落地凑够 3 座就自动合并
  refundMult: 1, // 合并返还 × 这个数（1 = 返还刚好等于挪一座同级建筑的花费，合并不亏不赚）
  refundOnLanding: false, // 落地触发的合并给不给返还
  landRandom: true, // true = 新建筑在空位里随机落（2026-11-28 Rex 定）；false = 贴同种 / 靠近上一座
  landNextToSame: true, // 新建筑优先落在同种同级建筑旁边（v9 规则）
  // 新建筑：每回合 1 次 cardChoices 选 1，每张卡的价值 ≈ arrivalPerPop × 本回合人口增长（单位 = 几座 Lv1）
  cardChoices: 3,
  dealFamilies: 3, // >0 = 不选卡：每次随机直接发这么多种建筑（价值平分）
  dealNeedWeight: 1, // 不选卡时，缺口大的建筑被抽中的权重（0 = 完全随机）
  dealNeedWeightEnd: 0, // ≥0：追缺口的权重随回合从 dealNeedWeight 变到这个数（0 = 后期完全按固定比例）
  dealNeedTurns: 30, // 在第几小回合变到 dealNeedWeightEnd
  arrivalPerPop: 8,
  needMargin: 1.1,
  needMarginEnd: 0, // >0：富余比例随回合从 needMargin 线性变到这个数（比如 1.3 → 0.95）
  needMarginTurns: 150, // 在第几小回合变到 needMarginEnd
  matNeedMult: 1, // 原料缺口发卡加权（>1 = 多发伐木场/采石场） // 发卡时住房/粮食/幸福按需求的几倍算够（原来是 +2）
  needHorizon: 1, // 发卡看几回合以后的缺口（人口按增长推算）；试过 5，早期会饿死，先用 1
  arrivalPerFamily: 0, // 每多开放一种建筑，卡牌价值多几成（0.1 = 每多一种 +10%）
  arrivalBaseFamilies: 4, // 开局开放几种（田地、伐木场、住房、采石场）不加
  arrivalMin: 3, // 每张卡至少值几座 Lv1
  bundleMinCount: 6, // 卡里同种建筑至少几座：价值不够就降级发
  // 时代升级后旧时代等级只补齐（2026-11-27 Rex 提议，先做成开关）：
  // 开着时，每个时代发卡的最低等级 = eraCardLevel[时代]；低于它的等级只补到凑满 3 座为止，之后不再发
  oldLevelFillOnly: false,
  eraCardLevel: [0, 1, 2, 3, 4, 5],
  autoFillGap: 0, // >0 时：比发卡等级低这么多级及以上的零头，每个大回合开始自动补到 3 座（不自动合），之后不再发。Rex 定 3
  autoFillRef: 'card' as 'card' | 'family', // 'family' = 按这种建筑自己的最高等级算“低几级”
  cardTopLevels: 2, // >0（Rex 定 2）：卡里每种建筑只发它地图上最高的这几个等级，更低的不发、只从最低一级补零头（这时 autoFillGap 不用）
  cardTopRef: 'family' as 'family' | 'card', // 'family' = 最高 2 级按这种建筑地图上的最高等级；'card' = 按这回合卡牌等级（建筑小、放得下）
  fillRemainders: false, // 发卡时顺便把同种建筑低等级的零头补到 3 座（凑不齐的低级建筑就能合掉）
  // 仓库：放不下的新建筑进仓库，每回合开始按落地规则自动放出（玩家不能选位置）
  warehouseCells: 6,
  warehouseSlots: 5, // >0 = 仓库按座数算（不管多大），容量 = warehouseSlots + warehouseSlotsPerEra × (时代 − 1)
  warehouseSlotsPerEra: 2,
  sellRatio: 0.5, // 卖出返还 = max(sellMin, floor(格数 × sellRatio))；应低于合并返还
  sellMin: 1,
  allowMapSell: true, // 地图上的建筑也能卖
  // 开局
  startRes: { wood: 10, stone: 5 } as Partial<Record<ResKey, number>>,
  startBuildings: ['field', 'field', 'lumber', 'lumber', 'quarry'],
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
  for (const f of FAMILIES) if (f.era <= era) for (let L = f.start; L <= Math.min(MAX_LEVEL, era + 2); L++) for (const k of Object.keys(lv1Row(f.id, L))) if ((MATERIALS as string[]).includes(k)) used.add(k as ResKey);
  for (const c of CORE_LEVELS) if (c.era <= era + 1 && c.cost) for (const k of Object.keys(c.cost)) used.add(k as ResKey);
  return MATERIALS.filter((m) => used.has(m));
}
