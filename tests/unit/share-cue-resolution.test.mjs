import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = new URL('../../', import.meta.url);
function load(path, deps) {
  const js = ts.transpileModule(readFileSync(new URL(path, root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = { exports: {}, console, require: id => { if (id in deps) return deps[id]; throw Error('Unexpected import ' + id); },
    URL, URLSearchParams, Response, Headers, Request, TextEncoder, TextDecoder, setTimeout, clearTimeout };
  vm.runInNewContext(js, context, { filename: path });
  return context.exports;
}

test('scraped unknown cue timestamps stay unknown and exact 1050 cue remains shareable', async () => {
  const tracks = [
    { track_number: 1, cue_seconds: 45, timestamp: '00:45', title_raw: 'Cosmic Gate - Come With Me' },
    { track_number: 2, cue_seconds: null, timestamp: '--:--', title_raw: 'Unknown cue' },
    { track_number: 3, cue_seconds: 1050, timestamp: '17:30', title_raw: 'Cosmic Gate & Diana Miro - Nothing To Hide WAKE YOUR MIND (BLACK HOLE )' },
  ];
  const api = load('src/services/discoveryApi.ts', {
    './authService': { authenticatedFetch: async url => {
      if (url.includes('/api/tracklists/')) return new Response('{}', { status: 404 });
      if (url.includes('/api/tracklist/resolve')) return new Response(JSON.stringify({ found: true, tracklistUrl: 'https://www.1001tracklists.com/tracklist/fixture' }), { status: 200 });
      if (url.includes('/api/scrape/tracklist')) return new Response(JSON.stringify({ tracks }), { status: 200 });
      throw Error('Unexpected request ' + url);
    } },
    './cache': { get: async () => null, set: async () => {}, del: async () => {}, TTL: {} },
    './subsonic': { getCoverUrl: id => id, getAlbumList: async () => ({}), getSearch3: async () => ({}) },
  });
  const { findActiveCueIndex } = load('src/utils/cues.ts', {});
  const cues = await api.getTracklist('2tOSEwE7kRK1Mg0jJsBXDn');
  assert.equal(cues[1].timeSec, -1, 'missing cue timestamp must not become second zero');
  assert.equal(cues[2].timeSec, 1050);
  assert.equal(findActiveCueIndex(cues, 0), -1, 'no invented cue at start');
  assert.equal(findActiveCueIndex(cues, 1050), 2, 'exact current cue');
});
