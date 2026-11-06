import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
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
  const text = source(path).replace(/import\.meta\.env\.VITE_GOOGLE_CLIENT_ID/g, "'fixture-client'");
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
    atob,
    btoa,
    fetch: async () => {
      throw Error('Unexpected network fetch call');
    },
    console,
    crypto: webcrypto,
    setTimeout,
    clearTimeout,
    AbortController,
    AbortSignal,
    ...globals,
  };
  vm.runInNewContext(js, context, { filename: path });
  return context.exports;
}

// -----------------------------------------------------------------------------
// YouTube Downloads Contract & Validation Tests
// -----------------------------------------------------------------------------
test('youtubeDownloads.ts source module exists and exports required contracts', () => {
  const mod = loadTs('src/services/youtubeDownloads.ts', {
    './authService': {
      authenticatedFetch: async () => new Response('[]'),
    },
  });

  assert.strictEqual(typeof mod.validateYoutubeUrl, 'function', 'validateYoutubeUrl must be exported');
  assert.strictEqual(typeof mod.submitYoutubeJob, 'function', 'submitYoutubeJob must be exported');
  assert.strictEqual(typeof mod.listYoutubeJobs, 'function', 'listYoutubeJobs must be exported');
  assert.strictEqual(typeof mod.getYoutubeJob, 'function', 'getYoutubeJob must be exported');
});

test('validateYoutubeUrl validates manual paste valid and invalid YouTube URLs with backend alignment', () => {
  const mod = loadTs('src/services/youtubeDownloads.ts', {
    './authService': {
      authenticatedFetch: async () => new Response('[]'),
    },
  });
  const { validateYoutubeUrl } = mod;

  const validUrls = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/watch?v=dQw4w9WgXcQ',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
  ];

  for (const url of validUrls) {
    assert.strictEqual(validateYoutubeUrl(url), true, `Expected valid: ${url}`);
  }

  const invalidUrls = [
    '',
    'not a url',
    'http://www.youtube.com/watch?v=dQw4w9WgXcQ', // HTTP rejected (backend HTTPS only)
    'https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ', // user:pass rejected
    'https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ', // explicit port rejected
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=10s', // fragment rejected
    'https://www.youtube.com/v/dQw4w9WgXcQ', // unsupported /v rejected
    'ftp://youtube.com/watch?v=dQw4w9WgXcQ',
    'https://vimeo.com/12345678',
    'https://malicious-youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=invalid_id_with_special!*#',
    'https://youtube.com',
    'https://youtu.be/',
    'javascript:alert(1)',
  ];

  for (const url of invalidUrls) {
    assert.strictEqual(validateYoutubeUrl(url), false, `Expected invalid: ${url}`);
  }
});

