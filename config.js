/*
  Настройки подключения. Заполняется один раз (см. README.md).

  supabaseUrl  : Project URL из Supabase (Project Settings → API), например https://abcd.supabase.co
  supabaseKey  : ТОЛЬКО публичный ключ anon или sb_publishable_...
                 Ключ service_role / sb_secret_ сюда вписывать НЕЛЬЗЯ.

  github       : запасной вариант (план Б), если Supabase недоступен.
                 Заполните owner и repo и оставьте supabaseUrl пустым:
                 админка будет сохранять содержимое прямо в репозиторий.

  Если всё пусто, админка работает в демо-режиме (правки хранятся только в этом браузере).
*/
window.SITE_CONFIG = {
  supabaseUrl: 'https://qwzyvewauyxlpsuktapc.supabase.co',
  supabaseKey: 'sb_publishable_9uJz2F2VKiBv676DBXN2ew_v2Vtns3A',
  bucket: 'media',
  timeoutMs: 5000,
  github: { owner: '', repo: '', branch: 'main' }
};
