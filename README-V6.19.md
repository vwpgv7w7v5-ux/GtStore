# GtStore v6.19 — Theme Builder 2.0

Расширен визуальный конструктор витрины и единая система дизайн-токенов.

## Возможности

- четыре готовые темы: Midnight, Graphite, Minimal, Candy;
- настройка акцента, фона, поверхности, текста и вторичного текста;
- выбор шрифта и ширины контейнера;
- стили карточек: soft, bordered, flat;
- стили кнопок: filled, outline, pill;
- стили шапки: glass, solid, minimal;
- серверная нормализация дизайн-токенов;
- единый вид в предпросмотре и публичной витрине;
- сохранение тем в версиях публикации.

## API

- `GET /api/v6/storefront/theme-presets`
- существующие draft/publish endpoints сохраняют расширенный объект `theme`.

## Проверка

```bash
npm run v6:theme:test
npm run v6:theme-ui:test
npm run v6:test
```
