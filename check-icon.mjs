/**
 * 复刻 DSH dsh-app-boot 中 iconOf() 的全部约束，校验本插件的 icon 声明。
 * 规则来源：app.asar 内 dsh-app-boot/lib/index.js
 *   - manifest icon 必须是相对路径（禁绝对路径与 URL 形式）
 *   - 解析后必须仍在清单所在目录内
 *   - 扩展名限 .svg/.png/.jpg/.jpeg/.webp
 *   - 必须是常规文件且 <= 256 KiB
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const manifestPath = require.resolve('dsh-session-index/package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const MEDIA = new Map([['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp']]);
const MAX = 256 * 1024;
const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok, detail });

const icon = manifest.icon;
add('清单声明了 icon 字段', typeof icon === 'string' && icon.length > 0, String(icon));

// 相对路径 & 非 URL
const isAbs = path.isAbsolute(icon) || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(icon);
add('是相对路径（非绝对/非 URL）', !isAbs, isAbs ? 'DSH 会直接抛错：icon must be a relative file path' : './icon.svg 相对于清单目录');

// 在清单目录内
const root = path.dirname(manifestPath);
const target = path.resolve(root, icon);
const rel = path.relative(root, target);
const inside = rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
add('位于清单目录内', inside, target);

// 扩展名
const media = MEDIA.get(path.extname(target).toLowerCase());
add('扩展名受支持（SVG/PNG/JPEG/WebP）', Boolean(media), media || path.extname(target));

// 常规文件 + 大小
const stat = fs.statSync(target);
add('是常规文件', stat.isFile(), `${stat.size} bytes`);
add('不超过 256 KiB', stat.size <= MAX, `${(stat.size / 1024).toFixed(1)} KiB / 256 KiB`);

// XML 基本合法性
const bytes = fs.readFileSync(target);
const text = bytes.toString('utf8');
add('SVG 含根元素且可解码', /^<\?xml|<svg[\s>]/.test(text) && text.includes('</svg>'), 'svg 根元素闭合');

// 真实安装位置（junction）下同样成立
const viaProfile = createRequire('C:/Users/Administrator/.dsh/profiles/desktop/package.json').resolve('dsh-session-index/package.json');
add('从 profile 解析到的也是同一文件', path.resolve(viaProfile) === path.resolve(manifestPath), viaProfile);

const ok = checks.every((c) => c.ok);
for (const c of checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'}  ${c.name} — ${c.detail}`);
console.log(ok ? '\n图标符合 DSH 插件页展示规范。' : '\n存在不合规项。');
process.exitCode = ok ? 0 : 1;
