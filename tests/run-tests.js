// Автотесты сайта и админки. Supabase имитируется. Запуск: npm install && npm test
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { start } = require('./serve');

const ROOT = path.resolve(__dirname, '..');
const PORT = 18080;
const BASE = `http://127.0.0.1:${PORT}`;
const SB = 'https://demo-project.supabase.co';
const KEY = 'sb_publishable_test_key_123';
const OUT = path.join(__dirname, 'output');
const DEFAULT = JSON.parse(fs.readFileSync(path.join(ROOT, 'content/default.json'), 'utf8'));

const SB_CONFIG = `window.SITE_CONFIG = { supabaseUrl: '${SB}', supabaseKey: '${KEY}', bucket: 'media', timeoutMs: 5000, github: {} };`;

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function b64url(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }
function jwt(user) {
  return b64url({ alg: 'HS256', typ: 'JWT' }) + '.' + b64url({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.c2ln';
}

// supabase-js отправляет Blob как multipart/form-data: достаём сам файл
function parseUpload(type, body) {
  const m = /boundary=(.+)$/.exec(type || '');
  if (!m) return { type, body };
  const sep = Buffer.from('--' + m[1]);
  let pos = body.indexOf(sep);
  while (pos >= 0) {
    const headEnd = body.indexOf('\r\n\r\n', pos);
    if (headEnd < 0) break;
    const head = body.slice(pos, headEnd).toString();
    const end = body.indexOf(Buffer.from('\r\n--' + m[1]), headEnd);
    const ct = /Content-Type:\s*([^\r\n]+)/i.exec(head);
    if (ct) return { type: ct[1].trim(), body: body.slice(headEnd + 4, end) };
    pos = end + 2;
  }
  return { type: 'application/octet-stream', body };
}

// Имитация Supabase: REST, Auth, Storage
function mockSupabase(opts = {}) {
  const db = {
    content: opts.content === undefined ? clone(DEFAULT) : opts.content,
    users: [
      { id: '11111111-1111-1111-1111-111111111111', email: 'teacher@test.ru', password: 'secret-pass', admin: true },
      { id: '22222222-2222-2222-2222-222222222222', email: 'parent@test.ru', password: 'secret-pass', admin: false }
    ],
    files: {},
    publicReads: [],
    saves: 0
  };
  const userByToken = (req) => {
    const a = req.headers()['authorization'] || '';
    const parts = a.replace(/^Bearer /, '').split('.');
    if (parts.length !== 3) return null;
    try {
      const sub = JSON.parse(Buffer.from(parts[1], 'base64url').toString()).sub;
      return db.users.find((u) => u.id === sub) || null;
    } catch (e) { return null; }
  };
  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: body === undefined ? '' : JSON.stringify(body) });

  async function handler(route) {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const method = req.method();
    if (method === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    }
    if (opts.fail) return route.abort('failed');
    if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
    const user = userByToken(req);

    if (p === '/rest/v1/site_content' && method === 'GET') {
      db.publicReads.push(req.headers());
      return json(route, 200, db.content ? [{ data: db.content }] : []);
    }
    if (p === '/rest/v1/site_content' && (method === 'POST' || method === 'PATCH')) {
      if (!user || !user.admin) return json(route, 403, { message: 'permission denied' });
      const body = JSON.parse(req.postData());
      db.content = (Array.isArray(body) ? body[0] : body).data;
      db.saves++;
      return json(route, 201);
    }
    if (p === '/rest/v1/rpc/is_admin') return json(route, 200, !!(user && user.admin));
    if (p === '/auth/v1/token') {
      const body = JSON.parse(req.postData() || '{}');
      const u = db.users.find((x) => x.email === body.email && x.password === body.password);
      if (!u) return json(route, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 'invalid_credentials' });
      return json(route, 200, {
        access_token: jwt(u), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'refresh-' + u.id,
        user: { id: u.id, email: u.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }
      });
    }
    if (p === '/auth/v1/user') {
      if (!user) return json(route, 401, { message: 'no user' });
      if (method === 'PUT') user.password = JSON.parse(req.postData()).password;
      return json(route, 200, { id: user.id, email: user.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} });
    }
    if (p === '/auth/v1/logout') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
    if (p === '/auth/v1/recover') return json(route, 200, {});
    if (p.startsWith('/storage/v1/object/public/media/')) {
      const f = db.files[p.replace('/storage/v1/object/public/media/', '')];
      if (!f) return route.fulfill({ status: 404 });
      return route.fulfill({ status: 200, contentType: f.type, headers: { 'access-control-allow-origin': '*' }, body: f.body });
    }
    if (p.startsWith('/storage/v1/object/media/') && method === 'POST') {
      if (!user || !user.admin) return json(route, 403, { message: 'denied' });
      const key = p.replace('/storage/v1/object/media/', '');
      db.files[key] = parseUpload(req.headers()['content-type'], req.postDataBuffer());
      return json(route, 200, { Key: 'media/' + key, Id: key });
    }
    return json(route, 404, { message: 'not mocked: ' + method + ' ' + p });
  }
  return { db, handler };
}

