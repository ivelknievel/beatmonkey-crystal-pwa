import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';

function target(extra = {}) {
  const listeners = new Map();
  return Object.assign({
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    fire(name) { for (const fn of [...listeners.get(name) || []]) fn(); },
    count() { return [...listeners.values()].reduce((n, fns) => n + fns.size, 0); },
  }, extra);
}
function worker(state = 'activated') {
  return target({ state, messages: [], postMessage(message) { this.messages.push(message); } });
}
async function fixture(t, { controller = worker(), active = controller, waiting = null, installing = null, deferred = false } = {}) {
  const slots = []; let cursor = 0; const effects = []; let reloads = 0, resolve;
  const state = { isPlaying: false, status: 'idle' }; const audio = { paused: true };
  const registration = target({ active, waiting, installing });
  const sw = target({ controller, register: () => deferred ? new Promise(r => { resolve = r; }) : Promise.resolve(registration) });
  const react = {
    useState(initial) { const n = cursor++; slots[n] ??= { value: initial }; return [slots[n].value, value => { slots[n].value = value; }]; },
    useRef(initial) { const n = cursor++; return slots[n] ??= { current: initial }; },
    useEffect(fn) { const n = cursor++; if (!slots[n]) { slots[n] = {}; effects.push(() => { slots[n].cleanup = fn(); }); } },
  };
  const globals = { navigator: { serviceWorker: sw }, window: { location: { reload: () => reloads++ } } };
  const restore = [];
  for (const [key, value] of Object.entries(globals)) {
    const before = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    restore.push(() => { if (before) Object.defineProperty(globalThis, key, before); else delete globalThis[key]; });
  }
  const source = (await fs.readFile(process.env.PWA_UPDATE_PROMPT_SOURCE || 'src/components/PwaUpdatePrompt.tsx', 'utf8')).replaceAll('import.meta.env.PROD', 'true');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const store = Object.assign(fn => fn(state), { getState: () => state });
  const jsx = (type, props) => ({ type, props });
  const deps = { react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../stores/playerStore': { usePlayerStore: store }, '../engine/AudioEngine': { AudioEngine: { getAudioElement: () => audio } } };
  const exports = {};
  new Function('require', 'exports', code)(id => { assert.ok(id in deps, id); return deps[id]; }, exports);
  const render = () => { cursor = 0; const tree = exports.PwaUpdatePrompt(); effects.splice(0).forEach(fn => fn()); return tree; };
  const find = (tree, text) => {
    if (!tree || typeof tree !== 'object') return null;
    if (tree.type === 'button' && tree.props.children === text) return tree.props;
    for (const child of [tree.props?.children].flat(Infinity)) { const found = find(child, text); if (found) return found; }
    return null;
  };
  const unmount = () => slots.forEach(slot => slot.cleanup?.());
  t.after(() => { unmount(); restore.forEach(fn => fn()); });
  render(); await new Promise(r => setImmediate(r));
  return { sw, registration, state, audio, render, unmount, resolve: () => resolve(registration), reloads: () => reloads,
    click: text => { const button = find(render(), text); assert.ok(button, text); button.onClick(); },
    button: text => find(render(), text), transition(w, next) { w.state = next; w.fire('statechange'); },
  };
}

test('first installation with no controller stays silent through waiting and first controller acquisition', async t => {
  const first = worker('installing');
  const f = await fixture(t, { controller: null, active: null, installing: first });
  assert.equal(f.render(), null);
  f.registration.waiting = first; f.transition(first, 'installed');
  assert.equal(f.render(), null, 'first install is not a newer version');
  f.registration.waiting = null; f.registration.active = first; f.sw.controller = first;
  f.sw.fire('controllerchange');
  assert.equal(f.render(), null, 'first control is not an update');
  assert.equal(f.reloads(), 0);
});
test('first controller acquisition before register resolves is not an update; subsequent replacement is', async t => {
  const f = await fixture(t, { controller: null, active: null, deferred: true });
  const first = worker(); f.sw.controller = first; f.sw.fire('controllerchange');
  f.registration.active = first; f.resolve(); await new Promise(r => setImmediate(r));
  assert.equal(f.render(), null);
  f.sw.controller = worker(); f.sw.fire('controllerchange');
  assert.ok(f.render()); assert.equal(f.reloads(), 0);
  f.click('Nu bijwerken'); assert.equal(f.reloads(), 1);
});
test('same or lost controller never invents an update', async t => {
  const f = await fixture(t);
  f.sw.fire('controllerchange'); assert.equal(f.render(), null);
  f.sw.controller = null; f.sw.fire('controllerchange'); assert.equal(f.render(), null);
});
test('waiting genuine update prompts even for uncontrolled document with an existing active registration', async t => {
  const waiting = worker('installed');
  const f = await fixture(t, { controller: null, active: worker(), waiting });
  assert.ok(f.render()); assert.equal(waiting.messages.length, 0);
  f.click('Nu bijwerken'); assert.deepEqual(waiting.messages, [{ type: 'ACTIVATE_UPDATE' }]);
  f.transition(waiting, 'activated');
  assert.equal(f.reloads(), 1, 'uncontrolled tabs do not receive controllerchange without claim');
});
test('updatefound and installing state race discovers real waiting worker; dismissal survives duplicate events', async t => {
  const f = await fixture(t); const next = worker('installing');
  f.registration.installing = next; f.registration.fire('updatefound');
  assert.equal(f.render(), null);
  f.registration.waiting = next; f.transition(next, 'installed'); assert.ok(f.render());
  f.click('Later'); f.transition(next, 'installed'); assert.equal(f.render(), null);
  assert.equal(next.messages.length, 0);
});
test('safe consent is rechecked against live store AND element; resumed audio revokes automatic reload', async t => {
  const waiting = worker('installed'); const f = await fixture(t, { waiting });
  f.state.status = 'loading'; assert.equal(f.button('Nu bijwerken').disabled, true);
  f.click('Nu bijwerken'); assert.equal(waiting.messages.length, 0);
  f.state.status = 'idle'; f.audio.paused = false; f.click('Nu bijwerken'); assert.equal(waiting.messages.length, 0);
  f.audio.paused = true; f.click('Nu bijwerken'); assert.equal(waiting.messages.length, 1);
  f.audio.paused = false; f.transition(waiting, 'activated'); assert.equal(f.reloads(), 0);
  f.audio.paused = true; assert.equal(f.reloads(), 0);
  f.sw.controller = waiting; f.sw.fire('controllerchange'); assert.equal(f.reloads(), 0, 'consent consumed when unsafe');
  f.click('Nu bijwerken'); assert.equal(f.reloads(), 1);
});
test('later revokes pending consent; another worker cannot spend consent; unmount removes every listener', async t => {
  const waiting = worker('installed'); const f = await fixture(t, { waiting });
  f.click('Nu bijwerken'); f.click('Later');
  f.sw.controller = waiting; f.sw.fire('controllerchange'); assert.equal(f.reloads(), 0);
  f.click('Nu bijwerken'); assert.equal(f.reloads(), 1);
  f.unmount(); assert.equal(f.sw.count(), 0); assert.equal(f.registration.count(), 0); assert.equal(waiting.count(), 0);
});
test('consent targets one worker, not unrelated controller changes', async t => {
  const waiting = worker('installed'); const f = await fixture(t, { waiting });
  f.click('Nu bijwerken'); f.sw.controller = worker(); f.sw.fire('controllerchange');
  assert.equal(f.reloads(), 0);
});
test('opt-in reload occurs once regardless of controllerchange versus activated event order', async t => {
  const waiting = worker('installed'); const f = await fixture(t, { waiting });
  f.click('Nu bijwerken');
  f.sw.controller = waiting; f.sw.fire('controllerchange');
  assert.equal(f.reloads(), 1);
  f.transition(waiting, 'activated'); f.sw.fire('controllerchange');
  assert.equal(f.reloads(), 1);
});
test('activation without consent stays visible, never reloads, and a duplicate event preserves Later', async t => {
  const waiting = worker('installed'); const f = await fixture(t, { waiting });
  f.transition(waiting, 'activated'); assert.equal(f.reloads(), 0);
  assert.ok(f.render()); f.click('Later');
  f.sw.controller = waiting; f.sw.fire('controllerchange');
  assert.equal(f.render(), null); assert.equal(f.reloads(), 0);
});
test('late registration resolution after unmount cannot attach listeners or prompt', async t => {
  const f = await fixture(t, { deferred: true, waiting: worker('installed') });
  f.unmount(); f.resolve(); await new Promise(r => setImmediate(r));
  assert.equal(f.registration.count(), 0); assert.equal(f.sw.count(), 0);
  assert.equal(f.render(), null);
});
test('install config has scoped standalone identity and real PNG dimensions, plus Apple icon', async () => {
  const manifest = JSON.parse(await fs.readFile('public/manifest.json', 'utf8'));
  assert.equal(manifest.id, '/app/'); assert.equal(manifest.scope, '/app/'); assert.equal(manifest.start_url, '/app/');
  assert.equal(manifest.display, 'standalone'); assert.ok(manifest.name); assert.ok(manifest.short_name);
  for (const size of [192, 512]) {
    const icon = manifest.icons.find(i => i.sizes === `${size}x${size}`);
    assert.ok(icon); assert.equal(icon.type, 'image/png');
    const data = await fs.readFile(`public/${icon.src.replace('/app/', '')}`);
    assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(data.readUInt32BE(16), size); assert.equal(data.readUInt32BE(20), size);
  }
  const html = await fs.readFile('index.html', 'utf8');
  assert.match(html, /rel="manifest" href="\/app\/manifest.json"/);
  assert.match(html, /rel="apple-touch-icon" href="\/app\/icon-192.png"/);
  assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
});
