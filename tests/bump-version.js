// Ставит новый номер версии в ссылки на стили и скрипты (index.html, admin.html),
// чтобы после обновления браузер сразу брал свежие файлы, а не старые из кэша.
// Запуск перед публикацией: npm run version
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const version = new Date().toISOString().replace(/\D/g, '').slice(0, 12);

for (const name of ['index.html', 'admin.html']) {
  const file = path.join(ROOT, name);
  const html = fs.readFileSync(file, 'utf8')
    .replace(/((?:href|src)="(?:config\.js|assets\/(?:css|js|vendor)\/[^"?]+))(\?v=\d+)?"/g, `$1?v=${version}"`);
  fs.writeFileSync(file, html);
}
console.log('Версия файлов: ' + version);
