import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const read = (p) => fs.readFile(path.join(root, p), 'utf8');

async function moduleSource(file, deps = {}) {
  const code = ts.transpileModule(await read(file), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const exports = {};
  new Function('require', 'exports', code)(
    (id) => {
      if (id in deps) return deps[id];
      throw Error(`Unexpected import ${id}`);
    },
    exports
  );
  return exports;
}

test('exact example at seconds 1050 with set, cue, Android, IOS, YouTube, and hashtag', async () => {
  const { composeShareText } = await moduleSource('src/utils/shareLinks.ts');
  const result = composeShareText({
    set: {
      id: '2tOSEwE7kRK1Mg0jJsBXDn',
      title: 'Cosmic Gate live at EDC Colombia 2026',
      youtubeUrl: 'https://www.youtube.com/watch?v=yClxCRg6b-8',
    },
    seconds: 1050,
    cue: {
      artist: 'Cosmic Gate & Diana Miro',
      title: 'Nothing To Hide WAKE YOUR MIND (BLACK HOLE )',
    },
  });

  const expected =
    '🎵 Om 17:30 in Cosmic Gate live at EDC Colombia 2026\n' +
    'Cosmic Gate & Diana Miro - Nothing To Hide WAKE YOUR MIND (BLACK HOLE )\n\n' +
    'Android: https://music.cyberspeeze.online/go/set/2tOSEwE7kRK1Mg0jJsBXDn?t=1050\n\n' +
    'IOS: https://music.cyberspeeze.online/app/set/2tOSEwE7kRK1Mg0jJsBXDn?t=1050\n\n' +
    'YouTube: https://www.youtube.com/watch?v=yClxCRg6b-8&t=1050s\n\n' +
    '#BeatmonkeyCrystal';

  assert.equal(result, expected);
});

test('floor nonnegative seconds consistent across all URLs and hour timestamp H:MM:SS', async () => {
  const { composeShareText } = await moduleSource('src/utils/shareLinks.ts');

  // Floored fractional seconds
  const resultFloat = composeShareText({
    set: { id: 'album1', title: 'Set Title', youtubeUrl: 'https://youtu.be/yClxCRg6b-8' },
    seconds: 1050.8,
  });
  assert.ok(resultFloat.includes('🎵 Om 17:30 in Set Title'));
  assert.ok(resultFloat.includes('Android: https://music.cyberspeeze.online/go/set/album1?t=1050'));
  assert.ok(resultFloat.includes('IOS: https://music.cyberspeeze.online/app/set/album1?t=1050'));
  assert.ok(resultFloat.includes('YouTube: https://www.youtube.com/watch?v=yClxCRg6b-8&t=1050s'));

  // Hour timestamp H:MM:SS formatting at 3661s (1:01:01)
  const resultHour = composeShareText({
    set: { id: 'album1', title: 'Long Set' },
    seconds: 3661,
  });
  assert.ok(resultHour.includes('🎵 Om 1:01:01 in Long Set'));
  assert.ok(resultHour.includes('Android: https://music.cyberspeeze.online/go/set/album1?t=3661'));
  assert.ok(resultHour.includes('IOS: https://music.cyberspeeze.online/app/set/album1?t=3661'));
});

test('invalid time defaults to 0 and formats 0:00', async () => {
  const { composeShareText } = await moduleSource('src/utils/shareLinks.ts');

  for (const invalid of [-5, NaN, Infinity, -Infinity, undefined, null, 'invalid']) {
    const text = composeShareText({
      set: { id: 'set-id', title: 'My Set', videoId: 'yClxCRg6b-8' },
      seconds: invalid,
    });
    assert.ok(text.includes('🎵 Om 0:00 in My Set'), `failed for ${invalid}`);
    assert.ok(text.includes('Android: https://music.cyberspeeze.online/go/set/set-id?t=0'), `failed for ${invalid}`);
    assert.ok(text.includes('IOS: https://music.cyberspeeze.online/app/set/set-id?t=0'), `failed for ${invalid}`);
    assert.ok(text.includes('YouTube: https://www.youtube.com/watch?v=yClxCRg6b-8&t=0s'), `failed for ${invalid}`);
  }
});

test('absent YouTube omits ONLY the YouTube line; no invented fallback', async () => {
  const { composeShareText } = await moduleSource('src/utils/shareLinks.ts');

  const textNoYt = composeShareText({
    set: { id: 'abc', title: 'No YouTube Set' },
    seconds: 120,
    cue: { artist: 'Artist', title: 'Track' },
  });

  assert.ok(!textNoYt.includes('YouTube:'), 'Should not contain YouTube line');
  const expected =
    '🎵 Om 2:00 in No YouTube Set\n' +
    'Artist - Track\n\n' +
    'Android: https://music.cyberspeeze.online/go/set/abc?t=120\n\n' +
    'IOS: https://music.cyberspeeze.online/app/set/abc?t=120\n\n' +
    '#BeatmonkeyCrystal';

  assert.equal(textNoYt, expected);

  // Invalid YouTube URL (e.g. Vimeo or domain not in allowlist) is omitted
  const textInvalidYt = composeShareText({
    set: { id: 'abc', title: 'Invalid YT', youtubeUrl: 'https://vimeo.com/12345678901' },
    seconds: 0,
  });
  assert.ok(!textInvalidYt.includes('YouTube:'), 'Invalid YouTube host must be omitted');
});

test('cue variations: absent cue omits line 2; title only and artist only supported without invented text', async () => {
  const { composeShareText } = await moduleSource('src/utils/shareLinks.ts');

  // No cue at all
  const noCue = composeShareText({
    set: { id: 'abc', title: 'Set Only' },
    seconds: 60,
  });
  assert.equal(
    noCue,
    '🎵 Om 1:00 in Set Only\n\n' +
      'Android: https://music.cyberspeeze.online/go/set/abc?t=60\n\n' +
      'IOS: https://music.cyberspeeze.online/app/set/abc?t=60\n\n' +
      '#BeatmonkeyCrystal'
  );

  // Cue with title only
  const titleOnly = composeShareText({
    set: { id: 'abc', title: 'Set Only' },
    seconds: 60,
    cue: { title: 'Solo Title' },
  });
  assert.ok(titleOnly.startsWith('🎵 Om 1:00 in Set Only\nSolo Title\n\n'));

  // Cue with artist only
  const artistOnly = composeShareText({
    set: { id: 'abc', title: 'Set Only' },
    seconds: 60,
    cue: { artist: 'Solo Artist' },
  });
  assert.ok(artistOnly.startsWith('🎵 Om 1:00 in Set Only\nSolo Artist\n\n'));
});

test('positional arguments composeShareText(set, seconds, cue) match options signature', async () => {
  const { composeShareText } = await moduleSource('src/utils/shareLinks.ts');

  const fromOptions = composeShareText({
    set: { id: 'pos1', title: 'Positional Set', youtubeUrl: 'https://youtu.be/yClxCRg6b-8' },
    seconds: 45,
    cue: { artist: 'A', title: 'B' },
  });

  const fromPositional = composeShareText(
    { id: 'pos1', title: 'Positional Set', youtubeUrl: 'https://youtu.be/yClxCRg6b-8' },
    45,
    { artist: 'A', title: 'B' }
  );

  assert.equal(fromPositional, fromOptions);
});

test('native navigator.share full text only, clipboard exact text, and AbortError cancellation', async () => {
  const { shareLink } = await moduleSource('src/utils/shareLinks.ts');

  let sharedPayload = null;
  const mockShare = {
    share: async (data) => {
      sharedPayload = data;
    },
  };

  const composed = '🎵 Om 1:00 in Set\n\nAndroid: ...\n\nIOS: ...\n\n#BeatmonkeyCrystal';

  // Native share passes full text only (no duplicate url)
  const res1 = await shareLink({ title: 'Deel Liveset', text: composed }, mockShare);
  assert.equal(res1, 'shared');
  assert.equal(sharedPayload.title, 'Deel Liveset');
  assert.equal(sharedPayload.text, composed);
  assert.equal(sharedPayload.url, undefined);

  // If text already includes url, duplicate url is stripped
  let sharedPayload2 = null;
  const res2 = await shareLink(
    { title: 'Deel', text: 'Full text with url https://example.test included', url: 'https://example.test' },
    { share: async (d) => { sharedPayload2 = d; } }
  );
  assert.equal(res2, 'shared');
  assert.equal(sharedPayload2.url, undefined);

  // Clipboard fallback receives same exact text
  let copiedText = null;
  const mockClipboard = {
    clipboard: {
      writeText: async (t) => {
        copiedText = t;
      },
    },
  };
  const res3 = await shareLink({ title: 'Deel Liveset', text: composed }, mockClipboard);
  assert.equal(res3, 'copied');
  assert.equal(copiedText, composed);

  // AbortError on share yields 'cancelled' without throwing or fallback
  const mockAbort = {
    share: async () => {
      const err = new Error('User cancelled');
      err.name = 'AbortError';
      throw err;
    },
    clipboard: {
      writeText: async () => {
        throw new Error('Should not call clipboard on cancel');
      },
    },
  };
  const res4 = await shareLink({ title: 'Deel', text: composed }, mockAbort);
  assert.equal(res4, 'cancelled');

  // Other errors re-throw
  const mockError = {
    share: async () => {
      throw new Error('PermissionDenied');
    },
  };
  await assert.rejects(shareLink({ title: 'Deel', text: composed }, mockError), /PermissionDenied/);
});

test('existing shareLinks helpers compatibility', async () => {
  const { buildShareUrl, buildIosShareUrl, buildAndroidShareUrl, buildYouTubeShareUrl, parseShareTime } =
    await moduleSource('src/utils/shareLinks.ts');

  assert.equal(parseShareTime('1050'), 1050);
  assert.equal(parseShareTime(-1), 0);
  assert.equal(parseShareTime('invalid'), 0);

  assert.equal(
    buildShareUrl({ id: 'album1', songId: 'song1' }, 1050.4),
    'https://music.cyberspeeze.online/app/set/song1?t=1050'
  );
  assert.equal(
    buildIosShareUrl({ id: 'album1' }, 42),
    'https://music.cyberspeeze.online/app/set/album1?t=42'
  );
  assert.equal(
    buildAndroidShareUrl({ id: 'album1' }, 42),
    'https://music.cyberspeeze.online/go/set/album1?t=42'
  );
  assert.equal(
    buildYouTubeShareUrl('https://www.youtube.com/watch?v=yClxCRg6b-8', 42),
    'https://www.youtube.com/watch?v=yClxCRg6b-8&t=42s'
  );
  assert.equal(buildYouTubeShareUrl('not-a-valid-url', 42), null);
  assert.equal(buildYouTubeShareUrl('https://example.com/not-youtube', 42), null);
});

test('both PWA share entrypoints integrate the common composer without duplicate URLs', async () => {
  const fullscreenSource = await read('src/components/Player/FullscreenPlayerOverlay.tsx');
  assert.match(fullscreenSource, /composeShareText/);
  assert.match(fullscreenSource, /findActiveCueIndex/);
  assert.match(fullscreenSource, /shareLink\(\{\s*title:\s*['"]Deel Liveset['"],\s*text/);
  assert.doesNotMatch(fullscreenSource, /buildShareUrl/);

  const tracklistSource = await read('src/components/Player/TracklistSection.tsx');
  assert.match(tracklistSource, /composeShareText/);
  assert.match(tracklistSource, /shareLink\(\{\s*title:\s*['"]Deel Track['"],\s*text/);
  assert.doesNotMatch(tracklistSource, /buildShareUrl/);
});

test('entrypoint cue resolution: matching cue from store tracklist is included, missing cue is omitted', async () => {
  const { composeShareText } = await moduleSource('src/utils/shareLinks.ts');
  const { findActiveCueIndex } = await moduleSource('src/utils/cues.ts');

  const currentSet = {
    id: 'album-edc',
    title: 'EDC Set',
    youtubeUrl: 'https://youtu.be/yClxCRg6b-8',
    tracklist: [
      { timeSec: 0, artist: 'Intro Artist', title: 'Intro Track' },
      { timeSec: 300, artist: 'Mid Artist', title: 'Mid Track' },
    ],
  };

  // At 350s, cue 1 (Mid Artist - Mid Track) should be resolved
  const cueIndex = findActiveCueIndex(currentSet.tracklist, 350);
  assert.equal(cueIndex, 1);
  const textAt350 = composeShareText({
    set: currentSet,
    seconds: 350,
    cue: currentSet.tracklist[cueIndex],
  });
  assert.ok(textAt350.includes('🎵 Om 5:50 in EDC Set\nMid Artist - Mid Track'));
  assert.ok(textAt350.includes('Android: https://music.cyberspeeze.online/go/set/album-edc?t=350'));
  assert.ok(textAt350.includes('IOS: https://music.cyberspeeze.online/app/set/album-edc?t=350'));
  assert.ok(textAt350.includes('YouTube: https://www.youtube.com/watch?v=yClxCRg6b-8&t=350s'));

  // Without tracklist (e.g. before fetch), cue is null, cue line is omitted
  const textWithoutTracklist = composeShareText({
    set: { id: 'album-edc', title: 'EDC Set', youtubeUrl: 'https://youtu.be/yClxCRg6b-8' },
    seconds: 350,
    cue: null,
  });
  assert.ok(textWithoutTracklist.startsWith('🎵 Om 5:50 in EDC Set\n\nAndroid:'));
});