async function newPage(browser, opts = {}) {
  const context = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 900 }, acceptDownloads: true });
  const mock = mockSupabase(opts);
  if (opts.config !== 'real') {
    await context.route('**/config.js', (route) => route.fulfill({ contentType: 'text/javascript', body: opts.config || SB_CONFIG }));
  }
  await context.route(SB + '/**', mock.handler);
  if (opts.offline) {
    await context.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort('internetdisconnected'));
  }
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  return { context, page, db: mock.db };
}

async function openSite(page, url = '/index.html') {
  await page.goto(BASE + url);
  await page.waitForSelector('html[data-ready]', { timeout: 15000 });
  return page.getAttribute('html', 'data-ready');
}

async function login(page, email = 'teacher@test.ru', password = 'secret-pass') {
  await page.goto(BASE + '/admin.html');
  await page.waitForSelector('html[data-ready="login"]');
  await page.fill('#loginEmail', email);
  await page.fill('#loginPassword', password);
  await page.click('#loginBtn');
}

async function loginOk(page) {
  await login(page);
  await page.waitForSelector('html[data-ready="admin"]', { timeout: 15000 });
}

async function menu(page, label) {
  await page.click(`#menu .menu-item:text-is("${label}")`);
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------------- сайт ---------------- */

test('Сайт берёт содержимое из базы, ключ только в apikey', async (b) => {
  const content = clone(DEFAULT);
  content.hero.kicker = 'Из базы данных';
  const { page, db, context } = await newPage(b, { content });
  const src = await openSite(page);
  assert(src === 'supabase', 'источник: ' + src);
  assert((await page.textContent('.hero-kicker')) === 'Из базы данных', 'нет текста из базы');
  const h = db.publicReads[0];
  assert(h.apikey === KEY, 'нет заголовка apikey');
  assert(!h.authorization, 'ключ sb_publishable_ ушёл в Authorization');
  for (const id of ['about', 'education', 'experience', 'courses', 'achievements', 'photos', 'students', 'parents', 'contacts']) {
    assert(await page.$('#' + id), 'нет блока ' + id);
  }
  assert((await page.textContent('h1')).includes('Шумилова Дарья Александровна'), 'нет ФИО');
  assert(await page.$('.portrait .circle img'), 'нет фото в круге');
  assert((await page.$$('.hero-card')).length === 3, 'должно быть 3 карточки');
  assert(page.errors.length === 0, 'ошибки JS: ' + page.errors.join('; '));
  await page.screenshot({ path: path.join(OUT, 'site-desktop.png'), fullPage: true });
  await context.close();
});

test('В текстах нет длинных тире', async (b) => {
  const raw = fs.readFileSync(path.join(ROOT, 'content/default.json'), 'utf8');
  assert(!/[—–]/.test(raw), 'тире в default.json');
  const { page, context } = await newPage(b);
  await openSite(page);
  const text = await page.evaluate(() => document.body.innerText);
  assert(!/[—–]/.test(text), 'тире на странице');
  await context.close();
});

test('Достижения: фильтр по категориям и лайтбокс', async (b) => {
  const { page, context } = await newPage(b);
  await openSite(page);
  const visibleCards = () => page.$$eval('#achievements .ach', (els) => els.filter((e) => !e.hidden).length);
  assert(await visibleCards() === 8, 'всего должно быть 8');
  await page.click('#achievements .chip[data-filter="Спортивные"]');
  assert(await visibleCards() === 4, 'спортивных должно быть 4');
  await page.click('#achievements .chip[data-filter=""]');
  assert(await visibleCards() === 8, 'фильтр «Все» не вернул карточки');
  await page.click('#achievements button.link-btn:has-text("Документы (2)")');
  await page.waitForSelector('.lightbox.open img');
  assert((await page.textContent('.lb-count')) === '1 из 2', 'счётчик лайтбокса');
  await page.click('.lb-next');
  assert((await page.textContent('.lb-count')) === '2 из 2', 'листание лайтбокса');
  await page.keyboard.press('Escape');
  assert(!(await page.$('.lightbox.open')), 'лайтбокс не закрылся');
  await context.close();
});

test('Фотографии: сначала фото, потом видео; пустые альбомы с описанием', async (b) => {
  const { page, context } = await newPage(b);
  await openSite(page);
  const kinds = await page.$$eval('[data-album-panel="0"] .media-tile', (els) => els.map((e) => (e.querySelector('.play') ? 'v' : 'p')).join(''));
  assert(kinds === 'ppppvvvvvvvvv', 'порядок: ' + kinds);
  assert(!(await page.$('[data-album-panel="0"] .media-caption')), 'в «Подготовке к школе» не должно быть подписей');
  await page.click('#photos .chip:has-text("Лагерная практика")');
  const panel = await page.textContent('[data-album-panel="1"]');
  assert(panel.includes('Яркие смены') && panel.includes('Скоро здесь появятся'), 'пустой альбом без описания');
  await page.click('#photos .chip:has-text("Подготовка к школе")');
  await page.click('[data-album-panel="0"] .media-tile >> nth=5');
  await page.waitForSelector('.lightbox.open video');
  await page.keyboard.press('Escape');
  await context.close();
});

test('Мобильная версия без горизонтальной прокрутки', async (b) => {
  const { page, context } = await newPage(b, { viewport: { width: 375, height: 800 } });
  await openSite(page);
  await page.waitForTimeout(300);
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  assert(sw <= 375, 'ширина страницы ' + sw);
  await page.click('.nav-toggle');
  assert(await page.isVisible('.nav.open a[href="#contacts"]'), 'меню не открылось');
  await page.click('.nav.open a[href="#contacts"]');
  await page.screenshot({ path: path.join(OUT, 'site-mobile.png'), fullPage: true });
  await context.close();
});

test('Пустые поля и пустые блоки не показываются', async (b) => {
  const content = clone(DEFAULT);
  const courses = content.sections.find((s) => s.id === 'courses');
  courses.text = ''; courses.items = [];
  const contacts = content.sections.find((s) => s.id === 'contacts');
  contacts.email = '';
  const { page, context } = await newPage(b, { content });
  await openSite(page);
  assert(!(await page.$('#courses')), 'пустой блок показан');
  assert(!(await page.$('.nav a[href="#courses"]')), 'пустой блок в меню');
  const c = await page.textContent('#contacts');
  assert(!c.includes('E-mail') && !c.includes('Telegram'), 'пустые контакты показаны');
  assert(c.includes('+7 (952) 762-21-22'), 'нет телефона');
  await context.close();
});

test('Защита от XSS', async (b) => {
  const content = clone(DEFAULT);
  content.hero.name = '<img src=x onerror="window.__xss=1">Имя';
  content.sections.find((s) => s.id === 'about').text = '<script>window.__xss=2<\/script>';
  const st = content.sections.find((s) => s.id === 'students');
  st.items[0].link = 'javascript:window.__xss=3';
  st.items[1].link = 'JaVaScRiPt:alert(1)';
  content.hero.buttons[0].href = 'data:text/html,<script>alert(1)<\/script>';
  content.hero.photo.src = '" onerror="window.__xss=4';
  const { page, context } = await newPage(b, { content });
  await openSite(page);
  await page.waitForTimeout(500);
  assert(await page.evaluate(() => window.__xss === undefined), 'XSS выполнился');
  assert((await page.textContent('h1')).includes('<img'), 'тег не экранирован');
  assert(!(await page.$('a[href^="javascript" i], a[href^="data:" i]')), 'опасная ссылка на странице');
  await context.close();
});

test('База недоступна: показывается резервная копия', async (b) => {
  const { page, context } = await newPage(b, { fail: true });
  const src = await openSite(page);
  assert(src === 'default', 'источник: ' + src);
  assert((await page.textContent('h1')).includes('Шумилова'), 'нет содержимого');
  await context.close();
});

test('База зависла: через 5 секунд резервная копия', async (b) => {
  const { page, context } = await newPage(b, { delay: 9000 });
  const t = Date.now();
  const src = await openSite(page);
  const dt = Date.now() - t;
  assert(src === 'default', 'источник: ' + src);
  assert(dt < 8000, 'слишком долго: ' + dt);
  await context.close();
});

test('Работает без внешнего интернета (шрифты и скрипты локальные)', async (b) => {
  const { page, context } = await newPage(b, { offline: true, config: 'real' });
  const failed = [];
  page.on('requestfailed', (r) => failed.push(r.url()));
  await openSite(page);
  await page.evaluate(() => document.fonts.ready);
  const fonts = await page.evaluate(() => [document.fonts.check('16px Manrope', 'Привет'), document.fonts.check('600 30px "Playfair Display"', 'Привет')]);
  assert(fonts[0] && fonts[1], 'шрифты не загрузились');
  assert(!failed.some((u) => u.startsWith(BASE)), 'не загрузились: ' + failed.join(', '));
  await page.goto(BASE + '/admin.html');
  await page.waitForSelector('html[data-ready="login"], html[data-ready="admin"]');
  assert(page.errors.length === 0, 'ошибки JS: ' + page.errors.join('; '));
  await context.close();
});

/* ---------------- админка ---------------- */

test('Вход: неверный пароль, нет прав, администратор', async (b) => {
  const { page, context } = await newPage(b);
  await login(page, 'teacher@test.ru', 'wrong');
  await page.waitForFunction(() => document.getElementById('loginMsg').textContent.includes('Неверный'));
  await login(page, 'parent@test.ru');
  await page.waitForFunction(() => document.getElementById('loginMsg').textContent.includes('нет прав'));
  assert(await page.isHidden('#shell'), 'редактор открылся без прав');
  await loginOk(page);
  assert(await page.isVisible('#saveBtn'), 'нет кнопки сохранить');
  await page.screenshot({ path: path.join(OUT, 'admin.png') });
  await context.close();
});

test('Забыли пароль и смена пароля', async (b) => {
  const { page, context, db } = await newPage(b);
  await page.goto(BASE + '/admin.html');
  await page.waitForSelector('html[data-ready="login"]');
  await page.click('#forgotBtn');
  await page.fill('#loginEmail', 'teacher@test.ru');
  await page.click('#loginBtn');
  await page.waitForFunction(() => document.getElementById('loginMsg').textContent.includes('письмо'));
  await page.click('#forgotBtn');
  await page.fill('#loginEmail', 'teacher@test.ru');
  await page.fill('#loginPassword', 'secret-pass');
  await page.click('#loginBtn');
  await page.waitForSelector('html[data-ready="admin"]');
  await menu(page, 'Копия и пароль');
  const inputs = await page.$$('input[type="password"]:visible');
  await inputs[0].fill('new-password-1');
  await inputs[1].fill('new-password-1');
  await page.click('button:has-text("Сменить пароль")');
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('Пароль изменён'));
  assert(db.users[0].password === 'new-password-1', 'пароль не изменён');
  await context.close();
});

