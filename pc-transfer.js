/* PC sender: uploads selected audio directly over WebRTC to DriveTunes on iPhone. */
(() => {
  'use strict';
  document.addEventListener('DOMContentLoaded',()=>{
    const B=window.DriveTunesBridge,$=id=>document.getElementById(id);
    const u={
      code:$('roomCode'),server:$('serverUrl'),connect:$('connectBtn'),picker:$('pcFiles'),
      pick:$('chooseBtn'),drop:$('dropZone'),status:$('pcStatus'),progress:$('fileProgress'),
      progressName:$('progressName'),queue:$('queueLabel'),disconnect:$('disconnectBtn')
    };
    if(!B||Object.values(u).some(v=>!v))return;
    const hash=new URLSearchParams(location.hash.slice(1));
    if(hash.has('room'))u.code.value=hash.get('room')||'';
    if(hash.has('server'))u.server.value=hash.get('server')||'';
    else u.server.value=B.savedServer();
    // Pairing details are not needed in browser history or Referer.
    if(location.hash)history.replaceState(null,'',location.pathname+location.search);
    let bridge=null,dc=null,queue=[],sending=false,pending=null,finished=0;
    const status=(message,error=false)=>{
      u.status.textContent=message;u.status.classList.toggle('error',error);
    };
    function cancelPending(){
      if(pending){pending.reject(new Error('Η σύνδεση διακόπηκε.'));pending=null;}
    }
    function stop(){
      cancelPending();
      if(bridge){bridge.stop();bridge=null;}
      if(dc){try{dc.close();}catch{}dc=null;}
      u.drop.classList.remove('connected');
      u.disconnect.hidden=true;
    }
    function handleReply(event){
      if(typeof event.data!=='string')return;
      let msg;try{msg=JSON.parse(event.data);}catch{return;}
      const wait=pending;
      if(wait){
        if(msg.type==='error'){pending=null;wait.reject(new Error(msg.message||'Το iPhone απέρριψε το αρχείο.'));}
        else if(msg.type===wait.type){pending=null;wait.resolve(msg);}
      }
    }
    function handshake(type,send){
      return new Promise((resolve,reject)=>{
        if(!dc||dc.readyState!=='open')return reject(new Error('Δεν υπάρχει σύνδεση με το iPhone.'));
        const timer=setTimeout(()=>{
          if(pending===entry){pending=null;reject(new Error('Το iPhone δεν απάντησε έγκαιρα.'));}
        },90000);
        const entry={
          type,
          resolve:value=>{clearTimeout(timer);resolve(value);},
          reject:error=>{clearTimeout(timer);reject(error);}
        };
        pending=entry;
        try{send();}catch(error){pending=null;entry.reject(error);}
      });
    }
    async function waitForSpace(){
      while(dc?.readyState==='open'&&dc.bufferedAmount>B.MAX_BUFFER){
        await new Promise(resolve=>setTimeout(resolve,35));
      }
      if(dc?.readyState!=='open')throw new Error('Η σύνδεση με το iPhone έκλεισε.');
    }
    async function sendFile(file){
      if(!B.MUSIC.test(file.name)||file.size<=0||file.size>B.FILE_LIMIT)throw new Error('Επιτρέπονται αρχεία ήχου έως 120 MB ανά τραγούδι.');
      u.progress.hidden=false;u.progress.value=0;
      u.progressName.textContent='Μεταφορά: '+file.name;
      await handshake('ready',()=>dc.send(JSON.stringify({
        type:'file',name:file.name,size:file.size,mime:file.type,lastModified:file.lastModified
      })));
      for(let offset=0;offset<file.size;offset+=B.CHUNK){
        await waitForSpace();
        const slice=await file.slice(offset,offset+B.CHUNK).arrayBuffer();
        if(dc?.readyState!=='open')throw new Error('Η σύνδεση έκλεισε.');
        dc.send(slice);
        u.progress.value=Math.round(Math.min(offset+B.CHUNK,file.size)/file.size*100);
      }
      const saved=await handshake('saved',()=>dc.send(JSON.stringify({type:'done'})));
      u.progressName.textContent=saved.result==='duplicate'?'Υπήρχε ήδη: '+file.name:'Αποθηκεύτηκε: '+file.name;
      return saved.result;
    }
    async function pump(){
      if(sending||!dc||dc.readyState!=='open'||!queue.length)return;
      sending=true;
      try{
        while(queue.length&&dc?.readyState==='open'){
          const file=queue.shift();
          u.queue.textContent='Απομένουν '+(queue.length+1)+' αρχεία';
          try{
            const result=await sendFile(file);
            if(result==='added')finished++;
            status(result==='duplicate'?'Το «'+file.name+'» υπήρχε ήδη στο iPhone.':'Μεταφέρθηκε «'+file.name+'» · '+finished+' νέα τραγούδια.');
          }catch(error){
            status('Αποτυχία στο «'+file.name+'»: '+error.message,true);
            queue=[];break;
          }
        }
        u.queue.textContent=queue.length?'Απομένουν '+queue.length+' αρχεία':'';
      }finally{sending=false;}
    }
    function enqueueFiles(fileList){
      const accepted=[...fileList].filter(file=>B.MUSIC.test(file.name)&&file.size>0&&file.size<=B.FILE_LIMIT);
      const skipped=fileList.length-accepted.length;
      if(!accepted.length){
        status('Επίλεξε MP3/M4A/AAC/WAV/FLAC/OGG έως 120 MB ανά αρχείο.',true);return;
      }
      queue.push(...accepted);
      u.queue.textContent=queue.length+' αρχεία προς μεταφορά'+(skipped?' · '+skipped+' παραλείφθηκαν':'');
      if(dc?.readyState==='open')pump();
      else status('Τα τραγούδια είναι έτοιμα. Πάτησε «Σύνδεση».');
    }
    function connect(){
      try{
        const server=B.normalizeServer(u.server.value);
        const room=B.normalizeCode(u.code.value);
        B.saveServer(server);
        stop();finished=0;u.progress.hidden=true;
        bridge=B.pair({
          role:'sender',server,room,
          onStatus:message=>status(message),
          onChannel:channel=>{
            dc=channel;
            dc.addEventListener('message',handleReply);
            dc.addEventListener('close',()=>{cancelPending();dc=null;});
            u.drop.classList.add('connected');
            u.disconnect.hidden=false;
            status('Συνδέθηκε το iPhone! Διάλεξε ή σύρε τα τραγούδια.');
            pump();
          }
        });
      }catch(error){status(error.message,true);}
    }
    u.connect.addEventListener('click',connect);
    u.disconnect.addEventListener('click',()=>{stop();status('Η σύνδεση έκλεισε.');});
    u.pick.addEventListener('click',()=>u.picker.click());
    u.picker.addEventListener('change',event=>{enqueueFiles(event.target.files);u.picker.value='';});
    u.drop.addEventListener('click',event=>{if(!event.target.closest('button'))u.picker.click();});
    u.drop.addEventListener('dragover',event=>{event.preventDefault();u.drop.classList.add('dragging');});
    u.drop.addEventListener('dragleave',()=>u.drop.classList.remove('dragging'));
    u.drop.addEventListener('drop',event=>{
      event.preventDefault();u.drop.classList.remove('dragging');
      if(event.dataTransfer?.files?.length)enqueueFiles(event.dataTransfer.files);
    });
    window.addEventListener('beforeunload',stop);
    status('Γράψε τον κωδικό από το iPhone και πάτα «Σύνδεση».');
  });
})();