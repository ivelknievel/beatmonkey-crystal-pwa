import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';

// Small deterministic hook/JSX fixtures exercise the real TSX handlers without a browser.
// These fixtures do not emulate iPhone layout, event synthesis or media policy.
function hooks() {
  const slots = []; let cursor = 0, queued = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState(initial) { const n = cursor++; slots[n] ??= { value: initial }; return [slots[n].value, v => { slots[n].value = typeof v === 'function' ? v(slots[n].value) : v; }]; },
    useRef(initial) { const n = cursor++; return slots[n] ??= { current: initial }; },
    useCallback(fn, deps) { const n = cursor++; if (!slots[n] || !same(slots[n].deps, deps)) slots[n] = { fn, deps }; return slots[n].fn; },
    useEffect(fn, deps) { const n = cursor++; if (!slots[n] || !same(slots[n].deps, deps)) { const old = slots[n]; slots[n] = { deps, cleanup: old?.cleanup }; queued.push(() => { old?.cleanup?.(); slots[n].cleanup = fn(); }); } },
  };
  return { react, slots, render(fn, props, beforeEffects) { cursor = 0; const tree = fn(props); beforeEffects?.(tree); const work = queued; queued = []; work.forEach(fn => fn()); return tree; }, unmount() { slots.forEach(s => s?.cleanup?.()); } };
}
const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null;
  if (predicate(tree)) return tree;
  for (const child of [tree.props?.children].flat(Infinity)) { const result = find(child, predicate); if (result) return result; }
  return null;
}
async function load(file, deps) {
  const source = (await fs.readFile(file, 'utf8')).replaceAll('import.meta.env.PROD', 'true');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  new Function('require', 'exports', code)(name => { if (name === 'react/jsx-runtime') return jsx; if (name in deps) return deps[name]; throw Error(`Unexpected ${name}`); }, exports);
  return exports;
}
const flush = () => new Promise(r => setImmediate(r));
function globals(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const before = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (before) Object.defineProperty(globalThis, key, before); else delete globalThis[key]; });
  }
}

test('real TrackRow handlers separate vertical scroll, cancellation, swipe and follow-up click', async () => {
  const h = hooks(); let shared = 0, spotify = 0, sought = 0;
  const { TrackRow } = await load('src/components/Player/TrackRow.tsx', { react: h.react, 'lucide-react': {}, '../../utils/format': { formatTime: String }, './EqualizerIndicator': {} });
  const tree = h.render(TrackRow, { track: { title: 'fixture', timeSec: 0 }, trackNumber: 1, onShare: () => shared++, onSpotifySearch: () => spotify++, onSeek: () => sought++ });
  const row = find(tree, n => n.props?.onTouchStart).props;
  const touch = (x, y) => ({ touches: [{ clientX: x, clientY: y }] });
  row.onTouchStart(touch(0, 0)); row.onTouchMove(touch(-90, 180)); row.onTouchEnd();
  assert.equal(shared, 0); assert.equal(spotify, 0);
  row.onTouchStart(touch(0, 0)); row.onTouchMove(touch(-100, 1)); row.onTouchCancel(); row.onTouchEnd(); assert.equal(shared, 0);
  row.onTouchStart(touch(0, 0)); row.onTouchMove(touch(-100, 1)); row.onTouchEnd(); assert.equal(shared, 1);
  row.onClick({ detail: 1, preventDefault() {}, stopPropagation() {} }); assert.equal(sought, 0);
  row.onKeyDown({ key: 'Enter', preventDefault() {} }); assert.equal(sought, 1);
  row.onTouchStart(touch(0, 0)); row.onTouchMove(touch(100, 1)); row.onTouchEnd(); assert.equal(spotify, 1);
});

