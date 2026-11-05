import test from 'node:test';
import assert from 'node:assert/strict';
import {environment,info,album,deferred,tick} from './player-helpers.mjs';

test('album identity is stable and explicit song selection is preserved',async()=>{
 const {store,engine}=await environment({getAlbum:async()=>({album:{...album('A').album,song:[{id:'first'},{id:'explicit'}]}})});
 await store.getState().loadSet({...info('A'),songId:'explicit'});
 assert.equal(store.getState().currentSetId,'A');assert.equal(engine.getCurrentSongId(),'explicit');
 assert.equal(store.getState().currentSongId,'explicit');
});
test('latest selection wins out-of-order metadata',async()=>{
 const a=deferred(),b=deferred();const {store}=await environment({getAlbum:id=>id==='A'?a.promise:b.promise});
 const pa=store.getState().loadSet(info('A')),pb=store.getState().loadSet(info('B'));
 b.resolve(album('B'));await pb;a.resolve(album('A'));await pa;assert.equal(store.getState().currentSetId,'B');
});
test('late queue answer cannot seek a new selection',async()=>{
 const d=deferred();let n=0;const {store,engine}=await environment({getPlayQueue:()=>++n===1?d.promise:Promise.resolve(null)});
 const pa=store.getState().loadSet(info('A'));await tick();await store.getState().loadSet(info('B'));engine.getAudioElement().readyState=1;
 d.resolve({songId:'song-A',albumId:'A',position:125000});await pa;assert.equal(engine.getCurrentTime(),0);
});
test('restore prepares real source paused and always converts milliseconds',async()=>{
 const {store,engine}=await environment({getPlayQueue:async()=>({songId:'song-A',albumId:'A',position:500})});
 await store.getState().restoreLastPosition();const a=engine.getAudioElement();
 assert.equal(a.src,'https://fixture.invalid/song-A');assert.equal(a.playCalls,0);assert.equal(a.paused,true);
 a.readyState=1;a.dispatchEvent(new Event('loadedmetadata'));assert.equal(a.currentTime,.5);assert.equal(store.getState().currentTime,.5);
 await store.getState().play();assert.equal(a.paused,false);
});
test('late restore cannot replace explicit selection',async()=>{
 const d=deferred();let n=0;const {store}=await environment({getPlayQueue:()=>++n===1?d.promise:Promise.resolve(null)});
 const p=store.getState().restoreLastPosition();await store.getState().loadSet(info('B'));
 d.resolve({songId:'song-A',albumId:'A',position:42000});await p;assert.equal(store.getState().currentSetId,'B');
});
test('noncurrent tracklist cannot change active cue; before first is -1',async()=>{
 const {store}=await environment();await store.getState().loadSet({...info('B'),tracklist:[{timeSec:60}]});
 store.getState().setTracklistForSet('B',[{timeSec:60}]);assert.equal(store.getState().activeCueIndex,-1);
 store.getState().setTracklistForSet('A',[{timeSec:0},{timeSec:1}]);assert.equal(store.getState().activeCueIndex,-1);
});
test('successful empty favourites clears local list, failures retain it',async()=>{
 let fail=false;const {store}=await environment({getStarred:async()=>{if(fail)throw Error('offline');return [];}});
 store.setState({likedSetIds:['old']});await store.getState().syncLikedSets();assert.deepEqual(store.getState().likedSetIds,[]);
 store.setState({likedSetIds:['keep']});fail=true;await store.getState().syncLikedSets();assert.deepEqual(store.getState().likedSetIds,['keep']);
});
for(const mode of ['false','throw'])test('like failure rolls back: '+mode,async()=>{
 const {store}=await environment({starAlbum:async()=>{if(mode==='throw')throw Error('failed');return false;}});
 await store.getState().toggleLike('A');assert.deepEqual(store.getState().likedSetIds,[]);
});
test('pause saves once and in-flight identical saves coalesce',async()=>{
 const d=deferred();let calls=0;const {engine,store}=await environment({savePlayQueue:()=>{calls++;return d.promise;}});
 await store.getState().loadSet(info('A'));engine.getAudioElement().currentTime=42;engine.pause();engine.savePlaybackPosition();await tick();assert.equal(calls,1);d.resolve(true);await tick();
});
test('failed save does not advance success clock and can retry',async()=>{
 let calls=0;const {engine,store}=await environment({savePlayQueue:async()=>{calls++;return false;}});
 await store.getState().loadSet(info('A'));engine.getAudioElement().currentTime=42;
 await engine.savePlaybackPosition();await engine.savePlaybackPosition();assert.equal(calls,2);
});
test('blocked play exits loading, retries, and never forces WebAudio',async()=>{
 const {store,engine}=await environment();let contexts=0;window.AudioContext=class{constructor(){contexts++;}};
 const a=engine.getAudioElement();a.rejectPlay=Object.assign(Error('tap required'),{name:'NotAllowedError'});
 await store.getState().loadSet(info('A'));assert.equal(store.getState().status,'blocked');assert.equal(store.getState().isPlaying,false);assert.ok(store.getState().error);
 a.rejectPlay=null;await store.getState().play();assert.equal(store.getState().status,'playing');assert.equal(store.getState().error,null);assert.equal(contexts,0);
});
test('seeks are finite and emitted position equals clamped media position',async()=>{
 const {store,engine}=await environment();await store.getState().loadSet(info('A'));const a=engine.getAudioElement();a.readyState=1;a.duration=100;
 store.getState().seek(999);assert.equal(a.currentTime,100);assert.equal(store.getState().currentTime,100);
 for(const value of [NaN,Infinity,-Infinity]){store.getState().seek(value);assert.ok(Number.isFinite(store.getState().currentTime));assert.ok(Number.isFinite(a.currentTime));}
 store.getState().seek(-50);assert.equal(a.currentTime,0);
});
test('account switch stops media without saving and ignores late work, isolates caches',async()=>{
 const d=deferred();const {store,engine,saves,storage}=await environment({getStarred:()=>d.promise});
 storage.setItem('beatmonkey_liked_sets',JSON.stringify(['legacy']));store.getState().setAccountScope('A');assert.deepEqual(store.getState().likedSetIds,[]);
 await store.getState().loadSet(info('A'));engine.getAudioElement().currentTime=42;await store.getState().toggleLike('private-A');const p=store.getState().syncLikedSets();
 store.getState().setAccountScope('B');d.resolve([{id:'late-A'}]);await p;
 assert.deepEqual(store.getState().likedSetIds,[]);assert.equal(engine.getAudioElement().src,'');assert.equal(engine.getCurrentSongId(),null);assert.equal(saves.length,0);
 store.getState().setAccountScope('A');assert.deepEqual(store.getState().likedSetIds,['private-A']);
 await store.getState().loadSet(info('B'));assert.equal(store.getState().currentSetId,'B');assert.equal(store.getState().isPlaying,true);
});
test('reset preserves engine subscribers and cancels pending selection',async()=>{
 const d=deferred();const {store,engine}=await environment({getAlbum:()=>d.promise});const p=store.getState().loadSet(info('A'));
 store.getState().resetPlayer();d.resolve(album('A'));await p;assert.equal(store.getState().currentSetId,null);
 engine.loadSet('song-B',0,info('B'));await tick();assert.equal(store.getState().currentSetId,'B');
});
test('cue helper defines invalid, duplicate and unsorted timestamps',async()=>{
 const {cues}=await environment();assert.equal(cues.findActiveCueIndex([{timeSec:60}],0),-1);
 assert.equal(cues.findActiveCueIndex([{timeSec:10},{timeSec:0},{timeSec:10},{timeSec:NaN}],10),2);
 assert.equal(cues.findActiveCueIndex([],20),-1);
});
