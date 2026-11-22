/* DriveTunes wireless import receiver — saves uploaded songs in existing IndexedDB. */
(() => {
  'use strict';
  document.addEventListener('DOMContentLoaded',()=>{
    const B=window.DriveTunesBridge,api=window.DriveTunesImportApi;
    const $=id=>document.getElementById(id);
    const ui={
      toggle:$('pcTransferToggle'),panel:$('pcTransferPanel'),server:$('pcTransferServer'),
      start:$('pcTransferStart'),close:$('pcTransferClose'),pairing:$('pcPairing'),
      code:$('pcPairCode'),pcUrl:$('pcSenderUrl'),copy:$('pcCopyLink'),
      status:$('pcTransferStatus'),progress:$('pcReceiveProgress'),name:$('pcReceiveName'),
      instructions:$('pcSetupHint')
    };
    if(!B||!api||Object.values(ui).some(x=>!x))return;
    let bridge=null,dc=null,incoming=null,code='',server='',link='',receivedCount=0;
    function status(value,error=false){
      ui.status.textContent=value;
      ui.status.classList.toggle('error',error);
    }
    function closeConnection(){
      if(bridge){bridge.stop();bridge=null;}
      if(dc){try{dc.close();}catch{}dc=null;}
      incoming=null;ui.progress.hidden=true;
    }
    function showPanel(){
      ui.panel.hidden=false;ui.toggle.setAttribute('aria-expanded','true');
      ui.server.value=B.savedServer();
      ui.instructions.hidden=!!ui.server.value;
      if(ui.server.value&&!bridge)begin();
      else if(!ui.server.value)status('Βάλε μία φορά τη διεύθυνση του DataTransfer και πάτα «Έναρξη».');
    }
    function hidePanel(){
      closeConnection();
      ui.panel.hidden=true;ui.toggle.setAttribute('aria-expanded','false');
      ui.pairing.hidden=true;ui.code.textContent='—';code='';
      status('');
    }
    function begin(){
      try{
        server=B.normalizeServer(ui.server.value);
        B.saveServer(server);
        closeConnection();
        code=B.randomCode();receivedCount=0;
        link=B.pairingUrl(server,code);
        ui.code.textContent=code;
        ui.pcUrl.textContent=new URL('./pc-transfer.html',location.href).href;
        ui.pairing.hidden=false;ui.instructions.hidden=true;
        bridge=B.pair({
          role:'receiver',room:code,server,
          onStatus:message=>status(message),
          onChannel:channel=>{
            dc=channel;
            status('Συνδέθηκε ο υπολογιστής. Περιμένω αρχεία…');
            channel.addEventListener('message',onData);
            channel.addEventListener('close',()=>{
              dc=null;incoming=null;ui.progress.hidden=true;
            });
          }
        });
      }catch(error){
        ui.pairing.hidden=true;
        status(error.message,true);
      }
    }
    function reply(message){
      if(dc?.readyState==='open')dc.send(JSON.stringify(message));
    }
    function abort(reason){
      incoming=null;ui.progress.hidden=true;
      status(reason,true);reply({type:'error',message:reason});
    }
    async function onData(event){
      if(typeof event.data==='string'){
        let m;
        try{m=JSON.parse(event.data);}catch{abort('Μη έγκυρο μήνυμα μεταφοράς.');return;}
        if(m.type==='file'){
          if(incoming){abort('Προηγούμενη μεταφορά δεν ολοκληρώθηκε.');return;}
          const name=String(m.name||'').split(/[\\/]/).pop().slice(0,200);
          const size=Number(m.size);
          if(!name||!Number.isSafeInteger(size)||size<=0||size>B.FILE_LIMIT||!B.MUSIC.test(name)){
            abort('Μη υποστηριζόμενο ή πολύ μεγάλο αρχείο (μέχρι 120 MB ανά τραγούδι).');
            return;
          }
          incoming={name,size,mime:String(m.mime||'').slice(0,100),lastModified:Number(m.lastModified)||Date.now(),received:0,chunks:[]};
          ui.name.textContent='Λήψη: '+name;
          ui.progress.value=0;ui.progress.hidden=false;
          status('Μεταφορά σε εξέλιξη…');
          reply({type:'ready'});
        }else if(m.type==='done'){
          const file=incoming;
          if(!file||file.received!==file.size){abort('Το αρχείο έφτασε ελλιπές. Δοκίμασε ξανά.');return;}
          incoming=null;
          ui.name.textContent='Αποθήκευση: '+file.name;
          status('Αποθήκευση στο iPhone…');
          try{
            const audioFile=new File(file.chunks,file.name,{
              type:file.mime,lastModified:file.lastModified
            });
            const result=await api.addFile(audioFile);
            await api.loadAllTracks();
            receivedCount+=result==='added'?1:0;
            ui.progress.hidden=true;
            status(result==='duplicate'
              ?'Το «'+file.name+'» υπάρχει ήδη. Περιμένω το επόμενο.'
              :'Αποθηκεύτηκε: '+file.name+' · '+receivedCount+' νέα τραγούδια.');
            reply({type:'saved',result});
          }catch(error){
            abort('Δεν αποθηκεύτηκε το «'+file.name+'»: '+(error?.message||'Έλεγξε τον ελεύθερο χώρο.'));
          }
        }
        return;
      }
      const file=incoming;
      if(!file)return;
      try{
        const bytes=event.data instanceof ArrayBuffer?event.data:
          (event.data instanceof Blob?await event.data.arrayBuffer():null);
        if(!bytes||file.received+bytes.byteLength>file.size){abort('Λανθασμένο μέγεθος αρχείου.');return;}
        file.chunks.push(bytes);
        file.received+=bytes.byteLength;
        ui.progress.value=Math.round(file.received/file.size*100);
      }catch{abort('Η μεταφορά διακόπηκε.');}
    }
    ui.toggle.addEventListener('click',()=>ui.panel.hidden?showPanel():hidePanel());
    ui.close.addEventListener('click',hidePanel);
    ui.start.addEventListener('click',begin);
    ui.copy.addEventListener('click',async()=>{
      try{
        await navigator.clipboard.writeText(link);
        status('Ο πλήρης σύνδεσμος αντιγράφηκε. Άνοιξέ τον στον υπολογιστή.');
      }catch{
        status('Η αντιγραφή μπλοκαρίστηκε. Χρησιμοποίησε τη διεύθυνση PC και τον κωδικό.',true);
      }
    });
    window.addEventListener('pagehide',closeConnection);
  });
})();