import { authenticatedFetch } from './authService';
import type { ArtistInfo, FestivalInfo, SetInfo, StageInfo, TrackCue } from '../types';
import { get, set, TTL } from './cache';
import { getCoverUrl, getAlbumList, getSearch3 } from './subsonic';

const BASE = 'https://music.cyberspeeze.online';

// Curated Fallback Festivals
const DEFAULT_FESTIVALS: FestivalInfo[] = [
  {
    name: 'Awakenings',
    slug: 'awakenings',
    logo: 'https://music.cyberspeeze.online/static/festivals/awakenings.jpg',
    date: 'Juli 2026',
    description: 'Het toonaangevende techno festival ter wereld in Spaarnwoude.',
    stages: [
      {
        name: 'Area V (Main)',
        sets: [
          {
            id: '0wdkhWbNjH1rt9QQI40g64',
            title: 'Awakenings 2025',
            artist: 'Adam Beyer',
            coverArt: 'al-0wdkhWbNjH1rt9QQI40g64_6a7ecb9c',
            duration: 5598,
            year: 2025,
            genre: 'Techno',
            festival: 'Awakenings',
            stage: 'Area V (Main)',
          },
          {
            id: '7Ks8ZoVMyQqg1xRUCkgdir',
            title: 'Awakenings Festival 2026',
            artist: 'Joris Voorn x Kevin de Vries',
            coverArt: 'al-7Ks8ZoVMyQqg1xRUCkgdir_6a7e38bd',
            duration: 5244,
            year: 2026,
            genre: 'Techno',
            festival: 'Awakenings',
            stage: 'Area V (Main)',
          },
        ],
      },
    ],
  },
  {
    name: 'EDC Las Vegas',
    slug: 'edc-las-vegas',
    logo: 'https://music.cyberspeeze.online/static/festivals/edc.png',
    date: 'Mei 2026',
    description: 'Electric Daisy Carnival in the Las Vegas Motor Speedway with world-class DJ sets.',
    stages: [
      {
        name: 'kineticFIELD',
        sets: [
          {
            id: '4363Gd0agyrEW96xDYhNIh',
            title: 'EDC Las Vegas 2026',
            artist: 'Charlotte de Witte',
            coverArt: 'al-4363Gd0agyrEW96xDYhNIh_6a7ecb9c',
            duration: 3502,
            year: 2026,
            genre: 'Techno',
            festival: 'EDC Las Vegas',
            stage: 'kineticFIELD',
          },
          {
            id: '3ByCPUrFTS6mqcWACYyEyF',
            title: 'EDC Las Vegas 2026',
            artist: 'Sub Focus',
            coverArt: 'al-3ByCPUrFTS6mqcWACYyEyF_6a7ecb9c',
            duration: 2529,
            year: 2026,
            genre: 'Drum & Bass',
            festival: 'EDC Las Vegas',
            stage: 'kineticFIELD',
          },
        ],
      },
      {
        name: 'circuitGROUNDS',
        sets: [
          {
            id: '4N4a2RqFogK4n8XcyYWZWx',
            title: 'Live at EDC Las Vegas 2026',
            artist: 'Walker & Royce B2B VNSSA',
            coverArt: 'al-4N4a2RqFogK4n8XcyYWZWx_6a8b2620',
            duration: 2699,
            year: 2026,
            genre: 'Tech House',
            festival: 'EDC Las Vegas',
            stage: 'circuitGROUNDS',
          },
        ],
      },
      {
        name: 'quantumVALLEY',
        sets: [
          {
            id: '6x7HSCh5l3GG2zlVn4mXi1',
            title: 'EDC Las Vegas 2026',
            artist: 'Tinlicker',
            coverArt: 'al-6x7HSCh5l3GG2zlVn4mXi1_6a7ecb9c',
            duration: 2824,
            year: 2026,
            genre: 'Melodic House',
            festival: 'EDC Las Vegas',
            stage: 'quantumVALLEY',
          },
        ],
      },
    ],
  },
  {
    name: 'Tomorrowland',
    slug: 'tomorrowland',
    logo: 'https://music.cyberspeeze.online/static/festivals/tomorrowland.png',
    date: 'Juli 2026',
    description: 'De iconische sprookjeswereld in Boom, België met de grootste elektronische artiesten ter wereld.',
    stages: [
      {
        name: 'Mainstage',
        sets: [
          {
            id: '0MVT8RJ7WCvMzduydRNEfc',
            title: 'Tomorrowland 2025 ｜ MainStage Closing',
            artist: 'Amelie Lens',
            coverArt: 'al-0MVT8RJ7WCvMzduydRNEfc_6a7ecb9c',
            duration: 2674,
            year: 2025,
            genre: 'Techno',
            festival: 'Tomorrowland',
            stage: 'Mainstage',
          },
          {
            id: '5ROvk9klGs6YG8kBj8aPt4',
            title: 'Odd Mob WE2 ｜ Tomorrowland 2026',
            artist: 'Odd Mob',
            coverArt: 'al-5ROvk9klGs6YG8kBj8aPt4_6a7ecb9c',
            duration: 2661,
            year: 2026,
            genre: 'Tech House',
            festival: 'Tomorrowland',
            stage: 'Mainstage',
          },
        ],
      },
      {
        name: 'Freedom Stage',
        sets: [
          {
            id: '2As1XOQgNUhoUvAGI96Ztg',
            title: 'Cassian b2b Joris Voorn WE2 ｜ Tomorrowland 2026',
            artist: 'Cassian b2b Joris Voorn',
            coverArt: 'al-2As1XOQgNUhoUvAGI96Ztg_6a7ecb9c',
            duration: 3917,
            year: 2026,
            genre: 'Melodic House',
            festival: 'Tomorrowland',
            stage: 'Freedom Stage',
          },
        ],
      },
    ],
  },
  {
    name: 'Ultra Music Festival',
    slug: 'ultra-music-festival',
    logo: 'https://music.cyberspeeze.online/static/festivals/ultra.png',
    date: 'Maart 2026',
    description: 'Bayfront Park Miami, de ultieme start van het festivalseizoen met legendarische optredens.',
    stages: [
      {
        name: 'Ultra Main Stage',
        sets: [
          {
            id: '5NZtxWjz6cianNdgc1QFLU',
            title: 'WORSHIP @ ULTRA MUSIC FESTIVAL MIAMI 2026',
            artist: 'WORSHIP',
            coverArt: 'al-5NZtxWjz6cianNdgc1QFLU_6a7ecb9c',
            duration: 2587,
            year: 2026,
            genre: 'Drum & Bass',
            festival: 'Ultra Music Festival',
            stage: 'Ultra Main Stage',
          },
        ],
      },
      {
        name: 'Resistance Megastructure',
        sets: [
          {
            id: '7J107zji0HaMt1QeQS0Mp2',
            title: 'Vintage Culture @ Ultra Music Festival Miami 2026',
            artist: 'Vintage Culture',
            coverArt: 'al-7J107zji0HaMt1QeQS0Mp2_6a7ecb9c',
            duration: 3897,
            year: 2026,
            genre: 'Tech House',
            festival: 'Ultra Music Festival',
            stage: 'Resistance Megastructure',
          },
        ],
      },
    ],
  },
  {
    name: 'Loveland Festival',
    slug: 'loveland',
    logo: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=600&auto=format&fit=crop&q=80',
    date: 'Augustus 2026',
    description: 'Sloterpark Amsterdam, het legendarische house & techno festival.',
    stages: [
      {
        name: 'Main Stage',
        sets: [
          {
            id: '4cyHGz7TfxOE88vMpbNaHw',
            title: 'CAMELPHAT ｜ LOVELAND FESTIVAL 2025',
            artist: 'CamelPhat',
            coverArt: 'al-4cyHGz7TfxOE88vMpbNaHw_6a7ecb9c',
            duration: 4921,
            year: 2025,
            genre: 'Progressive House',
            festival: 'Loveland Festival',
            stage: 'Main Stage',
          },
          {
            id: '4QR8pdRmhLIr3G0O34EbGq',
            title: 'BART SKILS ｜ LOVELAND FESTIVAL 2026',
            artist: 'Bart Skils',
            coverArt: 'al-4QR8pdRmhLIr3G0O34EbGq_6a89f7fd',
            duration: 4001,
            year: 2026,
            genre: 'Techno',
            festival: 'Loveland Festival',
            stage: 'Fire Stage',
          },
        ],
      },
    ],
  },
];

