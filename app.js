/* DriveTunes Offline — all music files stay in this browser's IndexedDB.
   No accounts, analytics, upload endpoints, CDNs or network music streaming. */
(() => {
  'use strict';

  const DB_NAME = 'drivetunes-offline-v1';
  const DB_VERSION = 1;
  const SETTINGS_KEY = 'drivetunes-preferences-v1';
  const MUSIC_EXT = /\.(mp3|m4a|aac|wav|flac|ogg|opus|aif|aiff)$/i;
  const $ = (id) => document.getElementById(id);
  const audio = $('audio');
  const dom = Object.fromEntries([
    'importTop', 'fileInput', 'emptyImport', 'trackList', 'emptyState', 'trackCount', 'search',
    'sortBtn', 'notice', 'importProgress', 'importText', 'importBar', 'playerDock',
    'nowTitle', 'nowArtist', 'nowMore', 'currentTime', 'duration', 'seek',
    'playBtn', 'playIcon', 'prevBtn', 'nextBtn', 'shuffleBtn', 'repeatBtn',
    'repeatOneBadge', 'storageUsed',
    'trackDialog', 'editTitle', 'editArtist', 'deleteTrackBtn', 'saveTrackBtn'
  ].map(id => [id, $(id)]));

  let dbPromise;
  let tracks = [];
  let currentId = null;
  let currentObjectUrl = null;
  let preparedNext = null;
  let aheadGeneration = 0;
  let currentQueue = [];
  let loadingSerial = 0;
  let dialogId = null;
  let busyImport = false;
  let noticeTimer = null;
  let metadataTick = 0;
  const prefs = {filter: 'all', sort: 'added', shuffle: false, repeat: 'off'};
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (['all', 'favorites'].includes(saved.filter)) prefs.filter = saved.filter;
    if (['added', 'title'].includes(saved.sort)) prefs.sort = saved.sort;
    prefs.shuffle = !!saved.shuffle;
    if (['off', 'all', 'one'].includes(saved.repeat)) prefs.repeat = saved.repeat;
  } catch (_) { /* private browsing may disable localStorage */ }

  function savePrefs() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(prefs)); } catch (_) { /* noncritical */ }
  }
  function request(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Πρόβλημα αποθήκευσης'));
    });
  }
  function openDB() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('Ο browser δεν υποστηρίζει αποθήκευση μουσικής.'));
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          const meta = db.createObjectStore('tracks', {keyPath: 'id', autoIncrement: true});
          meta.createIndex('fingerprint', 'fingerprint', {unique: true});
          db.createObjectStore('files', {keyPath: 'id'});
        };
        req.onsuccess = () => { const db = req.result; db.onversionchange = () => db.close(); resolve(db); };
        req.onerror = () => reject(req.error || new Error('Δεν ανοίγει η βιβλιοθήκη.'));
        req.onblocked = () => reject(new Error('Κλείσε άλλες καρτέλες του DriveTunes και δοκίμασε ξανά.'));
      }).catch(err => { dbPromise = null; throw err; });
    }
    return dbPromise;
  }
  async function loadAllTracks() {
    const db = await openDB();
    tracks = await request(db.transaction('tracks', 'readonly').objectStore('tracks').getAll());
    renderLibrary();
    updateStorageInfo();
    return tracks;
  }
  async function getBlob(id) {
    const db = await openDB();
    const record = await request(db.transaction('files', 'readonly').objectStore('files').get(id));
    return record && record.blob;
  }
  async function addFile(file) {
    const db = await openDB();
    const fingerprint = [file.name, file.size, file.lastModified].join('|');
    const exists = await request(db.transaction('tracks', 'readonly').objectStore('tracks').index('fingerprint').get(fingerprint));
    if (exists) return 'duplicate';
    const info = await readTags(file).catch(() => ({}));
    const fallback = filenameMetadata(file.name);
    const meta = {
      filename: file.name,
      title: info.title || fallback.title,
      artist: info.artist || fallback.artist,
      album: info.album || '',
      fingerprint,
      size: file.size,
      mime: file.type || '',
      favorite: false,
      addedAt: Date.now()
    };
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['tracks', 'files'], 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Δεν αποθηκεύτηκε το αρχείο.'));
      tx.onabort = () => reject(tx.error || new Error('Δεν υπάρχει αρκετός αποθηκευτικός χώρος.'));
      const add = tx.objectStore('tracks').add(meta);
      add.onsuccess = () => tx.objectStore('files').put({id: add.result, blob: file});
    });
    return 'added';
  }
  async function updateTrack(record) {
    const db = await openDB();
    await request(db.transaction('tracks', 'readwrite').objectStore('tracks').put(record));
    const i = tracks.findIndex(x => x.id === record.id);
    if (i >= 0) tracks[i] = record;
    renderLibrary();
    if (record.id === currentId) { setNowPlaying(record); updateMediaSession(); }
  }
  async function deleteTrack(id) {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['tracks', 'files'], 'readwrite');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('Η διαγραφή απέτυχε'));
      tx.objectStore('tracks').delete(id);
      tx.objectStore('files').delete(id);
    });
    tracks = tracks.filter(t => t.id !== id);
    currentQueue = currentQueue.filter(x => x !== id);
    if (preparedNext?.id === id) clearPrepared();
    if (currentId === id) {
      loadingSerial++;
      audio.pause(); audio.removeAttribute('src'); audio.load();
      releaseCurrent(); currentId = null;
      dom.playerDock.hidden = true;
      navigator.mediaSession && (navigator.mediaSession.playbackState = 'none');
    }
    renderLibrary(); updateStorageInfo();
  }

  function filenameMetadata(filename) {
    const noExt = filename.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
    const split = noExt.indexOf(' - ');
    return split > 0 ? {artist: noExt.slice(0, split).trim(), title: noExt.slice(split + 3).trim() || noExt} : {title: noExt || filename, artist: 'Άγνωστος καλλιτέχνης'};
  }
  // Common MP3 ID3v2.3/v2.4 text frames, read locally without dependencies.
  async function readTags(file) {
    if (!/\.mp3$/i.test(file.name) || file.size < 20) return {};
    const bytes = new Uint8Array(await file.slice(0, Math.min(file.size, 256 * 1024)).arrayBuffer());
    if (String.fromCharCode(...bytes.subarray(0, 3)) !== 'ID3') return {};
    const version = bytes[3];
    if (version !== 3 && version !== 4) return {};
    const size = x => ((x[0] & 127) << 21) | ((x[1] & 127) << 14) | ((x[2] & 127) << 7) | (x[3] & 127);
    const end = Math.min(bytes.length, size(bytes.subarray(6,10)) + 10);
    const readString = content => {
      if (!content.length) return '';
      const enc = content[0];
      let raw = content.subarray(1);
      if (enc === 0) return new TextDecoder('iso-8859-1').decode(raw).split('\0')[0].trim();
      if (enc === 3) return new TextDecoder('utf-8').decode(raw).split('\0')[0].trim();
      if (enc === 1 || enc === 2) {
        if (enc === 1 && raw[0] === 255 && raw[1] === 254) raw = raw.subarray(2);
        else if (enc === 1 && raw[0] === 254 && raw[1] === 255) {
          raw = raw.subarray(2); raw = new Uint8Array(raw);
          for (let i = 0; i + 1 < raw.length; i += 2) [raw[i], raw[i+1]] = [raw[i+1], raw[i]];
        } else if (enc === 2) {
          raw = new Uint8Array(raw);
          for (let i = 0; i + 1 < raw.length; i += 2) [raw[i], raw[i+1]] = [raw[i+1], raw[i]];
        }
        return new TextDecoder('utf-16le').decode(raw).split('\0')[0].trim();
      }
      return '';
    };
    const info = {};
    let pos = 10;
    if (bytes[5] & 0x40) { // Extended header (skip; uncommon)
      const len = version === 4 ? size(bytes.subarray(10,14)) : (bytes[10]*16777216 + (bytes[11]<<16) + (bytes[12]<<8) + bytes[13]);
      pos += Math.max(4, len + (version === 3 ? 4 : 0));
    }
    while (pos + 10 < end) {
      const id = String.fromCharCode(...bytes.subarray(pos,pos+4));
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const length = version === 4 ? size(bytes.subarray(pos+4,pos+8)) : ((bytes[pos+4]*16777216) + (bytes[pos+5]<<16) + (bytes[pos+6]<<8) + bytes[pos+7]);
      if (length <= 0 || pos + 10 + length > end) break;
      if (['TIT2','TPE1','TALB'].includes(id)) {
        const value = readString(bytes.subarray(pos+10,pos+10+length));
        if (value) info[{TIT2:'title',TPE1:'artist',TALB:'album'}[id]] = value;
      }
      pos += 10 + length;
      if (info.title && info.artist && info.album) break;
    }
    return info;
  }
  const prettyDuration = seconds => {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const x = Math.floor(seconds);
    const m = Math.floor(x / 60), s = String(x % 60).padStart(2, '0');
    return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2,'0')}:${s}` : `${m}:${s}`;
  };
  const humanBytes = n => n < 1024*1024 ? `${Math.round(n/1024)} KB` : `${(n/(1024*1024)).toLocaleString('el-GR',{maximumFractionDigits:1})} MB`;
  function sortedTracks() {
    let arr = tracks.filter(t => prefs.filter !== 'favorites' || t.favorite);
    const q = dom.search.value.trim().toLocaleLowerCase('el');
    if (q) arr = arr.filter(t => `${t.title} ${t.artist} ${t.album} ${t.filename}`.toLocaleLowerCase('el').includes(q));
    arr.sort((a,b) => prefs.sort === 'title' ? a.title.localeCompare(b.title,'el',{sensitivity:'base'}) : b.id-a.id);
    return arr;
  }
  function svgNote() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('aria-hidden','true');
    const p = document.createElementNS('http://www.w3.org/2000/svg','path');
    p.setAttribute('d','M9 18V5l12-2v13');
    const c = (x,y) => { const node=document.createElementNS('http://www.w3.org/2000/svg','circle');node.setAttribute('cx',x);node.setAttribute('cy',y);node.setAttribute('r','3');svg.appendChild(node); };
    svg.appendChild(p);c('6','18');c('18','16'); return svg;
  }
  function svgDots() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.classList.add('ico');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
    for (const y of [5,12,19]) {const c=document.createElementNS('http://www.w3.org/2000/svg','circle');c.setAttribute('cx','12');c.setAttribute('cy',String(y));c.setAttribute('r','1');svg.appendChild(c);}
    return svg;
  }
  function renderLibrary() {
    const visible = sortedTracks();
    dom.trackCount.textContent = `${tracks.length} ${tracks.length===1?'τραγούδι':'τραγούδια'}`;
    dom.trackList.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const track of visible) {
      const row = document.createElement('div'); row.className = 'track' + (track.id === currentId ? ' current' : ''); row.dataset.play=String(track.id);
      const art = document.createElement('span'); art.className='track-art'; art.appendChild(svgNote());
      const info = document.createElement('button');info.type='button';info.className='track-info';info.dataset.play=String(track.id);
      info.title=`Αναπαραγωγή: ${track.title}`;
      const title=document.createElement('strong');title.textContent=track.title;
      const artist=document.createElement('span');artist.textContent=track.artist||'Άγνωστος καλλιτέχνης';
      info.append(title,artist);
      const fav=document.createElement('button');fav.type='button';fav.className='track-action fav'+(track.favorite?' on':'');fav.dataset.favorite=String(track.id);fav.setAttribute('aria-label',track.favorite?'Αφαίρεση από αγαπημένα':'Προσθήκη στα αγαπημένα');fav.setAttribute('aria-pressed',String(!!track.favorite));fav.textContent='♥';
      const menu=document.createElement('button');menu.type='button';menu.className='track-action';menu.dataset.menu=String(track.id);menu.setAttribute('aria-label','Επεξεργασία / διαγραφή');menu.appendChild(svgDots());
      row.append(art,info,fav,menu);fragment.appendChild(row);
    }
    dom.trackList.appendChild(fragment);
    dom.emptyState.hidden=visible.length>0;
    document.dispatchEvent(new Event('drivetunes:library-render'));
    const headline=dom.emptyState.querySelector('strong'),paragraph=dom.emptyState.querySelector('p'),action=dom.emptyState.querySelector('button');
    if(tracks.length===0){headline.textContent='Τα αγαπημένα σου τραγούδια σε περιμένουν.';paragraph.textContent='Πάτησε «Προσθήκη τραγουδιών» και διάλεξε μουσική από τα Αρχεία σου.';action.hidden=false;}
    else {headline.textContent='Δεν βρέθηκαν τραγούδια.';paragraph.textContent=prefs.filter==='favorites'?'Πάτησε την καρδιά δίπλα σε ένα τραγούδι για να το βρεις εδώ.':'Δοκίμασε άλλη αναζήτηση.';action.hidden=true;}
  }
  function updateStorageInfo() {
    const sum = tracks.reduce((n,t)=>n+(t.size||0),0);
    dom.storageUsed.textContent=`Αποθηκευμένα στη συσκευή: ${humanBytes(sum)}`;
  }
  function showNotice(text,type='info',ms=6500){
    clearTimeout(noticeTimer);dom.notice.textContent=text;dom.notice.classList.toggle('error',type==='error');dom.notice.hidden=false;
    if(ms>0)noticeTimer=setTimeout(()=>{dom.notice.hidden=true;},ms);
  }
  function prepareQueue(selectedId){
    const ids=sortedTracks().map(t=>t.id);
    if(!ids.includes(selectedId)) ids.unshift(selectedId);
    if(prefs.shuffle){
      const other=ids.filter(id=>id!==selectedId);
      for(let i=other.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[other[i],other[j]]=[other[j],other[i]];}
      currentQueue=[selectedId,...other];
    }else currentQueue=ids;
  }
  function nextIdFromQueue(id,goForward=true) {
    if(!currentQueue.length)return null;
    const currentIndex=currentQueue.indexOf(id),shift=goForward?1:-1;
    if(currentIndex<0) return currentQueue[0] ?? null;
    const n=currentIndex+shift;
    if(n>=0&&n<currentQueue.length)return currentQueue[n];
    if(prefs.repeat==='all') return currentQueue[(n+currentQueue.length)%currentQueue.length];
    return null;
  }
  function releaseCurrent(){
    if(currentObjectUrl){URL.revokeObjectURL(currentObjectUrl);currentObjectUrl=null;}
  }
  function clearPrepared(){
    aheadGeneration++;
    if(preparedNext){URL.revokeObjectURL(preparedNext.url);preparedNext=null;}
  }
  async function prepareAhead(serial){
    clearPrepared();
    const generation = aheadGeneration;
    const next=nextIdFromQueue(currentId,true);
    if(next == null || next===currentId)return;
    try{
      const blob=await getBlob(next);
      if(!blob||serial!==loadingSerial||generation!==aheadGeneration||currentId==null)return;
      preparedNext={id:next,url:URL.createObjectURL(blob)};
    }catch(_) { /* playback still works without preload */ }
  }
  function setNowPlaying(track){
    dom.nowTitle.textContent=track.title;
    dom.nowArtist.textContent=track.artist||'Άγνωστος καλλιτέχνης';
    dom.playerDock.hidden=false;
  }
  function updatePlayButton(){
    const playing=!audio.paused&&!audio.ended;
    dom.playBtn.setAttribute('aria-label',playing?'Παύση':'Αναπαραγωγή');
    const path=dom.playIcon.querySelector('path');
    path.setAttribute('d',playing?'M8 5v14M16 5v14':'M8 5v14l11-7z');
    dom.playIcon.style.fill=playing?'none':'currentColor';
    if('mediaSession' in navigator)navigator.mediaSession.playbackState=playing?'playing':(currentId!=null?'paused':'none');
  }
  function updateMediaSession(){
    if(!('mediaSession' in navigator)|| currentId==null)return;
    const tr=tracks.find(t=>t.id===currentId);
    if(!tr)return;
    try{
      const icon=new URL('./assets/icon-512.png',location.href).href;
      navigator.mediaSession.metadata=new MediaMetadata({title:tr.title,artist:tr.artist,album:tr.album||'DriveTunes Offline',artwork:[{src:icon,sizes:'512x512',type:'image/png'}]});
    }catch(_) { /* MediaMetadata unsupported on some devices */ }
    updateMediaPosition();
  }
  function updateMediaPosition(){
    if(!('mediaSession' in navigator)||typeof navigator.mediaSession.setPositionState!=='function')return;
    const d=audio.duration;
    if(!Number.isFinite(d)||d<=0)return;
    try{navigator.mediaSession.setPositionState({duration:d,playbackRate:audio.playbackRate||1,position:Math.max(0,Math.min(audio.currentTime,d))});}catch(_){}
  }
  async function loadTrack(id,autoplay=true){
    const tr=tracks.find(t=>t.id===id);
    if(!tr)return;
    const serial=++loadingSerial;
    audio.pause();
    audio.removeAttribute('src');audio.load();
    releaseCurrent();
    currentId=id;
    setNowPlaying(tr);renderLibrary();
    dom.currentTime.textContent='0:00';dom.duration.textContent='0:00';dom.seek.value=0;
    try{
      let url;
      if(preparedNext?.id===id){url=preparedNext.url;preparedNext=null;}
      else{clearPrepared();const blob=await getBlob(id);if(!blob)throw new Error('Το αρχείο λείπει από τη συσκευή.');url=URL.createObjectURL(blob);}
      if(serial!==loadingSerial){URL.revokeObjectURL(url);return;}
      currentObjectUrl=url;
      audio.src=url;
      audio.load();
      updateMediaSession();
      if(autoplay) await startPlayback();
      prepareAhead(serial);
    }catch(error){
      if(serial!==loadingSerial)return;
      console.warn('Audio load problem',error);
      updatePlayButton();
      showNotice('Δεν μπόρεσε να ξεκινήσει το τραγούδι. Δοκίμασε ξανά το ▶ ή άλλο αρχείο.', 'error',10000);
    }
  }
  async function startPlayback(){
    if(currentId==null){if(tracks.length){const id=sortedTracks()[0]?.id??tracks[0].id;prepareQueue(id);await loadTrack(id,true);}return;}
    try{await audio.play();installHandlers();updateMediaSession();updatePlayButton();}
    catch(error){
      updatePlayButton();
      if(error?.name==='NotAllowedError')showNotice('Το iPhone χρειάζεται πάτημα στο ▶ για να ξεκινήσει η μουσική.','error',9500);
      else if(error?.name!=='AbortError')showNotice('Αυτό το αρχείο ίσως δεν υποστηρίζεται από το iPhone.','error',9500);
    }
  }
  async function playNext(fromEnded=false){
    if(currentId==null)return;
    if(fromEnded&&prefs.repeat==='one'){
      audio.currentTime=0;await startPlayback();return;
    }
    const next=nextIdFromQueue(currentId,true);
    if(next==null){audio.pause();updatePlayButton();return;}
    await loadTrack(next,true);
  }
  async function playPrevious(alwaysPrevious=false){
    if(currentId==null)return;
    if(!alwaysPrevious&&audio.currentTime>3){audio.currentTime=0;return;}
    const previous=nextIdFromQueue(currentId,false);
    if(previous!==null)await loadTrack(previous,true);
    else audio.currentTime=0;
  }
  function setRepeatMode(mode){
    prefs.repeat=mode;savePrefs();
    dom.repeatBtn.classList.toggle('active',mode!=='off');
    dom.repeatOneBadge.hidden=mode!=='one';
    dom.repeatBtn.setAttribute('aria-label',`Επανάληψη: ${mode==='off'?'κλειστή':mode==='one'?'ένα τραγούδι':'όλα'}`);
    clearPrepared();prepareAhead(loadingSerial);
  }

  async function importFiles(fileList){
    if(busyImport)return;
    const valid=[...fileList].filter(file=>file.size>0&&(file.type.startsWith('audio/')||MUSIC_EXT.test(file.name)));
    if(!valid.length){showNotice('Επίλεξε αρχεία μουσικής (MP3, M4A, AAC, WAV κ.ά.).','error');return;}
    busyImport=true;
    dom.importTop.disabled=true;dom.importProgress.hidden=false;dom.importBar.style.width='0%';
    try{
      if(navigator.storage?.persist)navigator.storage.persist().catch(()=>{});
      let added=0,skipped=0,errors=0;
      for(let i=0;i<valid.length;i++){
        dom.importText.textContent=`Αποθήκευση ${i+1} / ${valid.length}: ${valid[i].name}`;
        try{const result=await addFile(valid[i]);if(result==='added')added++;else skipped++;}
        catch(error){console.warn('Import failure',error);errors++;}
        dom.importBar.style.width=`${Math.round((i+1)/valid.length*100)}%`;
        await new Promise(resolve=>setTimeout(resolve,0));
      }
      await loadAllTracks();
      showNotice(`Αποθηκεύτηκαν ${added} τραγούδια${skipped?` · ${skipped} ήδη υπήρχαν`:''}${errors?` · ${errors} δεν αποθηκεύτηκαν`:''}. ${errors?'Έλεγξε τον ελεύθερο χώρο και κράτησε τα αρχικά αρχεία.':'Μπορείς πλέον να τα ακούς χωρίς σύνδεση.'}`,errors?'error':'info',11500);
    }catch(error){showNotice(`Πρόβλημα αποθήκευσης: ${error.message}`,'error',12000);}
    finally{busyImport=false;dom.importTop.disabled=false;dom.importProgress.hidden=true;dom.fileInput.value='';}
  }
  function openEdit(id){
    const tr=tracks.find(t=>t.id===id);if(!tr)return;
    dialogId=id;dom.editTitle.value=tr.title;dom.editArtist.value=tr.artist||'';
    dom.trackDialog.showModal();
  }
  async function saveEdit(){
    const tr=tracks.find(t=>t.id===dialogId);if(!tr)return;
    const title=dom.editTitle.value.trim();if(!title){dom.editTitle.focus();return;}
    try{await updateTrack({...tr,title,artist:dom.editArtist.value.trim()||'Άγνωστος καλλιτέχνης'});dom.trackDialog.close();showNotice('Οι πληροφορίες ενημερώθηκαν.');}
    catch(error){showNotice(`Δεν αποθηκεύτηκαν οι αλλαγές: ${error.message}`,'error');}
  }
  async function removeFromDialog(){
    if(dialogId==null)return;
    const tr=tracks.find(t=>t.id===dialogId);
    if(!confirm(`Να διαγραφεί το «${tr?.title||'τραγούδι'}» από την εφαρμογή; Το αρχικό αρχείο στα Αρχεία δεν θα επηρεαστεί.`))return;
    try{await deleteTrack(dialogId);dom.trackDialog.close();showNotice('Το τραγούδι διαγράφηκε από την εφαρμογή.');}
    catch(error){showNotice(`Η διαγραφή απέτυχε: ${error.message}`,'error');}
  }

  async function onTrackListClick(event){
    const row=event.target.closest('.track');
    if(!row)return;
    const button=event.target.closest('button');
    const id=Number(button?.dataset.play??button?.dataset.favorite??button?.dataset.menu??row.dataset.play);
    if(!Number.isSafeInteger(id))return;
    // Large tap target: pressing artwork or free card space also starts the song.
    // Favorite and edit remain independent, accessible buttons.
    if(button && 'favorite' in button.dataset){const t=tracks.find(x=>x.id===id);if(t)await updateTrack({...t,favorite:!t.favorite});}
    else if(button && 'menu' in button.dataset)openEdit(id);
    else{prepareQueue(id);await loadTrack(id,true);}
  }
  function installHandlers(){
    if(!('mediaSession' in navigator))return;
    const safe=(action,fn)=>{try{navigator.mediaSession.setActionHandler(action,fn)}catch(_){}};
    safe('play',()=>startPlayback());safe('pause',()=>audio.pause());
    // Lock screen and Bluetooth transport controls should change SONGS.
    safe('previoustrack',()=>playPrevious(true));
    safe('nexttrack',()=>playNext());
    // iOS may show ±10s buttons even with next/previous registered.
    // Treat the actions as previous/next songs when iOS sends them;
    // the iOS lock-screen ICONS themselves cannot be changed by this PWA.
    const ios=/iPad|iPhone|iPod/i.test(navigator.userAgent||'')||
      (navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
    safe('seekbackward',ios?()=>playPrevious(true):null);
    safe('seekforward',ios?()=>playNext():null);
    safe('seekto',null);
    safe('stop',()=>{audio.pause();audio.currentTime=0;});
  }
  function syncProgress(){
    dom.currentTime.textContent=prettyDuration(audio.currentTime);
    dom.duration.textContent=prettyDuration(audio.duration);
    dom.seek.value=Number.isFinite(audio.duration)&&audio.duration>0?String(Math.round(audio.currentTime/audio.duration*1000)):'0';
    const now=Date.now();if(now-metadataTick>900){updateMediaPosition();metadataTick=now;}
  }
  dom.importTop.addEventListener('click',()=>dom.fileInput.click());
  dom.emptyImport.addEventListener('click',()=>dom.fileInput.click());
  dom.fileInput.addEventListener('change',event=>{importFiles(event.target.files);});
  dom.trackList.addEventListener('click',event=>{onTrackListClick(event).catch(err=>showNotice(err.message,'error'));});
  dom.search.addEventListener('input',renderLibrary);
  dom.sortBtn.addEventListener('click',()=>{prefs.sort=prefs.sort==='added'?'title':'added';savePrefs();dom.sortBtn.title=prefs.sort==='title'?'Αλφαβητική σειρά':'Πρόσφατη εισαγωγή';renderLibrary();});
  document.querySelectorAll('.tab').forEach(tab=>tab.addEventListener('click',()=>{
    prefs.filter=tab.dataset.filter;savePrefs();
    document.querySelectorAll('.tab').forEach(btn=>{const active=btn===tab;btn.classList.toggle('active',active);btn.setAttribute('aria-selected',String(active));});
    renderLibrary();
  }));
  dom.playBtn.onclick=()=>{if(audio.paused)startPlayback();else audio.pause();};
  dom.prevBtn.onclick=()=>playPrevious();dom.nextBtn.onclick=()=>playNext();
  dom.shuffleBtn.onclick=()=>{prefs.shuffle=!prefs.shuffle;savePrefs();dom.shuffleBtn.classList.toggle('active',prefs.shuffle);dom.shuffleBtn.setAttribute('aria-pressed',String(prefs.shuffle));if(currentId!=null)prepareQueue(currentId);clearPrepared();prepareAhead(loadingSerial);};
  dom.repeatBtn.onclick=()=>setRepeatMode(prefs.repeat==='off'?'all':prefs.repeat==='all'?'one':'off');
  dom.seek.addEventListener('input',()=>{if(Number.isFinite(audio.duration)&&audio.duration>0)audio.currentTime=audio.duration*(Number(dom.seek.value)/1000);});
  dom.nowMore.addEventListener('click',()=>{if(currentId!=null)openEdit(currentId);});
  dom.saveTrackBtn.addEventListener('click',saveEdit);dom.deleteTrackBtn.addEventListener('click',removeFromDialog);
  dom.trackDialog.addEventListener('close',()=>{dialogId=null;});
  audio.addEventListener('play',updatePlayButton);audio.addEventListener('pause',updatePlayButton);
  audio.addEventListener('playing',()=>{installHandlers();updateMediaSession();updatePlayButton();});audio.addEventListener('loadedmetadata',syncProgress);
  audio.addEventListener('durationchange',syncProgress);audio.addEventListener('timeupdate',syncProgress);
  audio.addEventListener('ended',()=>playNext(true));
  audio.addEventListener('error',()=>{if(audio.currentSrc)showNotice('Αυτό το αρχείο δεν μπορεί να αναπαραχθεί. Δοκίμασε MP3 ή M4A.','error',9500);});
  document.addEventListener('dragover',event=>{if(event.dataTransfer?.types?.includes('Files'))event.preventDefault();});
  document.addEventListener('drop',event=>{if(event.dataTransfer?.files?.length){event.preventDefault();importFiles(event.dataTransfer.files);}});
  window.addEventListener('beforeunload',()=>{releaseCurrent();clearPrepared();});

  async function start(){
    // Request a music-playback audio session when supported by WebKit.
    try{if(navigator.audioSession)navigator.audioSession.type='playback';}catch(_){}
    document.querySelectorAll('.tab').forEach(tab=>{const active=tab.dataset.filter===prefs.filter;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active));});
    dom.shuffleBtn.classList.toggle('active',prefs.shuffle);dom.shuffleBtn.setAttribute('aria-pressed',String(prefs.shuffle));setRepeatMode(prefs.repeat);
    installHandlers();
    if('serviceWorker' in navigator&&window.isSecureContext){try{await navigator.serviceWorker.register('./sw.js');}catch(err){console.warn('Offline app shell unavailable',err);}}
    try{await loadAllTracks();}catch(err){console.error(err);showNotice('Δεν άνοιξε η τοπική βιβλιοθήκη. Έλεγξε τις ρυθμίσεις αποθήκευσης του Safari.','error',0);}
  }
  // Receiver imports directly into the original IndexedDB in this installed app.
  window.DriveTunesImportApi={addFile,loadAllTracks,renderLibrary,getTracks:()=>tracks.slice(),getPrefs:()=>({...prefs})};
  start();
})();
