import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const load=path=>readFileSync(resolve(root,path),'utf8');
const html=load('index.html'),css=load('style.css'),js=load('app.js'),sw=load('sw.js');
const manifest=JSON.parse(load('manifest.webmanifest'));
for(const x of ['index.html','style.css','app.js','sw.js','manifest.webmanifest','assets/icon.svg','assets/icon-192.png','assets/icon-512.png','assets/apple-touch-icon.png'])assert(existsSync(resolve(root,x)),`Missing ${x}`);
assert.doesNotThrow(()=>new Function(js));
assert.doesNotThrow(()=>new Function(sw));
assert.equal(manifest.display,'standalone');
assert.equal(manifest.icons.length,2);
for(const x of ['id="fileInput"','multiple hidden','id="audio"','id="playerDock"','id="shuffleBtn"','id="repeatBtn"'])assert(html.includes(x),`HTML missing ${x}`);
assert(js.includes("db.createObjectStore('files'"),'Binary store missing');
assert(js.includes('blob: file'),'Audio files not persisted');
assert(js.includes('mediaSession.setActionHandler'),'Media Session controls missing');
assert(js.includes('URL.revokeObjectURL'),'Object URL release missing');
assert(js.includes('navigator.storage.persist()'),'Storage persistence attempt missing');
assert(!/fetch\([^\n]*file/i.test(js),'Unexpected file upload');
assert(!/https?:\/\//i.test(sw),'Service worker should have no external URLs');
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
assert.equal(new Set(ids).size,ids.length,'Duplicate HTML ids');
let depth=0;for(const c of css){if(c==='{')depth++;if(c==='}')depth--;assert(depth>=0,'Bad CSS braces');}assert.equal(depth,0,'Unbalanced CSS');
const start=js.indexOf('  function filenameMetadata('),end=js.indexOf('  const prettyDuration',start);
assert(start>0&&end>start);
const tools=new Function(js.slice(start,end)+'\nreturn {filenameMetadata,readTags}')();
assert.deepEqual(tools.filenameMetadata('Artist - Great song.mp3'),{artist:'Artist',title:'Great song'});
assert.deepEqual(tools.filenameMetadata('Track_name.m4a'),{title:'Track name',artist:'Άγνωστος καλλιτέχνης'});
const frame=(tag,text)=>{const data=Buffer.from(text,'utf8');const bytes=Buffer.concat([Buffer.from([3]),data]);const size=Buffer.alloc(4);size.writeUInt32BE(bytes.length);return Buffer.concat([Buffer.from(tag),size,Buffer.from([0,0]),bytes]);};
const frames=Buffer.concat([frame('TIT2','Νυχτερινή βόλτα'),frame('TPE1','Test Artist'),frame('TALB','Car Mix')]);
let n=frames.length;const synchsafe=Buffer.from([(n>>>21)&127,(n>>>14)&127,(n>>>7)&127,n&127]);
const mp3=Buffer.concat([Buffer.from('ID3'),Buffer.from([3,0,0]),synchsafe,frames]);
const file=new File([mp3],'example.mp3',{type:'audio/mpeg'});
const parsed=await tools.readTags(file);
assert.equal(parsed.title,'Νυχτερινή βόλτα');assert.equal(parsed.artist,'Test Artist');assert.equal(parsed.album,'Car Mix');
console.log('PASS: files, manifest, JS/SW syntax, HTML IDs, CSS braces, ID3 metadata, filename parsing, local blob storage paths');

assert(!html.includes('class="hero"'),'Oversized hero must not reappear');
assert(html.includes('class="primary-button compact-import"'),'Compact add button missing');
assert(js.includes("safe('previoustrack',()=>playPrevious(true))"),'Previous track must switch songs');
assert(js.includes("safe('nexttrack',()=>playNext())"),'Next track must switch songs');
assert(!/safe\('seek(?:backward|forward)',details/.test(js),'10 second skipping handlers remain');
assert(js.includes("safe('seekbackward',ios?()=>playPrevious(true):null)")&&js.includes("safe('seekforward',ios?()=>playNext():null)"),'iOS seek controls must select songs');
assert(sw.includes('drivetunes-shell-v7'),'Cache version should be bumped');

assert(js.includes("audio.addEventListener('playing',()=>{installHandlers();updateMediaSession();updatePlayButton();})"),'Media Session must be registered after audio starts');
assert(js.includes('await audio.play();installHandlers();updateMediaSession()'),'Media Session registration after successful play missing');
assert(js.includes('row.dataset.play=String(track.id)'),'Card tap-to-play target missing');
assert(css.includes('.track{min-height:84px'),'Larger song rows missing');
assert(sw.includes('drivetunes-shell-v7'),'PWA cache version not updated');

assert(!html.includes('class="info-card"'),'Installation instructions must be removed');
assert(!html.includes('id="installDialog"')&&!html.includes('id="installBtn"'),'In-app install UI must be removed');
assert(!html.includes('id="networkStatus"'),'Unnecessary online status badge must be removed');
assert(!js.includes('setupInstall()')&&!js.includes('updateNetwork()'),'Removed interface handlers remain');
assert(js.includes("navigator.audioSession.type='playback'"),'Music audio session should be requested where supported');


// Direct PC-to-iPhone transfer: app storage, scripts, and WebRTC signaling.
for(const id of ['pcTransferToggle','pcTransferPanel','pcTransferServer','pcTransferStart',
 'pcTransferClose','pcPairing','pcPairCode','pcSenderUrl','pcCopyLink',
 'pcTransferStatus','pcReceiveProgress','pcReceiveName']){
 assert(html.includes('id="'+id+'"'),'PC transfer element missing: '+id);
}
assert(html.includes('src="./pc-bridge.js"')&&html.includes('src="./receiver-transfer.js"'));
assert(js.includes('window.DriveTunesImportApi={addFile,loadAllTracks}'),'Receiver must access existing local music import');
for(const path of ['pc-transfer.html','pc-transfer.css','pc-transfer.js','pc-bridge.js','receiver-transfer.js','DriveTunes-PC.cmd']){
 assert(existsSync(resolve(root,path)),'Missing PC transfer file: '+path);
}
for(const path of ['pc-transfer.js','pc-bridge.js','receiver-transfer.js']){
 assert.doesNotThrow(()=>new Function(load(path)),path+' syntax invalid');
}
const bridgeJs=load('pc-bridge.js'),receiveJs=load('receiver-transfer.js'),senderJs=load('pc-transfer.js');
assert(bridgeJs.includes("new WebSocket(endpoint.href)"),'Signaling must use DataTransfer Worker');
assert(bridgeJs.includes("new RTCPeerConnection(ICE)"),'Song bytes must use WebRTC');
assert(receiveJs.includes("await api.addFile(audioFile)"),'Uploaded audio must be saved in DriveTunes');
assert(receiveJs.includes("await api.loadAllTracks()"),'Library must refresh after import');
assert(senderJs.includes("file.slice(offset,offset+B.CHUNK)"),'Large files must stream in chunks');
assert(senderJs.includes("await handshake('saved'"),'Sender must wait for saved acknowledgment');
assert(sw.includes('drivetunes-shell-v7'),'New transfer pages must be in updated offline cache');
console.log('PASS: PC-to-iPhone WebRTC transfer scripts and original offline music storage');


// Spotify entry point and integration have been fully removed.
assert(!html.toLowerCase().includes('spotify'),'Spotify UI must not appear in DriveTunes');
assert(!js.toLowerCase().includes('spotify'),'Spotify JS and OAuth must be removed');
assert(!css.toLowerCase().includes('spotify'),'Spotify styling must be removed');
assert(sw.includes('drivetunes-shell-v7'),'New version must invalidate old Spotify shell');
const launcher=load('DriveTunes-PC.cmd');
assert(launcher.includes("TcpListener]::new([System.Net.IPAddress]::Loopback,$port)"),
 'Windows launcher must listen only on local loopback interface');
assert(launcher.includes("http://127.0.0.1:"),'Windows launcher missing local IP');
assert(!launcher.includes("0.0.0.0"),'Windows launcher must not expose the UI on all interfaces');
assert(load('receiver-transfer.js').includes("'http://127.0.0.1:8765/'"),
 'iPhone should show local PC browser IP');
console.log('PASS: Spotify removed and PC IP launcher configured');