export async function getFestivals(): Promise<FestivalInfo[]> {
  // 1. Check cache first
  const cached = await get<FestivalInfo[]>('festivals', 'all_festivals_v2');
  if (cached && cached.length > 0) {
    fetchFestivalsNetwork().catch(() => {});
    return cached;
  }

  // 2. Fetch from network
  const fresh = await fetchFestivalsNetwork();
  return fresh;
}

async function fetchFestivalsNetwork(): Promise<FestivalInfo[]> {
  try {
    // Try primary festival endpoint
    const res = await authenticatedFetch(`${BASE}/api/festivals`).catch(() => null);
    if (res && res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        await set('festivals', 'all_festivals_v2', data, TTL.FESTIVAL);
        return data;
      }
    }

    // Try navidrome albums endpoint as alternative
    const naviRes = await authenticatedFetch(`${BASE}/api/navidrome/recent-albums`).catch(() => null);
    let dynamicFestivals = [...DEFAULT_FESTIVALS];

    if (naviRes && naviRes.ok) {
      const naviData = await naviRes.json();
      const albums: any[] = naviData.albums || [];

      if (albums.length > 0) {
        dynamicFestivals = dynamicFestivals.map((fest) => {
          const matchingAlbums = albums.filter(
            (a) =>
              a.name?.toLowerCase().includes(fest.name.toLowerCase()) ||
              a.name?.toLowerCase().includes(fest.slug)
          );

          if (matchingAlbums.length > 0) {
            const extraSets: SetInfo[] = matchingAlbums.map((a) => ({
              id: a.id,
              title: a.name || a.title,
              artist: a.artist || 'Various Artists',
              coverArt: getCoverUrl(a.coverArt || a.id, 300),
              duration: a.duration || 3600,
              year: a.year || 2026,
              genre: a.genre || 'Live Set',
              festival: fest.name,
              stage: fest.stages[0]?.name || 'Main Stage',
            }));

            const updatedStages = [...fest.stages];
            if (updatedStages.length > 0) {
              const existingIds = new Set(updatedStages[0].sets.map((s) => s.id));
              extraSets.forEach((es) => {
                if (!existingIds.has(es.id)) {
                  updatedStages[0].sets.unshift(es);
                }
              });
            }
            return { ...fest, stages: updatedStages };
          }
          return fest;
        });
      }
    }

    await set('festivals', 'all_festivals_v2', dynamicFestivals, TTL.FESTIVAL);
    return dynamicFestivals;
  } catch (err) {
    console.warn('Network fetch error for festivals, using defaults:', err);
    await set('festivals', 'all_festivals_v2', DEFAULT_FESTIVALS, TTL.FESTIVAL);
    return DEFAULT_FESTIVALS;
  }
}