test('real Scrubber keyboard supports bounded arrows/home/end and cancelled pointer never seeks', async () => {
  const h = hooks(); const seeks = []; const state = { currentTime: 42, duration: 100, currentSet: { duration: 100, tracklist: [] } };
  const engine = { getCurrentTime: () => 42, getDuration: () => 100, seek: n => seeks.push(n) };
  const { Scrubber } = await load('src/components/Player/Scrubber.tsx', { react: h.react, '../../stores/playerStore': { usePlayerStore: fn => fn(state) }, '../../engine/AudioEngine': { AudioEngine: engine }, '../../utils/format': { formatTime: String } });
  // Render without effect flushing: only keyboard/pointer callbacks are under test.
  const tree = Scrubber();
  const slider = find(tree, n => n.props?.role === 'slider').props;
  assert.equal(slider.tabIndex, 0); assert.equal(slider['aria-valuenow'], 42);
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End', 'PageUp', 'PageDown']) slider.onKeyDown({ key, preventDefault() {} });
  assert.deepEqual(seeks, [47, 37, 0, 100, 100, 0]);
  const target = { setPointerCapture() {}, releasePointerCapture() {} };
  slider.onPointerDown({ currentTarget: target, pointerId: 1, clientX: 50 });
  slider.onPointerCancel({ currentTarget: target, pointerId: 1 });
  slider.onPointerUp({ currentTarget: target, pointerId: 1, clientX: 80 });
  assert.equal(seeks.length, 6);
});

test('Tracklist requests album identity; late A cannot replace B or update global cues', async t => {
  const h = hooks(); let state = { currentSet: { id: 'album-A', title: 'A' } }, resolveA; const calls = [], applied = [];
  const a = new Promise(r => { resolveA = r; });
  const store = Object.assign(fn => fn(state), { getState: () => ({ ...state, setTracklistForSet: (...args) => applied.push(args) }) });
  globals(t, { requestAnimationFrame: () => 1, cancelAnimationFrame() {}, window: { matchMedia: () => ({ matches: false }) } });
  const { TracklistSection } = await load('src/components/Player/TracklistSection.tsx', { react: h.react, '../../stores/playerStore': { usePlayerStore: store }, '../../services/discoveryApi': { getTracklist: id => { calls.push(id); return id === 'album-A' ? a : Promise.resolve([{ timeSec: 0, title: 'B cue' }]); } }, './TrackRow': {}, './WaveCurveCanvas': {}, 'lucide-react': {}, '../../engine/AudioEngine': { AudioEngine: {} }, '../../utils/shareLinks': {}, '../../utils/format': { formatTime: String }, '../../services/authService': {} });
  h.render(TracklistSection, { isOpen: true }); state = { currentSet: { id: 'album-B', title: 'B' } };
  h.render(TracklistSection, { isOpen: true }); await flush(); resolveA([{ timeSec: 9, title: 'A cue' }]); await flush();
  assert.deepEqual(calls, ['album-A', 'album-B']); assert.equal(applied.length, 1); assert.equal(applied[0][0], 'album-B');
  const tree = h.render(TracklistSection, { isOpen: true });
  assert.ok(find(tree, n => n.props?.track?.title === 'B cue'));
  assert.equal(find(tree, n => n.props?.track?.title === 'A cue'), null);
  h.unmount();
});

test('update requires explicit idle consent; cross-tab activation and resumed playback never auto reload', async t => {
  const h = hooks(); let state = { isPlaying: true, status: 'playing' }, paused = false, reloads = 0; const listeners = {}, messages = [];
  const waiting = { postMessage: value => messages.push(value) };
  const registration = { waiting, installing: null, addEventListener() {}, removeEventListener() {} };
  const sw = { controller: {}, register: async () => registration, addEventListener: (n, fn) => { listeners[n] = fn; }, removeEventListener: n => { delete listeners[n]; } };
  globals(t, { navigator: { serviceWorker: sw }, window: { location: { reload: () => reloads++ } } });
  const store = Object.assign(fn => fn(state), { getState: () => state });
  const { PwaUpdatePrompt } = await load('src/components/PwaUpdatePrompt.tsx', { react: h.react, '../stores/playerStore': { usePlayerStore: store }, '../engine/AudioEngine': { AudioEngine: { getAudioElement: () => ({ paused }) } } });
  h.render(PwaUpdatePrompt); await flush();
  let tree = h.render(PwaUpdatePrompt); const update = () => find(tree, n => n.type === 'button' && n.props.children === 'Nu bijwerken').props;
  assert.equal(update().disabled, true); update().onClick(); assert.equal(messages.length, 0);
  state = { isPlaying: false, status: 'paused' }; paused = true; tree = h.render(PwaUpdatePrompt); update().onClick(); assert.deepEqual(messages, [{ type: 'ACTIVATE_UPDATE' }]);
  state = { isPlaying: true, status: 'playing' }; paused = false; sw.controller = waiting; listeners.controllerchange(); assert.equal(reloads, 0);
  state = { isPlaying: false, status: 'paused' }; paused = true; tree = h.render(PwaUpdatePrompt); assert.equal(reloads, 0); update().onClick(); assert.equal(reloads, 1);
  listeners.controllerchange(); assert.equal(reloads, 1, 'another tab does not authorize reload');
  h.unmount(); assert.equal(listeners.controllerchange, undefined);
});

