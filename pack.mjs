/**
 * 打包 CLI：无需手工压缩，一条命令生成可分发包。
 *
 *   node pack.mjs            # 默认 all：插件包 + 技能包
 *   node pack.mjs plugin     # 仅完整插件包
 *   node pack.mjs skill      # 仅技能包（可直接导入 DSH 技能管理器）
 *   node pack.mjs status     # 查看已生成的包
 *   node pack.mjs verify     # 校验包结构
 *
 * 安装时 install.mjs 会自动调用，通常无需手动执行。
 */
import { pack, packAll, listPacks, inspectZip, defaultOutDir } from './lib/pack.mjs';

const mode = (process.argv[2] || 'all').toLowerCase();

try {
  if (mode === 'status') {
    const info = listPacks();
    console.log(`分发包目录：${info.outDir}`);
    if (!info.packs.length) console.log('（暂无包，运行 node pack.mjs 生成）');
    for (const p of info.packs) {
      console.log(`  ${p.valid ? 'OK  ' : 'FAIL'}  ${p.name} — ${p.fileCount || 0} 文件 / ${((p.bytes || 0) / 1024).toFixed(1)} KB / ${p.mtime || ''}`);
    }
  } else if (mode === 'verify') {
    const info = listPacks();
    let bad = 0;
    for (const p of info.packs) {
      try {
        const r = inspectZip(p.path);
        console.log(`OK    ${p.name} — ${r.count} 文件 / CRC 与中央目录有效`);
      } catch (e) {
        bad += 1;
        console.log(`FAIL  ${p.name} — ${e.message}`);
      }
    }
    if (bad) process.exitCode = 1;
  } else {
    const results = mode === 'all' ? packAll() : [pack({ mode })];
    console.log(`打包完成，输出目录：${defaultOutDir()}`);
    for (const r of results) {
      console.log(`  · [${r.mode}] ${r.path}`);
      console.log(`    ${r.fileCount} 文件 / ${(r.bytes / 1024).toFixed(1)} KB / sha256 ${r.sha256}`);
    }
    console.log('\n包内含 MANIFEST.json 与 INSTALL.md，不含任何会话数据、索引或密钥，可直接分发。');
    console.log('接收方解压后执行 node install.mjs 即完成安装。');
  }
} catch (err) {
  console.error('打包失败：' + err.message);
  process.exitCode = 1;
}
