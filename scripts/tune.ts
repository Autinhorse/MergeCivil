// 用法：GAIN=1.2 WORKERS=0.8 HOUSING=1.2 npx tsx scripts/tune.ts A   （其余参数同 sim.ts）
const env = process.env;
(globalThis as { __TUNE?: Record<string, number> }).__TUNE = Object.fromEntries(
  ([['gain', env.GAIN], ['workers', env.WORKERS], ['housing', env.HOUSING]] as [string, string | undefined][])
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => [k, Number(v)]),
);
if (env.GIFT3) (globalThis as { __GIFT3?: string[] }).__GIFT3 = env.GIFT3.split(',');
if (env.GIFT4) (globalThis as { __GIFT4?: string[] }).__GIFT4 = env.GIFT4.split(',');
export {};
await import('./sim');
