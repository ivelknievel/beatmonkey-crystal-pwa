import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';

// Existing unit-test pattern: execute the real TSX module with deterministic
// dependency/JSX fixtures. This checks semantics and bubbling, not iOS runtime.
const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
async function load(file, deps) {
  const source = await fs.readFile(file, 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  new Function('require', 'exports', code)(name => {
    if (name === 'react/jsx-runtime') return jsx;
    if (name in deps) return deps[name];
    throw Error(`Unexpected dependency ${name}`);
  }, exports);
  return exports;
}
const children = node => [node?.props?.children].flat(Infinity).filter(n => n && typeof n === 'object');
function nodes(tree, ancestors = []) {
  return [{ node: tree, ancestors }, ...children(tree).flatMap(child => nodes(child, [...ancestors, tree]))];
}
const text = node => typeof node === 'string' ? node : !node || typeof node !== 'object' ? '' : [node.props?.children].flat(Infinity).map(text).join('');
const name = node => node.props?.['aria-label'] || text(node);
const interactive = node => node.type === 'button' || node.type === 'a' || node.props?.role === 'button';
function button(tree, label) {
  const matches = nodes(tree).filter(({ node }) => node.type === 'button' && name(node) === label);
  assert.equal(matches.length, 1, `one native button named ${label}`);
  return matches[0];
}
function separated(tree) {
  assert.ok(['article', 'section'].includes(tree.type), 'noninteractive semantic wrapper');
  assert.equal(tree.props.role, undefined);
  assert.equal(tree.props.tabIndex, undefined);
  assert.equal(tree.props.onClick, undefined);
  assert.equal(tree.props.onKeyDown, undefined);
  for (const { node, ancestors } of nodes(tree).filter(({ node }) => interactive(node))) {
    assert.equal(node.type, 'button', 'native keyboard-accessible action');
    assert.equal(node.props.type, 'button');
    assert.ok(!ancestors.some(interactive), `no interactive ancestor around ${name(node)}`);
  }
}
// Model event bubbling through the real returned tree. Native buttons synthesize
// click for Enter/Space; no parent keydown may trigger a second action.
function activate(control, key) {
  let stopped = false;
  const event = { key, preventDefault() {}, stopPropagation() { stopped = true; } };
  if (key) {
    for (const node of [control.node, ...control.ancestors.toReversed()]) {
      node.props?.onKeyDown?.(event);
      if (stopped) break;
    }
    stopped = false;
  }
  for (const node of [control.node, ...control.ancestors.toReversed()]) {
    node.props?.onClick?.(event);
    if (stopped) break;
  }
}
const topSet = { id: 'fixture-set', title: 'Fixture set', artist: 'Fixture artist' };
const festival = { slug: 'fixture-festival', name: 'Fixture Festival', logo: '/fixture.png', stages: [{ sets: [topSet] }] };
async function spotlight() {
  const calls = { play: [], open: [] };
  const { SpotlightCard } = await load('src/components/Discover/SpotlightCard.tsx', {
    '@tanstack/react-router': { useNavigate: () => args => calls.open.push(args) },
    'lucide-react': {},
    '../../stores/playerStore': { usePlayerStore: select => select({ loadSet: (...args) => calls.play.push(args) }) },
  });
  return { render: props => SpotlightCard({ festival: props || festival }), calls };
}
async function mini(options = {}) {
  const calls = { play: 0, open: [], favorite: 0, propPlay: 0, propOpen: 0 };
  const state = { currentSet: topSet, isPlaying: false, status: 'paused', isFullscreen: false,
    togglePlay: () => calls.play++, setFullscreen: value => calls.open.push(value),
    likedSetIds: [], toggleLike: () => calls.favorite++, ...options };
  const { FavoriteButton } = await load('src/components/Shared/FavoriteButton.tsx', {
    'lucide-react': {}, '../../stores/playerStore': { usePlayerStore: select => select(state) },
  });
  const { MiniPlayerBar } = await load('src/components/MiniPlayer/MiniPlayerBar.tsx', {
    react: { useRef: () => ({ current: null }), useEffect() {} }, 'lucide-react': {},
    '../../stores/playerStore': { usePlayerStore: select => select(state) },
    '../../engine/AudioEngine': {}, '../../services/subsonic': { getCoverUrl: id => `/fixture/${id}` },
    '../Shared/FavoriteButton': { FavoriteButton },
  });
  const render = props => {
    const tree = MiniPlayerBar(props);
    // Resolve the real FavoriteButton module so its event propagation is checked too.
    for (const entry of nodes(tree)) {
      if (entry.node?.type === FavoriteButton) Object.assign(entry.node, FavoriteButton(entry.node.props));
    }
    return tree;
  };
  return { render, calls };
}

test('spotlight exposes separate named native controls without interactive ancestors', async () => {
  const { render } = await spotlight(); const tree = render();
  separated(tree);
  button(tree, 'Speel Top Set'); button(tree, 'Bekijk Festival: Fixture Festival');
});
for (const key of [undefined, 'Enter', ' ']) {
  test(`spotlight ${key === ' ' ? 'Space' : key ?? 'pointer'} play never navigates; open never plays`, async () => {
    const { render, calls } = await spotlight(); const tree = render();
    activate(button(tree, 'Speel Top Set'), key);
    assert.deepEqual(calls.play, [[topSet, 0]]); assert.deepEqual(calls.open, []);
    activate(button(tree, 'Bekijk Festival: Fixture Festival'), key);
    assert.deepEqual(calls.open, [{ to: '/festivals/fixture-festival' }]); assert.equal(calls.play.length, 1);
  });
}
test('spotlight without a top set retains open action and omits play', async () => {
  const { render } = await spotlight(); const tree = render({ ...festival, stages: [] });
  separated(tree); button(tree, 'Bekijk Festival: Fixture Festival');
  assert.ok(!nodes(tree).some(({ node }) => name(node) === 'Speel Top Set'));
});
test('mini-player exposes separate named open, play and favorite buttons', async () => {
  const { render } = await mini(); const tree = render();
  separated(tree);
  button(tree, 'Open speler: Fixture set - Fixture artist'); button(tree, 'Afspelen'); button(tree, 'Voeg toe aan favorieten');
});
for (const key of [undefined, 'Enter', ' ']) {
  test(`mini-player ${key === ' ' ? 'Space' : key ?? 'pointer'} play/favorite never open fullscreen`, async () => {
    const { render, calls } = await mini(); const tree = render();
    activate(button(tree, 'Afspelen'), key);
    assert.equal(calls.play, 1); assert.deepEqual(calls.open, []);
    activate(button(tree, 'Voeg toe aan favorieten'), key);
    assert.equal(calls.favorite, 1); assert.deepEqual(calls.open, []);
    activate(button(tree, 'Open speler: Fixture set - Fixture artist'), key);
    assert.deepEqual(calls.open, [true]); assert.equal(calls.play, 1);
  });
}
test('mini-player respects callback overrides and paused/playing action labels', async () => {
  const { render, calls } = await mini();
  const tree = render({ isPlaying: true, onPlayPause: () => calls.propPlay++, onOpenFullscreen: () => calls.propOpen++ });
  activate(button(tree, 'Pauzeer'), ' '); activate(button(tree, 'Open speler: Fixture set - Fixture artist'), 'Enter');
  assert.equal(calls.propPlay, 1); assert.equal(calls.propOpen, 1); assert.equal(calls.play, 0); assert.deepEqual(calls.open, []);
});
test('mini-player empty/loading/fullscreen states retain the existing contract', async () => {
  const empty = await mini({ currentSet: null, status: 'loading' }); const tree = empty.render();
  separated(tree); button(tree, 'Open speler: Beatmonkey Crystal - Geen track geladen'); button(tree, 'Afspelen');
  assert.equal(nodes(tree).filter(({ node }) => node.type === 'button').length, 2);
  const fullscreen = await mini({ isFullscreen: true }); assert.equal(fullscreen.render(), null);
});
