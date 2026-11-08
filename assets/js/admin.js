/* Админка: вход, редактирование содержимого, загрузка фото и видео, сохранение. */
(function () {
  'use strict';

  var S = window.Site;
  var CFG = S.config;
  var MODE = S.mode();
  var MAX_SIDE = 1800;
  var MAX_VIDEO_MB = 50;

  var state = { data: null, saved: '', current: 'hero', defaults: null, previews: {} };

  /* ---------- мелкие помощники ---------- */

  function $(id) { return document.getElementById(id); }

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'text') el.textContent = v;
      else if (k === 'className') el.className = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    (children || []).forEach(function (c) { if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }

  var toastTimer;
  function toast(text, isError) {
    var t = $('toast');
    t.textContent = text;
    t.className = 'toast' + (isError ? ' err' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, isError ? 6000 : 3000);
  }

  function isDirty() { return state.data && JSON.stringify(state.data) !== state.saved; }

  function markDirty() {
    var st = $('status');
    if (isDirty()) { st.textContent = 'Есть несохранённые правки'; st.className = 'status dirty'; }
    else { st.textContent = 'Всё сохранено'; st.className = 'status'; }
  }

  // Адрес для превью: только что загруженные в GitHub файлы ещё не опубликованы
  function previewSrc(src) { return state.previews[src] || S.safeMediaUrl(src); }

  function frameImg(media, isVideo) {
    var src = previewSrc(media.src);
    if (!src) return null;
    var el;
    if (isVideo && !media.poster) {
      el = h('video', { muted: true, playsinline: true, preload: 'metadata' });
      el.src = src + '#t=' + (Number(media.start) || 0.5);
    } else {
      el = h('img', { alt: '' });
      el.src = isVideo ? previewSrc(media.poster) : src;
    }
    el.setAttribute('style', S.frameStyle(media.frame));
    return el;
  }

  /* ---------- хранилища ---------- */

  function supabaseClient() {
    if (state.client) return state.client;
    var key = CFG.supabaseKey;
    var opts = {};
    if (/^sb_/.test(key)) {
      // Ключ sb_publishable_ не JWT: не отправляем его в Authorization
      opts.global = {
        fetch: function (input, init) {
          init = init || {};
          var headers = new Headers(init.headers || {});
          if (headers.get('Authorization') === 'Bearer ' + key) headers.delete('Authorization');
          return fetch(input, Object.assign({}, init, { headers: headers }));
        }
      };
    }
    state.client = window.supabase.createClient(CFG.supabaseUrl, key, opts);
    return state.client;
  }

  var backends = {
    supabase: {
      label: 'Supabase',
      start: function () {
        var c = supabaseClient();
        c.auth.onAuthStateChange(function (event) {
          if (event === 'PASSWORD_RECOVERY') showLogin('recovery');
        });
        if (/type=recovery/.test(location.hash)) return Promise.resolve(false);
        return c.auth.getSession().then(function (r) {
          if (!r.data.session) return false;
          return backends.supabase.checkAdmin();
        });
      },
      checkAdmin: function () {
        return supabaseClient().rpc('is_admin').then(function (r) {
          if (r.error) throw r.error;
          return r.data === true;
        });
      },
      signIn: function (email, password) {
        var c = supabaseClient();
        return c.auth.signInWithPassword({ email: email, password: password }).then(function (r) {
          if (r.error) throw new Error('Неверный e-mail или пароль');
          return backends.supabase.checkAdmin().then(function (ok) {
            if (!ok) return c.auth.signOut().then(function () { throw new Error('У этой учётной записи нет прав на управление сайтом'); });
            return true;
          });
        });
      },
      signOut: function () { return supabaseClient().auth.signOut(); },
      resetPassword: function (email) {
        return supabaseClient().auth.resetPasswordForEmail(email, { redirectTo: location.href.split('#')[0] }).then(function (r) {
          if (r.error) throw r.error;
        });
      },
      changePassword: function (pass) {
        return supabaseClient().auth.updateUser({ password: pass }).then(function (r) { if (r.error) throw r.error; });
      },
      load: function () {
        return supabaseClient().from('site_content').select('data').eq('id', 1).maybeSingle().then(function (r) {
          if (r.error) throw r.error;
          return r.data && S.isValidContent(r.data.data) ? r.data.data : null;
        });
      },
      save: function (data) {
        return supabaseClient().from('site_content').upsert({ id: 1, data: data, updated_at: new Date().toISOString() }).then(function (r) {
          if (r.error) throw r.error;
        });
      },
      upload: function (blob, name) {
        var path = 'uploads/' + name;
        var bucket = CFG.bucket || 'media';
        var st = supabaseClient().storage.from(bucket);
        return st.upload(path, blob, { contentType: blob.type || undefined, upsert: false, cacheControl: '31536000' }).then(function (r) {
          if (r.error) throw r.error;
          return st.getPublicUrl(path).data.publicUrl;
        });
      }
    },

    github: {
      label: 'GitHub',
      api: function (path, opts) {
        opts = opts || {};
        var g = CFG.github;
        return fetch('https://api.github.com/repos/' + encodeURIComponent(g.owner) + '/' + encodeURIComponent(g.repo) + path, {
          method: opts.method || 'GET',
          headers: { Authorization: 'Bearer ' + state.token, Accept: 'application/vnd.github+json' },
          body: opts.body ? JSON.stringify(opts.body) : undefined,
          cache: 'no-store'
        }).then(function (r) {
          if (r.status === 401) throw new Error('Токен не подходит');
          if (!r.ok && r.status !== 404) throw new Error('GitHub ответил ошибкой ' + r.status);
          return r.status === 404 ? null : r.json();
        });
      },
      start: function () {
        try { state.token = localStorage.getItem('teacherSite.ghToken') || ''; } catch (e) { state.token = ''; }
        if (!state.token) return Promise.resolve(false);
        return backends.github.check().catch(function () { return false; });
      },
      check: function () {
        return backends.github.api('').then(function (repo) {
          if (!repo) throw new Error('Репозиторий не найден');
          if (!repo.permissions || !repo.permissions.push) throw new Error('У токена нет права записи в репозиторий');
          return true;
        });
      },
      signIn: function (token, remember) {
        state.token = token.trim();
        return backends.github.check().then(function () {
          try { if (remember) localStorage.setItem('teacherSite.ghToken', state.token); } catch (e) { /* без сохранения */ }
          return true;
        });
      },
      signOut: function () {
        try { localStorage.removeItem('teacherSite.ghToken'); } catch (e) { /* ничего */ }
        state.token = '';
        return Promise.resolve();
      },
      branch: function () { return encodeURIComponent(CFG.github.branch || 'main'); },
      load: function () {
        return backends.github.api('/contents/content/default.json?ref=' + backends.github.branch()).then(function (f) {
          if (!f) return null;
          state.ghSha = f.sha;
          var text = decodeURIComponent(escape(atob(f.content.replace(/\n/g, ''))));
          var data = JSON.parse(text);
          return S.isValidContent(data) ? data : null;
        });
      },
      save: function (data) {
        var text = JSON.stringify(data, null, 2) + '\n';
        return backends.github.api('/contents/content/default.json', {
          method: 'PUT',
          body: { message: 'Обновление содержимого сайта', content: btoa(unescape(encodeURIComponent(text))), sha: state.ghSha, branch: CFG.github.branch || 'main' }
        }).then(function (r) { state.ghSha = r.content.sha; });
      },
      upload: function (blob, name) {
        var path = 'assets/uploads/' + name;
        return blobToBase64(blob).then(function (b64) {
          return backends.github.api('/contents/' + path, {
            method: 'PUT', body: { message: 'Загрузка файла ' + name, content: b64, branch: CFG.github.branch || 'main' }
          });
        }).then(function () {
          state.previews[path] = URL.createObjectURL(blob);
          return path;
        });
      }
    },

    demo: {
      label: 'Демо-режим',
      start: function () { return Promise.resolve(true); },
      signOut: function () { return Promise.resolve(); },
      load: function () { return Promise.resolve(S.readDemo()); },
      save: function (data) {
        try { S.writeDemo(data); return Promise.resolve(); }
        catch (e) { return Promise.reject(new Error('В браузере не хватает места. Подключите базу данных (см. README).')); }
      },
      upload: function (blob) {
        if (!/^image\//.test(blob.type)) return Promise.reject(new Error('В демо-режиме можно загружать только фото. Для видео и файлов подключите базу.'));
        return blobToDataUrl(blob);
      }
    }
  };

  var backend = backends[MODE];

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('Не удалось прочитать файл')); };
      fr.readAsDataURL(blob);
    });
  }

  function blobToBase64(blob) {
    return blobToDataUrl(blob).then(function (u) { return u.slice(u.indexOf(',') + 1); });
  }

  /* ---------- загрузка файлов ---------- */

  function fileName(original, ext) {
    var base = String(original || 'file').replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'file';
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6) + '-' + base + '.' + ext;
  }

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var im = new Image();
      im.onload = function () { resolve(im); };
      im.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Этот файл не похож на фото')); };
      im.src = url;
    });
  }

  // Сжатие до ~1800 пикселей по длинной стороне
  function compressImage(file, maxSide) {
    maxSide = maxSide || MAX_SIDE;
    return loadImage(file).then(function (im) {
      var k = Math.min(1, maxSide / Math.max(im.naturalWidth, im.naturalHeight));
      var w = Math.round(im.naturalWidth * k), hh = Math.round(im.naturalHeight * k);
      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = hh;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, hh);
      ctx.drawImage(im, 0, 0, w, hh);
      URL.revokeObjectURL(im.src);
      return new Promise(function (resolve) { canvas.toBlob(function (b) { resolve(b); }, 'image/jpeg', 0.85); });
    });
  }

  function videoPoster(file) {
    return new Promise(function (resolve) {
      var v = document.createElement('video');
      var url = URL.createObjectURL(file);
      var done = false;
      function finish(b) { if (done) return; done = true; URL.revokeObjectURL(url); resolve(b); }
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.onloadeddata = function () { v.currentTime = Math.min(1, (v.duration || 2) / 2); };
      v.onseeked = function () {
        var k = Math.min(1, 1000 / Math.max(v.videoWidth, v.videoHeight));
        var c = document.createElement('canvas');
        c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
        try {
          c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
          c.toBlob(function (b) { finish(b); }, 'image/jpeg', 0.8);
        } catch (e) { finish(null); }
      };
      v.onerror = function () { finish(null); };
      setTimeout(function () { finish(null); }, 8000);
      v.src = url;
    });
  }

  function uploadPhoto(file) {
    if (!/^image\/(jpeg|png|webp|gif|heic|heif)$/i.test(file.type) && !/\.(jpe?g|png|webp|heic)$/i.test(file.name)) {
      return Promise.reject(new Error('Нужен файл фото (JPG, PNG, WebP)'));
    }
    return compressImage(file, MODE === 'demo' ? 1200 : MAX_SIDE).then(function (blob) {
      var name = fileName(file.name, 'jpg');
      return backend.upload(blob, name).then(function (url) {
        if (MODE !== 'demo') state.previews[url] = state.previews[url] || URL.createObjectURL(blob);
        return url;
      });
    });
  }

  function uploadVideo(file) {
    if (file.size > MAX_VIDEO_MB * 1024 * 1024) {
      return Promise.reject(new Error('Видео больше ' + MAX_VIDEO_MB + ' МБ. Сократите или сожмите его перед загрузкой.'));
    }
    if (MODE === 'demo') return Promise.reject(new Error('В демо-режиме видео не сохраняется. Подключите базу (см. README).'));
    var ext = (/\.([a-z0-9]+)$/i.exec(file.name) || [0, 'mp4'])[1].toLowerCase();
    return backend.upload(file, fileName(file.name, ext)).then(function (src) {
      return videoPoster(file).then(function (poster) {
        if (!poster) return { src: src, poster: '' };
        return backend.upload(poster, fileName(file.name + '-poster', 'jpg')).then(function (p) { return { src: src, poster: p }; });
      });
    });
  }

  function uploadAnyFile(file) {
    if (file.size > MAX_VIDEO_MB * 1024 * 1024) return Promise.reject(new Error('Файл больше ' + MAX_VIDEO_MB + ' МБ'));
    var ext = (/\.([a-z0-9]+)$/i.exec(file.name) || [0, 'bin'])[1].toLowerCase();
    return backend.upload(file, fileName(file.name, ext));
  }

  function pickFiles(accept, multiple, cb) {
    var input = h('input', { type: 'file', accept: accept, className: 'file-input', multiple: multiple || null });
    input.addEventListener('change', function () {
      var files = Array.prototype.slice.call(input.files || []);
      input.remove();
      if (files.length) cb(files);
    });
    document.body.appendChild(input);
    input.click();
  }

  /* ---------- кадрирование ---------- */

  function openCrop(media, shape, isVideo, onDone) {
    var modal = $('cropModal'), box = $('cropBox'), zoom = $('cropZoom');
    var f = S.normFrame(media.frame);
    var start = S.clone(f);
    box.className = 'crop-box ' + shape;
    box.innerHTML = '';
    var el = frameImg({ src: media.src, poster: media.poster, frame: f, start: media.start }, isVideo);
    if (!el) return;
    box.appendChild(el);
    zoom.value = f.z;
    function apply() { el.setAttribute('style', S.frameStyle(f)); }
    var drag = null;
    box.onpointerdown = function (e) {
      drag = { x: e.clientX, y: e.clientY, fx: f.x, fy: f.y };
      box.setPointerCapture(e.pointerId);
      box.classList.add('dragging');
    };
    box.onpointermove = function (e) {
      if (!drag) return;
      var r = box.getBoundingClientRect();
      f.x = Math.round(Math.min(100, Math.max(0, drag.fx - (e.clientX - drag.x) / r.width * 100 / f.z * 1.6)) * 10) / 10;
      f.y = Math.round(Math.min(100, Math.max(0, drag.fy - (e.clientY - drag.y) / r.height * 100 / f.z * 1.6)) * 10) / 10;
      apply();
    };
    box.onpointerup = box.onpointercancel = function () { drag = null; box.classList.remove('dragging'); };
    zoom.oninput = function () { f.z = Number(zoom.value); apply(); };
    $('cropReset').onclick = function () { f = { x: 50, y: 50, z: 1 }; zoom.value = 1; apply(); };
    function close() { modal.hidden = true; box.innerHTML = ''; document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') { close(); } }
    $('cropCancel').onclick = function () { f = start; close(); };
    $('cropOk').onclick = function () { close(); onDone(S.normFrame(f)); };
    document.addEventListener('keydown', onKey);
    modal.hidden = false;
    $('cropOk').focus();
  }

  /* ---------- редактор видео: обрезка и обложка ---------- */

  function fmtTime(s) {
    s = Math.max(0, s || 0);
    var m = Math.floor(s / 60);
    var r = s - m * 60;
    return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1);
  }

  function round1(x) { return Math.round(x * 10) / 10; }

  // Видео с другого адреса (Supabase) нужно грузить с CORS, иначе кадр нельзя взять в canvas
  function corsVideo(v, src) {
    if (/^https?:/i.test(src) && src.indexOf(location.origin) !== 0) v.crossOrigin = 'anonymous';
    v.src = src;
  }

  var MIN_CLIP = 0.5;

  // Как в галерее iPhone: лента кадров, жёлтая рамка с ручками начала и конца, просмотр результата, выбор обложки
  function openVideoEditor(m, onDone) {
    var src = previewSrc(m.src);
    if (!src) return;
    var st = { start: Number(m.start) || 0, end: Number(m.end) || 0, dur: 0, posterBlob: null, posterUrl: previewSrc(m.poster) || '', posterTime: m.posterTime,
      vertical: !!m.vertical, vx: m.vx >= 0 ? Number(m.vx) : 50, landscape: false };
    var playing = false, raf = 0;

    var video = h('video', { className: 'vplayer', playsinline: true, preload: 'auto' });
    video.playsInline = true;
    corsVideo(video, src);
    // вертикальное окно 9:16 поверх горизонтального видео; тянется влево и вправо
    var vwin = h('div', { className: 'vwin', 'data-field': 'vertical-window', role: 'slider', tabindex: '0', 'aria-label': 'Положение вертикального кадра' });
    vwin.addEventListener('keydown', function (e) {
      var d = { ArrowLeft: -2, ArrowRight: 2 }[e.key];
      if (!d) return;
      e.preventDefault();
      st.vx = Math.max(0, Math.min(100, st.vx + (e.shiftKey ? d * 5 : d)));
      placeWin();
    });
    var vframe = h('div', { className: 'vframe' }, [video, vwin]);
    var vertCb = h('input', { type: 'checkbox', 'data-field': 'vertical' });
    var vertBox = h('label', { className: 'check vvert' }, [vertCb, h('span', {}, [h('strong', { text: 'Показывать вертикально' }),
      h('small', { className: 'muted', text: ' Для горизонтального видео: на сайте оно откроется вертикально. Перетащите светлое окно на нужную часть кадра.' })])]);
    vertCb.addEventListener('change', function () { st.vertical = vertCb.checked; layout(); });
    function placeWin() {
      if (!(st.vertical && st.landscape)) return;
      var fw = vframe.clientWidth, fh = vframe.clientHeight;
      var ww = Math.min(fw, fh * 9 / 16);
      vwin.style.width = ww + 'px';
      vwin.style.left = ((fw - ww) * st.vx / 100) + 'px';
      vwin.setAttribute('aria-valuenow', Math.round(st.vx));
    }
    var vdrag = null;
    vframe.addEventListener('pointerdown', function (e) {
      if (!(st.vertical && st.landscape)) return;
      e.preventDefault();
      vdrag = { x: e.clientX, vx: st.vx };
      try { vframe.setPointerCapture(e.pointerId); } catch (err) { /* без захвата */ }
    });
    vframe.addEventListener('pointermove', function (e) {
      if (!vdrag) return;
      var fw = vframe.clientWidth, ww = vwin.clientWidth;
      if (fw - ww < 1) return;
      st.vx = Math.max(0, Math.min(100, vdrag.vx + (e.clientX - vdrag.x) / (fw - ww) * 100));
      placeWin();
    });
    vframe.addEventListener('pointerup', function () { vdrag = null; });
    vframe.addEventListener('pointercancel', function () { vdrag = null; });
    window.addEventListener('resize', placeWin);
    var strip = h('canvas', { className: 'vstrip' });
    var shadeL = h('div', { className: 'vshade' });
    var shadeR = h('div', { className: 'vshade' });
    var handleL = h('div', { className: 'vhandle vh-start', role: 'slider', tabindex: '0', 'aria-label': 'Начало видео' });
    var handleR = h('div', { className: 'vhandle vh-end', role: 'slider', tabindex: '0', 'aria-label': 'Конец видео' });
    var sel = h('div', { className: 'vsel' }, [handleL, handleR]);
    var head = h('div', { className: 'vhead' });
    var pmark = h('div', { className: 'vpmark', title: 'Кадр обложки' });
    var tl = h('div', { className: 'vtl', 'data-field': 'video-timeline' }, [strip, shadeL, shadeR, sel, pmark, head]);
    var playBtn = h('button', { type: 'button', className: 'btn primary', 'data-action': 'preview' });
    var muteBtn = h('button', { type: 'button', className: 'btn ghost small' });
    var times = h('div', { className: 'vtimes' });
    var posterImg = h('img', { className: 'vposter-img', alt: 'Обложка видео' });
    var posterEmpty = h('span', { className: 'vposter-empty', text: 'Обложка не выбрана' });
    var shotBtn = h('button', { type: 'button', className: 'btn', text: 'Сделать обложкой этот кадр', 'data-action': 'poster' });
    var okBtn = h('button', { type: 'button', className: 'btn primary', text: 'Готово', 'data-action': 'done' });
    var modal = h('div', { className: 'modal vmodal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Редактор видео' }, [
      h('div', { className: 'modal-card vcard' }, [
        h('h2', { text: 'Видео: обрезка и обложка' }),
        h('div', { className: 'vstage' }, [vframe]),
        tl,
        h('div', { className: 'vrow' }, [playBtn, muteBtn, times]),
        h('p', { className: 'muted vhint', text: 'Тяните жёлтые края ленты, чтобы выбрать начало и конец. Нажмите на ленту, чтобы перейти к кадру.' }),
        vertBox,
        h('div', { className: 'vposter' }, [
          h('div', { className: 'vposter-box' }, [posterImg, posterEmpty]),
          h('div', {}, [h('strong', { text: 'Обложка' }),
            h('p', { className: 'muted', text: 'Этот кадр посетители увидят в галерее до запуска видео. Выберите кадр на ленте и нажмите кнопку.' }), shotBtn])
        ]),
        h('div', { className: 'row-end' }, [
          h('button', { type: 'button', className: 'btn ghost', text: 'Сбросить обрезку', onclick: function () { st.start = 0; st.end = st.dur; seek(0); layout(); } }),
          h('button', { type: 'button', className: 'btn ghost', text: 'Отмена', onclick: close }),
          okBtn
        ])
      ])
    ]);
    document.body.appendChild(modal);
    document.body.classList.add('modal-open');

    function pct(t) { return st.dur ? t / st.dur * 100 : 0; }
    function layout() {
      shadeL.style.cssText = 'left:0;width:' + pct(st.start) + '%';
      shadeR.style.cssText = 'left:' + pct(st.end) + '%;right:0';
      sel.style.cssText = 'left:' + pct(st.start) + '%;width:' + (pct(st.end) - pct(st.start)) + '%';
      handleL.setAttribute('aria-valuenow', round1(st.start)); handleL.setAttribute('aria-valuetext', fmtTime(st.start));
      handleR.setAttribute('aria-valuenow', round1(st.end)); handleR.setAttribute('aria-valuetext', fmtTime(st.end));
      times.textContent = fmtTime(st.start) + ' – ' + fmtTime(st.end) + '  ·  ' + (st.end - st.start).toFixed(1).replace('.', ',') + ' с';
      pmark.hidden = !(st.posterTime >= 0 && st.dur);
      pmark.style.left = pct(st.posterTime || 0) + '%';
      playBtn.textContent = playing ? '❚❚ Пауза' : '▶ Просмотр';
      muteBtn.textContent = video.muted ? 'Звук выкл.' : 'Звук вкл.';
      vertBox.hidden = !st.landscape;
      vertCb.checked = st.vertical;
      vframe.classList.toggle('is-vertical', st.vertical && st.landscape);
      placeWin();
      posterImg.hidden = !st.posterUrl;
      posterEmpty.hidden = !!st.posterUrl;
      if (st.posterUrl) posterImg.src = st.posterUrl;
      drawHead();
    }
    function drawHead() { head.style.left = pct(video.currentTime || 0) + '%'; }
    function seek(t) { video.currentTime = Math.max(0, Math.min(st.dur || 0, t)); drawHead(); }

    // предпросмотр: только выбранный отрезок, остановка на конце
    function tick() {
      drawHead();
      if (playing && video.currentTime >= st.end - 0.03) { stop(); seek(st.end); }
      if (playing) raf = requestAnimationFrame(tick);
    }
    function stop() { playing = false; video.pause(); cancelAnimationFrame(raf); layout(); }
    playBtn.addEventListener('click', function () {
      if (playing) { stop(); return; }
      if (video.currentTime < st.start || video.currentTime >= st.end - 0.05) video.currentTime = st.start;
      playing = true;
      var p = video.play();
      if (p && p.catch) p.catch(function () { video.muted = true; video.play().catch(function () { stop(); }); });
      layout();
      raf = requestAnimationFrame(tick);
    });
    muteBtn.addEventListener('click', function () { video.muted = !video.muted; layout(); });

    // перетаскивание ручек и переход по ленте
    function timeAt(clientX) {
      var r = tl.getBoundingClientRect();
      return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * st.dur;
    }
    var drag = null;
    tl.addEventListener('pointerdown', function (e) {
      if (!st.dur) return;
      e.preventDefault();
      if (playing) stop();
      drag = e.target === handleL ? 'start' : e.target === handleR ? 'end' : 'seek';
      try { tl.setPointerCapture(e.pointerId); } catch (err) { /* без захвата */ }
      moveTo(e.clientX);
    });
    tl.addEventListener('pointermove', function (e) { if (drag) moveTo(e.clientX); });
    tl.addEventListener('pointerup', function () { drag = null; });
    tl.addEventListener('pointercancel', function () { drag = null; });
    function moveTo(x) {
      var t = timeAt(x);
      if (drag === 'start') { st.start = Math.min(t, st.end - MIN_CLIP); seek(st.start); }
      else if (drag === 'end') { st.end = Math.max(t, st.start + MIN_CLIP); seek(st.end); }
      else seek(t);
      layout();
    }
    function keyMove(which) {
      return function (e) {
        var d = { ArrowLeft: -0.1, ArrowDown: -0.1, ArrowRight: 0.1, ArrowUp: 0.1 }[e.key];
        if (!d) return;
        e.preventDefault();
        if (e.shiftKey) d *= 10;
        if (which === 'start') { st.start = Math.max(0, Math.min(st.start + d, st.end - MIN_CLIP)); seek(st.start); }
        else { st.end = Math.min(st.dur, Math.max(st.end + d, st.start + MIN_CLIP)); seek(st.end); }
        layout();
      };
    }
    handleL.addEventListener('keydown', keyMove('start'));
    handleR.addEventListener('keydown', keyMove('end'));

    // обложка: текущий кадр в JPEG (загрузится только по «Готово»)
    shotBtn.addEventListener('click', function () {
      if (playing) stop();
      try {
        var k = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
        var c = document.createElement('canvas');
        c.width = Math.round(video.videoWidth * k); c.height = Math.round(video.videoHeight * k);
        c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
        c.toBlob(function (b) {
          if (!b) { toast('Не удалось взять кадр', true); return; }
          st.posterBlob = b;
          st.posterUrl = URL.createObjectURL(b);
          st.posterTime = round1(video.currentTime);
          layout();
          toast('Обложка выбрана. Нажмите «Готово».');
        }, 'image/jpeg', 0.85);
      } catch (err) {
        toast('Браузер не дал взять кадр из этого видео. Попробуйте загрузить видео заново.', true);
      }
    });

    // лента кадров: отдельное видео перематывается по точкам и рисует миниатюры
    function drawStrip() {
      var w = tl.clientWidth, hh = tl.clientHeight, dpr = window.devicePixelRatio || 1;
      strip.width = Math.round(w * dpr); strip.height = Math.round(hh * dpr);
      var ctx = strip.getContext('2d');
      var aspect = (video.videoWidth || 16) / (video.videoHeight || 9);
      var fw = hh * dpr * aspect;
      var n = Math.max(1, Math.ceil(strip.width / fw));
      var v2 = document.createElement('video');
      v2.muted = true; v2.preload = 'auto'; v2.playsInline = true;
      corsVideo(v2, src);
      var i = 0;
      function next() {
        if (i >= n || !document.body.contains(modal)) { v2.removeAttribute('src'); v2.load(); return; }
        v2.currentTime = Math.min(st.dur - 0.05, (i + 0.5) * st.dur / n);
      }
      v2.addEventListener('seeked', function () {
        try { ctx.drawImage(v2, i * fw, 0, fw, strip.height); } catch (err) { i = n; }
        i++; next();
      });
      v2.addEventListener('loadeddata', next, { once: true });
    }

    video.addEventListener('loadedmetadata', function () {
      st.dur = video.duration || 0;
      if (!st.end || st.end > st.dur) st.end = st.dur;
      st.start = Math.min(st.start, Math.max(0, st.end - MIN_CLIP));
      st.landscape = video.videoWidth > video.videoHeight;
      seek(st.posterTime >= 0 ? st.posterTime : st.start);
      layout();
      drawStrip();
      modal.setAttribute('data-ready', '1');
    });
    video.addEventListener('timeupdate', drawHead);
    video.addEventListener('error', function () { toast('Видео не открывается', true); });

    function close() {
      stop();
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', placeWin);
      video.removeAttribute('src'); video.load();
      modal.remove();
      document.body.classList.remove('modal-open');
    }
    function onKey(e) {
      if (e.key === 'Escape') close();
      if (e.key === ' ' && e.target === document.body) { e.preventDefault(); playBtn.click(); }
    }
    document.addEventListener('keydown', onKey);

    okBtn.addEventListener('click', function () {
      if (!st.dur) { close(); return; }
      var apply = function (posterUrl) {
        m.start = st.start > 0.05 ? round1(st.start) : '';
        m.end = st.end < st.dur - 0.05 ? round1(st.end) : '';
        if (st.landscape && st.vertical) {
          m.vertical = true;
          m.vx = Math.round(st.vx);
          m.frame = { x: m.vx, y: 50, z: 1 };
        } else if (m.vertical) {
          delete m.vertical; delete m.vx;
        }
        if (posterUrl) { m.poster = posterUrl; m.posterTime = st.posterTime; }
        close();
        onDone();
      };
      if (!st.posterBlob) { apply(null); return; }
      okBtn.disabled = true; okBtn.textContent = 'Сохраняю обложку…';
      backend.upload(st.posterBlob, fileName('poster', 'jpg')).then(function (url) {
        if (MODE !== 'demo') state.previews[url] = st.posterUrl;
        apply(url);
      }).catch(function (e) {
        okBtn.disabled = false; okBtn.textContent = 'Готово';
        toast('Не удалось загрузить обложку: ' + (e.message || ''), true);
      });
    });

    layout();
    playBtn.focus();
  }

  /* ---------- поля форм ---------- */

  function fieldWrap(label, input, hint) {
    return h('label', { className: 'field' }, [h('span', { text: label }), input, hint ? h('small', { className: 'hint', text: hint }) : null]);
  }

  function textField(obj, key, label, opts) {
    opts = opts || {};
    var input;
    if (opts.rows) {
      input = h('textarea', { rows: opts.rows, placeholder: opts.placeholder || null });
    } else {
      input = h('input', { type: opts.type || 'text', placeholder: opts.placeholder || null });
    }
    input.value = obj[key] == null ? '' : obj[key];
    input.addEventListener('input', function () {
      obj[key] = opts.number ? (input.value === '' ? '' : Number(input.value)) : input.value;
      markDirty();
      if (opts.onInput) opts.onInput(input.value);
    });
    if (opts.name) input.setAttribute('data-field', opts.name);
    return fieldWrap(label, input, opts.hint);
  }

  function selectField(obj, key, label, options, opts) {
    opts = opts || {};
    var sel = h('select');
    options.forEach(function (o) {
      var op = h('option', { value: o[0], text: o[1] });
      if (String(obj[key] || '') === String(o[0])) op.selected = true;
      sel.appendChild(op);
    });
    sel.addEventListener('change', function () { obj[key] = sel.value; markDirty(); if (opts.onChange) opts.onChange(); });
    return fieldWrap(label, sel, opts.hint);
  }

  function checkField(obj, key, label, invert, onChange) {
    var cb = h('input', { type: 'checkbox' });
    cb.checked = invert ? !obj[key] : !!obj[key];
    cb.addEventListener('change', function () { obj[key] = invert ? !cb.checked : cb.checked; markDirty(); if (onChange) onChange(); });
    return h('label', { className: 'check' }, [cb, label]);
  }

  function more(children) {
    var d = h('details', { className: 'more' }, [h('summary', { text: 'Дополнительно' })]);
    children.forEach(function (c) { if (c) d.appendChild(c); });
    return d;
  }

  // Цвет в формате #rrggbb: палитра RGB, код вручную и цвета сайта
  var RING_DEFAULT = '#c39a2b';
  // Цвета сайта: [что сохраняем, цвет, название]
  var RING_SWATCHES = [['#c39a2b', '#c39a2b', 'Золото'], ['#1c2a4f', '#1c2a4f', 'Тёмно-синий'], ['#8cc4ec', '#8cc4ec', 'Небесно-голубой'],
    ['#f5b6c7', '#f5b6c7', 'Пудрово-розовый'], ['#e9d2aa', '#e9d2aa', 'Тёплый беж'], ['#ffffff', '#ffffff', 'Белый']];
  var BG_SWATCHES = [['cream', 'Кремовый'], ['sky', 'Небесно-голубой'], ['powder', 'Пудрово-розовый'], ['beige', 'Тёплый беж'], ['navy', 'Тёмно-синий']]
    .map(function (b) { return [b[0], S.BG_PRESETS[b[0]], b[1]]; });
  var BOX_SWATCHES = [['paper', 'Белый'], ['cream', 'Кремовый'], ['sky', 'Небесно-голубой'], ['powder', 'Пудрово-розовый'],
    ['beige', 'Тёплый беж'], ['navy', 'Тёмно-синий'], ['gold', 'Золото']]
    .map(function (b) { return [b[0], S.BOX_PRESETS[b[0]], b[1]]; });

  // Палитра для текста и деталей: цвета сайта, их тёмные оттенки, белый и чёрный
  var THEME_SWATCHES = [['#1c2a4f', 'Тёмно-синий'], ['#4f5b7a', 'Серо-синий'], ['#3d8bc9', 'Голубой насыщенный'], ['#8cc4ec', 'Небесно-голубой'],
    ['#d76f8d', 'Розовый насыщенный'], ['#f5b6c7', 'Пудрово-розовый'], ['#e9d2aa', 'Тёплый беж'], ['#c39a2b', 'Золото'],
    ['#e6c766', 'Светлое золото'], ['#ffffff', 'Белый'], ['#000000', 'Чёрный']].map(function (c) { return [c[0], c[0], c[1]]; });

  // Цвет текста блока; пусто = автоматически (тёмный, а на тёмном фоне белый)
  function textColorField(obj, label, bg) {
    var auto = /is-dark/.test(bg.cls) ? '#ffffff' : ((state.data.theme || {}).text || '#1c2a4f');
    return colorField(obj, 'textColor', label, '', [['', auto, 'Автоматически']].concat(THEME_SWATCHES), { name: 'text-color' });
  }

  // Цвет плашки или карточки; пустое значение = «как задумано» (defaultHex показывает, какой это цвет)
  function boxColorField(obj, key, label, defaultHex, defaultTitle) {
    return colorField(obj, key, label, '', [['', defaultHex, defaultTitle || 'Как задумано']].concat(BOX_SWATCHES), { name: 'box-' + key });
  }

  // Выбор цвета: кнопки цветов сайта, палитра RGB и код #rrggbb
  function colorField(obj, key, label, def, swatchList, opts) {
    opts = opts || {};
    var toHex = function (v) {
      var s = swatchList.find(function (x) { return x[0] === v; });
      return s ? s[1] : (S.isHex(v) ? v.toLowerCase() : null);
    };
    var picker = h('input', { type: 'color', 'aria-label': label, 'data-field': opts.name || null });
    var hex = h('input', { type: 'text', maxlength: '7', placeholder: '#rrggbb', 'aria-label': 'Код цвета' });
    var buttons = [];
    function paint() {
      var cur = obj[key] || def;
      var hx = toHex(cur) || toHex(def);
      picker.value = hx;
      if (document.activeElement !== hex) hex.value = hx;
      buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b._value === cur || b._hex === cur)); });
      if (opts.onChange) opts.onChange(hx);
    }
    function set(v) { obj[key] = v; markDirty(); paint(); }
    picker.addEventListener('input', function () { set(picker.value.toLowerCase()); });
    hex.addEventListener('input', function () {
      var v = hex.value.trim();
      if (v && v[0] !== '#') v = '#' + v;
      if (S.isHex(v)) set(v.toLowerCase());
    });
    var swatches = h('div', { className: 'swatches' }, swatchList.map(function (s) {
      var b = h('button', { type: 'button', className: 'swatch' + (s[0] === '' ? ' swatch-default' : ''), title: s[2], 'aria-label': s[2],
        style: 'background:' + s[1], onclick: function () { set(s[0]); } });
      b._value = s[0]; b._hex = s[1];
      buttons.push(b);
      return b;
    }));
    var wrap = h('div', { className: 'field' }, [h('span', { text: label }),
      h('div', { className: 'inline color-row' }, [swatches, picker, hex]),
      h('small', { className: 'hint', text: 'Кружки: цвета сайта. Квадрат: любой цвет из палитры RGB. Можно вписать код вида #c39a2b.' })]);
    paint();
    return wrap;
  }


  // Одна картинка: { src, frame }
  function imageField(owner, key, label, shape) {
    var wrap = h('div', { className: 'field' }, [h('span', { text: label })]);
    var row = h('div', { className: 'img-field' });
    wrap.appendChild(row);
    function draw() {
      row.innerHTML = '';
      var media = owner[key];
      var thumb = h('div', { className: 'thumb ' + shape });
      var el = media && media.src ? frameImg(media) : null;
      thumb.appendChild(el || h('span', { className: 'empty', text: 'Нет фото' }));
      var busy = h('span', { className: 'progress' });
      var actions = h('div', { className: 'img-actions' }, [
        h('button', { type: 'button', className: 'btn small', text: media && media.src ? 'Заменить фото' : 'Загрузить фото', onclick: function () {
          pickFiles('image/*', false, function (files) {
            busy.textContent = 'Загрузка…';
            uploadPhoto(files[0]).then(function (url) {
              owner[key] = { src: url, frame: { x: 50, y: 50, z: 1 } };
              markDirty(); draw();
              toast('Фото загружено. Не забудьте сохранить.');
            }).catch(function (e) { busy.textContent = ''; toast(e.message || 'Не удалось загрузить фото', true); });
          });
        } }),
        media && media.src ? h('button', { type: 'button', className: 'btn small', text: 'Настроить кадр', onclick: function () {
          openCrop(media, shape, false, function (f) { media.frame = f; markDirty(); draw(); });
        } }) : null,
        media && media.src ? h('button', { type: 'button', className: 'btn small danger', text: 'Убрать', onclick: function () {
          owner[key] = { src: '', frame: { x: 50, y: 50, z: 1 } }; markDirty(); draw();
        } }) : null,
        busy
      ]);
      row.appendChild(thumb);
      row.appendChild(actions);
    }
    draw();
    return wrap;
  }

  // Ссылка или загруженный файл
  function linkField(obj, key, label, hint) {
    var input = h('input', { type: 'text', placeholder: 'https://… или загрузите файл' });
    input.value = obj[key] || '';
    input.addEventListener('input', function () { obj[key] = input.value; markDirty(); });
    var busy = h('span', { className: 'progress' });
    var btn = h('button', { type: 'button', className: 'btn small', text: 'Загрузить файл', onclick: function () {
      pickFiles('', false, function (files) {
        busy.textContent = 'Загрузка…';
        uploadAnyFile(files[0]).then(function (url) {
          obj[key] = url; input.value = url; busy.textContent = 'Готово'; markDirty();
        }).catch(function (e) { busy.textContent = ''; toast(e.message, true); });
      });
    } });
    return h('div', { className: 'field' }, [h('span', { text: label }), h('div', { className: 'inline' }, [input, btn, busy]),
      h('small', { className: 'hint', text: hint || 'Ссылка на страницу (https://…), почта (mailto:) или загруженный файл PDF, Word и т. п.' })]);
  }

  // Список карточек: добавить, раскрыть, перетащить, скрыть, удалить
  function listField(arr, opts) {
    var wrap = h('div');
    var listEl = h('div', { className: 'list' });
    wrap.appendChild(listEl);
    var openIds = {};
    function draw() {
      listEl.innerHTML = '';
      if (!arr.length) listEl.appendChild(h('p', { className: 'muted', text: opts.emptyText || 'Пока пусто.' }));
      arr.forEach(function (item, i) {
        if (!item.id) item.id = S.uid(opts.prefix || 'item');
        var isOpen = !!openIds[item.id];
        var card = h('div', { className: 'item' + (isOpen ? ' open' : '') + (item.hidden ? ' is-hidden' : '') });
        var titleBtn = h('button', { type: 'button', className: 'item-title', text: opts.title(item) || 'Без названия', 'aria-expanded': String(isOpen),
          onclick: function () { openIds[item.id] = !isOpen; draw(); } });
        var head = h('div', { className: 'item-head' }, [
          grip(arr, i, '.item', opts.title(item), function () { draw(); }),
          titleBtn,
          item.hidden ? h('span', { className: 'badge', text: 'скрыто' }) : null,
          opts.noHide ? null : h('button', { type: 'button', className: 'icon-btn', text: item.hidden ? 'Показать' : 'Скрыть',
            title: item.hidden ? 'Показать на сайте' : 'Скрыть на сайте', onclick: function () { item.hidden = !item.hidden; markDirty(); draw(); } }),
          h('button', { type: 'button', className: 'icon-btn del', title: 'Удалить', 'aria-label': 'Удалить', text: '✕', onclick: function () {
            if (!confirm('Удалить «' + (opts.title(item) || 'элемент') + '»?')) return;
            arr.splice(i, 1); markDirty(); draw();
          } })
        ]);
        card.appendChild(head);
        if (isOpen) {
          var body = h('div', { className: 'item-body' });
          opts.fields(item, body, function () { titleBtn.textContent = opts.title(item) || 'Без названия'; });
          card.appendChild(body);
        }
        listEl.appendChild(card);
      });
    }
    draw();
    wrap.appendChild(h('button', { type: 'button', className: 'btn small', text: '+ ' + (opts.addLabel || 'Добавить'), onclick: function () {
      var item = opts.make();
      item.id = item.id || S.uid(opts.prefix || 'item');
      arr.push(item);
      openIds[item.id] = true;
      markDirty(); draw();
    } }));
    return wrap;
  }

  /* ---------- перетаскивание ---------- */

  var GRIP_SVG = '<svg viewBox="0 0 20 28" width="14" height="20" aria-hidden="true" fill="currentColor">' +
    '<rect x="1" y="1" width="18" height="26" rx="4" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
    '<circle cx="7" cy="8.5" r="1.7"/><circle cx="13" cy="8.5" r="1.7"/><circle cx="7" cy="14" r="1.7"/>' +
    '<circle cx="13" cy="14" r="1.7"/><circle cx="7" cy="19.5" r="1.7"/><circle cx="13" cy="19.5" r="1.7"/></svg>';
  var gripGroups = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  var gripSeq = 0;

  function moveTo(arr, from, to) { arr.splice(to, 0, arr.splice(from, 1)[0]); }

  // Ручка слева от элемента: зажать и тянуть (мышь или палец) либо стрелки на клавиатуре.
  // itemSelector: какой элемент тянем; redraw(newIndex): перерисовать список после перестановки
  function grip(arr, index, itemSelector, label, redraw) {
    var group = gripGroups && gripGroups.get(arr);
    if (!group) { group = 'g' + (++gripSeq); if (gripGroups) gripGroups.set(arr, group); }
    var b = h('button', { type: 'button', className: 'grip', title: 'Зажмите и перетащите', 'data-grip': String(index), 'data-group': group,
      'aria-label': 'Переставить «' + (label || 'элемент') + '». Можно стрелками вверх и вниз' });
    b.innerHTML = GRIP_SVG;
    function done(to, focus) {
      markDirty();
      redraw(to);
      if (focus) {
        var g = document.querySelector('.grip[data-group="' + group + '"][data-grip="' + to + '"]');
        if (g) g.focus();
      }
    }
    b.addEventListener('keydown', function (e) {
      var d = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[e.key];
      if (!d) return;
      e.preventDefault();
      var to = index + d;
      if (to < 0 || to >= arr.length) return;
      moveTo(arr, index, to);
      done(to, true);
    });
    b.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      startDrag(e, b, itemSelector, function (to) {
        if (to === index) return;
        moveTo(arr, index, to);
        done(to, false);
      });
    });
    return b;
  }

  function startDrag(e, handleEl, itemSelector, onDrop) {
    var item = handleEl.closest(itemSelector);
    if (!item) return;
    var box = item.parentNode;
    e.preventDefault();
    try { handleEl.setPointerCapture(e.pointerId); } catch (err) { /* без захвата */ }
    var r0 = item.getBoundingClientRect();
    var grabX = e.clientX - r0.left, grabY = e.clientY - r0.top;
    var px = e.clientX, py = e.clientY, active = false, raf = 0;

    function siblings() {
      return Array.prototype.filter.call(box.children, function (c) { return c.matches(itemSelector); });
    }
    function follow() {
      item.style.transform = 'none';
      var r = item.getBoundingClientRect();
      item.style.transform = 'translate(' + (px - grabX - r.left) + 'px,' + (py - grabY - r.top) + 'px)';
    }
    // Элемент встаёт на новое место, когда палец или курсор переходит середину соседа
    function reorder() {
      var list = siblings();
      var a = list.indexOf(item);
      for (var k = 0; k < list.length; k++) {
        var el = list[k];
        if (el === item) continue;
        var r = el.getBoundingClientRect();
        if (px < r.left || px > r.right || py < r.top || py > r.bottom) continue;
        var midX = r.left + r.width / 2, midY = r.top + r.height / 2, band = r.height / 4;
        var after = py > midY + band || (Math.abs(py - midY) <= band && px > midX);
        var before = py < midY - band || (Math.abs(py - midY) <= band && px < midX);
        // переставляем соседей, а не сам элемент: иначе браузер может потерять захват пальца
        if (k > a && after) list.slice(a + 1, k + 1).forEach(function (s) { box.insertBefore(s, item); });
        else if (k < a && before) list.slice(k, a).forEach(function (s) { box.insertBefore(s, item.nextSibling); });
        break;
      }
    }
    // У края экрана страница сама прокручивается
    function tick() {
      var edge = 90, speed = 0;
      if (py < edge) speed = -Math.ceil((edge - py) / 6);
      else if (py > window.innerHeight - edge) speed = Math.ceil((py - window.innerHeight + edge) / 6);
      if (speed) { window.scrollBy(0, speed); reorder(); follow(); }
      raf = requestAnimationFrame(tick);
    }
    function onMove(ev) {
      px = ev.clientX; py = ev.clientY;
      if (!active) {
        if (Math.abs(px - e.clientX) + Math.abs(py - e.clientY) < 4) return;
        active = true;
        item.classList.add('dragging');
        document.body.classList.add('is-dragging');
        raf = requestAnimationFrame(tick);
      }
      reorder();
      follow();
    }
    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      cancelAnimationFrame(raf);
      item.classList.remove('dragging');
      item.style.transform = '';
      document.body.classList.remove('is-dragging');
      if (active) onDrop(siblings().indexOf(item));
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }

  // Набор фото (и видео): сетка миниатюр
  function mediaField(arr, opts) {
    var wrap = h('div', { className: 'field' }, [h('span', { text: opts.label })]);
    var grid = h('div', { className: 'media-grid' });
    var busy = h('span', { className: 'progress' });
    wrap.appendChild(grid);
    function draw() {
      grid.innerHTML = '';
      if (!arr.length) grid.appendChild(h('p', { className: 'muted', text: 'Пока ничего не загружено.' }));
      arr.forEach(function (m, i) {
        if (!m.id) m.id = S.uid('m');
        var isVideo = m.type === 'video';
        var thumb = h('div', { className: 'thumb ' + opts.shape });
        thumb.appendChild(frameImg(m, isVideo) || h('span', { className: 'empty', text: 'Нет файла' }));
        if (isVideo) thumb.appendChild(h('span', { className: 'kind', text: 'видео' }));
        var card = h('div', { className: 'media-card' + (m.hidden ? ' is-hidden' : '') }, [
          thumb,
          h('div', { className: 'tools' }, [
            grip(arr, i, '.media-card', (isVideo ? 'видео ' : 'фото ') + (i + 1), function () { draw(); }),
            h('button', { type: 'button', className: 'icon-btn', text: 'Кадр', title: 'Настроить кадр', onclick: function () {
              openCrop(m, opts.shape, isVideo, function (f) { m.frame = f; markDirty(); draw(); });
            } }),
            h('button', { type: 'button', className: 'icon-btn', text: m.hidden ? 'Показать' : 'Скрыть', onclick: function () { m.hidden = !m.hidden; markDirty(); draw(); } }),
            h('button', { type: 'button', className: 'icon-btn del', text: '✕', title: 'Удалить', 'aria-label': 'Удалить', onclick: function () {
              if (!confirm('Удалить этот файл со страницы?')) return;
              arr.splice(i, 1); markDirty(); draw();
            } })
          ])
        ]);
        if (opts.captions) {
          var cap = h('textarea', { rows: 2, placeholder: 'Подпись (необязательно)' });
          cap.value = m.caption || '';
          cap.addEventListener('input', function () { m.caption = cap.value; markDirty(); });
          card.appendChild(cap);
        }
        if (isVideo) {
          var trimmed = Number(m.start) > 0 || Number(m.end) > 0;
          card.appendChild(h('button', { type: 'button', className: 'btn small vedit-btn', 'data-action': 'video-edit',
            text: 'Обрезка и обложка', onclick: function () { openVideoEditor(m, function () { markDirty(); draw(); }); } }));
          if (trimmed) card.appendChild(h('span', { className: 'muted vtrim-note', text: 'Обрезано: ' + fmtTime(Number(m.start) || 0) + ' – ' + (Number(m.end) ? fmtTime(m.end) : 'конец') }));
        }
        grid.appendChild(card);
      });
    }
    draw();
    var accept = opts.allowVideo ? 'image/*,video/mp4,video/quicktime,video/webm' : 'image/*';
    wrap.appendChild(h('div', { className: 'inline' }, [
      h('button', { type: 'button', className: 'btn small', text: opts.allowVideo ? '+ Добавить фото или видео' : '+ Добавить скан или фото', onclick: function () {
        pickFiles(accept, true, function (files) {
          var done = 0;
          busy.textContent = 'Загрузка 0 из ' + files.length + '…';
          files.reduce(function (p, file) {
            return p.then(function () {
              var isVideo = /^video\//.test(file.type) || /\.(mp4|mov|webm|m4v)$/i.test(file.name);
              if (isVideo && !opts.allowVideo) throw new Error('Здесь можно загрузить только фото');
              var job = isVideo ? uploadVideo(file).then(function (r) {
                arr.push({ id: S.uid('m'), type: 'video', src: r.src, poster: r.poster, frame: { x: 50, y: 50, z: 1 }, caption: '' });
              }) : uploadPhoto(file).then(function (url) {
                arr.push({ id: S.uid('m'), type: 'photo', src: url, frame: { x: 50, y: 50, z: 1 }, caption: '' });
              });
              return job.then(function () {
                done++; busy.textContent = 'Загрузка ' + done + ' из ' + files.length + '…'; markDirty(); draw();
              });
            });
          }, Promise.resolve()).then(function () {
            busy.textContent = ''; toast('Загружено: ' + done + '. Не забудьте сохранить.');
          }).catch(function (e) { busy.textContent = ''; toast(e.message || 'Ошибка загрузки', true); });
        });
      } }),
      busy
    ]));
    return wrap;
  }

  /* ---------- экраны ---------- */

  function panel(title, children) {
    var p = h('section', { className: 'panel' }, title ? [h('h2', { text: title })] : []);
    children.forEach(function (c) { if (c) p.appendChild(c); });
    return p;
  }

  function sectionCommon(sec, refreshMenu) {
    return [
      textField(sec, 'title', 'Заголовок блока', { onInput: refreshMenu, name: 'section-title' }),
      checkField(sec, 'hidden', 'Показывать блок на сайте', true, refreshMenu),
      more([
        textField(sec, 'menuLabel', 'Название в меню', { hint: 'Если пусто, берётся заголовок', onInput: refreshMenu }),
        menuCheck(sec)
      ]),
      colorField(sec, 'bg', 'Фон блока', 'cream', BG_SWATCHES, { name: 'section-bg' }),
      textColorField(sec, 'Цвет текста блока', S.bgStyle(sec.bg, 'cream')),
      CARD_COLORS[sec.type] ? boxColorField(sec, 'cardBg', CARD_COLORS[sec.type][1], CARD_COLORS[sec.type][0]) : null
    ];
  }

  // Блоки с карточками внутри: исходный цвет карточек и подпись поля
  var CARD_COLORS = {
    education: ['#fffcf6', 'Цвет карточек внутри блока'],
    courses: ['#fffcf6', 'Цвет карточек внутри блока'],
    achievements: ['#fffcf6', 'Цвет карточек внутри блока'],
    materials: ['#fffcf6', 'Цвет карточек внутри блока'],
    contacts: ['#2c3f70', 'Цвет карточек с контактами'],
    gallery: ['#fffcf6', 'Цвет плашки пустого альбома']
  };

  // Цвет карточек блока, который наследует карточка без своего цвета
  function cardHex(sec) {
    var v = sec.cardBg;
    return (S.isHex(v) ? v : S.BOX_PRESETS[v]) || (CARD_COLORS[sec.type] || ['#fffcf6'])[0];
  }

  // Пункт в меню показан, пока не задано menu: false
  function menuCheck(sec) {
    var cb = h('input', { type: 'checkbox' });
    cb.checked = sec.menu !== false;
    cb.addEventListener('change', function () {
      if (cb.checked) delete sec.menu; else sec.menu = false;
      markDirty();
    });
    return h('label', { className: 'check' }, [cb, 'Показывать пункт в меню']);
  }

  var editors = {
    about: function (sec, v) {
      v.appendChild(panel('Текст', [
        textField(sec, 'text', 'О себе', { rows: 12, hint: 'Пустая строка между абзацами начинает новый абзац.' }),
        textField(sec, 'goal', 'Выделенная фраза', { rows: 2 }),
        boxColorField(sec, 'goalBg', 'Цвет плашки с выделенной фразой', '#f5b6c7')
      ]));
      v.appendChild(panel('Фото', [imageField(sec, 'photo', 'Фото в круге', 'circle'), more([textField(sec, 'photoAlt', 'Описание фото для незрячих')])]));
    },
    education: function (sec, v) {
      v.appendChild(panel('Учебные заведения', [listField(sec.items, {
        prefix: 'edu', addLabel: 'Добавить учебное заведение',
        title: function (it) { return it.title; },
        make: function () { return { title: '', place: '', period: '', text: '' }; },
        fields: function (it, b, upd) {
          b.appendChild(textField(it, 'title', 'Учебное заведение', { onInput: upd }));
          b.appendChild(textField(it, 'place', 'Город'));
          b.appendChild(textField(it, 'period', 'Годы обучения', { placeholder: 'например: с 2024 по 2027' }));
          b.appendChild(textField(it, 'text', 'Специальность, квалификация', { rows: 3, hint: 'Каждая строка выводится отдельно.' }));
          b.appendChild(boxColorField(it, 'bg', 'Цвет этой карточки', cardHex(sec), 'Как у остальных карточек'));
        }
      })]));
      v.appendChild(panel(null, [more([textField(sec, 'text', 'Вступительный текст', { rows: 3 })])]));
    },
    experience: function (sec, v) {
      v.appendChild(panel('Места работы и практики', [listField(sec.items, {
        prefix: 'exp', addLabel: 'Добавить место работы',
        title: function (it) { return [it.role, it.org].filter(Boolean).join(', '); },
        make: function () { return { role: '', period: '', org: '', points: '' }; },
        fields: function (it, b, upd) {
          b.appendChild(textField(it, 'role', 'Должность', { onInput: upd }));
          b.appendChild(textField(it, 'org', 'Где', { onInput: upd }));
          b.appendChild(textField(it, 'period', 'Когда', { placeholder: 'например: с 28.05 по 19.06.2026' }));
          b.appendChild(textField(it, 'points', 'Что делала', { rows: 6, hint: 'Каждый пункт с новой строки.' }));
        }
      })]));
    },
    courses: function (sec, v) {
      v.appendChild(panel('Текст', [textField(sec, 'text', 'Вступительный текст', { rows: 4 })]));
      v.appendChild(panel('Курсы', [listField(sec.items, {
        prefix: 'course', addLabel: 'Добавить курс', emptyText: 'Курсов пока нет. На сайте будет показан только текст.',
        title: function (it) { return it.title; },
        make: function () { return { title: '', org: '', year: '', hours: '', text: '', link: '' }; },
        fields: function (it, b, upd) {
          b.appendChild(textField(it, 'title', 'Название курса', { onInput: upd }));
          b.appendChild(textField(it, 'org', 'Организация'));
          b.appendChild(textField(it, 'year', 'Год'));
          b.appendChild(textField(it, 'hours', 'Часов'));
          b.appendChild(textField(it, 'text', 'Описание', { rows: 3 }));
          b.appendChild(linkField(it, 'link', 'Удостоверение или сертификат'));
          b.appendChild(boxColorField(it, 'bg', 'Цвет этой карточки', cardHex(sec), 'Как у остальных карточек'));
        }
      })]));
    },
    achievements: function (sec, v) {
      v.appendChild(panel('Категории', [textField(sec, 'categories', 'Категории для фильтра', { rows: 3, hint: 'Каждая категория с новой строки.' }),
        more([textField(sec, 'text', 'Вступительный текст', { rows: 3 })])]));
      v.appendChild(panel('Достижения и грамоты', [listField(sec.items, {
        prefix: 'ach', addLabel: 'Добавить достижение',
        title: function (it) { return it.title; },
        make: function () { return { category: S.lines(sec.categories)[0] || '', title: '', org: '', text: '', scans: [] }; },
        fields: function (it, b, upd) {
          var cats = S.lines(sec.categories);
          if (it.category && cats.indexOf(it.category) < 0) cats.push(it.category);
          b.appendChild(selectField(it, 'category', 'Категория', [['', 'Без категории']].concat(cats.map(function (c) { return [c, c]; }))));
          b.appendChild(textField(it, 'title', 'Название', { onInput: upd }));
          b.appendChild(textField(it, 'org', 'Кто наградил, где'));
          b.appendChild(textField(it, 'text', 'Описание', { rows: 3 }));
          if (!Array.isArray(it.links)) it.links = [];
          b.appendChild(h('div', { className: 'field' }, [h('span', { text: 'Ссылки на материалы' }), listField(it.links, {
            prefix: 'lnk', addLabel: 'Добавить ссылку', emptyText: 'Ссылок пока нет. Например: публикация работы, страница конкурса, видео занятия.',
            title: function (l) { return l.label || l.href; },
            make: function () { return { label: '', href: '' }; },
            fields: function (l, body, upd) {
              body.appendChild(textField(l, 'label', 'Подпись ссылки', { onInput: upd, placeholder: 'например: Публикация работы', name: 'link-label' }));
              body.appendChild(linkField(l, 'href', 'Адрес или файл', 'Ссылка на страницу (https://…) или загруженный файл PDF, Word, презентация.'));
            }
          })]));
          if (!Array.isArray(it.scans)) it.scans = [];
          b.appendChild(mediaField(it.scans, { label: 'Сканы дипломов и грамот', shape: 'wide', allowVideo: false, captions: false }));
          b.appendChild(boxColorField(it, 'bg', 'Цвет этой карточки', cardHex(sec), 'Как у остальных карточек'));
          b.appendChild(h('p', { className: 'muted', text: 'Не публикуйте документы с персональными данными других людей (например, списки награждённых).' }));
        }
      })]));
    },
    gallery: function (sec, v) {
      v.appendChild(panel('Альбомы', [listField(sec.albums, {
        prefix: 'album', addLabel: 'Добавить альбом',
        title: function (a) { var n = (a.items || []).length; return a.title + (n ? ' (' + n + ')' : ''); },
        make: function () { return { title: 'Новый альбом', text: '', items: [] }; },
        fields: function (a, b, upd) {
          if (!Array.isArray(a.items)) a.items = [];
          b.appendChild(textField(a, 'title', 'Название альбома', { onInput: upd }));
          b.appendChild(textField(a, 'text', 'Описание альбома', { rows: 3 }));
          b.appendChild(mediaField(a.items, { label: 'Фото и видео', shape: 'tile', allowVideo: true, captions: true }));
        }
      })]));
      v.appendChild(panel(null, [
        textField(sec, 'note', 'Примечание под альбомами', { rows: 2 }),
        more([textField(sec, 'text', 'Вступительный текст', { rows: 3 }), textField(sec, 'emptyText', 'Текст для пустого альбома', { placeholder: 'Скоро здесь появятся фотографии.' })])
      ]));
      v.appendChild(h('p', { className: 'muted', text: 'Фотографии детей публикуйте только с письменного согласия родителей. Видео до ' + MAX_VIDEO_MB + ' МБ.' }));
    },
    materials: function (sec, v) {
      v.appendChild(panel('Текст', [textField(sec, 'text', 'Вступление', { rows: 4 })]));
      v.appendChild(panel('Материалы', [listField(sec.items, {
        prefix: 'mat', addLabel: 'Добавить материал',
        title: function (it) { return it.title; },
        make: function () { return { title: '', text: '', link: '' }; },
        fields: function (it, b, upd) {
          b.appendChild(textField(it, 'title', 'Название', { onInput: upd }));
          b.appendChild(textField(it, 'text', 'Пояснение', { rows: 2 }));
          b.appendChild(linkField(it, 'link', 'Ссылка или файл'));
          b.appendChild(boxColorField(it, 'bg', 'Цвет этой карточки', cardHex(sec), 'Как у остальных карточек'));
        }
      })]));
      v.appendChild(panel('В конце', [textField(sec, 'remember', 'Памятка в рамке', { rows: 3 }), boxColorField(sec, 'rememberBg', 'Цвет памятки', '#1c2a4f')]));
    },
    contacts: function (sec, v) {
      v.appendChild(panel('Контакты', [
        textField(sec, 'text', 'Текст', { rows: 2 }),
        textField(sec, 'phone', 'Телефон'),
        textField(sec, 'email', 'E-mail', { type: 'email' }),
        textField(sec, 'telegram', 'Telegram', { placeholder: '@имя или ссылка' }),
        textField(sec, 'vk', 'ВКонтакте', { placeholder: 'адрес страницы' }),
        textField(sec, 'place', 'Где работаю'),
        h('p', { className: 'muted', text: 'Пустые поля на сайте не показываются.' })
      ]));
    },
    custom: function (sec, v) {
      if (!sec.button) sec.button = { label: '', href: '' };
      v.appendChild(panel('Содержимое', [
        textField(sec, 'text', 'Текст', { rows: 6, hint: 'Пустая строка между абзацами начинает новый абзац.' }),
        textField(sec, 'points', 'Пункты списка', { rows: 4, hint: 'Каждый пункт с новой строки.' }),
        imageField(sec, 'photo', 'Фото', 'wide')
      ]));
      v.appendChild(panel('Кнопка', [textField(sec.button, 'label', 'Надпись на кнопке'), linkField(sec.button, 'href', 'Куда ведёт')]));
    }
  };

  var views = {
    hero: {
      title: 'Шапка',
      draw: function (v) {
        var hr = state.data.hero;
        if (!Array.isArray(hr.buttons)) hr.buttons = [];
        if (!Array.isArray(hr.cards)) hr.cards = [];
        v.appendChild(panel('Главное', [
          textField(hr, 'kicker', 'Строка над именем'),
          textField(hr, 'name', 'ФИО', { name: 'hero-name' }),
          textField(hr, 'role', 'Должность'),
          textField(hr, 'epigraph', 'Эпиграф', { rows: 3, hint: 'Кавычки «» добавятся сами.' }),
          textField(hr, 'epigraphAuthor', 'Автор эпиграфа'),
          boxColorField(hr, 'epigraphBg', 'Фон эпиграфа', '#fffcf6'),
          textField(hr, 'text', 'Короткий текст', { rows: 3 }),
          colorField(hr, 'bg', 'Фон шапки', 'cream', BG_SWATCHES, { name: 'hero-bg' })
        ]));
        var photoPanel = panel('Фото', [imageField(hr, 'photo', 'Фото в круге', 'circle')]);
        function paintRing() {
          var t = photoPanel.querySelector('.thumb.circle');
          if (t) { t.style.borderColor = hr.ringColor || RING_DEFAULT; t.style.borderWidth = '4px'; }
        }
        photoPanel.appendChild(colorField(hr, 'ringColor', 'Цвет окантовки фото', RING_DEFAULT, RING_SWATCHES, { name: 'ring-color', onChange: paintRing }));
        photoPanel.appendChild(more([textField(hr, 'photoAlt', 'Описание фото для незрячих')]));
        new MutationObserver(paintRing).observe(photoPanel, { childList: true, subtree: true });
        paintRing();
        v.appendChild(photoPanel);
        v.appendChild(panel('Кнопки', [listField(hr.buttons, {
          prefix: 'btn', addLabel: 'Добавить кнопку',
          title: function (b) { return b.label; },
          make: function () { return { label: 'Новая кнопка', href: '#contacts' }; },
          fields: function (b, body, upd) {
            body.appendChild(textField(b, 'label', 'Надпись', { onInput: upd }));
            body.appendChild(selectField(b, 'href', 'Куда ведёт', anchorOptions(b.href)));
            body.appendChild(more([textField(b, 'href', 'Или своя ссылка', { placeholder: 'https://…' })]));
          }
        })]));
        v.appendChild(panel('Карточки под шапкой', [listField(hr.cards, {
          prefix: 'card', addLabel: 'Добавить карточку',
          title: function (c) { return c.title; },
          make: function () { return { title: '', text: '' }; },
          fields: function (c, body, upd) {
            body.appendChild(textField(c, 'title', 'Крупно', { onInput: upd }));
            body.appendChild(textField(c, 'text', 'Пояснение', { rows: 2 }));
            body.appendChild(boxColorField(c, 'bg', 'Цвет карточки', ['#8cc4ec', '#f5b6c7', '#e9d2aa'][Math.max(0, hr.cards.indexOf(c)) % 3]));
          }
        }), h('p', { className: 'muted', text: 'Лучше всего смотрятся три карточки.' })]));
      }
    },
    blocks: { title: 'Блоки страницы', draw: drawBlocks },
    colors: { title: 'Цвета', draw: drawColors },
    seo: {
      title: 'SEO и подвал',
      draw: function (v) {
        var seo = state.data.seo = state.data.seo || {};
        if (typeof seo.ogImage === 'string') seo.ogImage = { src: seo.ogImage, frame: { x: 50, y: 50, z: 1 } };
        v.appendChild(panel('Для поисковиков и мессенджеров', [
          textField(seo, 'title', 'Заголовок вкладки'),
          textField(seo, 'description', 'Описание сайта', { rows: 3, hint: 'Показывается в поиске, 1 или 2 предложения.' }),
          imageField(seo, 'ogImage', 'Картинка для ссылки в мессенджерах', 'wide')
        ]));
        v.appendChild(panel('Подвал', [textField(state.data, 'footer', 'Текст в подвале', { hint: 'Если пусто, берётся строка над именем.' })]));
      }
    },
    backup: { title: 'Копия и пароль', draw: drawBackup }
  };

  function anchorOptions(current) {
    var opts = state.data.sections.map(function (s) { return ['#' + s.id, 'Блок «' + s.title + '»']; });
    if (current && !opts.some(function (o) { return o[0] === current; })) opts.unshift([current, current]);
    return opts;
  }

  // Все цветные блоки сайта на одной странице, в том порядке, в каком они идут на сайте
  var CARD_DEFAULT_HEX = ['#8cc4ec', '#f5b6c7', '#e9d2aa'];
  var PER_ITEM_COLOR = { education: 'title', courses: 'title', achievements: 'title', materials: 'title' };

  function drawColors(view) {
    var hr = state.data.hero;
    if (!Array.isArray(hr.cards)) hr.cards = [];
    var v = h('div', { className: 'colors-page' });
    view.appendChild(v);
    v.appendChild(h('p', { className: 'muted', text: 'Здесь собраны все цветные блоки сайта по порядку. Кружки: цвета сайта, кружок с косой чертой: исходный цвет. Квадрат открывает палитру с любым цветом, рядом можно вписать код вида #c39a2b. Не забудьте нажать «Сохранить».' }));

    // Текст и мелкие детали всего сайта
    var theme = state.data.theme = state.data.theme && typeof state.data.theme === 'object' ? state.data.theme : {};
    var themePanel = panel('Текст и детали', [h('p', { className: 'muted', text: 'Цвета текста, линий, точек, кнопок и меню на всём сайте.' })]);
    S.THEME.forEach(function (g) {
      themePanel.appendChild(h('h3', { className: 'colors-sub', text: g[0] }));
      g[1].forEach(function (t) {
        themePanel.appendChild(colorField(theme, t[0], t[1], '', [['', t[2], 'Как задумано']].concat(THEME_SWATCHES), { name: 'theme-' + t[0] }));
      });
    });
    v.appendChild(themePanel);

    var heroPanel = panel('Шапка', [
      colorField(hr, 'bg', 'Фон шапки', 'cream', BG_SWATCHES, { name: 'c-hero-bg' }),
      textColorField(hr, 'Цвет текста шапки', S.bgStyle(hr.bg, 'cream')),
      colorField(hr, 'ringColor', 'Окантовка фото', RING_DEFAULT, RING_SWATCHES, { name: 'c-ring' }),
      boxColorField(hr, 'epigraphBg', 'Плашка с эпиграфом', '#fffcf6')
    ]);
    hr.cards.forEach(function (c, i) {
      heroPanel.appendChild(boxColorField(c, 'bg', 'Карточка ' + (i + 1) + (c.title ? ': «' + c.title + '»' : ''), CARD_DEFAULT_HEX[i % 3]));
    });
    v.appendChild(heroPanel);

    state.data.sections.forEach(function (sec) {
      var p = panel(sec.title || 'Блок', [colorField(sec, 'bg', 'Фон блока', 'cream', BG_SWATCHES), textColorField(sec, 'Цвет текста блока', S.bgStyle(sec.bg, 'cream'))]);
      if (sec.hidden) p.querySelector('h2').appendChild(h('span', { className: 'badge', text: 'скрыт', style: 'margin-left:8px' }));
      if (sec.type === 'about') p.appendChild(boxColorField(sec, 'goalBg', 'Плашка с выделенной фразой', '#f5b6c7'));
      if (CARD_COLORS[sec.type]) p.appendChild(boxColorField(sec, 'cardBg', CARD_COLORS[sec.type][1], CARD_COLORS[sec.type][0]));
      if (sec.type === 'materials') p.appendChild(boxColorField(sec, 'rememberBg', 'Памятка «Помните…»', '#1c2a4f'));
      var items = PER_ITEM_COLOR[sec.type] ? (sec.items || []) : [];
      if (items.length) {
        p.appendChild(more(items.map(function (it) {
          return boxColorField(it, 'bg', 'Карточка «' + (it.title || 'без названия') + '»', cardHex(sec), 'Как у остальных карточек');
        })));
        p.lastChild.querySelector('summary').textContent = 'Отдельные карточки (' + items.length + ')';
      }
      v.appendChild(p);
    });
  }

  function drawBlocks(v) {
    var secs = state.data.sections;
    var list = h('div', { className: 'list blocks' });
    secs.forEach(function (sec, i) {
      var std = isStandard(sec.id);
      list.appendChild(h('div', { className: 'item' + (sec.hidden ? ' is-hidden' : '') }, [h('div', { className: 'item-head' }, [
        grip(secs, i, '.item', sec.title, function () { drawMenu(); go('blocks', true); }),
        h('div', { className: 'block-name' }, [sec.title || 'Без названия', h('small', { text: S.SECTION_TYPES[sec.type] + (std ? '' : ', свой блок') })]),
        sec.hidden ? h('span', { className: 'badge', text: 'скрыт' }) : null,
        h('button', { type: 'button', className: 'icon-btn', text: sec.hidden ? 'Показать' : 'Скрыть', onclick: function () { sec.hidden = !sec.hidden; changed(); } }),
        h('button', { type: 'button', className: 'icon-btn', text: 'Изменить', onclick: function () { go('sec:' + sec.id); } }),
        h('button', { type: 'button', className: 'icon-btn del', text: '✕', 'aria-label': 'Удалить блок', onclick: function () {
          if (!confirm('Удалить блок «' + sec.title + '»?' + (std ? ' Стандартный блок потом можно вернуть.' : ''))) return;
          secs.splice(i, 1); changed();
        } })
      ])]));
    });
    function changed() { markDirty(); drawMenu(); go('blocks', true); }

    var custom = { title: '', bg: 'cream', menu: true };
    var addPanel = panel('Новый блок', [
      textField(custom, 'title', 'Заголовок', { name: 'new-block-title' }),
      colorField(custom, 'bg', 'Фон', 'cream', BG_SWATCHES),
      checkField(custom, 'menu', 'Добавить пункт в меню'),
      h('button', { type: 'button', className: 'btn primary', text: 'Создать блок', onclick: function () {
        if (!custom.title.trim()) { toast('Введите заголовок блока', true); return; }
        var sec = { id: S.uid('block'), type: 'custom', title: custom.title.trim(), menuLabel: '', bg: custom.bg, text: '', points: '',
          photo: { src: '', frame: { x: 50, y: 50, z: 1 } }, button: { label: '', href: '' } };
        if (!custom.menu) sec.menu = false;
        var ci = secs.findIndex(function (s) { return s.type === 'contacts'; });
        secs.splice(ci < 0 ? secs.length : ci, 0, sec);
        markDirty(); drawMenu(); go('sec:' + sec.id);
      } })
    ]);

    var missing = (state.defaults && state.defaults.sections || []).filter(function (d) {
      return !secs.some(function (s) { return s.id === d.id; });
    });
    var restore = missing.length ? panel('Вернуть стандартный блок', missing.map(function (d) {
      return h('div', { className: 'inline', style: 'margin-bottom:8px' }, [h('span', { text: d.title, style: 'flex:1;font-weight:700' }),
        h('button', { type: 'button', className: 'btn small', text: 'Вернуть', onclick: function () {
          var di = state.defaults.sections.indexOf(d);
          var after = state.defaults.sections.slice(0, di).reverse().map(function (x) { return x.id; });
          var pos = secs.length;
          for (var k = 0; k < after.length; k++) {
            var idx = secs.findIndex(function (s) { return s.id === after[k]; });
            if (idx >= 0) { pos = idx + 1; break; }
          }
          if (pos === secs.length && di === 0) pos = 0;
          secs.splice(pos, 0, S.clone(d));
          changed();
        } })]);
    })) : null;

    v.appendChild(panel('Порядок блоков', [h('p', { className: 'muted', text: 'Шапка всегда наверху. Блоки ниже можно переставлять, скрывать и удалять.' }), list]));
    v.appendChild(addPanel);
    if (restore) v.appendChild(restore);
  }

  function drawBackup(v) {
    v.appendChild(panel('Резервная копия', [
      h('p', { className: 'muted', text: 'Скачайте файл content.json: в нём всё содержимое сайта. Его можно загрузить обратно или положить в проект как content/default.json.' }),
      h('div', { className: 'inline' }, [
        h('button', { type: 'button', className: 'btn', text: 'Скачать content.json', onclick: exportJson }),
        h('button', { type: 'button', className: 'btn', text: 'Загрузить из файла', onclick: importJson })
      ])
    ]));
    v.appendChild(panel('Обновления проекта', [
      h('p', { className: 'muted', text: 'Если в проект добавили новые материалы, их можно перенести на сайт. Ваши правки сохранятся.' }),
      h('button', { type: 'button', className: 'btn', text: 'Проверить новые материалы', onclick: function () { checkMerge(true); } })
    ]));
    if (MODE === 'supabase') {
      var pass = { a: '', b: '' };
      v.appendChild(panel('Смена пароля', [
        textField(pass, 'a', 'Новый пароль', { type: 'password', hint: 'Не короче 8 символов.' }),
        textField(pass, 'b', 'Повторите пароль', { type: 'password' }),
        h('button', { type: 'button', className: 'btn primary', text: 'Сменить пароль', onclick: function () {
          if (pass.a.length < 8) { toast('Пароль должен быть не короче 8 символов', true); return; }
          if (pass.a !== pass.b) { toast('Пароли не совпадают', true); return; }
          backend.changePassword(pass.a).then(function () { toast('Пароль изменён'); go('backup'); })
            .catch(function (e) { toast('Не удалось сменить пароль: ' + (e.message || ''), true); });
        } })
      ]));
    }
    v.appendChild(panel('Где хранится содержимое', [h('p', { text: {
      supabase: 'База данных Supabase. Если база недоступна, сайт покажет копию из content/default.json.',
      github: 'Файл content/default.json в репозитории GitHub. После сохранения сайт обновится примерно через минуту.',
      demo: 'Демо-режим: правки хранятся только в этом браузере. Чтобы правки видели все, подключите базу (README.md).'
    }[MODE] })]));
  }

  function exportJson() {
    var blob = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' });
    var a = h('a', { href: URL.createObjectURL(blob), download: 'content.json' });
    document.body.appendChild(a); a.click(); a.remove();
  }

  function importJson() {
    pickFiles('application/json,.json', false, function (files) {
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var data = JSON.parse(fr.result);
          if (!S.isValidContent(data)) throw new Error();
          if (!confirm('Заменить всё содержимое сайта данными из файла? Изменения вступят в силу после сохранения.')) return;
          state.data = data; normalize(state.data); markDirty(); drawMenu(); go('hero');
          toast('Файл загружен. Нажмите «Сохранить».');
        } catch (e) { toast('Это не файл содержимого сайта', true); }
      };
      fr.readAsText(files[0]);
    });
  }

  /* ---------- новые материалы из default.json ---------- */

  function collectIds(node, out) {
    if (Array.isArray(node)) node.forEach(function (x) { collectIds(x, out); });
    else if (node && typeof node === 'object') {
      if (typeof node.id === 'string') out.push(node.id);
      Object.keys(node).forEach(function (k) { if (node[k] && typeof node[k] === 'object') collectIds(node[k], out); });
    }
    return out;
  }

  function findNew(def, cur, known, out, label) {
    Object.keys(def).forEach(function (key) {
      var dv = def[key];
      if (Array.isArray(dv) && dv.length && dv[0] && typeof dv[0] === 'object' && 'id' in dv[0]) {
        // списка ещё нет (например, ссылки у старого достижения): он появится, когда материалы добавят
        if (cur[key] != null && !Array.isArray(cur[key])) return;
        var ca = Array.isArray(cur[key]) ? cur[key] : [];
        dv.forEach(function (d, di) {
          var match = ca.find(function (c) { return c && c.id === d.id; });
          if (match) { findNew(d, match, known, out, d.title || d.role || label); return; }
          if (known[d.id]) return;
          out.push({ parent: cur, key: key, item: d, defArr: dv, index: di, where: label, name: d.title || d.role || d.label || (d.type === 'video' ? 'видео' : 'фото') });
        });
      } else if (dv && typeof dv === 'object' && !Array.isArray(dv) && cur[key] && typeof cur[key] === 'object') {
        findNew(dv, cur[key], known, out, label);
      }
    });
    return out;
  }

  function checkMerge(manual) {
    var box = $('banners');
    box.innerHTML = '';
    if (!state.defaults || MODE === 'github') { if (manual) toast('Новых материалов нет'); return; }
    var known = {};
    (state.data.knownDefaults || []).forEach(function (id) { known[id] = true; });
    var found = findNew(state.defaults, state.data, known, [], '');
    if (!found.length) { if (manual) toast('Новых материалов нет'); return; }
    var names = {};
    found.forEach(function (f) { var n = f.where ? f.where + ': ' + f.name : f.name; names[n] = (names[n] || 0) + 1; });
    var ul = h('ul');
    Object.keys(names).slice(0, 8).forEach(function (n) { ul.appendChild(h('li', { text: n + (names[n] > 1 ? ' × ' + names[n] : '') })); });
    function remember() {
      state.data.knownDefaults = uniq((state.data.knownDefaults || []).concat(collectIds(found.map(function (f) { return f.item; }), [])));
    }
    box.appendChild(h('div', { className: 'banner' }, [
      h('p', { text: 'В проекте появились новые материалы (' + found.length + '). Их можно добавить на сайт, ваши правки не изменятся:' }), ul,
      h('div', { className: 'row' }, [
        h('button', { type: 'button', className: 'btn primary small', text: 'Добавить', onclick: function () {
          found.forEach(function (f) {
            if (!Array.isArray(f.parent[f.key])) f.parent[f.key] = [];
            var arr = f.parent[f.key];
            var prev = f.defArr.slice(0, f.index).reverse();
            var pos = arr.length;
            for (var k = 0; k < prev.length; k++) {
              var idx = arr.findIndex(function (c) { return c && c.id === prev[k].id; });
              if (idx >= 0) { pos = idx + 1; break; }
            }
            if (f.index === 0) pos = 0;
            arr.splice(pos, 0, S.clone(f.item));
          });
          remember(); markDirty(); drawMenu(); go(state.current); box.innerHTML = '';
          toast('Добавлено. Нажмите «Сохранить».');
        } }),
        h('button', { type: 'button', className: 'btn small', text: 'Не добавлять', onclick: function () { remember(); markDirty(); box.innerHTML = ''; } }),
        h('button', { type: 'button', className: 'btn ghost small', text: 'Позже', onclick: function () { box.innerHTML = ''; } })
      ])
    ]));
  }

  function uniq(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }

  /* ---------- навигация ---------- */

  function isStandard(id) {
    return !!(state.defaults && state.defaults.sections.some(function (s) { return s.id === id; }));
  }

  function drawMenu() {
    var menu = $('menu');
    menu.innerHTML = '';
    function item(key, label, off) {
      return h('button', { type: 'button', className: 'menu-item' + (state.current === key ? ' active' : ''), 'data-view': key,
        onclick: function () { go(key); } }, [label, off ? h('span', { className: 'off', text: '(скрыт)' }) : null]);
    }
    function group(label, items) {
      var g = h('div', { className: 'menu-group' }, [h('span', { text: label })]);
      items.forEach(function (i) { g.appendChild(i); });
      menu.appendChild(g);
    }
    group('Страница', [item('hero', 'Шапка'), item('blocks', 'Блоки страницы'), item('colors', 'Цвета')]);
    group('Содержимое', state.data.sections.map(function (s) { return item('sec:' + s.id, s.title || 'Без названия', s.hidden); }));
    group('Настройки', [item('seo', 'SEO и подвал'), item('backup', 'Копия и пароль')]);
  }

  function go(key, keepScroll) {
    var v = $('view');
    var secId = key.indexOf('sec:') === 0 ? key.slice(4) : null;
    var sec = secId && state.data.sections.find(function (s) { return s.id === secId; });
    if (secId && !sec) key = 'blocks';
    state.current = key;
    v.innerHTML = '';
    if (sec) {
      $('viewTitle').textContent = sec.title || 'Блок';
      var refresh = function () { $('viewTitle').textContent = sec.title || 'Блок'; drawMenu(); };
      v.appendChild(panel('Блок', sectionCommon(sec, refresh)));
      (editors[sec.type] || editors.custom)(sec, v);
    } else {
      $('viewTitle').textContent = views[key].title;
      views[key].draw(v);
    }
    drawMenu();
    $('side').classList.remove('open');
    $('menuBtn').setAttribute('aria-expanded', 'false');
    if (!keepScroll) window.scrollTo(0, 0);
  }

  /* ---------- данные ---------- */

  // Достраиваем недостающие поля, чтобы формы не падали на старом содержимом
  function normalize(d) {
    d.hero = d.hero || {};
    if (!d.hero.photo || typeof d.hero.photo !== 'object') d.hero.photo = { src: d.hero.photo || '', frame: { x: 50, y: 50, z: 1 } };
    d.sections.forEach(function (s) {
      if (['education', 'experience', 'courses', 'achievements', 'materials'].indexOf(s.type) >= 0 && !Array.isArray(s.items)) s.items = [];
      if (s.type === 'gallery' && !Array.isArray(s.albums)) s.albums = [];
      if ((s.type === 'about' || s.type === 'custom') && (!s.photo || typeof s.photo !== 'object')) s.photo = { src: '', frame: { x: 50, y: 50, z: 1 } };
    });
    return d;
  }

  function save() {
    if (!state.data) return;
    var btn = $('saveBtn');
    btn.disabled = true;
    btn.textContent = 'Сохраняю…';
    state.data.updatedAt = new Date().toISOString();
    if (state.defaults) state.data.knownDefaults = uniq((state.data.knownDefaults || []).concat(collectIds(state.data, []).filter(function (id) {
      return defaultIds[id];
    })));
    var snapshot = JSON.stringify(state.data);
    backend.save(JSON.parse(snapshot)).then(function () {
      state.saved = snapshot;
      markDirty();
      toast(MODE === 'github' ? 'Сохранено. Сайт обновится примерно через минуту.' : 'Сохранено');
    }).catch(function (e) {
      toast('Не удалось сохранить: ' + (e.message || 'нет связи с сервером'), true);
    }).then(function () {
      btn.disabled = false;
      btn.textContent = 'Сохранить';
    });
  }

  var defaultIds = {};

  function openEditor() {
    $('login').hidden = true;
    $('shell').hidden = false;
    $('modeLabel').textContent = backend.label;
    $('view').innerHTML = '<p class="muted">Загрузка содержимого…</p>';
    var defP = S.fetchDefault().catch(function () { return null; });
    var curP = backend.load().catch(function (e) {
      toast('Не удалось прочитать базу: ' + (e.message || '') + '. Показана резервная копия.', true);
      return null;
    });
    return Promise.all([defP, curP]).then(function (r) {
      state.defaults = r[0];
      collectIds(r[0] || {}, []).forEach(function (id) { defaultIds[id] = true; });
      var fromDb = r[1];
      state.data = normalize(S.clone(fromDb || r[0]));
      state.saved = fromDb ? JSON.stringify(state.data) : '';
      if (!fromDb && MODE !== 'github') {
        $('banners').appendChild(h('div', { className: 'banner info' }, [h('p', {
          text: MODE === 'demo' ? 'Демо-режим: база не подключена. Правки сохранятся только в этом браузере.' :
            'В базе пока нет содержимого. Проверьте тексты и нажмите «Сохранить», чтобы записать их в базу.'
        })]));
      }
      if (!fromDb) state.saved = MODE === 'demo' ? JSON.stringify(state.data) : '';
      drawMenu();
      go('hero');
      markDirty();
      if (fromDb) checkMerge(false);
      document.documentElement.setAttribute('data-ready', 'admin');
    });
  }

  /* ---------- вход ---------- */

  var loginMode = 'login';

  function showLogin(kind) {
    loginMode = kind || 'login';
    $('shell').hidden = true;
    $('login').hidden = false;
    var msg = $('loginMsg');
    msg.textContent = ''; msg.className = 'msg';
    $('loginFields').hidden = MODE === 'github' || loginMode === 'recovery';
    $('tokenFields').hidden = MODE !== 'github';
    $('newPassFields').hidden = loginMode !== 'recovery';
    $('forgotBtn').hidden = MODE !== 'supabase';
    $('forgotBtn').textContent = loginMode === 'forgot' ? 'Вернуться ко входу' : 'Забыли пароль?';
    $('loginPassword').parentNode.hidden = loginMode === 'forgot';
    $('loginBtn').textContent = { login: 'Войти', forgot: 'Отправить ссылку', recovery: 'Сохранить новый пароль' }[loginMode];
    $('loginHint').textContent = {
      login: MODE === 'github' ? 'Вставьте токен GitHub с доступом к репозиторию сайта.' : 'Войдите, чтобы изменить содержимое сайта.',
      forgot: 'Введите e-mail. Мы пришлём ссылку для смены пароля.',
      recovery: 'Придумайте новый пароль.'
    }[loginMode];
    document.documentElement.setAttribute('data-ready', 'login');
  }

  $('forgotBtn').addEventListener('click', function () { showLogin(loginMode === 'forgot' ? 'login' : 'forgot'); });

  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var msg = $('loginMsg');
    var btn = $('loginBtn');
    msg.textContent = ''; msg.className = 'msg';
    var email = $('loginEmail').value.trim();
    var job;
    if (loginMode === 'forgot') {
      if (!email) { msg.textContent = 'Введите e-mail'; return; }
      job = backend.resetPassword(email).then(function () {
        msg.textContent = 'Если такой адрес есть, письмо уже отправлено. Проверьте почту.'; msg.className = 'msg ok';
      });
    } else if (loginMode === 'recovery') {
      var np = $('newPassword').value;
      if (np.length < 8) { msg.textContent = 'Пароль должен быть не короче 8 символов'; return; }
      job = backend.changePassword(np).then(function () {
        history.replaceState(null, '', location.pathname);
        return backend.checkAdmin();
      }).then(function (ok) {
        if (!ok) throw new Error('У этой учётной записи нет прав на управление сайтом');
        toast('Пароль изменён');
        return openEditor();
      });
    } else if (MODE === 'github') {
      var token = $('loginToken').value;
      if (!token.trim()) { msg.textContent = 'Вставьте токен'; return; }
      job = backend.signIn(token, $('rememberToken').checked).then(openEditor);
    } else {
      var pass = $('loginPassword').value;
      if (!email || !pass) { msg.textContent = 'Введите e-mail и пароль'; return; }
      job = backend.signIn(email, pass).then(openEditor);
    }
    btn.disabled = true;
    job.catch(function (err) {
      msg.textContent = err && err.message ? err.message : 'Не получилось. Проверьте подключение к интернету.';
      msg.className = 'msg';
    }).then(function () { btn.disabled = false; });
  });

  $('logoutBtn').addEventListener('click', function () {
    if (isDirty() && !confirm('Есть несохранённые правки. Всё равно выйти?')) return;
    backend.signOut().then(function () {
      state.data = null;
      if (MODE === 'demo') location.href = 'index.html';
      else showLogin('login');
    });
  });

  $('saveBtn').addEventListener('click', save);
  $('menuBtn').addEventListener('click', function () {
    var open = $('side').classList.toggle('open');
    $('menuBtn').setAttribute('aria-expanded', String(open));
  });

  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S' || e.key === 'ы' || e.key === 'Ы')) {
      e.preventDefault();
      if (!$('shell').hidden) save();
    }
  });

  window.addEventListener('beforeunload', function (e) {
    if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
  });

  backend.start().then(function (ok) {
    if (ok) return openEditor();
    showLogin(/type=recovery/.test(location.hash) ? 'recovery' : 'login');
  }).catch(function () { showLogin('login'); });

  window.__admin = { state: state, mode: MODE };
})();
