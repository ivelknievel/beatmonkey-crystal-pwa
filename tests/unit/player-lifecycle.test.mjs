import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, info, deferred, tick } from './player-helpers.mjs';

test('queued pause/play events respect current element state after a source switch',async()=>{
 const {store,engine}=await environment();await store.getState().loadSet(info('A'));await store.getState().loadSet(info('B'));
 const a=engine.getAudioElement();a.dispatchEvent(new Event('pause'));
 assert.equal(store.getState().isPlaying,true);assert.equal(store.getState().status,'playing');
 engine.pause();a.dispatchEvent(new Event('play'));
 assert.equal(store.getState().isPlaying,false);assert.equal(store.getState().status,'paused');
});

test('new source start offset never clamps against old media duration',async()=>{
 const {engine}=await environment();await engine.loadSet('song-A',0,info('A'));
 engine.getAudioElement().duration=30;
 await engine.loadSet('song-B',125,info('B'),false);
 engine.getAudioElement().duration=3600;engine.getAudioElement().dispatchEvent(new Event('loadedmetadata'));
 assert.equal(engine.getCurrentTime(),125);
});
test('metadata events do not overwrite an already applied seek',async()=>{
 const {engine}=await environment();await engine.loadSet('song-A',0,info('A'),false);
 const a=engine.getAudioElement();a.readyState=1;engine.seek(42);a.dispatchEvent(new Event('loadedmetadata'));
 assert.equal(a.currentTime,42);
});
test('reselecting same album ignores old-source events during metadata await',async()=>{
 const d=deferred();let calls=0;const {engine,store}=await environment({getAlbum:()=>++calls===1?Promise.resolve({album:{id:'A',song:[{id:'first'},{id:'second'}]}}):d.promise});
 await store.getState().loadSet({...info('A'),songId:'first'});const p=store.getState().loadSet({...info('A'),songId:'second'});
 engine.getAudioElement().currentTime=77;engine.getAudioElement().dispatchEvent(new Event('timeupdate'));
 assert.equal(store.getState().currentTime,0);
 d.resolve({album:{id:'A',song:[{id:'first'},{id:'second'}]}});await p;
 assert.equal(store.getState().currentSongId,'second');
});

test('set switch retains outgoing save captured before generation change',async()=>{
 const {engine,store,saves}=await environment();await store.getState().loadSet(info('A'));
 engine.getAudioElement().currentTime=42;
 // Direct engine consumer also requires a transition save.
 await engine.loadSet('song-B',0,info('B'));await tick();
 assert.deepEqual(saves,[['song-A',42000,'A']]);
});
test('old media events cannot corrupt a new selection while metadata is pending',async()=>{
 const d=deferred();const {engine,store}=await environment({getAlbum:async id=>id==='B'?d.promise:{album:{id,song:[{id:'song-'+id}]}}});
 await store.getState().loadSet(info('A'));const p=store.getState().loadSet(info('B'));
 const a=engine.getAudioElement();a.currentTime=88;a.dispatchEvent(new Event('timeupdate'));a.dispatchEvent(new Event('error'));
 assert.equal(store.getState().currentTime,0);assert.equal(store.getState().status,'loading');
 d.resolve({album:{id:'B',song:[{id:'song-B'}]}});await p;
});
test('save worker serializes updates, keeps latest queued position, cancels on account reset',async()=>{
 const d=deferred();const calls=[];const {engine,store}=await environment({savePlayQueue:(...args)=>{calls.push(args);return calls.length===1?d.promise:Promise.resolve(true);}});
 store.getState().setAccountScope('A');await store.getState().loadSet(info('A'));const a=engine.getAudioElement();a.currentTime=42;engine.savePlaybackPosition();await tick();
 a.currentTime=43;engine.savePlaybackPosition();a.currentTime=44;engine.savePlaybackPosition();assert.equal(calls.length,1);
 d.resolve(true);await tick();assert.deepEqual(calls.map(c=>c[1]),[42000,44000]);
 const blocked=deferred(); // independent reset scenario with a queued snapshot
 const env=await environment({savePlayQueue:(...args)=>{calls.push(args);return blocked.promise;}});
 env.store.getState().setAccountScope('A');await env.store.getState().loadSet(info('A'));env.engine.getAudioElement().currentTime=42;env.engine.savePlaybackPosition();await tick();
 env.engine.getAudioElement().currentTime=45;env.engine.savePlaybackPosition();env.store.getState().setAccountScope('B');blocked.resolve(true);await tick();assert.equal(calls.length,3);
});
test('late rejection from old play attempt does not block the new source',async()=>{
 const d=deferred();const {engine,store}=await environment();const a=engine.getAudioElement();let count=0;
 a.play=()=>++count===1?d.promise:Promise.resolve();const p=store.getState().loadSet(info('A'));await tick();
 await store.getState().loadSet(info('B'));d.reject(Object.assign(Error('old block'),{name:'NotAllowedError'}));await p;
 assert.equal(store.getState().currentSetId,'B');assert.equal(store.getState().status,'playing');
});
test('scope reset during awaited album or restore metadata ignores old account',async()=>{
 for(const restore of [false,true]){
 const d=deferred();const {store,engine}=await environment({getAlbum:()=>d.promise,getPlayQueue:async()=>({songId:'song-A',albumId:'A',position:42000})});
 store.getState().setAccountScope('A');const p=restore?store.getState().restoreLastPosition():store.getState().loadSet(info('A'));await tick();
 store.getState().setAccountScope('B');d.resolve({album:{id:'A',song:[{id:'song-A'}]}});await p;assert.equal(store.getState().currentSetId,null);assert.equal(engine.getAudioElement().src,'');
 }
});