export async function getFestivalDetail(nameOrSlug: string): Promise<FestivalInfo> {
  const cached = await get<FestivalInfo>('festivals', `detail_v2_${nameOrSlug}`);
  if (cached) return cached;

  try {
    const res = await authenticatedFetch(`${BASE}/api/festivals/${encodeURIComponent(nameOrSlug)}`);
    if (res.ok) {
      const data = await res.json();
      await set('festivals', `detail_v2_${nameOrSlug}`, data, TTL.FESTIVAL);
      return data;
    }
  } catch {
    // Fallback to match from all festivals
  }

  const festivals = await getFestivals();
  const normalized = nameOrSlug.toLowerCase().trim();
  const match = festivals.find(
    (f) => f.slug === normalized || f.name.toLowerCase() === normalized
  );

  if (match) {
    await set('festivals', `detail_v2_${nameOrSlug}`, match, TTL.FESTIVAL);
    return match;
  }

  // Fallback: try to find festival by iterating all and matching slug
  const allFestivals = await getFestivals();
  for (const fest of allFestivals) {
    if (fest.slug === nameOrSlug.toLowerCase().trim()) {
      await set('festivals', `detail_v2_${nameOrSlug}`, fest, TTL.FESTIVAL);
      return fest;
    }
  }

  return {
    name: nameOrSlug,
    slug: nameOrSlug.toLowerCase().replace(/\s+/g, '-'),
    logo: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=600&auto=format&fit=crop&q=80',
    date: '2026',
    description: 'Festival sets & live opnames',
    stages: [],
  };
}

export async function getFestivalSets(festivalSlugOrName: string): Promise<{
  name: string;
  logo: string;
  date: string;
  description?: string;
  stages: StageInfo[];
}> {
  const fest = await getFestivalDetail(festivalSlugOrName);
  return {
    name: fest.name,
    logo: fest.logo,
    date: fest.date,
    description: fest.description,
    stages: fest.stages || [],
  };
}

