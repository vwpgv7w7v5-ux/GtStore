# GtStore v6.0 Sprint 1 Foundation

Обновление рабочего сайта из GitHub описано в [GitHub → Timeweb](docs/GITHUB_DEPLOY.md).
Код обновляется через Actions, а база и фотографии хранятся отдельно на VPS.

## Запуск без npm install

Терминал 1:
```bash
npm run v6:api
```

Терминал 2:
```bash
npm run v6:admin
```

Открыть: http://127.0.0.1:4173

Первый вход: нажать «Создать демо-пространство», затем «Войти».

Данные: owner@gtstore.local / ChangeMe123!

## Проверка
```bash
npm run v6:test
npm run v6:stats
```
