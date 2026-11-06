import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url),ts=require('typescript');
const jwt=(sub='A',user='alice')=>'e30.'+Buffer.from(JSON.stringify({sub,user_name:user,exp:Date.now()/1000+3600})).toString('base64url')+'.fixture';
function fixture(fetch){
 const data=new Map(),local=new Map();
 const db={get:async(_,key)=>data.get(key),put:async(_,v)=>data.set(v.key,v),delete:async(_,key)=>data.delete(key)};
 const source=readFileSync(new URL('../../src/services/authService.ts',import.meta.url),'utf8').replace(/import\.meta\.env\.VITE_GOOGLE_CLIENT_ID/g,"'fixture-client'");
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const context={exports:{},require:id=>{assert.equal(id,'idb');return {openDB:async()=>db};},fetch,localStorage:{getItem:k=>local.get(k)??null,setItem:(k,v)=>local.set(k,v),removeItem:k=>local.delete(k)},URL,Headers,AbortController,setTimeout,clearTimeout,atob,TextDecoder,Uint8Array,console,window:{location:{origin:'https://fixture.example'}}};
 vm.runInNewContext(js,context);return context.exports;
}
test('real refresh succeeds and coalesces without cancelling itself on token save',async()=>{
 let calls=0,resolve;const reply=new Promise(r=>resolve=r);const api=fixture(async()=>{calls++;return reply;});
 await api.saveToken(jwt());await api.saveSubsonicCredentials('alice','fixture');
 const fresh=jwt();const a=api.refreshCoreSession('A'),b=api.refreshCoreSession('A');resolve(new Response(JSON.stringify({token:fresh}),{status:200}));
 assert.equal(await a,fresh);assert.equal(await b,fresh);assert.equal(calls,1);assert.ok(await api.loadToken());
});
test('explicit valid login can save a token after logout tombstone',async()=>{
 const api=fixture(async()=>new Response('{}'));await api.saveToken(jwt());await api.deleteToken();
 await api.saveToken(jwt('B','bob'));assert.equal(api.decodeJwt(await api.loadToken()).sub,'B');
});
test('protocol-relative outside host never receives bearer',async()=>{
 let options;const api=fixture(async(_,o)=>{options=o;return new Response('{}');});await api.saveToken(jwt());
 await api.authenticatedFetch('//evil.example/api/steal');assert.equal(new Headers(options.headers).get('Authorization'),null);
});
test('real refresh mismatch rejects and never overwrites original token',async()=>{
 const original=jwt();const api=fixture(async()=>new Response(JSON.stringify({token:jwt('B','bob')})));await api.saveToken(original);
 await assert.rejects(api.refreshCoreSession('A'),/Identiteit|identity/);assert.equal(await api.loadToken(),original);
});
test('late refresh after logout cannot resurrect access token',async()=>{
 let resolve;const reply=new Promise(r=>resolve=r);const api=fixture(async()=>reply);await api.saveToken(jwt());
 const refresh=api.refreshCoreSession('A');await api.deleteToken();resolve(new Response(JSON.stringify({token:jwt()})));
 await assert.rejects(refresh);assert.equal(await api.loadToken(),null);
});
