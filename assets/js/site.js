/* Отрисовка публичной страницы из содержимого (Supabase или content/default.json). */
(function () {
  'use strict';

  var S = window.Site;
  var esc = S.esc;
  var BGS = ['cream', 'sky', 'powder', 'beige', 'navy'];

  function visible(list) {
    return (Array.isArray(list) ? list : []).filter(function (it) { return it && !it.hidden; });
  }

  function has(v) { return String(v == null ? '' : v).trim() !== ''; }

  function anchorId(id) { return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '') || 'block'; }

  function img(media, alt, extraClass) {
    var src = media && S.safeMediaUrl(media.src);
    if (!src) return '';
    return '<img class="frame-img' + (extraClass ? ' ' + extraClass : '') + '" src="' + esc(src) + '" alt="' + esc(alt || '') +
      '" loading="lazy" decoding="async" style="' + S.frameStyle(media.frame) + '">';
  }

  function link(href, label, cls) {
    var url = S.safeUrl(href);
    if (!url || !has(label)) return '';
    var ext = /^https?:/i.test(url) ? ' target="_blank" rel="noopener noreferrer"' : '';
    return '<a class="' + cls + '" href="' + esc(url) + '"' + ext + '>' + esc(label) + '</a>';
  }

  function head(sec, leadHtml) {
    return '<div class="section-head"><h2>' + esc(sec.title) + '</h2>' + (leadHtml ? '<div class="lead">' + leadHtml + '</div>' : '') + '</div>';
  }

  /* ---------- блоки ---------- */

  var renderers = {
    about: function (sec) {
      var text = S.paragraphs(sec.text);
      var photo = sec.photo && S.safeMediaUrl(sec.photo.src);
      if (!text && !has(sec.goal) && !photo) return '';
      return head(sec) + '<div class="about-grid' + (photo ? '' : ' no-photo') + '"><div class="about-text">' + text +
        (has(sec.goal) ? '<div class="goal">' + esc(sec.goal) + '</div>' : '') + '</div>' +
        (photo ? '<div class="about-photo">' + img(sec.photo, sec.photoAlt || 'Фото учителя') + '</div>' : '') + '</div>';
    },

    education: function (sec) {
      var items = visible(sec.items).filter(function (it) { return has(it.title) || has(it.text); });
      if (!items.length && !has(sec.text)) return '';
      return head(sec, S.paragraphs(sec.text)) + '<div class="grid-2">' + items.map(function (it) {
        var meta = [it.place, it.period].filter(has).map(esc).join(' · ');
        var ls = S.lines(it.text);
        return '<article class="card"><h3>' + esc(it.title) + '</h3>' + (meta ? '<div class="meta">' + meta + '</div>' : '') +
          (ls.length ? '<ul class="lines">' + ls.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>' : '') + '</article>';
      }).join('') + '</div>';
    },

    experience: function (sec) {
      var items = visible(sec.items).filter(function (it) { return has(it.role) || has(it.points); });
      if (!items.length && !has(sec.text)) return '';
      return head(sec, S.paragraphs(sec.text)) + '<div class="timeline">' + items.map(function (it) {
        var pts = S.lines(it.points);
        return '<article class="tl-item"><div>' + (has(it.period) ? '<div class="tl-when">' + esc(it.period) + '</div>' : '') +
          (has(it.org) ? '<div class="tl-org">' + esc(it.org) + '</div>' : '') + '</div><div><h3>' + esc(it.role) + '</h3>' +
          (pts.length ? '<ul class="dots">' + pts.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>' : '') + '</div></article>';
      }).join('') + '</div>';
    },

    courses: function (sec) {
      var items = visible(sec.items).filter(function (it) { return has(it.title); });
      if (!items.length && !has(sec.text)) return '';
      return head(sec, S.paragraphs(sec.text)) + (items.length ? '<div class="grid-2">' + items.map(function (it) {
        var meta = [it.org, it.year, it.hours ? it.hours + ' ч' : ''].filter(has).map(esc).join(' · ');
        return '<article class="card"><h3>' + esc(it.title) + '</h3>' + (meta ? '<div class="meta">' + meta + '</div>' : '') +
          (has(it.text) ? '<div class="body">' + S.paragraphs(it.text) + '</div>' : '') +
          link(it.link, 'Документ', 'link-btn') + '</article>';
      }).join('') + '</div>' : '');
    },

    achievements: function (sec, ctx) {
      var items = visible(sec.items).filter(function (it) { return has(it.title); });
      if (!items.length) return '';
      var cats = S.lines(sec.categories).filter(function (c) {
        return items.some(function (it) { return it.category === c; });
      });
      var chips = cats.length > 1 ? '<div class="chips" role="group" aria-label="Фильтр достижений"><button type="button" class="chip" data-filter="" aria-pressed="true">Все<span class="count">' +
        items.length + '</span></button>' + cats.map(function (c) {
          var n = items.filter(function (it) { return it.category === c; }).length;
          return '<button type="button" class="chip" data-filter="' + esc(c) + '" aria-pressed="false">' + esc(c) + '<span class="count">' + n + '</span></button>';
        }).join('') + '</div>' : '';
      var allCats = S.lines(sec.categories);
      return head(sec, S.paragraphs(sec.text)) + chips + '<div class="ach-grid">' + items.map(function (it) {
        var scans = visible(it.scans).filter(function (s) { return S.safeMediaUrl(s.src); });
        var key = ctx.addGallery(scans.map(function (s) { return { type: 'photo', src: s.src, caption: it.title }; }));
        var ci = allCats.indexOf(it.category);
        var cover = scans.length ? '<button type="button" class="cover" data-open="' + key + '" data-index="0" aria-label="Открыть документ: ' + esc(it.title) + '">' +
          img(scans[0], it.title) + '</button>' : '<div class="cover cover-plain"></div>';
        return '<article class="card ach" data-category="' + esc(it.category || '') + '">' + cover + '<div class="ach-body">' +
          (has(it.category) ? '<span class="tag t' + (ci < 0 ? 0 : ci % 3) + '">' + esc(it.category) + '</span>' : '') +
          '<h3>' + esc(it.title) + '</h3>' + (has(it.org) ? '<div class="org">' + esc(it.org) + '</div>' : '') +
          (has(it.text) ? '<div class="desc">' + esc(it.text) + '</div>' : '') +
          (scans.length ? '<button type="button" class="link-btn" data-open="' + key + '" data-index="0">' +
            (scans.length > 1 ? 'Документы (' + scans.length + ')' : 'Смотреть документ') + '</button>' : '') +
          '</div></article>';
      }).join('') + '</div>';
    },

    gallery: function (sec, ctx) {
      var albums = visible(sec.albums).filter(function (a) { return has(a.title); });
      if (!albums.length) return '';
      var html = head(sec, S.paragraphs(sec.text));
      if (albums.length > 1) {
        html += '<div class="albums" role="tablist">' + albums.map(function (a, i) {
          var n = visible(a.items).length;
          return '<button type="button" class="chip" role="tab" data-album="' + i + '" aria-pressed="' + (i === 0) + '">' + esc(a.title) +
            (n ? '<span class="count">' + n + '</span>' : '') + '</button>';
        }).join('') + '</div>';
      }
      html += albums.map(function (a, i) {
        var items = visible(a.items).filter(function (m) { return S.safeMediaUrl(m.src); });
        var key = ctx.addGallery(items.map(function (m) {
          return { type: m.type === 'video' ? 'video' : 'photo', src: m.src, poster: m.poster, caption: m.caption, start: m.start, end: m.end };
        }));
        var grid = items.length ? '<div class="media-grid">' + items.map(function (m, j) {
          var inner;
          if (m.type === 'video') {
            inner = S.safeMediaUrl(m.poster) ? img({ src: m.poster, frame: m.frame }, 'Видео') :
              '<video class="frame-img" muted playsinline preload="metadata" src="' + esc(S.safeMediaUrl(m.src)) + '#t=' + (Number(m.start) || 0.5) +
              '" style="' + S.frameStyle(m.frame) + '"></video>';
            inner += '<span class="play" aria-hidden="true"></span>';
          } else {
            inner = img(m, m.caption || a.title);
          }
          return '<figure style="margin:0"><button type="button" class="media-tile" data-open="' + key + '" data-index="' + j + '" aria-label="' +
            (m.type === 'video' ? 'Смотреть видео' : 'Открыть фото') + ' ' + (j + 1) + '">' + inner + '</button>' +
            (has(m.caption) ? '<figcaption class="media-caption">' + esc(m.caption) + '</figcaption>' : '') + '</figure>';
        }).join('') + '</div>' : '<div class="empty-album">' + esc(sec.emptyText || 'Скоро здесь появятся фотографии.') + '</div>';
        return '<div class="album" data-album-panel="' + i + '"' + (i === 0 ? '' : ' hidden') + '>' +
          (has(a.text) ? '<div class="album-text">' + S.paragraphs(a.text) + '</div>' : '') + grid + '</div>';
      }).join('');
      if (has(sec.note)) html += '<p class="note">' + esc(sec.note) + '</p>';
      return html;
    },

    materials: function (sec) {
      var items = visible(sec.items).filter(function (it) { return has(it.title); });
      if (!items.length && !has(sec.text) && !has(sec.remember)) return '';
      return head(sec, S.paragraphs(sec.text)) + (items.length ? '<div class="mat-list">' + items.map(function (it, i) {
        var url = S.safeUrl(it.link);
        var title = url ? link(url, it.title, '') : esc(it.title);
        return '<article class="card mat"><span class="num">' + (i + 1) + '</span><div><h3>' + title + '</h3>' +
          (has(it.text) ? '<div class="body">' + esc(it.text) + '</div>' : '') + '</div></article>';
      }).join('') + '</div>' : '') + (has(sec.remember) ? '<div class="remember">' + esc(sec.remember) + '</div>' : '');
    },

    contacts: function (sec) {
      var rows = [];
      function tg(v) {
        v = String(v || '').trim();
        if (/^https?:/i.test(v)) return v;
        return 'https://t.me/' + v.replace(/^@/, '').replace(/[^a-zA-Z0-9_]/g, '');
      }
      function vk(v) {
        v = String(v || '').trim();
        if (/^https?:/i.test(v)) return v;
        return 'https://vk.com/' + v.replace(/^@/, '').replace(/[^a-zA-Z0-9_.]/g, '');
      }
      if (has(sec.phone)) rows.push(['Телефон', sec.phone, 'tel:' + String(sec.phone).replace(/[^\d+]/g, '')]);
      if (has(sec.email)) rows.push(['E-mail', sec.email, 'mailto:' + String(sec.email).trim()]);
      if (has(sec.telegram)) rows.push(['Telegram', sec.telegram, tg(sec.telegram)]);
      if (has(sec.vk)) rows.push(['ВКонтакте', sec.vk, vk(sec.vk)]);
      if (has(sec.place)) rows.push(['Где работаю', sec.place, '']);
      if (!rows.length && !has(sec.text)) return '';
      return head(sec, S.paragraphs(sec.text)) + '<div class="contact-grid">' + rows.map(function (r) {
        var url = S.safeUrl(r[2]);
        var inner = '<span class="k">' + esc(r[0]) + '</span><span class="v">' + esc(r[1]) + '</span>';
        if (!url) return '<div class="contact">' + inner + '</div>';
        var ext = /^https?:/i.test(url) ? ' target="_blank" rel="noopener noreferrer"' : '';
        return '<a class="contact" href="' + esc(url) + '"' + ext + '>' + inner + '</a>';
      }).join('') + '</div>';
    },

    custom: function (sec) {
      var text = S.paragraphs(sec.text);
      var pts = S.lines(sec.points);
      var photo = sec.photo && S.safeMediaUrl(sec.photo.src);
      var btn = sec.button ? link(sec.button.href, sec.button.label, 'btn') : '';
      if (!text && !pts.length && !photo && !btn) return '';
      var body = '<div>' + text + (pts.length ? '<ul class="dots">' + pts.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>' : '') +
        (btn ? '<div class="buttons">' + btn + '</div>' : '') + '</div>';
      return head(sec) + (photo ? '<div class="custom-grid">' + body + '<div class="custom-photo">' + img(sec.photo, sec.title) + '</div></div>' : body);
    }
  };

  /* ---------- шапка ---------- */

  function renderHero(h, cards) {
    var photo = h.photo && S.safeMediaUrl(h.photo.src);
    var buttons = visible(h.buttons).map(function (b, i) { return link(b.href, b.label, i === 0 ? 'btn' : 'btn alt'); }).filter(Boolean);
    var cardList = visible(cards).filter(function (c) { return has(c.title) || has(c.text); });
    return '<header class="hero" id="top"><div class="wrap"><div class="hero-grid"><div>' +
      (has(h.kicker) ? '<div class="hero-kicker">' + esc(h.kicker) + '</div>' : '') +
      '<h1>' + esc(h.name) + '</h1>' +
      (has(h.role) ? '<div class="hero-role">' + esc(h.role) + '</div>' : '') +
      (has(h.epigraph) ? '<blockquote class="epigraph"><p>«' + esc(h.epigraph) + '»</p>' + (has(h.epigraphAuthor) ? '<cite>' + esc(h.epigraphAuthor) + '</cite>' : '') + '</blockquote>' : '') +
      (has(h.text) ? '<div class="hero-text">' + S.paragraphs(h.text) + '</div>' : '') +
      (buttons.length ? '<div class="buttons">' + buttons.join('') + '</div>' : '') +
      '</div>' + (photo ? '<div class="portrait"><div class="circle">' + img(h.photo, h.photoAlt || h.name) + '</div></div>' : '') + '</div>' +
      (cardList.length ? '<div class="hero-cards">' + cardList.map(function (c) {
        return '<div class="hero-card">' + (has(c.title) ? '<h3>' + esc(c.title) + '</h3>' : '') + (has(c.text) ? '<p>' + esc(c.text) + '</p>' : '') + '</div>';
      }).join('') + '</div>' : '') + '</div></header>';
  }

  /* ---------- лайтбокс ---------- */

  var galleries = [];
  var lb = null;
  var lbState = { list: [], index: 0, opener: null };

  function buildLightbox() {
    lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.setAttribute('role', 'dialog');
    lb.setAttribute('aria-modal', 'true');
    lb.setAttribute('aria-label', 'Просмотр');
    lb.innerHTML = '<span class="lb-count"></span><figure></figure>' +
      '<button type="button" class="lb-btn lb-close" aria-label="Закрыть">✕</button>' +
      '<button type="button" class="lb-btn lb-prev" aria-label="Назад">‹</button>' +
      '<button type="button" class="lb-btn lb-next" aria-label="Вперёд">›</button>';
    document.body.appendChild(lb);
    lb.querySelector('.lb-close').addEventListener('click', closeLightbox);
    lb.querySelector('.lb-prev').addEventListener('click', function () { step(-1); });
    lb.querySelector('.lb-next').addEventListener('click', function () { step(1); });
    lb.addEventListener('click', function (e) { if (e.target === lb) closeLightbox(); });
    document.addEventListener('keydown', function (e) {
      if (!lb.classList.contains('open')) return;
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
    });
    var sx = null;
    lb.addEventListener('touchstart', function (e) { sx = e.touches[0].clientX; }, { passive: true });
    lb.addEventListener('touchend', function (e) {
      if (sx == null) return;
      var dx = e.changedTouches[0].clientX - sx;
      if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
      sx = null;
    });
  }

  function showItem() {
    var it = lbState.list[lbState.index];
    var fig = lb.querySelector('figure');
    var src = S.safeMediaUrl(it.src);
    var html;
    if (it.type === 'video') {
      var frag = '';
      var st = Number(it.start) || 0, en = Number(it.end) || 0;
      if (st || en) frag = '#t=' + st + (en > st ? ',' + en : '');
      var poster = S.safeMediaUrl(it.poster);
      html = '<video controls playsinline preload="metadata" src="' + esc(src + frag) + '"' + (poster ? ' poster="' + esc(poster) + '"' : '') + '></video>';
    } else {
      html = '<img src="' + esc(src) + '" alt="' + esc(it.caption || '') + '">';
    }
    fig.innerHTML = html + (has(it.caption) ? '<figcaption>' + esc(it.caption) + '</figcaption>' : '');
    var many = lbState.list.length > 1;
    lb.querySelector('.lb-count').textContent = many ? (lbState.index + 1) + ' из ' + lbState.list.length : '';
    lb.querySelector('.lb-prev').hidden = !many;
    lb.querySelector('.lb-next').hidden = !many;
  }

  function step(d) {
    var n = lbState.list.length;
    if (n < 2) return;
    lbState.index = (lbState.index + d + n) % n;
    showItem();
  }

  function openLightbox(list, index, opener) {
    if (!list || !list.length) return;
    if (!lb) buildLightbox();
    lbState = { list: list, index: index || 0, opener: opener };
    showItem();
    lb.classList.add('open');
    document.body.style.overflow = 'hidden';
    lb.querySelector('.lb-close').focus();
  }

  function closeLightbox() {
    lb.classList.remove('open');
    lb.querySelector('figure').innerHTML = '';
    document.body.style.overflow = '';
    if (lbState.opener) lbState.opener.focus();
  }

  /* ---------- страница ---------- */

  function setMeta(data) {
    var seo = data.seo || {};
    if (has(seo.title)) document.title = seo.title;
    function meta(sel, val) { var el = document.querySelector(sel); if (el && has(val)) el.setAttribute('content', val); }
    meta('meta[name="description"]', seo.description);
    meta('meta[property="og:title"]', seo.title);
    meta('meta[property="og:description"]', seo.description);
    meta('meta[property="og:image"]', S.safeMediaUrl(seo.ogImage && typeof seo.ogImage === 'object' ? seo.ogImage.src : seo.ogImage));
  }

  function render(data, source) {
    galleries = [];
    var ctx = { addGallery: function (list) { galleries.push(list); return galleries.length - 1; } };
    var hero = data.hero || {};
    var blocks = [];
    var nav = [];
    visible(data.sections).forEach(function (sec, i) {
      var fn = renderers[sec.type];
      if (!fn) return;
      var inner = fn(sec, ctx);
      if (!inner) return;
      var id = anchorId(sec.id);
      var bg = BGS.indexOf(sec.bg) >= 0 ? sec.bg : (i % 2 ? 'beige' : 'cream');
      blocks.push('<section class="section bg-' + bg + '" id="' + id + '" data-type="' + esc(sec.type) + '"><div class="wrap">' + inner + '</div></section>');
      if (sec.menu !== false) nav.push('<a href="#' + id + '">' + esc(sec.menuLabel || sec.title) + '</a>');
    });

    var demo = source === 'demo' ? '<div class="demo-bar">Демо-режим: показаны правки, сохранённые в этом браузере</div>' : '';
    var year = new Date().getFullYear();
    document.getElementById('app').innerHTML = demo +
      '<div class="topbar"><div class="wrap"><a class="brand" href="#top">' + esc(hero.name || '') + '</a>' +
      (nav.length ? '<button type="button" class="nav-toggle" aria-expanded="false" aria-controls="nav">Меню</button><nav class="nav" id="nav" aria-label="Разделы">' + nav.join('') + '</nav>' : '') +
      '</div></div>' + renderHero(hero, hero.cards) + '<main>' + blocks.join('') + '</main>' +
      '<footer class="footer"><div class="wrap"><span>© ' + year + ' ' + esc(hero.name || '') + '</span><span>' + esc(data.footer || hero.kicker || '') + '</span></div></footer>';

    setMeta(data);
    bind();
  }

  function bind() {
    var app = document.getElementById('app');
    var toggle = app.querySelector('.nav-toggle');
    var nav = app.querySelector('.nav');
    if (toggle) {
      toggle.addEventListener('click', function () {
        var open = nav.classList.toggle('open');
        toggle.setAttribute('aria-expanded', String(open));
      });
      nav.addEventListener('click', function (e) {
        if (e.target.closest('a')) { nav.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); }
      });
    }

    app.addEventListener('click', function (e) {
      var opener = e.target.closest('[data-open]');
      if (opener) {
        openLightbox(galleries[Number(opener.getAttribute('data-open'))], Number(opener.getAttribute('data-index')), opener);
        return;
      }
      var chip = e.target.closest('.chips .chip');
      if (chip) {
        var cat = chip.getAttribute('data-filter');
        var sec = chip.closest('section');
        sec.querySelectorAll('.chips .chip').forEach(function (c) { c.setAttribute('aria-pressed', String(c === chip)); });
        sec.querySelectorAll('.ach').forEach(function (card) {
          card.hidden = !!cat && card.getAttribute('data-category') !== cat;
        });
        return;
      }
      var tab = e.target.closest('[data-album]');
      if (tab) {
        var s = tab.closest('section');
        var n = tab.getAttribute('data-album');
        s.querySelectorAll('[data-album]').forEach(function (t) { t.setAttribute('aria-pressed', String(t === tab)); });
        s.querySelectorAll('[data-album-panel]').forEach(function (p) { p.hidden = p.getAttribute('data-album-panel') !== n; });
      }
    });

    reveal(app);

    if (location.hash) {
      var target = document.getElementById(location.hash.slice(1));
      if (target) target.scrollIntoView();
    }
  }

  // Блоки плавно появляются, когда доходят до экрана
  var REVEAL = '.hero-grid > *, .hero-card, .section-head, .chips, .albums, .about-text, .about-photo, .card, .tl-item, ' +
    '.album-text, .media-tile, .empty-album, .remember, .contact, .custom-photo, .note';

  function reveal(root) {
    if (!('IntersectionObserver' in window)) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var items = root.querySelectorAll(REVEAL);
    var io = new IntersectionObserver(function (entries) {
      // элементы, вошедшие в экран одновременно, появляются друг за другом
      entries.filter(function (e) { return e.isIntersecting; }).forEach(function (e, i) {
        e.target.style.setProperty('--d', Math.min(i, 5) * 90 + 'ms');
        e.target.classList.add('in');
        io.unobserve(e.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    Array.prototype.forEach.call(items, function (el) {
      el.classList.add('rv');
      io.observe(el);
    });
    document.documentElement.classList.add('reveal-on');
  }

  S.loadContent().then(function (res) {
    window.__siteSource = res.source;
    render(res.data, res.source);
    document.documentElement.setAttribute('data-ready', res.source);
  }).catch(function () {
    document.getElementById('app').innerHTML = '<div class="loading">Не удалось загрузить содержимое сайта. Обновите страницу.</div>';
    document.documentElement.setAttribute('data-ready', 'error');
  });

  S.render = render;
})();
