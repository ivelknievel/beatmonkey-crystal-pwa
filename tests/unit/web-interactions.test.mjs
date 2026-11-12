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

test('TrackRow and EqualizerIndicator: play-pause-play animation, no LIVE badge, and preserved highlight/progress/timestamps', async t => {
  const hEq = hooks();
  const timers = new Map();
  let nextTimerId = 1;
  globals(t, {
    setInterval: fn => { const id = nextTimerId++; timers.set(id, fn); return id; },
    clearInterval: id => { timers.delete(id); },
  });
  const { EqualizerIndicator } = await load('src/components/Player/EqualizerIndicator.tsx', { react: hEq.react });
  const barHeights = tree => [tree.props.children].flat().map(bar => bar.props.style.height);

  // Paused inicialmente: static bars, no active interval
  let eqTree = hEq.render(EqualizerIndicator, { isPlaying: false });
  eqTree = hEq.render(EqualizerIndicator, { isPlaying: false });
  assert.equal(eqTree.props['data-playing'], 'false');
  assert.equal(timers.size, 0);
  const pausedInitial = barHeights(eqTree);
  assert.deepEqual(pausedInitial, ['6px', '11px', '8px']);

  // Play: interval starts and bars animate on tick
  hEq.render(EqualizerIndicator, { isPlaying: true });
  eqTree = hEq.render(EqualizerIndicator, { isPlaying: true });
  assert.equal(eqTree.props['data-playing'], 'true');
  assert.equal(timers.size, 1);
  const playingFirst = barHeights(eqTree);
  assert.notDeepEqual(playingFirst, pausedInitial);
  for (const fn of [...timers.values()]) fn();
  eqTree = hEq.render(EqualizerIndicator, { isPlaying: true });
  const playingSecond = barHeights(eqTree);

  // Pause: interval cleared, bars return to static state and stay static
  hEq.render(EqualizerIndicator, { isPlaying: false });
  eqTree = hEq.render(EqualizerIndicator, { isPlaying: false });
  assert.equal(eqTree.props['data-playing'], 'false');
  assert.equal(timers.size, 0);
  assert.deepEqual(barHeights(eqTree), ['6px', '11px', '8px']);
  assert.notDeepEqual(playingSecond, ['6px', '11px', '8px']);

  // Play again (resume): interval restarts and bars animate again
  hEq.render(EqualizerIndicator, { isPlaying: true });
  eqTree = hEq.render(EqualizerIndicator, { isPlaying: true });
  assert.equal(eqTree.props['data-playing'], 'true');
  assert.equal(timers.size, 1);
  assert.notDeepEqual(barHeights(eqTree), ['6px', '11px', '8px']);
  hEq.unmount();
  assert.equal(timers.size, 0);

  // TrackRow: no LIVE badge, preserves highlight, progress and timestamps across play-pause-play and inactive cues
  const hRow = hooks();
  const { TrackRow } = await load('src/components/Player/TrackRow.tsx', {
    react: hRow.react,
    'lucide-react': { Music2: 'Music2', Share2: 'Share2', ChevronRight: 'ChevronRight' },
    '../../utils/format': { formatTime: s => `0:${String(s).padStart(2, '0')}` },
    './EqualizerIndicator': { EqualizerIndicator },
  });
  const track = { title: 'Come With Me', artist: 'Cosmic Gate', timeSec: 45 };

  const activePlayingRow = hRow.render(TrackRow, {
    track,
    isActive: true,
    isPlaying: true,
    playProgress: 0.5,
    trackNumber: 1,
    onSeek() {},
  });
  assert.equal(find(activePlayingRow, n => n.props?.children === 'LIVE'), null, 'LIVE badge must be completely removed');
  const eqNodePlaying = find(activePlayingRow, n => n.type === EqualizerIndicator);
  assert.ok(eqNodePlaying, 'active row renders EqualizerIndicator');
  assert.equal(eqNodePlaying.props.isPlaying, true);
  assert.ok(find(activePlayingRow, n => typeof n.props?.className === 'string' && n.props.className.includes('bg-[#132036]')), 'active highlight preserved');
  assert.ok(find(activePlayingRow, n => n.props?.children === '0:45'), 'timestamp preserved');
  assert.ok(find(activePlayingRow, n => n.props?.style?.width === '50%'), 'progress bar preserved');

  const activePausedRow = hRow.render(TrackRow, {
    track,
    isActive: true,
    isPlaying: false,
    playProgress: 0.5,
    trackNumber: 1,
    onSeek() {},
  });
  assert.equal(find(activePausedRow, n => n.props?.children === 'LIVE'), null);
  const eqNodePaused = find(activePausedRow, n => n.type === EqualizerIndicator);
  assert.ok(eqNodePaused, 'active paused row still renders static EqualizerIndicator');
  assert.equal(eqNodePaused.props.isPlaying, false);
  assert.ok(find(activePausedRow, n => typeof n.props?.className === 'string' && n.props.className.includes('bg-[#132036]')), 'active highlight preserved on pause');
  assert.ok(find(activePausedRow, n => n.props?.children === '0:45'), 'timestamp preserved on pause');
  assert.ok(find(activePausedRow, n => n.props?.style?.width === '50%'), 'progress bar preserved on pause');

  const inactiveRow = hRow.render(TrackRow, {
    track,
    isActive: false,
    isPlaying: true,
    playProgress: 0.5,
    trackNumber: 2,
    onSeek() {},
  });
  assert.equal(find(inactiveRow, n => n.type === EqualizerIndicator), null, 'other cue does not render EqualizerIndicator');
  assert.equal(find(inactiveRow, n => n.props?.children === 'LIVE'), null);
});