test('submitYoutubeJob: 202 Accepted returns status pending, NOT completed, normalizes backend job', async () => {
  let calledUrl = '';
  let calledOptions = {};

  const fakeAuthenticatedFetch = async (url, options) => {
    calledUrl = url;
    calledOptions = options;
    return new Response(
      JSON.stringify({
        job_id: 'job-123',
        status: 'pending',
        video_id: 'dQw4w9WgXcQ',
        message: 'Download queued',
        created_at: new Date().toISOString(),
      }),
      {
        status: 202,
        statusText: 'Accepted',
        headers: { 'Content-Type': 'application/json' },
      }
    );
  };

  const mod = loadTs('src/services/youtubeDownloads.ts', {
    './authService': {
      authenticatedFetch: fakeAuthenticatedFetch,
    },
  });
  const job = await mod.submitYoutubeJob('https://www.youtube.com/watch?v=dQw4w9WgXcQ');

  assert.strictEqual(calledUrl, '/api/youtube/jobs');
  assert.strictEqual(calledOptions.method, 'POST');
  assert.strictEqual(job.id, 'job-123');
  assert.strictEqual(job.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.strictEqual(job.error, 'Download queued');
  assert.strictEqual(job.status, 'pending');
  assert.notStrictEqual(job.status, 'completed', 'submit 202 Accepted status must be pending NOT completed');
});

test('submitYoutubeJob: non-202/401 throws safe Dutch reauth/error, timeout yields no completed', async () => {
  // Test 401 Unauthorized -> safe Dutch reauth error
  const mock401 = async () => new Response(JSON.stringify({ detail: 'Unauthorized' }), { status: 401 });
  const mod401 = loadTs('src/services/youtubeDownloads.ts', {
    './authService': {
      authenticatedFetch: mock401,
    },
  });

  await assert.rejects(
    async () => {
      await mod401.submitYoutubeJob('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    },
    (err) => {
      return /sessie verlopen|opnieuw inloggen|authenticatie/i.test(err.message);
    }
  );

  // Test 500 error -> safe Dutch error
  const mock500 = async () => new Response(JSON.stringify({ detail: 'Internal Server Error' }), { status: 500 });
  const mod500 = loadTs('src/services/youtubeDownloads.ts', {
    './authService': {
      authenticatedFetch: mock500,
    },
  });

  await assert.rejects(
    async () => {
      await mod500.submitYoutubeJob('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    },
    (err) => {
      return /fout bij indienen|internal server error/i.test(err?.message || '');
    }
  );

  // Test timeout error -> no completed job state returned
  const mockTimeout = async () => {
    const err = new Error('The operation was aborted');
    err.name = 'TimeoutError';
    throw err;
  };
  const modTimeout = loadTs('src/services/youtubeDownloads.ts', {
    './authService': {
      authenticatedFetch: mockTimeout,
    },
  });

  await assert.rejects(
    async () => {
      await modTimeout.submitYoutubeJob('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    },
    (err) => {
      assert.notStrictEqual(err.status, 'completed');
      return true;
    }
  );
});

test('job statuses type contract supports pending/running/completed/failed/uncertain, validates known statuses', async () => {
  let fetchCount = 0;
  const mockFetch = async () => {
    fetchCount++;
    return new Response(
      JSON.stringify({
        job_id: 'job-pending-1',
        video_id: 'dQw4w9WgXcQ',
        status: 'pending',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const mod = loadTs('src/services/youtubeDownloads.ts', {
    './authService': {
      authenticatedFetch: mockFetch,
    },
  });
  const res = await mod.getYoutubeJob('job-pending-1');
  assert.strictEqual(res.id, 'job-pending-1');
  assert.strictEqual(res.status, 'pending');
  assert.strictEqual(res.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.strictEqual(fetchCount, 1, 'getYoutubeJob must perform a single fetch without polling');

  // Verify unknown status falls back to uncertain
  const mockUnknown = async () => new Response(JSON.stringify({ job_id: 'j2', video_id: 'dQw4w9WgXcQ', status: 'weird_status' }), { status: 200 });
  const modUnknown = loadTs('src/services/youtubeDownloads.ts', {
    './authService': {
      authenticatedFetch: mockUnknown,
    },
  });
  const resUnknown = await modUnknown.getYoutubeJob('j2');
  assert.strictEqual(resUnknown.status, 'uncertain');
});

test('listYoutubeJobs: normalizes actual array from backend, canonicalizes URL and extracts message into error', async () => {
  let capturedUrl = '';
  const mockFetch = async (url) => {
    capturedUrl = url;
    return new Response(
      JSON.stringify([
        { job_id: 'job-1', video_id: 'dQw4w9WgXcQ', status: 'completed', user_id: 'server-verified-owner', message: null },
        { job_id: 'job-2', video_id: 'dQw4w9WgXcQ', status: 'failed', user_id: 'server-verified-owner', message: 'Failed format' },
      ]),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const mod = loadTs('src/services/youtubeDownloads.ts', {
    './authService': {
      authenticatedFetch: mockFetch,
    },
  });
  const jobs = await mod.listYoutubeJobs();

  assert.strictEqual(capturedUrl, '/api/youtube/jobs');
  assert.ok(Array.isArray(jobs));
  assert.strictEqual(jobs.length, 2);
  assert.strictEqual(jobs[0].id, 'job-1');
  assert.strictEqual(jobs[0].url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.strictEqual(jobs[0].status, 'completed');
  assert.strictEqual(jobs[0].owner, 'server-verified-owner');
  assert.strictEqual(jobs[1].id, 'job-2');
  assert.strictEqual(jobs[1].error, 'Failed format');
});

test('youtubeDownloads methods propagate AbortSignal to underlying authenticatedFetch', async () => {
  let capturedSignal = null;
  const mockFetch = async (url, opts = {}) => {
    capturedSignal = opts.signal;
    return new Response(JSON.stringify([]), { status: 200 });
  };

  const mod = loadTs('src/services/youtubeDownloads.ts', {
    './authService': {
      authenticatedFetch: mockFetch,
    },
  });
  const controller = new AbortController();

  await mod.listYoutubeJobs(controller.signal);
  assert.strictEqual(capturedSignal, controller.signal, 'AbortSignal must be propagated');
});
