import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = new URL('../../', import.meta.url);

function source(path) {
  return readFileSync(new URL(path, root), 'utf8');
}

function loadTs(path, deps = {}, globals = {}) {
  const fullUrl = new URL(path, root);
  if (!existsSync(fullUrl)) {
    throw new Error(`Cannot find module '${path}'`);
  }
  const text = source(path);
  const js = ts.transpileModule(text, {
    fileName: path,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;

  const context = {
    exports: {},
    require: (id) => {
      if (id in deps) return deps[id];
      throw Error('Unexpected dependency: ' + id);
    },
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Headers,
    Request,
    Response,
    setTimeout,
    clearTimeout,
    AbortController,
    AbortSignal,
    console,
    ...globals,
  };
  vm.runInNewContext(js, context, { filename: path });
  return context.exports;
}

test('resolves valid source hTBl... via authenticatedFetch for actual setId', async () => {
  let requestedUrl = null;
  const mockFetch = async (url) => {
    requestedUrl = url;
    return new Response(
      JSON.stringify({ youtube_url: 'https://www.youtube.com/watch?v=hTBlDqsvwi8' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const shareSource = loadTs('src/services/shareSource.ts', {
    './authService': { authenticatedFetch: mockFetch },
  });

  const fetchFn = shareSource.fetchShareSource || shareSource.getShareSource;
  assert.equal(typeof fetchFn, 'function', 'fetchShareSource or getShareSource should be a function');

  const result = await fetchFn('28N9c27ocSVJKF6R7Duu0K');
  assert.equal(requestedUrl, '/api/navidrome/source/28N9c27ocSVJKF6R7Duu0K');
  assert.equal(result, 'https://www.youtube.com/watch?v=hTBlDqsvwi8');
  assert.match(result, /hTBlDqsvwi8/);
});

test('missing, malformed, non-200, or unrelated sources gracefully return null', async () => {
  const cases = [
    { name: '404 not found', handler: async () => new Response('Not found', { status: 404 }) },
    { name: '500 server error', handler: async () => new Response('Internal error', { status: 500 }) },
    { name: 'network rejection', handler: async () => { throw new Error('Network failure'); } },
    { name: 'invalid JSON', handler: async () => new Response('not-json', { status: 200, headers: { 'Content-Type': 'text/plain' } }) },
    { name: 'empty object', handler: async () => new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } }) },
    { name: 'unrelated host source', handler: async () => new Response(JSON.stringify({ youtube_url: 'https://evil.com/watch?v=hTBlDqsvwi8' }), { status: 200, headers: { 'Content-Type': 'application/json' } }) },
    { name: 'malformed video id', handler: async () => new Response(JSON.stringify({ youtube_url: 'https://www.youtube.com/watch?v=bad' }), { status: 200, headers: { 'Content-Type': 'application/json' } }) },
  ];

  for (const { name, handler } of cases) {
    const shareSource = loadTs('src/services/shareSource.ts', {
      './authService': { authenticatedFetch: handler },
    });
    const fetchFn = shareSource.fetchShareSource || shareSource.getShareSource;
    const res = await fetchFn('some-id');
    assert.equal(res, null, `expected null on ${name}`);
  }
});

test('invalid or empty setId returns null without calling authenticatedFetch', async () => {
  let called = false;
  const shareSource = loadTs('src/services/shareSource.ts', {
    './authService': {
      authenticatedFetch: async () => {
        called = true;
        return new Response('{}');
      },
    },
  });

  const fetchFn = shareSource.fetchShareSource || shareSource.getShareSource;
  for (const emptyId of ['', '   ', null, undefined]) {
    called = false;
    const res = await fetchFn(emptyId);
    assert.equal(res, null);
    assert.equal(called, false, `should not fetch for empty setId: ${emptyId}`);
  }
});

test('bounded timeout cancels fetch and returns null gracefully', async () => {
  const shareSource = loadTs('src/services/shareSource.ts', {
    './authService': {
      authenticatedFetch: async (url, options) => {
        return new Promise((resolve, reject) => {
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              const err = new Error('Aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      },
    },
  });

  const fetchFn = shareSource.fetchShareSource || shareSource.getShareSource;
  const start = Date.now();
  const res = await fetchFn('28N9c27ocSVJKF6R7Duu0K', { timeoutMs: 50 });
  const duration = Date.now() - start;
  assert.equal(res, null);
  assert.ok(duration < 1500, `timeout took too long: ${duration}ms`);
});
