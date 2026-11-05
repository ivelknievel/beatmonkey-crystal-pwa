import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';
import * as jsx from 'react/jsx-runtime';
import { environment, info, album, deferred, tick } from './player-helpers.mjs';

const guidance = 'Tik op Afspelen om deze set te starten.';
const blocked = () => new DOMException('The request is not allowed by the user agent in the current context.', 'NotAllowedError');
function component(file, dependencies) {
  const code = ts.transpileModule(readFileSync(new URL('../../' + file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  new Function('require', 'exports', code)(name => {
    if (name === 'react/jsx-runtime') return jsx;
    assert.ok(name in dependencies, `explicit fixture dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}
function hooks() {
  const slots = []; let cursor = 0; const pending = [];
  return {
    react: {
      useState(initial) { const i = cursor++; slots[i] ??= { value: initial }; return [slots[i].value, value => { slots[i].value = value; }]; },
      useEffect(fn, deps) { const i = cursor++; if (!slots[i] || deps.some((v, n) => v !== slots[i].deps[n])) { const old = slots[i]; slots[i] = { deps }; pending.push(() => { old?.cleanup?.(); slots[i].cleanup = fn(); }); } },
      useCallback: fn => fn, useRef: () => ({ current: null }),
    },
    render(fn, effects = true) { cursor = 0; const tree = fn(); if (effects) pending.splice(0).forEach(fn => fn()); return tree; },
    unmount() { slots.forEach(slot => slot.cleanup?.()); },
  };
}
async function shared(overrides = {}) {
  const env = await environment(overrides); const h = hooks();
  const { Route } = component('src/routes/set.$id.tsx', {
    react: h.react, '@tanstack/react-router': { createRoute: config => ({ ...config, useParams: () => ({ id: 'song-A' }), useSearch: () => ({ t: 42 }) }) },
    './__root': { Route: {} }, '../services/subsonic': { getSong: async () => ({ song: { id: 'song-A', albumId: 'A' } }), getAlbum: async id => album(id), getCoverUrl: id => id },
    '../stores/playerStore': { usePlayerStore: env.store }, '../utils/shareLinks': { parseShareTime: Number },
  });
  return { ...env, render: () => renderToStaticMarkup(h.render(Route.component)), unmount: h.unmount };
}

test('cold shared autoplay rejection gives Dutch guidance, explicit play clears store AND route message', async () => {
  const env = await shared(); const audio = env.engine.getAudioElement(); audio.rejectPlay = blocked();
  env.render(); await tick();
  const html = env.render();
  assert.equal(env.store.getState().status, 'blocked');
  assert.equal(env.store.getState().error, guidance);
  assert.ok(html.includes(guidance));
  assert.doesNotMatch(html, /NotAllowedError|user agent|not allowed/);
  assert.equal(env.store.getState().isFullscreen, true, 'blocked shared set exposes fullscreen play controls');
  audio.rejectPlay = null; await env.store.getState().play();
  assert.equal(env.store.getState().status, 'playing'); assert.equal(env.store.getState().error, null);
  assert.doesNotMatch(env.render(), /Tik op Afspelen|not allowed|openen…/);
  env.engine.pause(); assert.doesNotMatch(env.render(), /Tik op Afspelen|not allowed/);
  env.unmount();
});

test('shared route reflects later playback failure and removes it after successful retry', async () => {
  const env = await shared(); env.render(); await tick(); env.engine.pause();
  env.engine.getAudioElement().rejectPlay = Error('raw English codec failure');
  await env.store.getState().play();
  assert.equal(env.store.getState().status, 'error');
  assert.match(env.render(), /Afspelen mislukt/); assert.doesNotMatch(env.render(), /raw English/);
  env.engine.getAudioElement().rejectPlay = null; await env.store.getState().play();
  assert.doesNotMatch(env.render(), /Afspelen mislukt|raw English/); env.unmount();
});

test('media element error is friendly and a successful retry clears it', async () => {
  const { store, engine } = await environment(); await store.getState().loadSet(info('A'));
  const audio = engine.getAudioElement(); audio.error = { code: 4, message: 'raw English decoder details' }; audio.dispatchEvent(new Event('error'));
  assert.match(store.getState().error, /Afspelen mislukt/); assert.doesNotMatch(store.getState().error, /raw English|decoder/);
  await store.getState().play(); assert.equal(store.getState().error, null);
});

test('delegated shared metadata failure is visible in Dutch instead of hanging or exposing exception text', async () => {
  const env = await shared({ getAlbum: async () => { throw Error('raw English network failure'); } });
  env.render(); await tick();
  assert.equal(env.store.getState().status, 'error');
  assert.equal(env.store.getState().error, 'Set laden mislukt. Probeer opnieuw.');
  assert.match(env.render(), /Set laden mislukt/);
  assert.doesNotMatch(env.render(), /raw English|openen…/);
  const audio = env.engine.getAudioElement();
  env.engine.togglePlay(); await env.store.getState().play(); await tick();
  assert.equal(audio.playCalls, 0, 'cold metadata failure has no source to retry');
  assert.equal(audio.paused, true);
  assert.equal(env.engine.getCurrentSongId(), null);
  assert.match(env.render(), /Set laden mislukt/, 'inert playback must not hide the load error');
  env.unmount();
});

test('obsolete blocked rejection after newer explicit play cannot restore stale error', async () => {
  const { engine, store } = await environment(); const audio = engine.getAudioElement(); const pending = deferred();
  audio.play = () => pending.promise;
  const loading = store.getState().loadSet(info('A')); await tick();
  audio.play = () => { audio.paused = false; return Promise.resolve(); };
  await store.getState().play(); pending.reject(blocked()); await loading;
  assert.equal(store.getState().error, null); assert.equal(store.getState().status, 'playing');
});

test('fullscreen renders no numeric zero for missing year, including festival-only metadata; valid year remains', async () => {
  const { store, engine } = await environment(); const h = hooks(); const empty = () => null;
  const { FullscreenPlayerOverlay } = component('src/components/Player/FullscreenPlayerOverlay.tsx', {
    react: h.react, 'lucide-react': { ChevronDown: empty, ListPlus: empty, Disc3: empty, Sparkles: empty, Share2: empty },
    '../../utils/shareLinks': {}, '../../stores/playerStore': { usePlayerStore: store }, '../../services/subsonic': { getCoverUrl: id => id },
    '../Shared/FavoriteButton': { FavoriteButton: empty }, './Scrubber': { Scrubber: empty }, './PlaybackControls': { PlaybackControls: empty },
    './TracklistSection': { TracklistSection: empty }, './QueueSheet': { QueueSheet: empty }, './Visualizer': { Visualizer: empty }, '../../engine/AudioEngine': { AudioEngine: engine },
  });
  for (const metadata of [{ year: 0 }, { year: 0, festival: 'Fixture Festival' }, {}, { year: 2026 }]) {
    store.setState({ currentSet: { ...info('A'), ...metadata }, status: 'blocked', error: guidance });
    const html = renderToStaticMarkup(h.render(FullscreenPlayerOverlay, false));
    assert.doesNotMatch(html, />0</, JSON.stringify(metadata));
    if (metadata.year === 2026) assert.match(html, />2026</);
    assert.ok(html.includes(guidance), 'blocked guidance also visible inside modal');
  }
});