test('Полный сценарий: правка текста, загрузка фото, кадр, сохранение', async (b) => {
  const { page, context, db } = await newPage(b);
  await loginOk(page);
  assert((await page.textContent('#status')).includes('сохранено'), 'статус до правок');
  await page.fill('[data-field="hero-name"]', 'Шумилова Дарья Александровна (тест)');
  assert((await page.textContent('#status')).includes('несохранённые'), 'нет предупреждения о правках');

  const heroPhoto = page.locator('.panel:has(h2:text-is("Фото"))');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), heroPhoto.locator('button:has-text("Заменить фото")').click()]);
  await chooser.setFiles(path.join(ROOT, 'assets/media/podgotovka/photo-04.jpg'));
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('Фото загружено'));
  const key = Object.keys(db.files)[0];
  assert(key && key.startsWith('uploads/') && key.endsWith('.jpg'), 'файл не загружен');
  assert(db.files[key].type === 'image/jpeg', 'тип файла ' + db.files[key].type);

  await heroPhoto.locator('button:has-text("Настроить кадр")').click();
  const box = await page.locator('#cropBox').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, { steps: 5 });
  await page.mouse.up();
  await page.locator('#cropZoom').fill('1.5');
  await page.click('#cropOk');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('сохранено'));

  assert(db.saves === 1, 'сохранений: ' + db.saves);
  const hero = db.content.hero;
  assert(hero.name === 'Шумилова Дарья Александровна (тест)', 'имя не сохранено');
  assert(hero.photo.src === SB + '/storage/v1/object/public/media/' + key, 'адрес фото ' + hero.photo.src);
  assert(hero.photo.frame.z === 1.5 && hero.photo.frame.x < 50 && hero.photo.frame.y < 50, 'кадр ' + JSON.stringify(hero.photo.frame));

  const site = await context.newPage();
  await openSite(site);
  assert((await site.textContent('h1')).includes('(тест)'), 'на сайте старое имя');
  const style = await site.getAttribute('.portrait img', 'style');
  assert(style.includes('scale(1.5)'), 'кадр не применён: ' + style);
  assert(await site.evaluate(() => document.querySelector('.portrait img').complete && document.querySelector('.portrait img').naturalWidth > 0), 'фото не показалось');
  await context.close();
});

