/**
 * DSH session.v4.jsonl.zstd 读取器。
 *
 * 实测格式：整个文件不是单个 zstd 流，而是「上千个独立 zstd 帧首尾拼接」，
 * 每个帧解压后是 1~N 行 JSONL 事件。因此不能一次性 zstdDecompressSync，
 * 必须按 magic 找帧边界后逐帧解压。
 *
 * 帧头不含 content size，无法直接算长度；压缩数据里偶然出现 magic 的概率极低，
 * 但仍做了「起点解不开就向后扩展边界重试」的容错，并跳过坏帧而不是中断整个会话。
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function assertZstdSupport() {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error(
      '当前 Node 缺少 zlib.zstdDecompressSync（需 Node >= 22.15）。' +
      '构建/刷新索引请改用 Node 22.15+，查询服务本身可用更低版本运行。'
    );
  }
}

function frameOffsets(buf) {
  const out = [];
  let i = buf.indexOf(MAGIC);
  while (i !== -1) {
    out.push(i);
    i = buf.indexOf(MAGIC, i + 1);
  }
  return out;
}

/**
 * 逐事件读取一个会话文件（同步生成器，避免把解压后的全部文本一次性装进内存）。
 * @param {string} filePath session.v4.jsonl.zstd 路径
 * @param {{onWarning?: (msg: string) => void}} [options]
 * @yields {object} 事件对象，形如 { type, seq, time, data }
 */
export function* readSessionEvents(filePath, { onWarning } = {}) {
  assertZstdSupport();
  const buf = fs.readFileSync(filePath);
  const offsets = frameOffsets(buf);
  if (offsets.length === 0) {
    onWarning?.(`未发现 zstd 帧: ${filePath}`);
    return;
  }

  let k = 0;
  while (k < offsets.length) {
    const start = offsets[k];
    let out = null;
    let consumed = 1;
    const maxTry = Math.min(5, offsets.length - k);

    for (let n = 1; n <= maxTry; n++) {
      const end = k + n < offsets.length ? offsets[k + n] : buf.length;
      try {
        out = zlib.zstdDecompressSync(buf.subarray(start, end));
        consumed = n;
        break;
      } catch {
        // 该起点可能不是真帧，或帧跨越了下一个 magic，继续向后扩展
      }
    }

    if (!out) {
      onWarning?.(`跳过无法解压的帧 @ byte ${start} (${filePath})`);
      k += 1;
      continue;
    }

    const text = out.toString('utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // 单个坏行不影响整库
      }
    }
    k += consumed;
  }
}