export async function getTracklist(setId: string): Promise<TrackCue[]> {
  // 1. Cache check
  const cached = await get<TrackCue[]>('tracklists', setId);
  if (cached && cached.length > 0) {
    return cached;
  }

  // 2. Fetch from backend
  try {
    const res = await authenticatedFetch(`${BASE}/api/tracklists/${encodeURIComponent(setId)}`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        await set('tracklists', setId, data, TTL.TRACKLIST);
        return data;
      }
    }

    // Secondary resolve endpoint
    const resolveRes = await authenticatedFetch(`${BASE}/api/tracklist/resolve?album_id=${encodeURIComponent(setId)}`).catch(() => null);
    if (resolveRes && resolveRes.ok) {
      const resolveData = await resolveRes.json();
      if (resolveData.found && resolveData.tracklistUrl) {
        const scrapeRes = await authenticatedFetch(`${BASE}/api/scrape/tracklist?url=${encodeURIComponent(resolveData.tracklistUrl)}`).catch(() => null);
        if (scrapeRes && scrapeRes.ok) {
          const scrapeData = await scrapeRes.json();
          if (scrapeData.tracks && Array.isArray(scrapeData.tracks) && scrapeData.tracks.length > 0) {
            const cues: TrackCue[] = scrapeData.tracks.map((t: any, i: number) => ({
              title: (t.title_raw || t.title || t.name || 'Unknown Track').replace(/^\d+\.\s*/, ''),
              artist: t.artist || '',
              timeSec: t.cue_seconds ?? (typeof t.timeSec === 'number' ? t.timeSec : parseTime(t.time || t.timestamp || '0:00')),
              trackNumber: t.track_number || i + 1,
            }));
            await set('tracklists', setId, cues, TTL.TRACKLIST);
            return cues;
          }
        }
      }
    }
  } catch (err) {
    console.warn(`Error resolving tracklist for set ${setId}:`, err);
  }

  // 3. No tracklist available — return empty instead of mock data
  const fallbackCues: TrackCue[] = [];
  await set('tracklists', setId, fallbackCues, TTL.TRACKLIST);
  return fallbackCues;
}

function parseTime(str: string): number {
  if (!str) return 0;
  const parts = str.split(':').map((p) => parseInt(p, 10) || 0);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return 0;
}


export async function getRecentSets(): Promise<SetInfo[]> {
  const cached = await get<SetInfo[]>('sets', 'recent_sets_v2');
  if (cached && cached.length > 0) {
    fetchRecentSetsNetwork().catch(() => {});
    return cached;
  }
  return fetchRecentSetsNetwork();
}