test('Галерея в админке: загрузка видео и фото в альбом', async (b) => {
  const { page, context, db } = await newPage(b);
  await loginOk(page);
  await menu(page, 'Фотографии');
  await page.click('.item-title:has-text("Лагерная практика")');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('button:has-text("Добавить фото или видео")')]);
  await chooser.setFiles([path.join(ROOT, 'assets/media/podgotovka/photo-01.jpg'), path.join(ROOT, 'assets/media/podgotovka/video-06.mp4')]);
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('Загружено: 2'), null, { timeout: 30000 });
  const caption = page.locator('.media-card textarea').first();
  await caption.fill('Открытие смены');
  await page.click('#saveBtn');
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('сохранено'));
  const album = db.content.sections.find((s) => s.id === 'photos').albums.find((a) => a.id === 'album-lager');
  assert(album.items.length === 2, 'в альбоме ' + album.items.length);
  assert(album.items[0].type === 'photo' && album.items[0].caption === 'Открытие смены', 'фото или подпись');
  assert(album.items[1].type === 'video' && /\.mp4$/.test(album.items[1].src), 'видео');
  assert(album.items[1].poster, 'нет обложки видео');
  await context.close();
});

test('Блоки страницы: скрыть, переставить, удалить, вернуть, новый блок', async (b) => {
  const { page, context, db } = await newPage(b);
  await loginOk(page);
  await menu(page, 'Блоки страницы');
  const row = (title) => page.locator('.blocks .item', { has: page.locator('.block-name', { hasText: title }) });
  await row('Опыт работы').locator('button:has-text("Скрыть")').click();
  await row('Контакты').locator('button[aria-label="Выше"]').click();
  page.once('dialog', (d) => d.accept());
  await row('Повышение квалификации').locator('button[aria-label="Удалить блок"]').click();
  assert(await row('Повышение квалификации').count() === 0, 'блок не удалён');
  await page.click('.panel:has(h2:text-is("Вернуть стандартный блок")) button:has-text("Вернуть")');
  assert(await row('Повышение квалификации').count() === 1, 'блок не вернулся');
  await page.fill('[data-field="new-block-title"]', 'Кружок «Умелые ручки»');
  await page.click('button:has-text("Создать блок")');
  await page.fill('.panel:has(h2:text-is("Содержимое")) textarea >> nth=0', 'Занятия по средам.');
  await page.click('#saveBtn');
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('сохранено'));

  const ids = db.content.sections.map((s) => s.id);
  assert(db.content.sections.find((s) => s.id === 'experience').hidden === true, 'опыт не скрыт');
  assert(ids.indexOf('contacts') < ids.indexOf('parents'), 'контакты не переставлены');
  assert(ids.indexOf('courses') === ids.indexOf('experience') + 1, 'блок вернулся не на место');

  const site = await context.newPage();
  await openSite(site);
  assert(!(await site.$('#experience')), 'скрытый блок на сайте');
  const custom = site.locator('section[data-type="custom"]');
  assert((await custom.textContent()).includes('Занятия по средам.'), 'нет нового блока');
  assert(await site.$('.nav a:has-text("Кружок")'), 'нет пункта меню');
  await context.close();
});

