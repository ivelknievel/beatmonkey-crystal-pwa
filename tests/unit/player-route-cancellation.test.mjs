import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { environment, info, album, deferred, tick } from './player-helpers.mjs';

async function routeEnvironment(overrides = {}) {
  const calls = [];
  const services = {
    getSong: async id => ({ song: { id, albumId: id.replace('song-', ''), duration: 3600 } }),
    getAlbum: async id => album(id), getCoverUrl: id => id, ...overrides,
  };
  const env = await environment({ ...services, getAlbum: id => {
    calls.push(id);
    return services.getAlbum(id, calls.filter(value => value === id).length);
  } });
  let params = { id: 'song-A' }, search = { t: 42 }, effect, cleanup;
  const errors = [];
  const deps = {
    '@tanstack/react-router': { createRoute: config => ({ ...config, useParams: () => params, useSearch: () => search }) },
    react: { useState: value => [value, value => errors.push(value)], useEffect: fn => { effect = fn; } },
    'react/jsx-runtime': { jsx: () => null }, './__root': { Route: {} },
    '../services/subsonic': { ...services, getAlbum: id => {
      calls.push(id);
      return services.getAlbum(id, calls.filter(value => value === id).length);
    } },
    '../stores/playerStore': { usePlayerStore: env.store },
    '../utils/shareLinks': { parseShareTime: value => Number(value) || 0 },
  };
  const raw = readFileSync(new URL('../../src/routes/set.$id.tsx', import.meta.url), 'utf8');
  const code = ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  new Function('require', 'exports', code)(id => {
    assert.ok(id in deps, `explicit route dependency: ${id}`);
    return deps[id];
  }, exports);
  return { ...env, calls, errors,
    mount(id = 'song-A', t = 42) {
      cleanup?.(); params = { id }; search = { t };
      exports.Route.component(); cleanup = effect();
    },
    unmount() { cleanup?.(); cleanup = undefined; },
  };
}

test('real shared route unmount cancels metadata already delegated to the actual store', { timeout: 3000 }, async () => {
  const pending = deferred();
  const env = await routeEnvironment({ getAlbum: (id, call) => call === 2 ? pending.promise : album(id) });
  env.mount(); await tick();
  assert.deepEqual(env.calls, ['A', 'A'], 'route lookup completed and redundant store lookup is pending');
  env.unmount(); pending.resolve(album('A')); await tick();
  assert.equal(env.engine.getAudioElement().playCalls, 0);
  assert.equal(env.engine.getAudioElement().src, '');
  assert.equal(env.store.getState().currentSongId, null);
  assert.deepEqual(env.store.getState().queue, []);
  assert.equal(env.store.getState().isFullscreen, false);
});

test('shared B metadata pending cancels delegated A before B reaches the store', { timeout: 3000 }, async () => {
  const pendingA = deferred(), pendingB = deferred();
  const env = await routeEnvironment({
    getSong: id => id === 'song-B' ? pendingB.promise : Promise.resolve({ song: { id, albumId: 'A' } }),
    getAlbum: (id, call) => id === 'A' && call === 2 ? pendingA.promise : album(id),
  });
  env.mount(); await tick(); env.mount('song-B', 81);
  pendingA.resolve(album('A')); await tick();
  assert.equal(env.engine.getAudioElement().playCalls, 0, 'A cannot start while B first metadata is pending');
  pendingB.resolve({ song: { id: 'song-B', albumId: 'B' } }); await tick();
  env.engine.getAudioElement().dispatchEvent(new Event('loadedmetadata'));
  assert.equal(env.store.getState().currentSetId, 'B');
  assert.equal(env.store.getState().currentSongId, 'song-B');
  assert.equal(env.store.getState().currentTime, 81);
  assert.deepEqual(env.store.getState().queue.map(item => item.id), ['B']);
  assert.equal(env.engine.getAudioElement().playCalls, 1);
  env.unmount();
});

