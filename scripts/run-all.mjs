// 统一回归入口：跑 scripts/ 下全部检查，汇总成一张表。
// 用法：node scripts/run-all.mjs
//
// 为什么要一个总入口：25 个分散的脚本，新人克隆仓库后不知道要跑什么、
// 跑到哪算通过。一个命令 + 一份汇总表，是最低成本的「这个项目是健康的」。

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(HERE)
  .filter((name) => name.endsWith('-check.mjs') || name === 'scope-check.mjs')
  .sort();

let pass = 0;
let fail = 0;
const failed = [];

for (const file of files) {
  const result = spawnSync(process.execPath, [join(HERE, file)], {
    encoding: 'utf8',
    env: process.env,
  });
  const output = `${result.stdout}${result.stderr}`;
  // 各脚本自己打印 "N pass, M fail"
  const summary = output.match(/(\d+) pass, (\d+) fail/);
  const p = summary ? Number(summary[1]) : 0;
  const f = summary ? Number(summary[2]) : 1;
  pass += p;
  if (f > 0 || result.status !== 0) {
    fail += Math.max(f, 1);
    failed.push({ file, output });
    console.log(`❌ ${file.padEnd(36)} ${summary ? `${p} pass, ${f} fail` : 'NO SUMMARY'}`);
  } else {
    console.log(`ok ${file.padEnd(36)} ${p} pass`);
  }
}

console.log('');
for (const item of failed) {
  console.log(`── ${item.file} ──`);
  // 只回放失败行，避免刷屏
  for (const line of item.output.split('\n')) {
    if (line.includes('❌') || line.includes('FAIL') || line.includes('Error')) {
      console.log('   ' + line.trim());
    }
  }
}

console.log(`\n合计：${pass} pass, ${fail} fail（${files.length} 个脚本）`);
if (fail > 0) process.exitCode = 1;
