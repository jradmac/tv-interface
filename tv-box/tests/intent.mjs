// Word rules (voice without a Claude key). Run: node tests/intent.mjs
import { parseRules } from '../server/intent.mjs';
let pass = 0, fail = 0;
const cases = [
  ['Hey can you open up a jazz playlist on YouTube', { kind: 'play', service: 'youtube', query: 'jazz playlist' }],
  ['Hey, could you please put on some jazz on Spotify for me?', { kind: 'play', service: 'spotify', query: 'jazz' }],
  ['play the office on netflix please', { kind: 'play', service: 'netflix', query: 'the office' }],
  ['jazz playlist on youtube', { kind: 'play', service: 'youtube', query: 'jazz playlist' }],
  ['can you open up youtube', { kind: 'open', service: 'youtube' }],
  ['open netflix', { kind: 'open', service: 'netflix' }],
  ['pause', { kind: 'control' }],
  ['hey turn it up', { kind: 'control' }],
  ['find me a cooking show', { kind: 'search', query: 'cooking show' }],
  ['open claude code', { kind: 'open', service: 'claudecode' }],
];
for (const [said, want] of cases) {
  const got = parseRules(said);
  const good = Object.entries(want).every(([k, v]) => got && got[k] === v);
  console.log((good ? 'PASS ' : 'FAIL ') + `"${said}" -> ${JSON.stringify(got).slice(0, 90)}`);
  good ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
