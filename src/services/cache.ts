import { openDB, type IDBPDatabase } from 'idb';

export const DB_NAME = 'beatmonkey-crystal';
export const DB_VERSION = 1;

// Generic cache entry
export interface CacheEntry<T> {
  data: T;
  cachedAt: number;
  ttl: number;
}

// Store types
export interface BeatmonkeyDBTypes {
  sets: { key: string; value: CacheEntry<any> };
  artists: { key: string; value: CacheEntry<any> };
  tracklists: { key: string; value: CacheEntry<any> };
  festivals: { key: string; value: CacheEntry<any> };
  meta: { key: string; value: any };
}

export type StoreName = keyof BeatmonkeyDBTypes;

// TTL constants
export const TTL = {
  SET: 24 * 60 * 60 * 1000,        // 24h
  ARTIST: 24 * 60 * 60 * 1000,     // 24h
  TRACKLIST: 7 * 24 * 60 * 60 * 1000, // 7d
  FESTIVAL: 60 * 60 * 1000,        // 1h
  META: 24 * 60 * 60 * 1000,       // 24h
};

export const DEFAULT_TTLS: Record<StoreName, number> = {
  sets: TTL.SET,
  artists: TTL.ARTIST,
  tracklists: TTL.TRACKLIST,
  festivals: TTL.FESTIVAL,
  meta: TTL.META,
};

let dbPromise: Promise<IDBPDatabase<BeatmonkeyDBTypes>> | null = null;

export function getDb(): Promise<IDBPDatabase<BeatmonkeyDBTypes>> {
  if (!dbPromise) {
    dbPromise = openDB<BeatmonkeyDBTypes>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const stores: StoreName[] = ['sets', 'artists', 'tracklists', 'festivals', 'meta'];
        for (const store of stores) {
          if (!db.objectStoreNames.contains(store)) {
            db.createObjectStore(store);
          }
        }
      },
    });
  }
  return dbPromise;
}

export async function get<T>(store: StoreName, key: string): Promise<T | null> {
  try {
    const db = await getDb();
    const entry = (await db.get(store, key)) as CacheEntry<T> | undefined;
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > entry.ttl) {
      await db.delete(store, key);
      return null;
    }
    return entry.data;
  } catch (err) {
    console.warn(`Cache read error for ${store}/${key}:`, err);
    return null;
  }
}

export async function set<T>(
  store: StoreName,
  key: string,
  data: T,
  ttlMs?: number
): Promise<void> {
  try {
    const db = await getDb();
    const ttl = ttlMs !== undefined ? ttlMs : DEFAULT_TTLS[store];
    const entry: CacheEntry<T> = {
      data,
      cachedAt: Date.now(),
      ttl,
    };
    await db.put(store, entry, key);
  } catch (err) {
    console.warn(`Cache write error for ${store}/${key}:`, err);
  }
}

export async function del(store: StoreName, key: string): Promise<void> {
  try {
    const db = await getDb();
    await db.delete(store, key);
  } catch (err) {
    console.warn(`Cache delete error for ${store}/${key}:`, err);
  }
}

export async function clear(store?: StoreName): Promise<void> {
  try {
    const db = await getDb();
    if (store) {
      await db.clear(store);
    } else {
      const stores: StoreName[] = ['sets', 'artists', 'tracklists', 'festivals', 'meta'];
      await Promise.all(stores.map((s) => db.clear(s)));
    }
  } catch (err) {
    console.warn(`Cache clear error:`, err);
  }
}

export async function clearAll(): Promise<void> {
  return clear();
}

export const CacheService = {
  get,
  set,
  del,
  delete: del,
  clear,
  clearAll,
  TTL,
};

export default CacheService;
