/* Spotify links play through Spotify's official online Embed.
   Spotify audio is never downloaded, cached or stored by DriveTunes. */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const panel = $('spotifyPanel');
  if (!panel) return;
  const toggle = $('spotifyToggle');
  const form = $('spotifyForm');
  const input = $('spotifyUrl');
  const list = $('spotifyList');
  const stage = $('spotifyPlayer');
  const status = $('spotifyStatus');
  const offlineImport = $('spotifyOfflineImport');
  const DB_NAME = 'drivetunes-spotify-links-v1';
  const titleFor = kind => kind === 'playlist' ? 'Playlist Spotify' : 'Τραγούδι Spotify';
  let dbPromise = null;
  let items = [];
  let activeKey = null;

  function parseSpotifyLink(raw) {
    const text = String(raw || '').trim();
    let kind, id;
    const uri = /^spotify:(track|playlist):([A-Za-z0-9]{22})$/i.exec(text);
    if (uri) {
      kind = uri[1].toLowerCase();
      id = uri[2];
    } else {
      let url;
      try { url = new URL(text); } catch (_) { return null; }
      if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'open.spotify.com') return null;
      const segments = url.pathname.split('/').filter(Boolean);
      if (/^intl-[a-z]{2}$/i.test(segments[0] || '')) segments.shift();
      if (segments.length !== 2 || !['track', 'playlist'].includes(segments[0]) || !/^[A-Za-z0-9]{22}$/.test(segments[1])) return null;
      [kind, id] = segments;
    }
    return {key: kind + ':' + id, kind, id, url: 'https://open.spotify.com/' + kind + '/' + id};
  }

  function request(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Δεν ολοκληρώθηκε η αποθήκευση.'));
    });
  }
  function openDB() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('Η συσκευή δεν υποστηρίζει IndexedDB.'));
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore('links', {keyPath: 'key'});
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => db.close();
          resolve(db);
        };
        req.onerror = () => reject(req.error || new Error('Δεν ανοίγει η συλλογή Spotify.'));
        req.onblocked = () => reject(new Error('Κλείσε άλλες καρτέλες και ξαναδοκίμασε.'));
      }).catch(err => { dbPromise = null; throw err; });
    }
    return dbPromise;
  }
  async function getAll() {
    const db = await openDB();
    return request(db.transaction('links', 'readonly').objectStore('links').getAll());
  }
  async function put(entry) {
    const db = await openDB();
    return request(db.transaction('links', 'readwrite').objectStore('links').put(entry));
  }
  async function remove(key) {
    const db = await openDB();
    return request(db.transaction('links', 'readwrite').objectStore('links').delete(key));
  }
  function say(message, error = false) {
    status.textContent = message;
    status.classList.toggle('error', error);
  }
  function stopEmbed() {
    activeKey = null;
    stage.replaceChildren();
    stage.hidden = true;
  }
  function play(entry) {
    if (!navigator.onLine) { say('Για αναπαραγωγή Spotify χρειάζεται internet.', true); return; }
    if (activeKey === entry.key) { stopEmbed(); render(); return; }
    $('audio')?.pause();
    activeKey = entry.key;
    stage.replaceChildren();
    const caption = document.createElement('p');
    caption.textContent = 'Spotify · online αναπαραγωγή (δεν αποθηκεύεται offline)';
    const iframe = document.createElement('iframe');
    iframe.title = titleFor(entry.kind);
    iframe.src = 'https://open.spotify.com/embed/' + entry.kind + '/' + entry.id;
    iframe.width = '100%';
    iframe.height = entry.kind === 'playlist' ? '380' : '152';
    iframe.loading = 'lazy';
    iframe.allow = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';
    iframe.setAttribute('allowfullscreen', '');
    stage.append(caption, iframe);
    stage.hidden = false;
    say('Η αναπαραγωγή εξαρτάται από το Spotify και τη σύνδεσή σου.');
    render();
  }

  function render() {
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'spotify-help';
      empty.textContent = 'Δεν έχεις αποθηκεύσει ακόμη Spotify links.';
      list.append(empty);
      return;
    }
    for (const entry of items) {
      const row = document.createElement('div');
      row.className = 'spotify-row';
      const details = document.createElement('div');
      details.className = 'spotify-details';
      const title = document.createElement('strong');
      title.textContent = titleFor(entry.kind);
      const label = document.createElement('span');
      label.textContent = entry.kind === 'playlist' ? 'Playlist · online' : 'Τραγούδι · online';
      details.append(title, label);

      const actions = document.createElement('div');
      actions.className = 'spotify-actions';
      const playButton = document.createElement('button');
      playButton.type = 'button';
      playButton.textContent = activeKey === entry.key ? 'Κλείσιμο' : '▶ Παίξε';
      playButton.setAttribute('aria-label', (activeKey === entry.key ? 'Κλείσιμο ' : 'Αναπαραγωγή ') + titleFor(entry.kind));
      playButton.addEventListener('click', () => play(entry));
      const spotifyLink = document.createElement('a');
      spotifyLink.href = entry.url;
      spotifyLink.target = '_blank';
      spotifyLink.rel = 'noopener noreferrer';
      spotifyLink.textContent = 'Spotify';
      spotifyLink.setAttribute('aria-label', 'Άνοιγμα στο Spotify');
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'spotify-delete';
      del.textContent = '×';
      del.setAttribute('aria-label', 'Διαγραφή συνδέσμου Spotify');
      del.addEventListener('click', async () => {
        try {
          await remove(entry.key);
          items = items.filter(item => item.key !== entry.key);
          if (activeKey === entry.key) stopEmbed();
          render();
          say('Ο σύνδεσμος διαγράφηκε.');
        } catch (err) { say(err.message, true); }
      });
      actions.append(playButton, spotifyLink, del);
      row.append(details, actions);
      list.append(row);

      // Only the URL is persisted. Metadata is fetched temporarily while online.
      if (navigator.onLine) {
        fetch('https://open.spotify.com/oembed?url=' + encodeURIComponent(entry.url), {credentials: 'omit', cache: 'no-store'})
          .then(res => { if (!res.ok) throw new Error('Metadata unavailable'); return res.json(); })
          .then(meta => { if (list.contains(row) && typeof meta.title === 'string') title.textContent = meta.title.slice(0, 180); })
          .catch(() => {});
      }
    }
  }

  toggle.addEventListener('click', () => {
    const opening = panel.hidden;
    panel.hidden = !opening;
    toggle.setAttribute('aria-expanded', String(opening));
    if (!opening) stopEmbed();
    if (opening) input.focus();
  });
  $('spotifyClose').addEventListener('click', () => {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    stopEmbed();
  });
  offlineImport.addEventListener('click', () => $('fileInput')?.click());
  $('audio')?.addEventListener('play', () => { if (activeKey) { stopEmbed(); render(); } });
  window.addEventListener('offline', () => {
    if (activeKey) stopEmbed();
    say('Χωρίς internet λειτουργούν μόνο τα τραγούδια που έχεις προσθέσει ως αρχεία.');
    render();
  });
  window.addEventListener('online', render);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const entry = parseSpotifyLink(input.value);
    if (!entry) {
      say('Βάλε κανονικό link open.spotify.com/track/... ή /playlist/...', true);
      return;
    }
    if (items.some(item => item.key === entry.key)) {
      say('Αυτός ο σύνδεσμος υπάρχει ήδη στη συλλογή σου.');
      return;
    }
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await put(entry);
      items.unshift(entry);
      input.value = '';
      render();
      say('Ο σύνδεσμος προστέθηκε. Για αναπαραγωγή απαιτείται internet.');
    } catch (err) {
      say(err.message || 'Αποτυχία αποθήκευσης.', true);
    } finally { submit.disabled = false; }
  });

  getAll().then(saved => {
    items = saved.filter(item => parseSpotifyLink(item.url)?.key === item.key);
    render();
  }).catch(err => say(err.message, true));
})();
