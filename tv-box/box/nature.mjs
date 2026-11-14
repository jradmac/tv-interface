// Downloads the Nature theme photos (listed in tv/nature-sources.json) into <app>/themes/nature/
// and writes list.json for the TV page. Run by the installer; safe to run again (keeps what's there).
// Photos that fail are skipped; with none, the TV falls back to its built-in painted scenes.
//   node box/nature.mjs /opt/tv
import fs from 'node:fs';
import path from 'node:path';

const APP = path.resolve(process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), '..'));
const DIR = path.join(APP, 'themes', 'nature');
const ALLOW = (process.env.NATURE_ALLOW_HOST || 'images.unsplash.com').split(',');
const MAX = 4 * 1024 * 1024;

let src;
try { src = JSON.parse(fs.readFileSync(path.join(APP, 'tv', 'nature-sources.json'), 'utf8')).photos || []; } catch { src = []; }
fs.mkdirSync(DIR, { recursive: true });
const list = [];
let got = 0, kept = 0;
const end = Date.now() + 90_000;
for (let i = 0; i < Math.min(src.length, 24); i++) {
  const p = src[i] || {};
  const name = String(i + 1).padStart(2, '0') + '.jpg';
  const file = path.join(DIR, name);
  let u;
  try { u = new URL(String(p.url)); } catch { continue; }
  if (!['https:', 'http:'].includes(u.protocol) || !ALLOW.includes(u.hostname)) continue;
  const credit = String(p.credit || 'Unsplash').slice(0, 60);
  if (fs.existsSync(file) && fs.statSync(file).size > 10_000) { list.push({ src: '/themes/nature/' + name, credit }); kept++; continue; }
  if (Date.now() > end) break;
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(20_000), redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 10_000 || buf.length > MAX || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG photo');
    fs.writeFileSync(file + '.tmp', buf);
    fs.renameSync(file + '.tmp', file);
    list.push({ src: '/themes/nature/' + name, credit });
    got++;
  } catch (e) {
    console.log(`nature photo ${i + 1} skipped: ${e.message}`);
  }
}
fs.writeFileSync(path.join(DIR, 'list.json'), JSON.stringify(list));
console.log(`Nature theme: ${list.length} photos (${got} new, ${kept} already here).`);
