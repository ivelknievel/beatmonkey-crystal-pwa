import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run AFTER vite build: node scripts/generate-service-worker.mjs dist
const directory = resolve(process.argv[2] || 'dist');
const template = await readFile(fileURLToPath(new URL('../public/service-worker.js', import.meta.url)), 'utf8');
const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.isFile()) {
      const name = relative(directory, full).split(sep).join('/');
      // Do not precache sourcemaps, secrets or arbitrary runtime/media downloads.
      if (name === 'index.html' || name === 'manifest.json' || /^(?:assets\/.*\.(?:js|css|woff2?|svg|png|jpe?g|webp|ico)|(?:icon-\d+\.png|favicon\.svg))$/.test(name)) files.push(name);
    }
  }
}
await stat(join(directory, 'index.html'));
await stat(join(directory, 'manifest.json'));
await walk(directory);
files.sort();
const included = new Set(files.map(file => '/app/' + file));
const html = await readFile(join(directory, 'index.html'), 'utf8');
for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
  const url = match[1].split(/[?#]/)[0];
  if (url.startsWith('/app/') && !included.has(url)) throw new Error(`Shell references missing or excluded build asset: ${url}`);
}
const hash = createHash('sha256');
hash.update(template);
for (const file of files) { hash.update(file); hash.update('\0'); hash.update(await readFile(join(directory, file))); }
const version = hash.digest('hex').slice(0, 24);
const config = { version, urls: ['/app/', ...files.map(f => '/app/' + f)] };
const result = template.replace('/* __PRECACHE_CONFIG__ */', `self.__PRECACHE__ = ${JSON.stringify(config)};`);
await writeFile(join(directory, 'service-worker.js'), result);
console.log(`Generated service worker ${version}: ${config.urls.length} app-shell URLs`);
