/* Общие функции сайта и админки: безопасный вывод, кадрирование, загрузка содержимого. */
(function (global) {
  'use strict';

  var CFG = global.SITE_CONFIG || {};
  var DEMO_KEY = 'teacherSite.demoContent';
  var DEFAULT_URL = 'content/default.json';

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Ссылки: только http(s), mailto, tel и относительные адреса
  function safeUrl(value) {
    var url = String(value == null ? '' : value).trim();
    if (!url) return '';
    if (/[\u0000-\u001f]/.test(url)) return '';
    if (/^(https?:|mailto:|tel:)/i.test(url)) return url;
    if (/^\/\//.test(url) || /^\\/.test(url)) return '';
    if (/^[a-z][a-z0-9+.\-]*:/i.test(url)) return '';
    return url;
  }

  // Для картинок и видео дополнительно разрешены data:image (демо-режим) и blob:
  function safeMediaUrl(value) {
    var url = String(value == null ? '' : value).trim();
    if (/^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+\/=]+$/i.test(url)) return url;
    if (/^blob:https?:\/\//i.test(url)) return url;
    return safeUrl(url);
  }

  function clamp(n, min, max, def) {
    n = Number(n);
    if (!isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  }

  function normFrame(frame) {
    frame = frame || {};
    return { x: clamp(frame.x, 0, 100, 50), y: clamp(frame.y, 0, 100, 50), z: clamp(frame.z, 1, 4, 1) };
  }

  // Файл не обрезается: точка кадра задаётся object-position, приближение transform: scale
  function frameStyle(frame) {
    var f = normFrame(frame);
    return 'object-position:' + f.x + '% ' + f.y + '%;transform-origin:' + f.x + '% ' + f.y + '%;transform:scale(' + f.z + ')';
  }

  function paragraphs(text) {
    return String(text || '').split(/\n\s*\n/).map(function (p) { return p.trim(); }).filter(Boolean)
      .map(function (p) { return '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>'; }).join('');
  }

  function lines(text) {
    return String(text || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
  }

  function uid(prefix) {
    return (prefix || 'id') + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  function isValidContent(data) {
    return !!(data && typeof data === 'object' && data.hero && Array.isArray(data.sections));
  }

  function mode() {
    if (CFG.supabaseUrl && CFG.supabaseKey) return 'supabase';
    if (CFG.github && CFG.github.owner && CFG.github.repo) return 'github';
    return 'demo';
  }

  function restHeaders() {
    var key = CFG.supabaseKey;
    var headers = { apikey: key, Accept: 'application/json' };
    // Ключ sb_publishable_ не является JWT, поэтому шлём его только в apikey
    if (!/^sb_/.test(key)) headers.Authorization = 'Bearer ' + key;
    return headers;
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('timeout')); }, ms);
      promise.then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); });
    });
  }

  function fetchDefault() {
    return fetch(DEFAULT_URL + '?v=' + Date.now(), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('default.json: ' + r.status);
      return r.json();
    });
  }

  function fetchSupabase() {
    var base = String(CFG.supabaseUrl).replace(/\/+$/, '');
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var req = fetch(base + '/rest/v1/site_content?id=eq.1&select=data', {
      headers: restHeaders(), cache: 'no-store', signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      if (!r.ok) throw new Error('supabase: ' + r.status);
      return r.json();
    }).then(function (rows) {
      var data = rows && rows[0] && rows[0].data;
      if (!isValidContent(data)) throw new Error('empty');
      return data;
    });
    return withTimeout(req, CFG.timeoutMs || 5000).catch(function (e) {
      if (ctrl) ctrl.abort();
      throw e;
    });
  }

  function readDemo() {
    try {
      var raw = global.localStorage.getItem(DEMO_KEY);
      var data = raw ? JSON.parse(raw) : null;
      return isValidContent(data) ? data : null;
    } catch (e) { return null; }
  }

  function writeDemo(data) {
    global.localStorage.setItem(DEMO_KEY, JSON.stringify(data));
  }

  // Сайт: сначала база (5 с), при ошибке резервная копия content/default.json
  function loadContent() {
    var m = mode();
    if (m === 'supabase') {
      return fetchSupabase().then(function (data) { return { data: data, source: 'supabase' }; })
        .catch(function () { return fetchDefault().then(function (data) { return { data: data, source: 'default' }; }); });
    }
    if (m === 'demo') {
      var demo = readDemo();
      if (demo) return Promise.resolve({ data: demo, source: 'demo' });
    }
    return fetchDefault().then(function (data) { return { data: data, source: 'default' }; });
  }

  // Стандартные блоки сайта
  var SECTION_TYPES = {
    about: 'Обо мне',
    education: 'Образование',
    experience: 'Опыт работы',
    courses: 'Повышение квалификации',
    achievements: 'Достижения',
    gallery: 'Фотографии',
    materials: 'Материалы',
    contacts: 'Контакты',
    custom: 'Свой блок'
  };

  global.Site = {
    config: CFG,
    esc: esc,
    safeUrl: safeUrl,
    safeMediaUrl: safeMediaUrl,
    normFrame: normFrame,
    frameStyle: frameStyle,
    paragraphs: paragraphs,
    lines: lines,
    uid: uid,
    clone: clone,
    isValidContent: isValidContent,
    mode: mode,
    restHeaders: restHeaders,
    withTimeout: withTimeout,
    fetchDefault: fetchDefault,
    readDemo: readDemo,
    writeDemo: writeDemo,
    loadContent: loadContent,
    SECTION_TYPES: SECTION_TYPES,
    DEMO_KEY: DEMO_KEY
  };
})(window);
