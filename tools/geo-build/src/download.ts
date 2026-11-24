import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import AdmZip from 'adm-zip';

/** Download `url` into `cacheDir` once; later runs reuse the cached file. */
export async function fetchCached(url: string, cacheDir: string): Promise<string> {
  const name = url.split('/').pop()!;
  const dest = join(cacheDir, name);
  if (existsSync(dest) && statSync(dest).size > 0) return dest;
  mkdirSync(dirname(dest), { recursive: true });
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      process.stdout.write(`  ↓ ${name} ... `);
      const res = await fetch(url, { headers: { 'User-Agent': 'outbreak-grid-geo-build' } });
      if (res.status === 429 || res.status === 503) {
        const ra = Number(res.headers.get("retry-after")) || 15 * attempt;
        throw Object.assign(new Error(`HTTP ${res.status}`), { waitMs: ra * 1000 });
      }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const tmp = `${dest}.part`;
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
      renameSync(tmp, dest);
      console.log(`${(statSync(dest).size / 1e6).toFixed(1)} MB`);
      await new Promise((r) => setTimeout(r, 400)); // be polite to www2.census.gov
      return dest;
    } catch (err) {
      console.log(`failed (${(err as Error).message})`);
      if (attempt === 6) throw err;
      const wait = (err as { waitMs?: number }).waitMs ?? 2000 * attempt;
      console.log(`    retrying in ${Math.round(wait / 1000)} s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error('unreachable');
}

/** Extract a zip next to itself (once) and return the extraction folder. */
export function unzipCached(zipPath: string): string {
  const out = zipPath.replace(/\.zip$/i, '');
  if (existsSync(out)) return out;
  new AdmZip(zipPath).extractAllTo(`${out}.part`, true);
  renameSync(`${out}.part`, out);
  return out;
}

/** Run async tasks with a small concurrency limit. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
