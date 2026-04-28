import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PNG } from 'pngjs';
import { iterCells, parseDmi } from './dmi.js';
import { type PackInput, packAtlas, sliceRgba } from './pack.js';

const [, , srcArg, outArg] = process.argv;
const srcRoot = srcArg ?? '../../assets/dmi-source';
const outDir = outArg ?? '../../packages/client/public/atlases';
mkdirSync(outDir, { recursive: true });

const dmiPaths = walk(srcRoot).filter((p) => p.toLowerCase().endsWith('.dmi'));
console.log(`found ${dmiPaths.length} .dmi files under ${srcRoot}`);

const inputs: PackInput[] = [];
const frameMeta: Array<{
  key: string;
  source: string;
  state: string;
  dir: string;
  frame: number;
  delay?: number;
}> = [];

for (const path of dmiPaths) {
  const buf = readFileSync(path);
  const sourceName = makeSourceName(path, srcRoot);
  let parsed: ReturnType<typeof parseDmi>;
  try {
    parsed = parseDmi(buf, sourceName);
  } catch (e) {
    console.warn(`skip ${sourceName}: ${(e as Error).message}`);
    continue;
  }
  for (const cell of iterCells(parsed)) {
    const key = makeKey(sourceName, cell.stateName, cell.dir, cell.frame);
    inputs.push({
      key,
      width: cell.width,
      height: cell.height,
      pixels: sliceRgba(parsed.png, cell.sx, cell.sy, cell.width, cell.height),
    });
    const meta: (typeof frameMeta)[number] = {
      key,
      source: sourceName,
      state: cell.stateName,
      dir: cell.dir,
      frame: cell.frame,
    };
    if (cell.delay !== undefined) meta.delay = cell.delay;
    frameMeta.push(meta);
  }
}
console.log(`extracted ${inputs.length} frames`);

const { png, frames } = packAtlas(inputs);
const atlasPng = join(outDir, 'sprites.png');
const pngBuf = PNG.sync.write(png);
writeFileSync(atlasPng, pngBuf);
console.log(`wrote ${atlasPng} (${png.width}x${png.height}, ${pngBuf.length} bytes)`);

// Phaser JSON Hash format. Frame names are exactly our packed keys.
const phaserHash: Record<string, unknown> = {};
for (const f of frames) {
  phaserHash[f.key] = {
    frame: { x: f.x, y: f.y, w: f.width, h: f.height },
    rotated: false,
    trimmed: false,
    spriteSourceSize: { x: 0, y: 0, w: f.width, h: f.height },
    sourceSize: { w: f.width, h: f.height },
  };
}
const phaserJson = {
  frames: phaserHash,
  meta: {
    app: 'pyrce/dmi-extract',
    version: '1',
    image: 'sprites.png',
    format: 'RGBA8888',
    size: { w: png.width, h: png.height },
    scale: '1',
  },
};
const atlasJson = join(outDir, 'sprites.json');
writeFileSync(atlasJson, JSON.stringify(phaserJson));
console.log(`wrote ${atlasJson}`);

// Sidecar with state/dir/frame/delay metadata so the client can build animations.
const sidecar = join(outDir, 'sprites-meta.json');
writeFileSync(sidecar, JSON.stringify({ frames: frameMeta }, null, 2));
console.log(`wrote ${sidecar} (${frameMeta.length} entries)`);

function walk(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const p = stack.pop();
    if (!p) break;
    let s: ReturnType<typeof statSync>;
    try {
      s = statSync(p);
    } catch {
      continue;
    }
    if (s.isDirectory()) for (const e of readdirSync(p)) stack.push(join(p, e));
    else out.push(p);
  }
  return out;
}

function makeSourceName(path: string, root: string): string {
  return relative(root, path)
    .replace(/\\/g, '/')
    .replace(/\.dmi$/i, '');
}

function makeKey(source: string, state: string, dir: string, frame: number): string {
  const safeState = state === '' ? '_' : state.replace(/\s+/g, '_').toLowerCase();
  return `${source}/${safeState}/${dir}/${frame}`;
}
