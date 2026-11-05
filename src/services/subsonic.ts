import type {
  AlbumListResponse,
  AlbumListType,
  ArtistResponse,
  SearchResponse,
  SongResponse,
  SetInfo,
} from '../types';

// RFC 1321 MD5 Implementation in pure TypeScript
function md5(string: string): string {
  function rotateLeft(lValue: number, iShiftBits: number) {
    return (lValue << iShiftBits) | (lValue >>> (32 - iShiftBits));
  }

  function addUnsigned(lX: number, lY: number) {
    const lX8 = lX & 0x80000000;
    const lY8 = lY & 0x80000000;
    const lX4 = lX & 0x40000000;
    const lY4 = lY & 0x40000000;
    const lResult = (lX & 0x3fffffff) + (lY & 0x3fffffff);
    if (lX4 & lY4) return lResult ^ 0x80000000 ^ lX8 ^ lY8;
    if (lX4 | lY4) {
      if (lResult & 0x40000000) return lResult ^ 0xc0000000 ^ lX8 ^ lY8;
      return lResult ^ 0x40000000 ^ lX8 ^ lY8;
    }
    return lResult ^ lX8 ^ lY8;
  }

  function F(x: number, y: number, z: number) { return (x & y) | (~x & z); }
  function G(x: number, y: number, z: number) { return (x & z) | (y & ~z); }
  function H(x: number, y: number, z: number) { return x ^ y ^ z; }
  function I(x: number, y: number, z: number) { return y ^ (x | ~z); }

  function FF(a: number, b: number, c: number, d: number, x: number, s: number, ac: number) {
    a = addUnsigned(a, addUnsigned(addUnsigned(F(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }

  function GG(a: number, b: number, c: number, d: number, x: number, s: number, ac: number) {
    a = addUnsigned(a, addUnsigned(addUnsigned(G(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }

  function HH(a: number, b: number, c: number, d: number, x: number, s: number, ac: number) {
    a = addUnsigned(a, addUnsigned(addUnsigned(H(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }

  function II(a: number, b: number, c: number, d: number, x: number, s: number, ac: number) {
    a = addUnsigned(a, addUnsigned(addUnsigned(I(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }

  function convertToWordArray(str: string) {
    let lWordCount;
    const bytes = new TextEncoder().encode(str);
    const lMessageLength = bytes.length;
    const lNumberOfWordsTempOne = lMessageLength + 8;
    const lNumberOfWordsTempTwo = (lNumberOfWordsTempOne - (lNumberOfWordsTempOne % 64)) / 64;
    const lNumberOfWords = (lNumberOfWordsTempTwo + 1) * 16;
    const lWordArray = new Array(lNumberOfWords - 1);
    let lBytePosition = 0;
    let lByteCount = 0;
    while (lByteCount < lMessageLength) {
      lWordCount = (lByteCount - (lByteCount % 4)) / 4;
      lBytePosition = (lByteCount % 4) * 8;
      lWordArray[lWordCount] = (lWordArray[lWordCount] | (bytes[lByteCount] << lBytePosition));
      lByteCount++;
    }
    lWordCount = (lByteCount - (lByteCount % 4)) / 4;
    lBytePosition = (lByteCount % 4) * 8;
    lWordArray[lWordCount] = lWordArray[lWordCount] | (0x80 << lBytePosition);
    lWordArray[lNumberOfWords - 2] = lMessageLength << 3;
    lWordArray[lNumberOfWords - 1] = lMessageLength >>> 29;
    return lWordArray;
  }

  function wordToHex(lValue: number) {
    let wordToHexValue = '', wordToHexValueTemp = '', lByte, lCount;
    for (lCount = 0; lCount <= 3; lCount++) {
      lByte = (lValue >>> (lCount * 8)) & 255;
      wordToHexValueTemp = '0' + lByte.toString(16);
      wordToHexValue = wordToHexValue + wordToHexValueTemp.substr(wordToHexValueTemp.length - 2, 2);
    }
    return wordToHexValue;
  }

  const x = convertToWordArray(string);
  let k, AA, BB, CC, DD, a, b, c, d;
  const S11 = 7, S12 = 12, S13 = 17, S14 = 22;
  const S21 = 5, S22 = 9, S23 = 14, S24 = 20;
  const S31 = 4, S32 = 11, S33 = 16, S34 = 23;
  const S41 = 6, S42 = 10, S43 = 15, S44 = 21;

  a = 0x67452301; b = 0xefcdab89; c = 0x98badcfe; d = 0x10325476;

  for (k = 0; k < x.length; k += 16) {
    AA = a; BB = b; CC = c; DD = d;
    a = FF(a, b, c, d, x[k + 0], S11, 0xd76aa478);
    d = FF(d, a, b, c, x[k + 1], S12, 0xe8c7b756);
    c = FF(c, d, a, b, x[k + 2], S13, 0x242070db);
    b = FF(b, c, d, a, x[k + 3], S14, 0xc1bdceee);
    a = FF(a, b, c, d, x[k + 4], S11, 0xf57c0faf);
    d = FF(d, a, b, c, x[k + 5], S12, 0x4787c62a);
    c = FF(c, d, a, b, x[k + 6], S13, 0xa8304613);
    b = FF(b, c, d, a, x[k + 7], S14, 0xfd469501);
    a = FF(a, b, c, d, x[k + 8], S11, 0x698098d8);
    d = FF(d, a, b, c, x[k + 9], S12, 0x8b44f7af);
    c = FF(c, d, a, b, x[k + 10], S13, 0xffff5bb1);
    b = FF(b, c, d, a, x[k + 11], S14, 0x895cd7be);
    a = FF(a, b, c, d, x[k + 12], S11, 0x6b901122);
    d = FF(d, a, b, c, x[k + 13], S12, 0xfd987193);
    c = FF(c, d, a, b, x[k + 14], S13, 0xa679438e);
    b = FF(b, c, d, a, x[k + 15], S14, 0x49b40821);
    a = GG(a, b, c, d, x[k + 1], S21, 0xf61e2562);
    d = GG(d, a, b, c, x[k + 6], S22, 0xc040b340);
    c = GG(c, d, a, b, x[k + 11], S23, 0x265e5a51);
    b = GG(b, c, d, a, x[k + 0], S24, 0xe9b6c7aa);
    a = GG(a, b, c, d, x[k + 5], S21, 0xd62f105d);
    d = GG(d, a, b, c, x[k + 10], S22, 0x2441453);
    c = GG(c, d, a, b, x[k + 15], S23, 0xd8a1e681);
    b = GG(b, c, d, a, x[k + 4], S24, 0xe7d3fbc8);
    a = GG(a, b, c, d, x[k + 9], S21, 0x21e1cde6);
    d = GG(d, a, b, c, x[k + 14], S22, 0xc33707d6);
    c = GG(c, d, a, b, x[k + 3], S23, 0xf4d50d87);
    b = GG(b, c, d, a, x[k + 8], S24, 0x455a14ed);
    a = GG(a, b, c, d, x[k + 13], S21, 0xa9e3e905);
    d = GG(d, a, b, c, x[k + 2], S22, 0xfcefa3f8);
    c = GG(c, d, a, b, x[k + 7], S23, 0x676f02d9);
    b = GG(b, c, d, a, x[k + 12], S24, 0x8d2a4c8a);
    a = HH(a, b, c, d, x[k + 5], S31, 0xfffa3942);
    d = HH(d, a, b, c, x[k + 8], S32, 0x8771f681);
    c = HH(c, d, a, b, x[k + 11], S33, 0x6d9d6122);
    b = HH(b, c, d, a, x[k + 14], S34, 0xfde5380c);
    a = HH(a, b, c, d, x[k + 1], S31, 0xa4beea44);
    d = HH(d, a, b, c, x[k + 4], S32, 0x4bdecfa9);
    c = HH(c, d, a, b, x[k + 7], S33, 0xf6bb4b60);
    b = HH(b, c, d, a, x[k + 10], S34, 0xbebfbc70);
    a = HH(a, b, c, d, x[k + 13], S31, 0x289b7ec6);
    d = HH(d, a, b, c, x[k + 0], S32, 0xeaa127fa);
    c = HH(c, d, a, b, x[k + 3], S33, 0xd4ef3085);
    b = HH(b, c, d, a, x[k + 6], S34, 0x4881d05);
    a = HH(a, b, c, d, x[k + 9], S31, 0xd9d4d039);
    d = HH(d, a, b, c, x[k + 12], S32, 0xe6db99e5);
    c = HH(c, d, a, b, x[k + 15], S33, 0x1fa27cf8);
    b = HH(b, c, d, a, x[k + 2], S34, 0xc4ac5665);
    a = II(a, b, c, d, x[k + 0], S41, 0xf4292244);
    d = II(d, a, b, c, x[k + 7], S42, 0x432aff97);
    c = II(c, d, a, b, x[k + 14], S43, 0xab9423a7);
    b = II(b, c, d, a, x[k + 5], S44, 0xfc93a039);
    a = II(a, b, c, d, x[k + 12], S41, 0x655b59c3);
    d = II(d, a, b, c, x[k + 3], S42, 0x8f0ccc92);
    c = II(c, d, a, b, x[k + 10], S43, 0xffeff47d);
    b = II(b, c, d, a, x[k + 1], S44, 0x85845dd1);
    a = II(a, b, c, d, x[k + 8], S41, 0x6fa87e4f);
    d = II(d, a, b, c, x[k + 15], S42, 0xfe2ce6e0);
    c = II(c, d, a, b, x[k + 6], S43, 0xa3014314);
    b = II(b, c, d, a, x[k + 13], S44, 0x4e0811a1);
    a = II(a, b, c, d, x[k + 4], S41, 0xf7537e82);
    d = II(d, a, b, c, x[k + 11], S42, 0xbd3af235);
    c = II(c, d, a, b, x[k + 2], S43, 0x2ad7d2bb);
    b = II(b, c, d, a, x[k + 9], S44, 0xeb86d391);
    a = addUnsigned(a, AA);
    b = addUnsigned(b, BB);
    c = addUnsigned(c, CC);
    d = addUnsigned(d, DD);
  }

  return (wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d)).toLowerCase();
}

function safeStored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
let BASE = safeStored('bm_server') || 'https://music.cyberspeeze.online/rest';
// Credentials are only activated by the authoritative auth store.
let _user = '';
let _pass = '';

export function setServerUrl(url: string) {
  BASE = url.replace(/\/+$/, '');
  if (!BASE.endsWith('/rest')) {
    BASE += '/rest';
  }
}

export function getServerUrl(): string {
  return BASE;
}

export function setCredentials(user: string, pass: string) {
  _user = user;
  _pass = pass;
}

export function getCredentials() {
  return { user: _user, pass: _pass };
}

export function getAuthParams(user = _user, pass = _pass): string {
  const salt = Math.random().toString(36).substring(2, 12);
  const token = md5(pass + salt);
  return `u=${encodeURIComponent(user)}&t=${token}&s=${salt}&v=1.16.1&c=beatmonkey-pwa&f=json`;
}

async function request<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
  const auth = getAuthParams();
  const query = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const url = `${BASE}/${method}.view?${auth}${query ? `&${query}` : ''}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP error ${res.status}: ${res.statusText}`);
  }
  return validateResponse<T>(res);
}

export class SubsonicError extends Error {
  readonly code?: number;
  readonly httpStatus?: number;

  constructor(message: string, code?: number, httpStatus?: number) {
    super(message);
    this.name = 'SubsonicError';
    this.code = code;
    this.httpStatus = httpStatus;
  }

  get authenticationRejected(): boolean {
    // 403 can mean endpoint permission/configuration, not invalid credentials.
    return this.code === 40 || this.code === 41 || this.httpStatus === 401;
  }
}

async function validateResponse<T = any>(res: Response): Promise<T> {
  if (!res.ok) throw new SubsonicError(`HTTP error ${res.status}`, undefined, res.status);
  const data = await res.json();
  const subsonicResponse = data?.['subsonic-response'];
  if (!subsonicResponse || !['ok', 'failed'].includes(subsonicResponse.status)) {
    throw new SubsonicError('Invalid Subsonic API response');
  }
  if (subsonicResponse.status !== 'ok') {
    throw new SubsonicError(subsonicResponse.error?.message || 'Subsonic API error', subsonicResponse.error?.code);
  }
  return subsonicResponse as T;
}

// False means definite rejection; transport/server/invalid-response failures throw.
// Validate candidates without exposing them to the active player's network calls.
export async function validateCredentials(user: string, pass: string): Promise<boolean> {
  try {
    await validateResponse(await fetch(`${BASE}/ping.view?${getAuthParams(user, pass)}`));
    return true;
  } catch (error) {
    if (error instanceof SubsonicError && error.authenticationRejected) return false;
    throw error;
  }
}

export async function ping(): Promise<boolean> {
  try {
    const res = await request<{ status: string }>('ping');
    return res.status === 'ok';
  } catch {
    return false;
  }
}

export async function getAlbum(id: string): Promise<any> {
  return request('getAlbum', { id });
}

export async function getArtist(id: string): Promise<ArtistResponse> {
  return request<ArtistResponse>('getArtist', { id });
}

export async function getAlbumList(
  type: AlbumListType,
  params: Record<string, any> = {}
): Promise<AlbumListResponse> {
  return request<AlbumListResponse>('getAlbumList2', { type, ...params });
}

export async function search3(
  query: string,
  params: Record<string, any> = {}
): Promise<SearchResponse> {
  return request<SearchResponse>('search3', { query, ...params });
}

export const getSearch3 = search3;

export async function search(query: string): Promise<SearchResponse> {
  return search3(query);
}

export async function getSong(id: string): Promise<SongResponse> {
  return request<SongResponse>('getSong', { id });
}

export function getStreamUrl(id: string): string {
  if (id.startsWith('http://') || id.startsWith('https://')) {
    return id;
  }
  const salt = Math.random().toString(36).substring(2, 12);
  const token = md5(_pass + salt);
  // NO f=json — stream.view moet audio bytes teruggeven, geen JSON
  return `${BASE}/stream.view?u=${encodeURIComponent(_user)}&t=${token}&s=${salt}&v=1.16.1&c=beatmonkey-pwa&id=${encodeURIComponent(id)}&format=raw&maxBitRate=320`;
}

export function getCoverUrl(id?: string | null, size: number = 300): string {
  if (!id) return '';
  if (id.startsWith('http://') || id.startsWith('https://') || id.startsWith('/')) {
    return id;
  }
  const auth = getAuthParams();
  return `${BASE}/getCoverArt.view?id=${encodeURIComponent(id)}&size=${size}&${auth}`;
}

export async function getStarred(): Promise<SetInfo[]> {
    const resp = await request('getStarred2');
    
    const starred = resp.starred2 || resp.starred || {};
    const albums = starred.album || [];
    const songs = starred.song || [];
    
    // Map starred albums
    const albumSets = albums.map((a: any) => ({
      id: a.id,
      title: a.title || a.name || 'Live Set',
      artist: a.artist || 'Unknown',
      coverArt: getCoverUrl(a.coverArt || a.id),
      duration: a.duration || 0,
      year: a.year || 0,
      genre: a.genre || '',
    }));
    
    // Map starred songs to album-based sets (Android app uses song star)
    const songSets = songs.map((s: any) => ({
      id: s.albumId || s.id,
      title: s.title || 'Live Set',
      artist: s.artist || 'Unknown',
      coverArt: getCoverUrl(s.coverArt || s.albumId || s.id),
      duration: s.duration || 0,
      year: s.year || 0,
      genre: s.genre || '',
    }));
    
    // Combine, deduplicate by id
    const all = [...albumSets];
    const seen = new Set(all.map(s => s.id));
    for (const s of songSets) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        all.push(s);
      }
    }
    
    return all;
}

export async function starAlbum(albumId: string): Promise<boolean> {
  try {
    await request('star', { albumId });
    return true;
  } catch {
    return false;
  }
}

export async function unstarAlbum(albumId: string): Promise<boolean> {
  try {
    await request('unstar', { albumId });
    return true;
  } catch {
    return false;
  }
}

// Haal de laatste playback positie op van de server
export async function getPlayQueue(): Promise<{ songId: string; position: number; albumId?: string } | null> {
  try {
    const auth = getAuthParams();
    const url = `${BASE}/getPlayQueue?${auth}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const resp = data['subsonic-response'];
    if (!resp || resp.status !== 'ok' || !resp.playQueue) return null;
    const pq = resp.playQueue;
    const entry = pq.entry?.[0] || null;
    return {
      songId: pq.current || entry?.id || '',
      position: pq.position || 0,
      albumId: entry?.albumId || undefined,
    };
  } catch {
    return null;
  }
}

// Sla de playback positie op naar de server
export async function savePlayQueue(songId: string, positionMs: number, albumId?: string): Promise<boolean> {
  try {
    if (!songId || !Number.isFinite(positionMs) || positionMs < 0) return false;
    await request('savePlayQueue', { id: songId, current: songId, position: Math.round(positionMs), albumId });
    return true;
  } catch {
    return false;
  }
}

export type { AlbumListType };


