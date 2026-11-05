import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = new URL('../../', import.meta.url);
const source = p => readFileSync(new URL(p, root), 'utf8');
function load(path, deps = {}, globals = {}) {
  const text = source(path).replace(/import\.meta\.env\.VITE_GOOGLE_CLIENT_ID/g, "'fixture-client'");
  const js = ts.transpileModule(text, { fileName: path, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const context = { exports: {}, require: id => { if (id in deps) return deps[id]; throw Error('Unexpected dependency: '+id); }, URL, URLSearchParams, TextEncoder, TextDecoder, Uint8Array, Headers, atob, fetch: async () => { throw Error('Unexpected network'); }, console, crypto: webcrypto, setTimeout, clearTimeout, ...globals };
  vm.runInNewContext(js, context, { filename: path });
  return context.exports;
}
const storage = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k,v) => m.set(k,v), removeItem: k => m.delete(k) }; };
const jwt = claims => 'e30.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.fixture';
const valid = () => jwt({ sub:'A', user_name:'Returned Name', exp: Date.now()/1000+3600 });
const response = body => ({ ok:true, json: async () => body });
const pingOK = () => response({'subsonic-response':{status:'ok'}});
const uncertainPings = {
  'fetch throws': async()=>{throw Error('Invalid credentials from a network proxy');},
  'HTTP 503': async()=>({ok:false,status:503}),
  'invalid JSON': async()=>({ok:true,json:async()=>{throw SyntaxError('Unexpected <');}}),
  'invalid response': async()=>response({}),
  'HTTP 404': async()=>({ok:false,status:404}),
  'HTTP 403 permission denied': async()=>({ok:false,status:403}),
  'unrelated Subsonic failure': async()=>response({'subsonic-response':{status:'failed',error:{code:70,message:'Wrong password'}}}),
};
for (const [name, failure] of Object.entries(uncertainPings)) {
  test(`real validator: ${name} preserves established session, playback scope and saved values`,async()=>{
    let fetch=async()=>pingOK();const api=subsonic((...args)=>fetch(...args));
    const f=authFixture({},undefined,api);const token=valid(),creds={user:'A',pass:'saved'};
    f.stored(token,creds);await f.get().checkSession();const before=f.get(),calls=f.calls.length;
    fetch=failure;await f.get().checkSession();
    assert.equal(f.get().isAuthenticated,true);assert.equal(f.get().token,token);
    assert.equal(f.get().accountScope,before.accountScope);assert.equal(f.get().user,before.user);
    assert.equal(f.get().isLoading,false);assert.match(f.get().error,/verbinding|opnieuw/i);
    assert.equal(f.calls.length,calls);assert.deepEqual(f.saved(),{token,creds});
    assert.equal(api.getCredentials().user,'A');assert.equal(api.getCredentials().pass,'saved');
    assert.equal(await f.get().loginManual('B','candidate'),false);
    assert.match(f.get().error,/verbinding/i);assert.deepEqual(f.saved(),{token,creds});
    assert.equal(api.getCredentials().user,'A');
  });
}
test('real validator: expired saved token is revoked before reading unavailable credential storage',async()=>{
  let pings=0;const api=subsonic(async()=>{pings++;throw Error('offline');});
  const f=authFixture({loadSubsonicCredentials:async()=>{throw Error('storage unavailable');}},undefined,api);
  f.stored(jwt({exp:1}),{user:'A',pass:'saved'});await f.get().checkSession();
  assert.equal(pings,0);assert.deepEqual(f.saved(),{token:null,creds:null});
});
for (const next of ['manual login','logout']) {
  test(`late offline revalidation failure cannot mutate newer ${next}`,async()=>{
    let fetch=async()=>pingOK();const api=subsonic((...args)=>fetch(...args));
    const f=authFixture({},undefined,api);f.stored(valid(),{user:'A',pass:'saved'});await f.get().checkSession();
    let reject;fetch=()=>new Promise((_,r)=>{reject=r;});const check=f.get().checkSession();
    await new Promise(r=>setImmediate(r));fetch=async()=>pingOK();
    if(next==='manual login')assert.equal(await f.get().loginManual('B','candidate'),true);
    else await f.get().logout();
    const before=f.get(),saved=f.saved(),calls=f.calls.length;reject(Error('offline'));await check;
    assert.equal(f.get(),before);assert.deepEqual(f.saved(),saved);assert.equal(f.calls.length,calls);
  });
}
test('real validator: cold offline start retains credentials and permits coalesced retry',async()=>{
  let fetch=uncertainPings['fetch throws'];const api=subsonic((...args)=>fetch(...args));
  const f=authFixture({},undefined,api),token=valid(),creds={user:'A',pass:'saved'};f.stored(token,creds);
  const check=f.get().checkSession();assert.equal(f.get().checkSession(),check);await check;
  assert.equal(f.get().isAuthenticated,false);assert.equal(f.get().isLoading,false);
  assert.match(f.get().error,/verbinding|opnieuw/i);assert.deepEqual(f.saved(),{token,creds});
  assert.equal(f.calls.length,0);fetch=async()=>pingOK();await f.get().checkSession();
  assert.equal(f.get().isAuthenticated,true);assert.equal(f.get().error,null);
});
for (const rejection of [40,41,401]) {
  test(`real validator: definite rejection ${rejection} revokes session and saved values`,async()=>{
    let fetch=async()=>pingOK();const api=subsonic((...args)=>fetch(...args));const f=authFixture({},undefined,api);
    f.stored(valid(),{user:'A',pass:'saved'});await f.get().checkSession();
    fetch=async()=>rejection===401?{ok:false,status:401}:response({'subsonic-response':{status:'failed',error:{code:rejection,message:'Denied'}}});
    await f.get().checkSession();assert.equal(f.get().isAuthenticated,false);
    assert.deepEqual(f.saved(),{token:null,creds:null});assert.equal(api.getCredentials().user,'');
  });
}
test('real validator: expired Google token revokes while offline before ping',async()=>{
  let pings=0;const api=subsonic(async()=>{pings++;throw Error('offline');});const f=authFixture({},undefined,api);
  f.stored(jwt({exp:1}),{user:'A',pass:'saved'});await f.get().checkSession();
  assert.equal(pings,0);assert.equal(f.get().isAuthenticated,false);assert.deepEqual(f.saved(),{token:null,creds:null});
});
for (const method of ['loadToken','loadSubsonicCredentials']) {
  test(`storage failure in ${method} preserves established session and saved values`,async()=>{
    let fail=false;const token=valid(),creds={user:'A',pass:'saved'};
    const f=authFixture({[method]:async()=>{if(fail)throw Error('storage unavailable');return method==='loadToken'?token:creds;}});
    f.stored(token,creds);await f.get().checkSession();const calls=f.calls.length;fail=true;
    await f.get().checkSession();assert.equal(f.get().isAuthenticated,true);assert.equal(f.calls.length,calls);
    assert.deepEqual(f.saved(),{token,creds});assert.equal(f.get().isLoading,false);assert.ok(f.get().error);
  });
}
test('real auth storage read failure must not look like absent credentials or write a revocation tombstone',async()=>{
  const localStorage=storage(),data=new Map([['bm_auth_token',{value:valid()}],['subsonic_user',{value:'A'}],['subsonic_pass',{value:'saved'}]]);
  let fail=true;const db={get:async(_,key)=>{if(fail)throw Error('storage temporarily unavailable');return data.get(key);},delete:async(_,key)=>data.delete(key),put:async(_,v)=>data.set(v.key,v)};
  const service=load('src/services/authService.ts',{'idb':{openDB:async()=>db}},{localStorage});
  const api=subsonic(async()=>pingOK()),f=authFixture(service,undefined,api);
  await f.get().checkSession();assert.equal(f.get().isAuthenticated,false);assert.equal(f.get().isLoading,false);
  assert.ok(f.get().error);assert.equal(localStorage.getItem('bm_auth_revoked'),null);assert.equal(data.size,3);
  fail=false;await f.get().checkSession();assert.equal(f.get().isAuthenticated,true);
});
function subsonic(fetch, localStorage = storage()) { return load('src/services/subsonic.ts', {}, { fetch, localStorage }); }