test('query-only shared navigation aborts old delegated load and preserves new finite timestamp', { timeout: 3000 }, async () => {
  const pending = deferred();
  const env = await routeEnvironment({ getAlbum: (id, call) => call === 2 ? pending.promise : album(id) });
  env.mount(); await tick(); env.mount('song-A', 99); await tick();
  pending.resolve(album('A')); await tick();
  assert.equal(env.engine.getAudioElement().playCalls, 1);
  env.engine.getAudioElement().dispatchEvent(new Event('loadedmetadata'));
  assert.equal(env.store.getState().currentSetId, 'A');
  assert.equal(env.store.getState().currentSongId, 'song-A');
  assert.equal(env.store.getState().currentTime, 99);
  env.unmount();
});

test('route cleanup never stops or resets a newer independent selection', { timeout: 3000 }, async () => {
  const pending = deferred();
  const env = await routeEnvironment({ getAlbum: (id, call) => id === 'A' && call === 2 ? pending.promise : album(id) });
  env.mount(); await tick(); await env.store.getState().loadSet({ ...info('C'), songId: 'song-C' }, 125);
  env.unmount(); pending.resolve(album('A')); await tick();
  assert.equal(env.store.getState().currentSetId, 'C');
  env.engine.getAudioElement().dispatchEvent(new Event('loadedmetadata'));
  assert.equal(env.store.getState().currentSongId, 'song-C');
  assert.equal(env.engine.getCurrentSongId(), 'song-C');
  assert.equal(env.engine.getAudioElement().paused, false);
  assert.equal(env.store.getState().currentTime, 125);
});

test('already-aborted request is a complete no-op even for selection generation', { timeout: 3000 }, async () => {
  const pending = deferred(); let lookups = 0;
  const { store, engine } = await environment({ getAlbum: () => { lookups++; return pending.promise; } });
  const selected = store.getState().loadSet(info('B'));
  const snapshot = store.getState();
  const controller = new AbortController(); controller.abort();
  const aborted = store.getState().loadSet(info('A'), Infinity, controller.signal);
  assert.equal(store.getState(), snapshot);
  assert.equal(lookups, 1);
  pending.resolve(album('B')); await Promise.all([selected, aborted]);
  assert.equal(store.getState().currentSetId, 'B');
  assert.equal(engine.getCurrentSongId(), 'song-B');
});

test('abort during real engine play await prevents subsequent resume lookup without stopping newer source', { timeout: 3000 }, async () => {
  const pendingPlay = deferred(); let queueCalls = 0;
  const { store, engine } = await environment({ getPlayQueue: async () => { queueCalls++; return null; } });
  const audio = engine.getAudioElement();
  audio.play = () => { audio.playCalls++; return pendingPlay.promise; };
  const controller = new AbortController();
  const loading = store.getState().loadSet(info('A'), 0, controller.signal); await tick();
  assert.equal(engine.getCurrentSongId(), 'song-A');
  controller.abort(); pendingPlay.resolve(); await loading;
  assert.equal(queueCalls, 0, 'aborted engine continuation must not start playqueue restore');
  // A started before abort: cancellation is not a global media reset.
  assert.equal(engine.getCurrentSongId(), 'song-A');
  audio.play = () => { audio.paused = false; return Promise.resolve(); };
  await store.getState().loadSet({ ...info('B'), songId: 'song-B' }, 9);
  assert.equal(store.getState().currentSetId, 'B');
  assert.equal(engine.getCurrentSongId(), 'song-B');
  assert.equal(audio.paused, false);
});

test('abort while playqueue is pending suppresses late seek', { timeout: 3000 }, async () => {
  const pending = deferred();
  const { store, engine } = await environment({ getPlayQueue: () => pending.promise });
  const controller = new AbortController();
  const loading = store.getState().loadSet(info('A'), 0, controller.signal); await tick();
  engine.getAudioElement().readyState = 1; controller.abort();
  pending.resolve({ songId: 'song-A', albumId: 'A', position: 125000 }); await loading;
  assert.equal(engine.getCurrentTime(), 0);
  assert.equal(store.getState().currentTime, 0);
});

test('aborted store metadata rejection cannot publish an error', { timeout: 3000 }, async () => {
  const pending = deferred();
  const { store, engine } = await environment({ getAlbum: () => pending.promise });
  const controller = new AbortController();
  const loading = store.getState().loadSet(info('A'), 0, controller.signal);
  controller.abort(); pending.reject(Error('obsolete failure')); await loading;
  assert.equal(store.getState().error, null);
  assert.equal(engine.getAudioElement().playCalls, 0);
});