test('Обновление проекта: новые материалы добавляются без потери правок', async (b) => {
  const content = clone(DEFAULT);
  content.hero.name = 'Правка учителя';
  content.sections = content.sections.filter((s) => s.id !== 'parents' && s.id !== 'courses');
  content.knownDefaults = ['courses'];
  const pod = content.sections.find((s) => s.id === 'photos').albums[0];
  pod.items = pod.items.filter((m) => m.id !== 'pod-video-09');
  const { page, context, db } = await newPage(b, { content });
  await loginOk(page);
  await page.waitForSelector('.banner:has-text("новые материалы (2)")');
  await page.click('.banner button:has-text("Добавить")');
  await page.click('#saveBtn');
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('сохранено'));
  const ids = db.content.sections.map((s) => s.id);
  assert(db.content.hero.name === 'Правка учителя', 'правка потеряна');
  assert(ids.includes('parents') && ids.indexOf('parents') === ids.indexOf('students') + 1, 'раздел «Родителям» не на месте');
  assert(!ids.includes('courses'), 'удалённый учителем блок вернулся');
  const items = db.content.sections.find((s) => s.id === 'photos').albums[0].items;
  assert(items[items.length - 1].id === 'pod-video-09', 'видео не добавлено в конец');
  await page.reload();
  await page.waitForSelector('html[data-ready="admin"]');
  await page.waitForTimeout(300);
  assert(!(await page.$('.banner:has-text("новые материалы")')), 'предложение повторилось');
  await context.close();
});