test('UTF8 MD5 uses protocol bytes including non-BMP and block boundaries', () => {
  const api = subsonic(async () => {});
  for (const pass of ['', 'abc', 'café', '🔊秘密', 'é'.repeat(80)]) {
    api.setCredentials('test', pass);
    const params = new URLSearchParams(api.getAuthParams());
    assert.equal(params.get('t'), createHash('md5').update(pass+params.get('s'), 'utf8').digest('hex'));
  }
});
test('Subsonic module tolerates denied localStorage access', () => {
  const denied = { getItem(){ throw Error('SecurityError'); } };
  assert.doesNotThrow(() => subsonic(async () => {}, denied));
});
test('mutations reject HTTP200 application failures and accept validated success', async () => {
  let body = {'subsonic-response':{status:'failed',error:{message:'Denied'}}};
  const api = subsonic(async () => response(body));
  for (const act of [() => api.starAlbum('A'), () => api.unstarAlbum('A'), () => api.savePlayQueue('s',500)]) assert.equal(await act(), false);
  body = {'subsonic-response':{status:'ok'}};
  for (const act of [() => api.starAlbum('A'), () => api.unstarAlbum('A'), () => api.savePlayQueue('s',500)]) assert.equal(await act(), true);
});
test('getStarred distinguishes failure from successful empty and deduplicates Android song stars', async () => {
  let body = {'subsonic-response':{status:'failed'}};
  const api = subsonic(async () => response(body));
  await assert.rejects(api.getStarred());
  body = {'subsonic-response':{status:'ok',starred2:{}}};
  assert.equal((await api.getStarred()).length,0);
  body = {'subsonic-response':{status:'ok',starred2:{album:[{id:'a'}],song:[{id:'s',albumId:'a'}]}}};
  assert.equal((await api.getStarred()).length,1);
});
function serviceFixture(extra = {}) {
  const data = new Map(); const db = { put:async (_,v) => data.set(v.key,v), get:async (_,k)=>data.get(k), delete:async (_,k)=>data.delete(k) };
  return load('src/services/authService.ts', {'idb':{openDB:async()=>db}, './subsonic':{setCredentials(){}}}, {localStorage:storage(), ...extra});
}
test('authenticatedFetch preserves Headers and tuple arrays while replacing bearer', async () => {
  let options; const api = serviceFixture({fetch: async (_,o) => {options=o;return response({});}});
  await api.saveToken(valid());
  for (const headers of [new Headers({'X-Test':'yes'}), [['X-Test','yes']], {'X-Test':'yes'}]) {
    await api.authenticatedFetch('/fixture',{headers});
    assert.equal(new Headers(options.headers).get('X-Test'),'yes');
    assert.match(new Headers(options.headers).get('Authorization'),/^Bearer /);
  }
});
test('JWT UTF8 claims and returned user_name survive exchange', async () => {
  const api=serviceFixture({fetch:async()=>response({token:valid(),user_name:'Jöhn',subsonic_pass:'fixture'})});
  assert.equal(api.decodeJwt(jwt({name:'秘密'})).name,'秘密');
  assert.equal((await api.exchangeGoogleToken('fixture','nonce')).user.name,'Jöhn');
});
function authFixture(overrides = {}, validate = async()=>true, realSubsonic = null) {
  let state; const calls=[]; let storedToken=null, creds=null;
  const service = { loadToken:async()=>storedToken, loadSubsonicCredentials:async()=>creds, saveToken:async t=>{storedToken=t;}, deleteToken:async()=>{storedToken=null;}, saveSubsonicCredentials:async(u,p)=>{creds={user:u,pass:p};}, clearSubsonicCredentials:async()=>{creds=null;}, decodeJwt:t=>JSON.parse(Buffer.from(t.split('.')[1],'base64url')), isTokenValid:t=>JSON.parse(Buffer.from(t.split('.')[1],'base64url')).exp*1000>Date.now(), exchangeGoogleToken:async()=>({accessToken:valid(),user:{name:'A'},subsonic_user:'A',subsonic_pass:'pass'}), ...overrides };
  const player={setAccountScope:s=>calls.push(['scope',s]),resetPlayer:()=>calls.push(['reset']),syncLikedSets:async()=>{},restoreLastPosition:async()=>{},setStatus:()=>{}};
  const create=fn=>{ const store=require('zustand/vanilla').createStore(fn); state=store.getState; return store; };
  load('src/stores/useAuthStore.ts', {'zustand':{create},'../services/authService':service,'../services/subsonic':{setCredentials:(u,p)=>calls.push(['creds',u,p]), getServerUrl:()=> 'https://fixture/rest',ping:async()=>true,validateCredentials:validate,...(realSubsonic ? {...realSubsonic,setCredentials:(u,p)=>{calls.push(['creds',u,p]);realSubsonic.setCredentials(u,p);}} : {})}, './playerStore':{usePlayerStore:{getState:()=>player}},'../engine/AudioEngine':{AudioEngine:{init(){},reset:()=>calls.push(['engineReset'])}}}, {localStorage:storage()});
  return {get:()=>state(),calls,saved:()=>({token:storedToken,creds}),stored:(t,c)=>{storedToken=t;creds=c;}};
}
test('manual session is authoritative and repeated checks do not reset account',async()=>{
  const f=authFixture();f.stored(null,{user:'manual',pass:'fixture'});await f.get().checkSession();
  assert.equal(f.get().isAuthenticated,true);
  await f.get().checkSession();
  assert.equal(f.calls.filter(c=>c[0]==='scope'&&c[1]!==null).length,1);
});
test('expired Google session revokes auth, credentials and player scope without manual fallback',async()=>{
  const f=authFixture();f.stored(valid(),{user:'A',pass:'fixture'});await f.get().checkSession();
  f.stored(jwt({exp:1}),{user:'A',pass:'fixture'});await f.get().checkSession();
  assert.equal(f.get().isAuthenticated,false);
  assert.ok(f.calls.some(c=>c[0]==='scope'&&c[1]===null));
  assert.deepEqual(f.calls.at(-1),['creds','','']);
});
test('logout clears both identities and account scope',async()=>{
  const f=authFixture();f.stored(valid(),{user:'A',pass:'fixture'});await f.get().checkSession();await f.get().logout();
  assert.equal(f.get().isAuthenticated,false);assert.equal(f.get().user,null);
  assert.ok(f.calls.some(c=>c[0]==='scope'&&c[1]===null));
});
test('missing previously established Google token is not silently downgraded to manual',async()=>{
  const f=authFixture();f.stored(valid(),{user:'A',pass:'fixture'});await f.get().checkSession();
  f.stored(null,{user:'A',pass:'fixture'});await f.get().checkSession();
  assert.equal(f.get().isAuthenticated,false);
});
test('late Google exchange cannot restore a logged-out session',async()=>{
  let finish;const delayed=new Promise(r=>{finish=r;});
  const f=authFixture({exchangeGoogleToken:()=>delayed});
  const login=f.get().login('fixture','nonce');await f.get().logout();
  finish({accessToken:valid(),subsonic_user:'A',subsonic_pass:'pass',user:{name:'A'}});
  assert.equal(await login,false);assert.equal(f.get().isAuthenticated,false);
  assert.equal(f.calls.filter(c=>c[0]==='scope'&&c[1]!==null).length,0);
});
test('late restored credentials cannot overwrite a later manual account',async()=>{
  let finish;const delayed=new Promise(r=>{finish=r;});let loads=0;
  const f=authFixture({loadSubsonicCredentials:()=>++loads===1?delayed:Promise.resolve(null)});
  const check=f.get().checkSession();await new Promise(r=>setImmediate(r));
  assert.equal(await f.get().loginManual('B','fixture'),true);
  finish({user:'A',pass:'old'});await check;
  assert.equal(f.get().subsonic_user,'B');
  assert.equal(f.calls.filter(c=>c[0]==='scope'&&c[1]!==null).length,1);
});
test('account A logout B establishes scopes before replacing credentials',async()=>{
  const f=authFixture();f.stored(null,{user:'A',pass:'fixture'});await f.get().checkSession();
  await f.get().logout();assert.equal(await f.get().loginManual('B','pass'),true);
  assert.equal(f.get().subsonic_user,'B');
  const b=f.calls.findIndex(c=>c[0]==='creds'&&c[1]==='B');
  assert.equal(f.calls[b-1][0],'scope');assert.match(f.calls[b-1][1],/B/);
  const clear=f.calls.findIndex(c=>c[0]==='creds'&&c[1]==='');assert.deepEqual(f.calls[clear-1],['scope',null]);
});
test('Google exchange passes expected_nonce without persisting rejected identities',async()=>{
  let body;const api=serviceFixture({fetch:async(_,o)=>{body=JSON.parse(o.body);return response({token:valid(),user_name:'Name'});}});
  assert.ok(await api.exchangeGoogleToken('fixture','request-nonce'));assert.equal(body.expected_nonce,'request-nonce');
  assert.equal(await api.loadToken(),null);assert.equal(await api.loadSubsonicCredentials(),null);
});
test('auth storage denial does not prevent full logout',async()=>{
  const denied={getItem(){throw Error('SecurityError');},setItem(){throw Error('SecurityError');},removeItem(){throw Error('SecurityError');}};
  const api=load('src/services/authService.ts',{'idb':{openDB:async()=>{throw Error('Denied');}}},{localStorage:denied});
  await api.saveToken(valid());await api.saveSubsonicCredentials('A','fixture');
  assert.ok(await api.loadToken());assert.equal((await api.loadSubsonicCredentials()).user,'A');
  await api.deleteToken();await api.clearSubsonicCredentials();
  assert.equal(await api.loadToken(),null);assert.equal(await api.loadSubsonicCredentials(),null);
});
test('focus/session recheck must not cancel an in-flight manual login',async()=>{
  let finish; const delayed=new Promise(r=>{finish=r;});
  const f=authFixture({},()=>delayed);
  const login=f.get().loginManual('B','fixture');await f.get().checkSession();finish(true);
  assert.equal(await login,true);assert.equal(f.get().subsonic_user,'B');
});
test('manual credential revalidation can revoke a stale session without restarting playback',async()=>{
  let valid=true;const f=authFixture({},async()=>valid);f.stored(null,{user:'A',pass:'fixture'});
  await f.get().checkSession();valid=false;await f.get().checkSession();
  assert.equal(f.get().isAuthenticated,false);
});
test('nested returned user_name is a display-name fallback',async()=>{
  const api=serviceFixture({fetch:async()=>response({token:jwt({exp:Date.now()/1000+3600}),user:{user_name:'Nested Name'}})});
  assert.equal((await api.exchangeGoogleToken('fixture')).user.name,'Nested Name');
});
test('manual submit does not replace the form with the root session-loading screen',async()=>{
  let finish;const delayed=new Promise(r=>{finish=r;});const f=authFixture({},()=>delayed);
  await f.get().checkSession();const login=f.get().loginManual('A','fixture');
  assert.equal(f.get().isLoading,false);finish(false);await login;
});
test('single root gate, both logout buttons and Favorites never union old ids',()=>{
  const root=source('src/components/Layout/RootLayout.tsx');
  assert.doesNotMatch(root,/setIsLoggedIn/);
  assert.match(source('src/pages/SettingsPage.tsx'),/useAuthStore/);
  assert.doesNotMatch(source('src/pages/FavoritesPage.tsx'),/\.\.\.current|beatmonkey_liked_sets|usePlayerStore\.setState/);
  assert.match(source('src/pages/FavoritesPage.tsx'),/starredResult\?\.scope === accountScope/);
  const form=source('src/components/Auth/LoginFlow.tsx');
  assert.match(form,/htmlFor="username"/);assert.match(form,/autoComplete="current-password"/);assert.doesNotMatch(form,/text-white text-sm focus/);
});
function rootFixture() {
  const effects=[], timers=[];let now=0, logouts=0;
  const Login=()=>null, Child=()=>null;
  const state={token:'fixture',isAuthenticated:true,isLoading:false,checkSession:async()=>{},logout:async()=>{logouts++;state.isAuthenticated=false;state.token=null;}};
  const deps={ 'react/jsx-runtime':require('react/jsx-runtime'), 'react':{useEffect:fn=>effects.push(fn)}, '@tanstack/react-router':{Outlet:Child,useRouterState:()=>({location:{pathname:'/discover'}})}, '../Navigation/BottomNav':{BottomNav:Child}, '../MiniPlayer/MiniPlayerBar':{MiniPlayerBar:Child}, '../Player/FullscreenPlayerOverlay':{FullscreenPlayerOverlay:Child}, '../Auth/LoginFlow':{LoginFlow:Login}, '../../services/authService':{decodeJwt:()=>({exp:3000000}),isTokenValid:()=>now<3000000000}, '../../stores/playerStore':{usePlayerStore:fn=>fn({isFullscreen:false})}, '../../stores/useAuthStore':{useAuthStore:()=>state} };
  const root=load('src/components/Layout/RootLayout.tsx',deps,{Date:{now:()=>now},window:{addEventListener(){},removeEventListener(){},setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout(){}},document:{addEventListener(){},removeEventListener(){},visibilityState:'visible'}}).RootLayout;
  return {root,state,Login,effects,timers,now:n=>{now=n;},logouts:()=>logouts};
}
test('root gate immediately follows the authoritative manual/Google auth state',()=>{
  const f=rootFixture();assert.notEqual(f.root().type,f.Login);f.state.isAuthenticated=false;
  assert.equal(f.root().type,f.Login);
});
test('root expiry timer reschedules long sessions and expires without another focus event',async()=>{
  const f=rootFixture();f.root();for(const effect of f.effects) effect();
  assert.equal(f.timers[0].ms,2147483647);f.now(2147483647);f.timers[0].fn();
  assert.equal(f.timers.length,2);assert.equal(f.logouts(),0);
  f.now(3000000000);f.timers[1].fn();assert.equal(f.logouts(),1);
});
test('OAuth context uses crypto state+nonce, one-use cleanup and safe timestamp return',()=>{
  const ss=storage();const api=load('src/services/authRequest.ts',{}, {sessionStorage:ss});
  const ctx=api.beginGoogleRequest('/app/set/a?t=42&song=s');
  assert.match(ctx.state,/^[a-f0-9]{64}$/);assert.notEqual(ctx.state,ctx.nonce);
  const result=api.consumeGoogleCallback('#'+new URLSearchParams({state:ctx.state,id_token:jwt({nonce:ctx.nonce})}));
  assert.equal(result.returnUrl,'/set/a?t=42&song=s');assert.equal(result.expectedNonce,ctx.nonce);
  assert.throws(()=>api.consumeGoogleCallback('#state='+ctx.state));
  for(const bad of ['//evil.test','/\\evil.test','https://evil.test','/auth/callback','/%2f%2fevil.test']) assert.equal(api.safeReturnUrl(bad),'/discover');
});
test('OAuth rejects mismatch/expired request and cleans up',()=>{
  const ss=storage();const api=load('src/services/authRequest.ts',{}, {sessionStorage:ss});
  for (const variant of ['state','nonce','expired']) {
    const ctx=api.beginGoogleRequest('/app/set/a?t=42');
    if(variant==='expired'){const stored=JSON.parse(ss.getItem('bm_google_request'));stored.createdAt=1;ss.setItem('bm_google_request',JSON.stringify(stored));}
    assert.throws(()=>api.consumeGoogleCallback('#'+new URLSearchParams({state:variant==='state'?'bad':ctx.state,id_token:jwt({nonce:variant==='nonce'?'bad':ctx.nonce})})));
    assert.equal(ss.getItem('bm_google_request'),null);
  }
});