async function fetchRecentSetsNetwork(): Promise<SetInfo[]> {
  try {
    const subsonicRes = await getAlbumList('newest', { size: 20 }).catch(() => null);
    const albums = (subsonicRes as any)?.albumList2?.album || (subsonicRes as any)?.albumList?.album;
    if (albums && Array.isArray(albums) && albums.length > 0) {
      const sets: SetInfo[] = albums.map((a: any) => ({
        id: a.id,
        title: a.title || a.name || 'Live Set',
        artist: a.artist || 'Onbekende DJ',
        coverArt: getCoverUrl(a.coverArt || a.id, 300),
        duration: a.duration || 3600,
        year: a.year || 2026,
        genre: a.genre || 'Electronic',
        festival: a.album || a.parent || 'Festival Live',
      }));
      await set('sets', 'recent_sets_v2', sets, TTL.SET);
      return sets;
    }
  } catch (err) {
    console.warn('Error fetching recent sets from Subsonic:', err);
  }

  try {
    const res = await authenticatedFetch(`${BASE}/api/navidrome/recent-albums`);
    if (res.ok) {
      const data = await res.json();
      const albums = data.albums || [];
      if (albums.length > 0) {
        const sets: SetInfo[] = albums.map((a: any) => ({
          id: a.id,
          title: a.name || 'Live Set',
          artist: a.artist || 'Various Artists',
          coverArt: getCoverUrl(a.coverArt || a.id, 300),
          duration: 3600,
          year: a.year || 2026,
          genre: 'Electronic',
          festival: a.name?.includes('EDC') ? 'EDC Las Vegas' : a.name?.includes('Lollapalooza') ? 'Lollapalooza' : 'Festival Live',
        }));
        await set('sets', 'recent_sets_v2', sets, TTL.SET);
        return sets;
      }
    }
  } catch (err) {
    console.warn('Error fetching recent sets from API:', err);
  }

  // Fallback sets
  const fallbackSets: SetInfo[] = [
    {
      id: '4YuXo852caWq38j0yY9QvZ',
      title: 'SIDEPIECE LIVE @lollapalooza Perry Stage 2026',
      artist: 'SIDEPIECE',
      coverArt: 'al-4YuXo852caWq38j0yY9QvZ_6a8b4d3c',
      duration: 2633,
      year: 2026,
      genre: 'Tech House',
      festival: 'Lollapalooza',
      stage: 'Perry Stage',
    },
    {
      id: '4N4a2RqFogK4n8XcyYWZWx',
      title: 'Walker & Royce B2B VNSSA Live at EDC Las Vegas 2026',
      artist: 'Walker & Royce B2B VNSSA',
      coverArt: 'al-4N4a2RqFogK4n8XcyYWZWx_6a8b2620',
      duration: 2699,
      year: 2026,
      genre: 'Tech House',
      festival: 'EDC Las Vegas',
      stage: 'circuitGROUNDS',
    },
    {
      id: '4363Gd0agyrEW96xDYhNIh',
      title: 'Charlotte de Witte - EDC Las Vegas 2026',
      artist: 'Charlotte de Witte',
      coverArt: 'al-4363Gd0agyrEW96xDYhNIh_6a7ecb9c',
      duration: 3502,
      year: 2026,
      genre: 'Techno',
      festival: 'EDC Las Vegas',
      stage: 'kineticFIELD',
    },
  ];

  await set('sets', 'recent_sets_v2', fallbackSets, TTL.SET);
  return fallbackSets;
}

export async function getDJs(): Promise<ArtistInfo[]> {
  const cached = await get<ArtistInfo[]>('artists', 'all_djs');
  if (cached && cached.length > 0) {
    fetchDJsNetwork().catch(() => {});
    return cached;
  }
  return fetchDJsNetwork();
}

async function fetchDJsNetwork(): Promise<ArtistInfo[]> {
  try {
    const res = await authenticatedFetch(`${BASE}/api/discover/djs`);
    if (res.ok) {
      const data = await res.json();
      const djList = data.djs || [];
      if (djList.length > 0) {
        const artists: ArtistInfo[] = djList.map((d: any) => ({
          id: d.id || d.dj_name.toLowerCase().replace(/\s+/g, '-'),
          name: d.dj_name,
          image: d.image_url || d.logo_url || 'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=600&auto=format&fit=crop&q=80',
          bio: d.bio || undefined,
          genres: d.genres ? d.genres.split(',').map((g: string) => g.trim()).filter(Boolean) : ['Electronic'],
          setCount: d.liveset_count || 1,
        }));
        await set('artists', 'all_djs', artists, TTL.ARTIST);
        return artists;
      }
    }
  } catch (err) {
    console.warn('Error fetching DJs from API:', err);
  }

  // Fallback DJs
  const fallbackDJs: ArtistInfo[] = [
    {
      id: 'reinier-zonneveld',
      name: 'Reinier Zonneveld',
      image: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=600&auto=format&fit=crop&q=80',
      bio: 'Nederlandse live techno artiest en producer bekend om zijn energieke all-night live sets met analoge synthesizers en drummachines.',
      genres: ['Techno', 'Acid Techno', 'Live Act'],
      setCount: 4,
    },
    {
      id: 'charlotte-de-witte',
      name: 'Charlotte de Witte',
      image: 'https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?w=600&auto=format&fit=crop&q=80',
      bio: 'Belgische techno DJ en oprichter van het KNTXT label, bekend om haar donkere, stuwende peak-time techno sounds.',
      genres: ['Techno', 'Peak Time Techno', 'Acid'],
      setCount: 6,
    },
    {
      id: 'mau-p',
      name: 'Mau P',
      image: 'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=600&auto=format&fit=crop&q=80',
      bio: 'Wereldwijde tech house sensatie bekend van hits als "Drugs From Amsterdam", "Gimme That Bounce" en "Metro".',
      genres: ['Tech House', 'House'],
      setCount: 3,
    },
    {
      id: 'amelie-lens',
      name: 'Amelie Lens',
      image: 'https://images.unsplash.com/photo-1501386761578-eac5c94b800a?w=600&auto=format&fit=crop&q=80',
      bio: "Belgische techno superster, oprichter van het Lenske label en resident van 's werelds grootste festivals.",
      genres: ['Techno', 'Hard Techno'],
      setCount: 5,
    },
    {
      id: 'armin-van-buuren',
      name: 'Armin van Buuren',
      image: 'https://images.unsplash.com/photo-1429962714451-bb934ecdc4ec?w=600&auto=format&fit=crop&q=80',
      bio: 'Legendarische Nederlandse trance DJ, 5-voudig nummer 1 DJ van de wereld en presentator van A State Of Trance.',
      genres: ['Trance', 'Progressive Trance', 'EDM'],
      setCount: 8,
    },
  ];

  await set('artists', 'all_djs', fallbackDJs, TTL.ARTIST);
  return fallbackDJs;
}