test('Несохранённые правки: предупреждение при уходе', async (b) => {
  const { page, context } = await newPage(b);
  await loginOk(page);
  await page.fill('[data-field="hero-name"]', 'Другое имя');
  let type = '';
  page.on('dialog', (d) => { type = d.type(); d.dismiss(); });
  await page.close({ runBeforeUnload: true });
  await new Promise((r) => setTimeout(r, 500));
  assert(type === 'beforeunload', 'нет предупреждения');
  await context.close();
});

test('Резервная копия: экспорт и импорт content.json', async (b) => {
  const { page, context } = await newPage(b);
  await loginOk(page);
  await menu(page, 'Копия и пароль');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Скачать content.json")')]);
  const file = path.join(OUT, 'content-export.json');
  await dl.saveAs(file);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert(data.hero && data.sections.length === DEFAULT.sections.length, 'экспорт неполный');
  data.hero.name = 'Из файла';
  fs.writeFileSync(file, JSON.stringify(data));
  page.once('dialog', (d) => d.accept());
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('button:has-text("Загрузить из файла")')]);
  await chooser.setFiles(file);
  await page.waitForFunction(() => document.querySelector('[data-field="hero-name"]') && document.querySelector('[data-field="hero-name"]').value === 'Из файла');
  await context.close();
});

test('Демо-режим без базы: правки сохраняются в браузере', async (b) => {
  const { page, context } = await newPage(b, { config: "window.SITE_CONFIG = { supabaseUrl: '', supabaseKey: '', github: {} };" });
  await page.goto(BASE + '/admin.html');
  await page.waitForSelector('html[data-ready="admin"]');
  await page.fill('[data-field="hero-name"]', 'Демо имя');
  await page.click('#saveBtn');
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('сохранено'));
  const src = await openSite(page);
  assert(src === 'demo', 'источник ' + src);
  assert((await page.textContent('h1')) === 'Демо имя', 'правка не видна');
  assert(await page.isVisible('.demo-bar'), 'нет пометки демо-режима');
  await context.close();
});

test('Мобильная админка без горизонтальной прокрутки', async (b) => {
  const { page, context } = await newPage(b, { viewport: { width: 375, height: 800 } });
  await loginOk(page);
  await page.click('#menuBtn');
  await menu(page, 'Достижения');
  await page.click('.item-title >> nth=0');
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  assert(sw <= 375, 'ширина ' + sw);
  await page.screenshot({ path: path.join(OUT, 'admin-mobile.png'), fullPage: true });
  await context.close();
});

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await start(PORT);
  const browser = await chromium.launch();
  const only = process.argv[2];
  let failed = 0;
  for (const t of tests) {
    if (only && !t.name.toLowerCase().includes(only.toLowerCase())) continue;
    const t0 = Date.now();
    try {
      await t.fn(browser);
      console.log(`  ✓ ${t.name} (${Date.now() - t0} мс)`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${t.name}\n      ${e.message.split('\n')[0]}`);
    }
  }
  await browser.close();
  server.close();
  console.log(failed ? `\nНе прошло: ${failed}` : '\nВсе тесты прошли');
  process.exit(failed ? 1 : 0);
})();