test('TracklistSection equalizer only animates on real isPlaying for current set and active cue', async t => {
  const h = hooks();
  const cuesA = [
    { timeSec: 0, title: 'Cue A1', artist: 'Artist A' },
    { timeSec: 60, title: 'Cue A2', artist: 'Artist A' },
  ];
  const cuesB = [
    { timeSec: 0, title: 'Cue B1', artist: 'Artist B' },
  ];
  let state = {
    currentSetId: 'album-A',
    currentSet: { id: 'album-A', title: 'Set A' },
    activeCueIndex: 0,
    currentTime: 30,
    duration: 120,
    isPlaying: true,
    status: 'playing',
    togglePlay() {},
    setFullscreen() {},
  };
  const store = Object.assign(fn => fn(state), {
    getState: () => ({ ...state, setTracklistForSet() {}, setActiveCueIndex: i => { state.activeCueIndex = i; } }),
  });
  globals(t, { requestAnimationFrame: () => 1, cancelAnimationFrame() {}, window: { matchMedia: () => ({ matches: false }) } });
  const RowMarker = props => ({ type: 'TrackRow', props });
  const { TracklistSection } = await load('src/components/Player/TracklistSection.tsx', {
    react: h.react,
    '../../stores/playerStore': { usePlayerStore: store },
    '../../services/discoveryApi': { getTracklist: async id => (id === 'album-A' ? cuesA : cuesB) },
    './TrackRow': { TrackRow: RowMarker },
    './WaveCurveCanvas': { WaveCurveCanvas: () => null },
    'lucide-react': {},
    '../../engine/AudioEngine': { AudioEngine: { getCurrentTime: () => state.currentTime, getDuration: () => state.duration, seek() {} } },
    '../../utils/shareLinks': {},
    '../../utils/format': { formatTime: String },
    '../../services/authService': {},
  });

  // Load set A tracklist while playing cue 0
  h.render(TracklistSection, { isOpen: true });
  await flush();
  let tree = h.render(TracklistSection, { isOpen: true });
  let rowA1 = find(tree, n => n.props?.track?.title === 'Cue A1').props;
  let rowA2 = find(tree, n => n.props?.track?.title === 'Cue A2').props;
  assert.equal(rowA1.isActive, true);
  assert.equal(rowA1.isPlaying, true);
  assert.equal(rowA1.playProgress, 0.5);
  assert.equal(rowA2.isActive, false, 'other cue is not active');
  assert.equal(rowA2.isPlaying, false, 'other cue does not animate');

  // Pause on set A cue 0 -> active stays true, isPlaying becomes false
  state = { ...state, isPlaying: false, status: 'paused' };
  tree = h.render(TracklistSection, { isOpen: true });
  rowA1 = find(tree, n => n.props?.track?.title === 'Cue A1').props;
  rowA2 = find(tree, n => n.props?.track?.title === 'Cue A2').props;
  assert.equal(rowA1.isActive, true, 'active cue stays highlighted on pause');
  assert.equal(rowA1.isPlaying, false, 'equalizer static on pause');
  assert.equal(rowA1.playProgress, 0.5, 'progress preserved on pause');
  assert.equal(rowA2.isPlaying, false);

  // Resume play on set A cue 0 -> isPlaying becomes true again
  state = { ...state, isPlaying: true, status: 'playing' };
  tree = h.render(TracklistSection, { isOpen: true });
  rowA1 = find(tree, n => n.props?.track?.title === 'Cue A1').props;
  assert.equal(rowA1.isActive, true);
  assert.equal(rowA1.isPlaying, true, 'equalizer resumes on play');

  // Advance to cue 1 -> cue 0 stops, cue 1 animates
  state = { ...state, activeCueIndex: 1, currentTime: 90 };
  tree = h.render(TracklistSection, { isOpen: true });
  rowA1 = find(tree, n => n.props?.track?.title === 'Cue A1').props;
  rowA2 = find(tree, n => n.props?.track?.title === 'Cue A2').props;
  assert.equal(rowA1.isActive, false);
  assert.equal(rowA1.isPlaying, false);
  assert.equal(rowA2.isActive, true);
  assert.equal(rowA2.isPlaying, true);

  // Switch to another set B (before B tracklist resolves or while loading): A cues must not animate
  state = { ...state, currentSetId: 'album-B', currentSet: { id: 'album-B', title: 'Set B' }, activeCueIndex: 0, isPlaying: true, status: 'loading' };
  let beforeEffectsTree;
  h.render(TracklistSection, { isOpen: true }, rendered => { beforeEffectsTree = rendered; });
  const staleRowA2 = find(beforeEffectsTree, n => n.props?.track?.title === 'Cue A2')?.props;
  if (staleRowA2) {
    assert.equal(staleRowA2.isActive, false, 'previous set cue cannot stay active after set switch');
    assert.equal(staleRowA2.isPlaying, false, 'previous set cue cannot animate after set switch');
  }
  await flush();
  tree = h.render(TracklistSection, { isOpen: true });
  let rowB1 = find(tree, n => n.props?.track?.title === 'Cue B1').props;
  assert.equal(rowB1.isActive, true);
  assert.equal(rowB1.isPlaying, false, 'loading set does not animate until status is playing');

  state = { ...state, status: 'playing', isPlaying: true };
  tree = h.render(TracklistSection, { isOpen: true });
  rowB1 = find(tree, n => n.props?.track?.title === 'Cue B1').props;
  assert.equal(rowB1.isActive, true);
  assert.equal(rowB1.isPlaying, true, 'new set active cue animates once truly playing');
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
