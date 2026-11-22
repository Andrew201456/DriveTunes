/* DriveTunes PC transfer: WebRTC file channel.
   Signaling reuses the user's deployed DataTransfer WebSocket Worker.
   The Worker exchanges SDP/ICE only; music bytes never go through it. */
(() => {
  'use strict';
  const ICE={iceServers:[
    {urls:'stun:stun.cloudflare.com:3478'},
    {urls:'stun:stun.l.google.com:19302'}
  ]};
  const ABC='23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const FILE_LIMIT=120*1024*1024; // keep peak memory reasonable on iOS
  const CHUNK=16*1024;
  const MAX_BUFFER=1024*1024;
  const MUSIC=/\.(mp3|m4a|aac|wav|flac|ogg|opus|aif|aiff)$/i;
  const STORE='drivetunes-transfer-server-v1';
  function randomCode(){
    const bytes=crypto.getRandomValues(new Uint8Array(10));
    return Array.from(bytes,x=>ABC[x%ABC.length]).join('');
  }
  function normalizeCode(value){
    const code=String(value||'').trim().replace(/[\s-]/g,'').toUpperCase();
    if(!/^[2-9A-HJ-NP-Z]{10}$/.test(code))throw new Error('Ο κωδικός πρέπει να έχει 10 γράμματα/αριθμούς.');
    return code;
  }
  function normalizeServer(value){
    let url;
    try{url=new URL(String(value||'').trim());}
    catch{throw new Error('Βάλε την πλήρη HTTPS διεύθυνση του DataTransfer.');}
    if(url.protocol!=='https:'||!url.hostname||url.username||url.password)throw new Error('Χρειάζεται ασφαλής HTTPS διεύθυνση DataTransfer.');
    if(url.pathname!=='/'&&url.pathname!=='')throw new Error('Βάλε την αρχική διεύθυνση του DataTransfer, χωρίς /ws.');
    return url.origin;
  }
  function savedServer(){
    try{return localStorage.getItem(STORE)||'';}catch{return '';}
  }
  function saveServer(server){
    try{localStorage.setItem(STORE,server);}catch{}
  }
  function pairingUrl(server,room){
    const url=new URL('http://127.0.0.1:8765/');
    url.hash=new URLSearchParams({room,server}).toString();
    return url.href;
  }
  // Called once by a receiver or a sender. Sender initiates WebRTC; receiver answers.
  function pair({role,server,room,onStatus=()=>{},onChannel=()=>{}}){
    const origin=normalizeServer(server),code=normalizeCode(room);
    if(!['receiver','sender'].includes(role))throw new Error('Invalid role');
    if(!('RTCPeerConnection' in window)||!('WebSocket' in window))throw new Error('Ο browser δεν υποστηρίζει WebRTC.');
    const id=Array.from(crypto.getRandomValues(new Uint8Array(12)),x=>x.toString(16).padStart(2,'0')).join('');
    const peerType=role==='receiver'?'DT-Receiver':'DT-Sender';
    const expected=role==='receiver'?'DT-Sender':'DT-Receiver';
    const endpoint=new URL('/ws',origin);
    endpoint.protocol='wss:';
    endpoint.searchParams.set('room','dt-'+code.toLowerCase());
    let socket=null,pc=null,channel=null,peerId=null,closed=false,pingTimer=null;
    let pendingCandidates=[],signalSerial=0;
    const status=s=>{if(!closed)onStatus(s);};
    function send(message){if(!closed&&socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(message));}
    function signal(data){if(peerId)send({type:'signal',to:peerId,data});}
    function cleanupPeer(){
      signalSerial++;
      if(channel){try{channel.close();}catch{}channel=null;}
      if(pc){try{pc.close();}catch{}pc=null;}
      peerId=null;pendingCandidates=[];
    }
    function attachChannel(dc){
      channel=dc;dc.binaryType='arraybuffer';dc.bufferedAmountLowThreshold=256*1024;
      dc.addEventListener('open',()=>{status('Οι συσκευές συνδέθηκαν.');onChannel(dc);});
      dc.addEventListener('close',()=>{if(!closed)status('Η σύνδεση έκλεισε. Ξεκίνα νέα μεταφορά.');});
      dc.addEventListener('error',()=>{status('Σφάλμα μεταφοράς.');});
    }
    function makePc(id){
      cleanupPeer();
      peerId=id;
      pc=new RTCPeerConnection(ICE);
      const current=pc,serial=signalSerial;
      pc.onicecandidate=event=>{if(event.candidate&&pc===current&&serial===signalSerial)signal({ice:event.candidate.toJSON?.()||event.candidate});};
      pc.onconnectionstatechange=()=>{
        if(pc!==current)return;
        if(current.connectionState==='failed')status('Δεν συνδέθηκαν απευθείας οι συσκευές. Έλεγξε το Wi-Fi και το router.');
        if(current.connectionState==='disconnected')status('Η σύνδεση διακόπηκε. Κράτησε ανοιχτές τις δύο σελίδες.');
      };
      if(role==='receiver')pc.ondatachannel=event=>attachChannel(event.channel);
      if(role==='sender')attachChannel(pc.createDataChannel('music',{ordered:true}));
      return current;
    }
    async function signalMessage(from,data){
      if(closed||!data||typeof data!=='object')return;
      if(role==='receiver'&&data.sdp?.type==='offer'){
        const active=makePc(from),serial=signalSerial;
        await active.setRemoteDescription(data.sdp);
        if(closed||pc!==active||serial!==signalSerial)return;
        await active.setLocalDescription(await active.createAnswer());
        signal({sdp:active.localDescription});
        for(const c of pendingCandidates.splice(0))await active.addIceCandidate(c);
      }else if(role==='sender'&&from===peerId&&pc&&data.sdp?.type==='answer'){
        const active=pc;
        await active.setRemoteDescription(data.sdp);
        for(const c of pendingCandidates.splice(0))await active.addIceCandidate(c);
      }else if(data.ice&&from===peerId){
        if(pc?.remoteDescription)await pc.addIceCandidate(data.ice);
        else pendingCandidates.push(data.ice);
      }
    }
    async function offer(id){
      if(closed||pc||role!=='sender')return;
      const active=makePc(id);
      try{
        await active.setLocalDescription(await active.createOffer());
        if(pc===active)signal({sdp:active.localDescription});
      }catch(error){status('Δεν ξεκίνησε η σύνδεση WebRTC: '+error.message);cleanupPeer();}
    }
    try{
      socket=new WebSocket(endpoint.href);
      status('Σύνδεση με τον μηχανισμό μεταφοράς…');
      socket.addEventListener('open',()=>{
        send({type:'hello',id,name:peerType});
        // Keep the DataTransfer signaling WebSocket alive while the other device joins.
        pingTimer=setInterval(()=>{if(socket?.readyState===WebSocket.OPEN)socket.send('ping');},25000);
        status(role==='receiver'?'Περιμένω τον υπολογιστή…':'Αναζήτηση iPhone…');
      });
      socket.addEventListener('message',event=>{
        let m;try{m=JSON.parse(event.data);}catch{return;}
        if(m.type==='peers'){
          if(role==='sender'){
            const receiver=Array.isArray(m.peers)?m.peers.find(p=>p.name===expected):null;
            if(receiver&&receiver.id!==peerId)offer(receiver.id);
          }
        }else if(m.type==='signal'){
          signalMessage(m.from,m.data).catch(e=>status('Σφάλμα σύνδεσης: '+e.message));
        }
      });
      socket.addEventListener('error',()=>status('Δεν συνδέθηκε το DataTransfer. Έλεγξε τη διεύθυνση.'));
      socket.addEventListener('close',()=>{if(pingTimer){clearInterval(pingTimer);pingTimer=null;}if(!closed)status('Η υπηρεσία σύνδεσης έκλεισε. Δοκίμασε ξανά.');});
    }catch(error){cleanupPeer();throw error;}
    return {
      stop(){closed=true;if(pingTimer){clearInterval(pingTimer);pingTimer=null;}cleanupPeer();if(socket){try{socket.close();}catch{}socket=null;}},
      get connected(){return channel?.readyState==='open';}
    };
  }
  window.DriveTunesBridge={pair,randomCode,normalizeCode,normalizeServer,savedServer,saveServer,pairingUrl,FILE_LIMIT,CHUNK,MAX_BUFFER,MUSIC};
})();