(function(){
  'use strict';

  var STORAGE_KEY = 'biodiv_observations_v1';

  // Target kompresi: sistem akan mengecilkan foto bertahap (kualitas lalu dimensi)
  // sampai ukurannya di bawah TARGET_KB, supaya aman untuk localStorage.
  var TARGET_KB = 280;
  var START_MAX_DIM = 1600;
  var MIN_QUALITY = 0.4;
  var MIN_DIM = 480;
  var MAX_ATTEMPTS = 7;
  var STORAGE_LIMIT_BYTES = 5 * 1024 * 1024; // perkiraan konservatif kuota localStorage

  var CAT = {
    flora: {label:'Flora', color:'#2f5233'},
    fauna: {label:'Fauna', color:'#a6552c'},
    fungi: {label:'Fungi & Lumut', color:'#6b4a6b'}
  };

  var state = {
    observations: [],
    filter: 'all',
    search: '',
    selectedId: null,
    loaded: false
  };

  var draft = { photo:null, lat:null, lng:null, category:null, foundBy:null };

  var map, markersLayer, modalMap, modalMarker;

  function $(id){ return document.getElementById(id); }

  // ---------------- storage (browser localStorage, works on GitHub Pages / any static host) ----------------
  function loadObservations(){
    try{
      var raw = localStorage.getItem(STORAGE_KEY);
      state.observations = raw ? JSON.parse(raw) : [];
    }catch(e){
      state.observations = [];
    }
    state.observations.sort(function(a,b){ return b.createdAt - a.createdAt; });
    state.loaded = true;
    renderAll();
  }

  function persist(){
    try{
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.observations));
      return true;
    }catch(e){
      console.error('Gagal menyimpan ke localStorage', e);
      return false;
    }
  }

  function saveObservation(obs){
    state.observations.unshift(obs);
    var ok = persist();
    if(!ok){ state.observations.shift(); }
    updateStorageMeter();
    return ok;
  }

  function deleteObservation(id){
    state.observations = state.observations.filter(function(o){ return o.id!==id; });
    persist();
    renderAll();
    updateStorageMeter();
  }

  function estimateUsedBytes(){
    try{
      return new Blob([JSON.stringify(state.observations)]).size;
    }catch(e){
      return JSON.stringify(state.observations).length;
    }
  }

  function formatBytes(bytes){
    if(bytes >= 1024*1024) return (bytes/(1024*1024)).toFixed(2)+' MB';
    return Math.round(bytes/1024)+' KB';
  }

  function updateStorageMeter(){
    var used = estimateUsedBytes();
    var pct = Math.min(100, (used/STORAGE_LIMIT_BYTES)*100);
    var fill = $('storageFill');
    fill.style.width = pct+'%';
    fill.className = 'storage-fill' + (pct>90 ? ' full' : pct>65 ? ' warn' : '');
    $('storageText').textContent = formatBytes(used)+' terpakai (perkiraan)';
  }

  // ---------------- map ----------------
  function initMap(){
    map = L.map('map', {zoomControl:true}).setView([-2.5, 118], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
    markersLayer = L.layerGroup().addTo(map);
  }

  function makeIcon(color){
    return L.divIcon({
      className:'',
      html:'<div class="marker-pin" style="background:'+color+'"></div>',
      iconSize:[26,26],
      iconAnchor:[13,26],
      popupAnchor:[0,-24]
    });
  }

  function renderMarkers(list){
    markersLayer.clearLayers();
    list.forEach(function(o){
      if(o.lat==null || o.lng==null) return;
      var color = CAT[o.category] ? CAT[o.category].color : '#2f5233';
      var marker = L.marker([o.lat, o.lng], {icon: makeIcon(color)});
      var html = '';
      if(o.photo){ html += '<img class="popup-photo" src="'+o.photo+'">'; }
      html += '<div class="popup-title">'+escapeHtml(o.species)+'</div>';
      html += '<div class="popup-meta">'+CAT[o.category].label+' &middot; '+o.date+'</div>';
      if(o.notes){ html += '<div class="popup-meta" style="margin-top:5px;">'+escapeHtml(o.notes)+'</div>'; }
      marker.bindPopup(html);
      marker.on('click', function(){ selectObservation(o.id, false); });
      marker.addTo(markersLayer);
      marker._obsId = o.id;
    });
  }

  function focusObservation(o){
    if(o.lat==null || o.lng==null) return;
    map.flyTo([o.lat,o.lng], Math.max(map.getZoom(), 12), {duration:0.6});
    markersLayer.eachLayer(function(m){
      if(m._obsId === o.id){ m.openPopup(); }
    });
  }

  // ---------------- render ----------------
  function escapeHtml(s){
    return (s||'').replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  function getFiltered(){
    return state.observations.filter(function(o){
      var passCat = state.filter==='all' || o.category===state.filter;
      var passSearch = !state.search || (o.species||'').toLowerCase().indexOf(state.search.toLowerCase())>-1;
      return passCat && passSearch;
    });
  }

  function renderTally(){
    var total = state.observations.length;
    var species = new Set(state.observations.map(function(o){ return (o.species||'').trim().toLowerCase(); })).size;
    var locs = new Set(state.observations.filter(function(o){return o.lat!=null;}).map(function(o){ return o.lat.toFixed(2)+','+o.lng.toFixed(2); })).size;
    $('tally').innerHTML =
      '<div class="tally-item"><div class="tally-num">'+total+'</div><div class="tally-label">observasi</div></div>'+
      '<div class="tally-item"><div class="tally-num">'+species+'</div><div class="tally-label">spesies</div></div>'+
      '<div class="tally-item"><div class="tally-num">'+locs+'</div><div class="tally-label">lokasi</div></div>';
  }

  function renderSidebar(list){
    var sidebar = $('sidebar');
    if(!state.loaded){
      sidebar.innerHTML = '<div class="empty-state"><div class="glyph">&#8230;</div><p>Memuat data observasi...</p></div>';
      return;
    }
    if(list.length===0){
      var msg = state.observations.length===0
        ? 'Belum ada observasi. Jadilah yang pertama mendokumentasikan keanekaragaman hayati di sekitarmu.'
        : 'Tidak ada observasi yang cocok dengan filter atau pencarian ini.';
      sidebar.innerHTML = '<div class="empty-state"><div class="glyph">&#127807;</div><p>'+msg+'</p></div>';
      return;
    }
    sidebar.innerHTML = '';
    list.forEach(function(o){
      var card = document.createElement('div');
      card.className = 'card' + (state.selectedId===o.id ? ' selected' : '');
      var catInfo = CAT[o.category] || CAT.flora;
      card.innerHTML =
        (o.photo ? '<img src="'+o.photo+'" alt="'+escapeHtml(o.species)+'">' : '<div style="width:64px;height:64px;border-radius:3px;background:var(--paper-deep);flex-shrink:0;"></div>') +
        '<div class="card-body">'+
          '<h3>'+escapeHtml(o.species)+'</h3>'+
          '<div class="card-meta"><span class="cat-tag" style="background:'+catInfo.color+'">'+catInfo.label+'</span>'+o.date+'</div>'+
          (o.notes ? '<div class="card-notes">'+escapeHtml(o.notes)+'</div>' : '') +
          (o.lat!=null ? '<div class="card-meta">'+o.lat.toFixed(4)+', '+o.lng.toFixed(4)+'</div>' : '<div class="card-meta">Lokasi tidak tercatat</div>') +
          '<div class="card-actions"><button class="del-btn" data-id="'+o.id+'">Hapus</button></div>'+
        '</div>';
      card.addEventListener('click', function(e){
        if(e.target.classList.contains('del-btn')) return;
        selectObservation(o.id, true);
      });
      sidebar.appendChild(card);
    });
    sidebar.querySelectorAll('.del-btn').forEach(function(btn){
      btn.addEventListener('click', function(e){
        e.stopPropagation();
        if(confirm('Hapus observasi ini?')){ deleteObservation(btn.dataset.id); }
      });
    });
  }

  function selectObservation(id, panMap){
    state.selectedId = id;
    var o = state.observations.find(function(x){ return x.id===id; });
    renderSidebar(getFiltered());
    if(o && panMap) focusObservation(o);
  }

  function renderAll(){
    renderTally();
    var list = getFiltered();
    renderSidebar(list);
    renderMarkers(list);
  }

  // ---------------- filters ----------------
  document.querySelectorAll('.chip').forEach(function(chip){
    chip.addEventListener('click', function(){
      document.querySelectorAll('.chip').forEach(function(c){ c.classList.remove('active'); });
      chip.classList.add('active');
      state.filter = chip.dataset.filter;
      renderAll();
    });
  });
  $('searchInput').addEventListener('input', function(e){
    state.search = e.target.value;
    renderAll();
  });

  // ---------------- modal / add flow ----------------
  var overlay = $('overlay');

  function resetDraft(){
    draft = { photo:null, lat:null, lng:null, category:null, foundBy:null };
    $('previewWrap').style.display='none';
    $('dropzone').style.display='block';
    $('locStatus').className='loc-status';
    $('locStatus').textContent='Belum ada foto diunggah.';
    $('modal-map').style.display='none';
    $('useGeoBtn').style.display='none';
    $('speciesInput').value='';
    $('notesInput').value='';
    $('dateInput').value = new Date().toISOString().slice(0,10);
    document.querySelectorAll('.cat-btn').forEach(function(b){ b.classList.remove('active'); b.style.background=''; b.style.color=''; });
    updateSaveState();
    if(modalMarker){ modalMap.removeLayer(modalMarker); modalMarker=null; }
  }

  function openModal(){
    resetDraft();
    overlay.classList.add('open');
  }
  function closeModal(){
    overlay.classList.remove('open');
  }
  $('openModalBtn').addEventListener('click', openModal);
  $('closeModalBtn').addEventListener('click', closeModal);
  $('cancelBtn').addEventListener('click', closeModal);
  overlay.addEventListener('click', function(e){ if(e.target===overlay) closeModal(); });

  $('dropzone').addEventListener('click', function(){ $('fileInput').click(); });
  $('fileInput').addEventListener('change', function(e){
    var file = e.target.files[0];
    if(file) handleFile(file);
    e.target.value = ''; // supaya file yang sama bisa dipilih ulang jika perlu
  });

  ['dragover','dragenter'].forEach(function(evt){
    $('dropzone').addEventListener(evt, function(e){
      e.preventDefault(); e.stopPropagation();
      $('dropzone').style.background = 'var(--paper-deep)';
    });
  });
  ['dragleave','drop'].forEach(function(evt){
    $('dropzone').addEventListener(evt, function(e){
      e.preventDefault(); e.stopPropagation();
      $('dropzone').style.background = '';
    });
  });
  $('dropzone').addEventListener('drop', function(e){
    var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if(file) handleFile(file);
  });

  function handleFile(file){
    if(!file.type || file.type.indexOf('image/') !== 0){
      $('locStatus').className = 'loc-status';
      $('locStatus').textContent = 'File ini bukan gambar. Pilih file .jpg, .png, atau .webp.';
      return;
    }

    $('locStatus').textContent = 'Membaca foto...';
    $('locStatus').className = 'loc-status';
    $('compressInfo').style.display = 'none';
    $('saveBtn').disabled = true;

    // EXIF GPS extraction (dari file asli, sebelum dikompres)
    try{
      EXIF.getData(file, function(){
        var lat = EXIF.getTag(this, 'GPSLatitude');
        var lon = EXIF.getTag(this, 'GPSLongitude');
        var latRef = EXIF.getTag(this, 'GPSLatitudeRef');
        var lonRef = EXIF.getTag(this, 'GPSLongitudeRef');
        if(lat && lon){
          var latDec = dmsToDecimal(lat, latRef);
          var lonDec = dmsToDecimal(lon, lonRef);
          draft.lat = latDec; draft.lng = lonDec; draft.foundBy='exif';
          showLocationFound('Lokasi ditemukan otomatis dari data EXIF foto.', latDec, lonDec);
        } else {
          showNoLocation();
        }
      });
    }catch(err){
      showNoLocation();
    }

    // Kompresi otomatis & adaptif, lalu tampilkan pratinjau
    compressImage(file).then(function(result){
      draft.photo = result.dataUrl;
      $('previewImg').src = result.dataUrl;
      $('previewWrap').style.display='block';
      $('dropzone').style.display='none';

      var savedPct = result.originalKB > 0
        ? Math.max(0, Math.round((1 - (result.finalKB/result.originalKB))*100))
        : 0;
      var info = $('compressInfo');
      info.style.display = 'block';
      info.textContent = 'Ukuran asli ' + formatKB(result.originalKB) + ' \u2192 dikompres jadi ' +
        formatKB(result.finalKB) + ' (' + savedPct + '% lebih kecil, kualitas ' +
        Math.round(result.quality*100) + '%).';

      updateSaveState();
    }).catch(function(){
      $('locStatus').className = 'loc-status';
      $('locStatus').textContent = 'Gagal memproses foto ini. Coba file lain.';
    });
  }

  function dmsToDecimal(dms, ref){
    var d = dms[0], m = dms[1], s = dms[2];
    var dec = d + m/60 + s/3600;
    if(ref === 'S' || ref === 'W') dec = -dec;
    return dec;
  }

  function formatKB(kb){
    if(kb >= 1024) return (kb/1024).toFixed(2)+' MB';
    return Math.round(kb)+' KB';
  }

  function dataUrlSizeKB(dataUrl){
    var base64 = dataUrl.split(',')[1] || '';
    return (base64.length * 0.75) / 1024;
  }

  function loadImageFromFile(file){
    return new Promise(function(resolve, reject){
      var reader = new FileReader();
      reader.onload = function(e){
        var img = new Image();
        img.onload = function(){ resolve(img); };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function drawResized(img, maxDim, quality){
    var w = img.width, h = img.height;
    if(w > h && w > maxDim){ h = Math.round(h*maxDim/w); w = maxDim; }
    else if(h >= w && h > maxDim){ w = Math.round(w*maxDim/h); h = maxDim; }
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', quality);
  }

  // Kompresi bertahap: turunkan kualitas dulu, lalu dimensi, sampai di bawah TARGET_KB
  // atau sampai batas percobaan/dimensi minimum tercapai.
  function compressImage(file){
    return loadImageFromFile(file).then(function(img){
      var maxDim = START_MAX_DIM;
      var quality = 0.82;
      var dataUrl = drawResized(img, maxDim, quality);
      var kb = dataUrlSizeKB(dataUrl);
      var attempts = 0;

      while(kb > TARGET_KB && attempts < MAX_ATTEMPTS){
        if(quality > MIN_QUALITY){
          quality = Math.max(MIN_QUALITY, quality - 0.12);
        } else if(maxDim > MIN_DIM){
          maxDim = Math.max(MIN_DIM, Math.round(maxDim * 0.82));
        } else {
          break; // sudah di titik minimum, terima hasil apa adanya
        }
        dataUrl = drawResized(img, maxDim, quality);
        kb = dataUrlSizeKB(dataUrl);
        attempts++;
      }

      return {
        dataUrl: dataUrl,
        finalKB: kb,
        quality: quality,
        maxDim: maxDim,
        originalKB: file.size / 1024
      };
    });
  }

  function ensureModalMap(){
    if(modalMap) return;
    $('modal-map').style.display='block';
    modalMap = L.map('modal-map', {zoomControl:false}).setView([-2.5,118], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:''}).addTo(modalMap);
    modalMap.on('click', function(e){
      setModalMarker(e.latlng.lat, e.latlng.lng);
      draft.lat = e.latlng.lat; draft.lng = e.latlng.lng; draft.foundBy='manual';
      showLocationFound('Lokasi dipilih manual di peta.', draft.lat, draft.lng, true);
    });
    setTimeout(function(){ modalMap.invalidateSize(); }, 200);
  }

  function setModalMarker(lat,lng){
    if(modalMarker){ modalMarker.setLatLng([lat,lng]); }
    else{
      modalMarker = L.marker([lat,lng], {draggable:true}).addTo(modalMap);
      modalMarker.on('dragend', function(){
        var p = modalMarker.getLatLng();
        draft.lat = p.lat; draft.lng = p.lng; draft.foundBy='manual';
        showLocationFound('Lokasi disesuaikan manual di peta.', p.lat, p.lng, true);
      });
    }
    modalMap.setView([lat,lng], 13);
  }

  function showLocationFound(msg, lat, lng, skipMapCenter){
    $('locStatus').className = 'loc-status found';
    $('locStatus').textContent = msg + ' ('+lat.toFixed(5)+', '+lng.toFixed(5)+')';
    ensureModalMap();
    if(!skipMapCenter) setModalMarker(lat,lng);
    else if(!modalMarker) setModalMarker(lat,lng);
    $('useGeoBtn').style.display='inline-block';
    updateSaveState();
  }

  function showNoLocation(){
    $('locStatus').className = 'loc-status';
    $('locStatus').textContent = 'Lokasi tidak terdeteksi dari foto. Klik pada peta di bawah untuk menandai lokasinya, atau gunakan lokasi Anda sekarang.';
    ensureModalMap();
    $('useGeoBtn').style.display='inline-block';
    updateSaveState();
  }

  $('useGeoBtn').addEventListener('click', function(){
    if(!navigator.geolocation){ alert('Geolocation tidak didukung di perangkat ini.'); return; }
    $('locStatus').textContent = 'Mengambil lokasi Anda...';
    navigator.geolocation.getCurrentPosition(function(pos){
      draft.lat = pos.coords.latitude; draft.lng = pos.coords.longitude; draft.foundBy='geo';
      showLocationFound('Menggunakan lokasi Anda saat ini.', draft.lat, draft.lng);
    }, function(){
      $('locStatus').textContent = 'Gagal mengambil lokasi. Silakan klik pada peta secara manual.';
    });
  });

  document.querySelectorAll('.cat-btn').forEach(function(btn){
    btn.addEventListener('click', function(){
      document.querySelectorAll('.cat-btn').forEach(function(b){ b.classList.remove('active'); b.style.background=''; b.style.color=''; });
      btn.classList.add('active');
      btn.style.background = CAT[btn.dataset.cat].color;
      draft.category = btn.dataset.cat;
      updateSaveState();
    });
  });

  $('speciesInput').addEventListener('input', updateSaveState);

  function updateSaveState(){
    var ok = draft.photo && draft.category && $('speciesInput').value.trim().length>0;
    $('saveBtn').disabled = !ok;
  }

  $('saveBtn').addEventListener('click', function(){
    var obs = {
      id: 'obs_' + Date.now() + '_' + Math.random().toString(36).slice(2,8),
      species: $('speciesInput').value.trim(),
      category: draft.category,
      notes: $('notesInput').value.trim(),
      date: $('dateInput').value || new Date().toISOString().slice(0,10),
      lat: draft.lat, lng: draft.lng,
      photo: draft.photo,
      createdAt: Date.now()
    };
    var projected = estimateUsedBytes() + JSON.stringify(obs).length;
    if(projected > STORAGE_LIMIT_BYTES * 0.95){
      var lanjut = confirm('Penyimpanan lokal browser hampir penuh. Observasi ini mungkin gagal tersimpan.\n\nHapus beberapa observasi lama dulu, atau tetap coba simpan sekarang?');
      if(!lanjut) return;
    }

    $('saveBtn').disabled = true;
    $('saveBtn').textContent = 'Menyimpan...';

    var ok = saveObservation(obs);
    $('saveBtn').textContent = 'Simpan Observasi';

    if(ok){
      closeModal();
      renderAll();
      if(obs.lat!=null){ focusObservation(obs); }
    } else {
      alert('Gagal menyimpan observasi. Penyimpanan browser mungkin penuh — coba hapus beberapa observasi lama atau gunakan foto yang lebih kecil.');
      updateSaveState();
    }
  });

  // ---------------- init ----------------
  $('dateInput').value = new Date().toISOString().slice(0,10);
  initMap();
  loadObservations();
  updateStorageMeter();

})();
