/* Run with: node tests/pc-transfer.mjs */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {webcrypto} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const load=path=>readFileSync(resolve(root,path),'utf8');
const src=load('pc-bridge.js');
const sender=load('pc-transfer.js'),receiver=load('receiver-transfer.js');
for(const js of [src,sender,receiver])assert.doesNotThrow(()=>new Function(js));

class MockWebSocket {
  static OPEN=1;
  static instances=[];
  constructor(url){this.url=url;this.readyState=0;this.handlers={};this.sent=[];MockWebSocket.instances.push(this);}
  addEventListener(event,cb){(this.handlers[event]??=[]).push(cb);}
  send(data){this.sent.push(data);}
  close(){this.readyState=3;}
  fire(type){if(type==='open')this.readyState=1;for(const fn of this.handlers[type]||[])fn();}
}
class MockRTC{}
const local={items:new Map(),getItem(k){return this.items.get(k)||null;},setItem(k,v){this.items.set(k,v);}};
const mockWindow={WebSocket:MockWebSocket,RTCPeerConnection:MockRTC};
const bridge=new Function('window','crypto','localStorage','location','URL','URLSearchParams','WebSocket','RTCPeerConnection',src+'\nreturn window.DriveTunesBridge;')(
  mockWindow,webcrypto,local,new URL('https://music.example/app/index.html'),URL,URLSearchParams,MockWebSocket,MockRTC
);
const code=bridge.randomCode();
assert.match(code,/^[2-9A-HJ-NP-Z]{10}$/);
assert.equal(bridge.normalizeCode(' '+code.toLowerCase()+' '),code);
assert.throws(()=>bridge.normalizeCode('bad'));
assert.equal(bridge.normalizeServer('https://transfer.example/?room=a'),'https://transfer.example');
assert.throws(()=>bridge.normalizeServer('http://transfer.example'));
assert.throws(()=>bridge.normalizeServer('https://transfer.example/ws'));
assert.throws(()=>bridge.normalizeServer('https://user:pass@transfer.example'));
const link=new URL(bridge.pairingUrl('https://transfer.example',code));
assert.equal(link.origin,'http://127.0.0.1:8765');
assert.equal(link.pathname,'/');
assert.equal(new URLSearchParams(link.hash.slice(1)).get('room'),code);
assert.equal(new URLSearchParams(link.hash.slice(1)).get('server'),'https://transfer.example');
const p=bridge.pair({role:'receiver',room:code,server:'https://transfer.example'});
assert.equal(MockWebSocket.instances.length,1);
const socket=MockWebSocket.instances[0];
assert.equal(new URL(socket.url).pathname,'/ws');
assert.equal(new URL(socket.url).searchParams.get('room'),'dt-'+code.toLowerCase());
socket.fire('open');
const hello=JSON.parse(socket.sent[0]);
assert.equal(hello.type,'hello');
assert.equal(hello.name,'DT-Receiver');
p.stop();
assert.equal(socket.readyState,3);

// A receiver must create a File from binary chunks, store it in the original
// DriveTunes IndexedDB through addFile, and only then acknowledge success.
class Element {
  constructor(){this.value='';this.hidden=false;this.textContent='';this.classList={toggle(){}};this.listeners={};this.attrs={};}
  addEventListener(k,f){(this.listeners[k]??=[]).push(f);}
  setAttribute(k,v){this.attrs[k]=v;}
  async emit(k,e={}){for(const f of this.listeners[k]||[])await f(e);}
}
const ids=['pcTransferToggle','pcTransferPanel','pcTransferServer','pcTransferStart','pcTransferClose',
 'pcPairing','pcPairCode','pcSenderUrl','pcCopyLink','pcTransferStatus',
 'pcReceiveProgress','pcReceiveName','pcSetupHint'];
const els=Object.fromEntries(ids.map(id=>[id,new Element()]));
let readyCallback;
const doc={getElementById:id=>els[id],addEventListener:(name,f)=>{if(name==='DOMContentLoaded')readyCallback=f;}};
let pairConfig,stored;
let libraryRefreshes=0;
const api={addFile:async file=>{stored=file;return 'added';},loadAllTracks:async()=>{libraryRefreshes++;}};
const bstub={
  savedServer:()=>'',normalizeServer:value=>value,saveServer:()=>{},
  randomCode:()=>code,pairingUrl:(server,room)=>bridge.pairingUrl(server,room),
  pair:args=>{pairConfig=args;return {stop(){}};},
  FILE_LIMIT:bridge.FILE_LIMIT,MUSIC:bridge.MUSIC
};
const mockReceiverWindow={DriveTunesBridge:bstub,DriveTunesImportApi:api,addEventListener:()=>{}};
class FakeFile {
  constructor(parts,name,opts){this.parts=parts;this.name=name;this.type=opts.type;this.lastModified=opts.lastModified;
    this.bytes=parts.flatMap(p=>Array.from(new Uint8Array(p)));}
}
new Function('document','window','navigator','location','URL','File',receiver)(
  doc,mockReceiverWindow,{clipboard:{writeText:async()=>{}}},new URL('https://music.example/app/index.html'),URL,FakeFile
);
readyCallback();
els.pcTransferServer.value='https://transfer.example';
await els.pcTransferStart.emit('click');
assert.equal(pairConfig.role,'receiver');
assert.equal(els.pcPairCode.textContent,code);
const sent=[];
const chan={readyState:'open',listeners:{},addEventListener(k,fn){this.listeners[k]=fn;},send(data){sent.push(JSON.parse(data));},
  async deliver(data){await this.listeners.message({data});}};
pairConfig.onChannel(chan);
await chan.deliver(JSON.stringify({type:'file',name:'Example.mp3',size:3,mime:'audio/mpeg',lastModified:123}));
await chan.deliver(Uint8Array.from([1,2,3]).buffer);
await chan.deliver(JSON.stringify({type:'done'}));
assert.deepEqual(sent.map(m=>m.type),['ready','saved']);
assert.equal(sent[1].result,'added');
assert.equal(stored.name,'Example.mp3');
assert.deepEqual(stored.bytes,[1,2,3]);
assert.equal(libraryRefreshes,1);
await chan.deliver(JSON.stringify({type:'file',name:'bad.exe',size:3,mime:'application/octet-stream'}));
assert.equal(sent.at(-1).type,'error');
console.log('PASS: pairing code/server validation, signaling handshake, binary receiver, IndexedDB save acknowledgements');

// The Windows launcher should serve a local browser UI, not listen on the iPhone,
// and must not expose any local files beyond its fixed allowlist.
const launcher=load('DriveTunes-PC.cmd');
assert(launcher.includes('TcpListener]::new([System.Net.IPAddress]::Loopback,$port)'));
assert(launcher.includes("http://127.0.0.1:"));
assert(launcher.includes("'/' = 'pc-transfer.html'"));
assert(launcher.includes("'/pc-bridge.js' = 'pc-bridge.js'"));
assert(launcher.includes("'/pc-transfer.js' = 'pc-transfer.js'"));
assert(!launcher.includes('0.0.0.0'));
console.log('PASS: local Windows localhost server configuration');