test('update is safe before any audio element has been initialized', async t => {
  const h = hooks(); const messages = [];
  const waiting = { postMessage: value => messages.push(value) };
  const registration = { waiting, installing: null, addEventListener() {}, removeEventListener() {} };
  const sw = { controller: {}, register: async () => registration, addEventListener() {}, removeEventListener() {} };
  globals(t, { navigator: { serviceWorker: sw }, window: { location: { reload() {} } } });
  const state = { isPlaying: false, status: 'idle' };
  const store = Object.assign(fn => fn(state), { getState: () => state });
  const { PwaUpdatePrompt } = await load('src/components/PwaUpdatePrompt.tsx', { react: h.react, '../stores/playerStore': { usePlayerStore: store }, '../engine/AudioEngine': { AudioEngine: { getAudioElement: () => null } } });
  h.render(PwaUpdatePrompt); await flush();
  const tree = h.render(PwaUpdatePrompt);
  const button = find(tree, n => n.type === 'button' && n.props.children === 'Nu bijwerken');
  assert.doesNotThrow(() => button.props.onClick());
  assert.deepEqual(messages, [{ type: 'ACTIVATE_UPDATE' }]);
  h.unmount();
});

test('fullscreen dialog enters focus, wraps Tab in both directions and restores opener', async t => {
  const h = hooks(), listeners = {};
  const doc = { activeElement: null, querySelectorAll: () => [root], addEventListener: (n, fn) => { listeners[n] = fn; }, removeEventListener: n => { delete listeners[n]; } };
  const element = () => ({ focus() { doc.activeElement = this; }, getClientRects: () => [1] });
  const first = element(), last = element(), opener = element();
  const root = { ...element(), querySelectorAll: () => [first, last], contains: el => [first, last].includes(el) };
  doc.activeElement = opener;
  globals(t, { document: doc, window: { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} }, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  const state = { currentSet: null, queue: [], setFullscreen() {} };
  const { FullscreenPlayerOverlay } = await load('src/components/Player/FullscreenPlayerOverlay.tsx', {
    react: h.react, '../../utils/shareLinks': {}, 'lucide-react': {}, '../../stores/playerStore': { usePlayerStore: fn => fn(state) }, '../../services/subsonic': {}, '../Shared/FavoriteButton': {}, './Scrubber': {}, './PlaybackControls': {}, './TracklistSection': {}, './QueueSheet': {}, './Visualizer': {}, '../../engine/AudioEngine': {},
  });
  h.render(FullscreenPlayerOverlay, undefined, tree => { tree.props.ref.current = root; });
  assert.equal(doc.activeElement, first);
  doc.activeElement = last; let prevented = false;
  listeners.keydown({ key: 'Tab', shiftKey: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(doc.activeElement, first);
  listeners.keydown({ key: 'Tab', shiftKey: true, preventDefault() {} }); assert.equal(doc.activeElement, last);
  h.unmount(); assert.equal(doc.activeElement, opener); assert.equal(listeners.keydown, undefined);
});

test('fullscreen provides a distinct labelled queue focus scope', async () => {
  const source = await fs.readFile('src/components/Player/FullscreenPlayerOverlay.tsx', 'utf8');
  assert.match(source, /aria-label="Afspeelwachtrij"/);
  assert.match(source, /queueDialogRef/);
});

test('Visualizer is inert by default and does not touch engine or audio graph', async () => {
  const h = hooks(); const engine = new Proxy({}, { get() { throw Error('unexpected engine access'); }, set() { throw Error('unexpected engine write'); } });
  const { Visualizer } = await load('src/components/Player/Visualizer.tsx', { react: h.react });
  assert.equal(h.render(Visualizer, { engine, isPlaying: true }), null);
  h.unmount();
});