export async function getDJDetail(djIdOrName: string): Promise<{ artist: ArtistInfo; sets: SetInfo[] }> {
  const djs = await getDJs();
  const normalized = djIdOrName.toLowerCase().trim();
  let artist = djs.find(
    (d) => d.id.toLowerCase() === normalized || d.name.toLowerCase() === normalized
  );

  if (!artist) {
    artist = {
      id: djIdOrName,
      name: djIdOrName,
      image: 'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=600&auto=format&fit=crop&q=80',
      genres: ['Electronic'],
      setCount: 1,
    };
  }

  // Fetch sets for this DJ
  let sets: SetInfo[] = [];
  try {
    const res = await authenticatedFetch(`${BASE}/api/discover/dj/${encodeURIComponent(artist.name)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.sets && Array.isArray(data.sets) && data.sets.length > 0) {
        sets = data.sets.map((s: any) => ({
          id: s.id || `${artist?.id}-set-${s.title}`,
          title: s.title || s.name || `${artist?.name} Live Set`,
          artist: artist?.name || 'Artist',
          coverArt: s.coverArt || artist?.image || '',
          duration: s.duration || 3600,
          year: s.year || 2026,
          genre: s.genre || artist?.genres[0] || 'Electronic',
          festival: s.festival || 'Festival Live',
          stage: s.stage,
          youtubeUrl: s.youtubeUrl,
        }));
      }
    }
  } catch (err) {
    console.warn(`Error fetching DJ detail sets for ${artist.name}:`, err);
  }

  if (sets.length === 0) {
    // Try Subsonic search for albums by this artist
    try {
      const searchRes = await getSearch3(artist.name, { albumCount: 20 });
      const albums = searchRes?.searchResult3?.album || [];
      
      if (albums.length > 0) {
        sets = albums.map((a: any) => ({
          id: a.id,
          title: a.title || a.name || `${artist.name} Live Set`,
          artist: artist.name,
          coverArt: getCoverUrl(a.coverArt || a.id, 300),
          duration: a.duration || 3600,
          year: a.year || 2026,
          genre: a.genre || artist.genres[0] || 'Electronic',
          festival: a.album || 'Festival Live',
        }));
      }
    } catch (err) {
      console.warn(`Subsonic search failed for ${artist.name}:`, err);
    }
  }

  // If STILL no sets, fall back to Subsonic getAlbumList by genre
  if (sets.length === 0) {
    try {
      const { getAlbumList, getCoverUrl } = await import('./subsonic');
      const genreRes = await getAlbumList('byGenre', {
        genre: artist.genres[0] || 'Electronic',
        size: 10,
      });
      const albums = genreRes?.albumList2?.album || genreRes?.albumList?.album || [];
      
      if (albums.length > 0) {
        sets = albums.map((a: any) => ({
          id: a.id,
          title: a.title || a.name || 'Live Set',
          artist: a.artist || artist.name,
          coverArt: getCoverUrl(a.coverArt || a.id, 300),
          duration: a.duration || 3600,
          year: a.year || 2026,
          genre: a.genre || 'Electronic',
        }));
      }
    } catch (err) {
      console.warn(`Genre fallback failed:`, err);
    }
  }

  // If STILL no sets, show a helpful empty state instead of mock data
  if (sets.length === 0) {
    // Return empty array — the UI will show a "Geen sets gevonden" message
    // Don't generate mock data
  }

  return { artist, sets };
}
