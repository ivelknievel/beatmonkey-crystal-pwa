import { readFileSync, existsSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createStore } from '../../node_modules/zustand/esm/vanilla.mjs';
let serial = 0;
export const tick = () => new Promise(resolve => setImmediate(resolve));
export function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; }
export const album = id => ({album:{id,title:id,duration:3600,song:[{id:'song-'+id}]}});
export const info = id => ({id,title:id,artist:'fixture',coverArt:'',duration:3600});
async function load(path, deps) {
  const raw = readFileSync(new URL('../../'+path, import.meta.url),'utf8');
  const body = stripTypeScriptTypes(raw,{mode:'strip'}).replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*/gm,'');
  const id=++serial; globalThis.__playerFixtures ??= {}; globalThis.__playerFixtures[id]=deps;
  return import('data:text/javascript;base64,'+Buffer.from(`const {${Object.keys(deps).join(',')}}=globalThis.__playerFixtures[${id}];\n`+body+`\n// ${id}`).toString('base64'));
}
export async function environment(overrides={}) {
  const data=new Map(); const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,String(v)),removeItem:k=>data.delete(k)};
  globalThis.localStorage=storage; globalThis.sessionStorage={...storage,getItem:()=>null};
  globalThis.window={location:{pathname:'/app/discover'},addEventListener(){},removeEventListener(){}};
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{}});
  globalThis.requestAnimationFrame=()=>1; globalThis.cancelAnimationFrame=()=>{};
  class FixtureAudio extends EventTarget {
    src=''; currentTime=0; duration=3600; readyState=0; paused=true; playbackRate=1; rejectPlay=null; playCalls=0;
    load(){this.currentTime=0;this.readyState=0;this.paused=true;}
    removeAttribute(name){if(name==='src')this.src='';}
    play(){this.playCalls++;if(this.rejectPlay)return Promise.reject(this.rejectPlay);this.paused=false;this.dispatchEvent(new Event('play'));return Promise.resolve();}
    pause(){const was=!this.paused;this.paused=true;if(was)this.dispatchEvent(new Event('pause'));}
  }
  globalThis.Audio=FixtureAudio;
  const saves=[]; const deps={getStreamUrl:id=>'https://fixture.invalid/'+id,getCoverUrl:id=>id,savePlayQueue:async(...a)=>{saves.push(a);return true;},getAlbum:async id=>album(id),getPlayQueue:async()=>null,getStarred:async()=>[],starAlbum:async()=>true,unstarAlbum:async()=>true,...overrides};
  const cuesPath=new URL('../../src/utils/cues.ts',import.meta.url);
  const cues=existsSync(cuesPath)?await load('src/utils/cues.ts',{}):{};
  const {AudioEngine:engine}=await load('src/engine/AudioEngine.ts',deps);
  const create=initializer=>{const api=createStore(initializer);return Object.assign((selector=x=>x)=>selector(api.getState()),api);};
  const {usePlayerStore:store}=await load('src/stores/playerStore.ts',{...deps,...cues,create,AudioEngine:engine});
  engine.init();
  return {engine,store,saves,storage,cues};
}
