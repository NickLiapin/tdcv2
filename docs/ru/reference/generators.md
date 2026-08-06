<a name="top"></a>

[English](../../reference/generators.md#top) · **Русский** · [Español](../../es/reference/generators.md#top)

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/reference/generators)**

← Назад: [Атрибуты](./attributes.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Compute-функции](./compute.md#top) →

---

# Справочник генераторов

Каждый `type` для [`<gen>`](../generators/overview.md#top). Каждая строка ведёт на свою полную страницу.

| `type`                                                  | Что производит                                                |
| :------------------------------------------------------ | :------------------------------------------------------------ |
| [`text`](../generators/text.md#top)                        | Значение из набора — равномерно или по точным `percent`       |
| [`number`](../generators/number.md#top)                    | Целое число в диапазоне или строку цифр фиксированной длины   |
| [`template`](../generators/template.md#top)                | Встроенные правдоподобные данные и технические идентификаторы |
| [`file`](../generators/file.md#top)                        | Значения из ваших файлов и CSV-колонок                        |
| [`date`](../generators/date.md#top)                        | Дату или дату-время в диапазоне и формате                     |
| [`symbol`](../generators/symbol.md#top)                    | Строку из набора символов или именованного алфавита           |
| [`regex`](../generators/regex.md#top)                      | Строку по конечному регулярному выражению                     |
| [`advanced_regex`](../generators/advanced-regex.md#top)    | Regex плюс взвешенный выбор между вариантами                  |
| [`increment` / `decrement`](../generators/counters.md#top) | Возрастающий и убывающий счётчики                             |
| [`timeseries`](../generators/timeseries.md#top)            | Временной ряд — тренд + сезонность + шум                      |
| [`pattern`](../generators/pattern.md#top)                  | Распределение по нарисованной кривой                          |
| [`http`](../generators/http.md#top)                        | Значение от вашего сервиса, по HTTP                           |
| [`pool`](../pools/overview.md#top)                         | Один целый член `<pool>` — запись, а не значение              |
| [`running`](../generators/running.md#top)                  | Итог, накопленный по колонке, а не разыгранный                |
| [`stat`](../generators/stat.md#top)                        | Одно число на весь прогон, в каждой строке                   |

## Сквозные атрибуты

Работают на **любом** генераторе (см. [Маски и регистр](../guides/masks-and-case.md#top)):

- `case=` / `mask=` — регистр букв и маски отображения;
- `missing=` — оставить часть ячеек пустыми.

Этим двум нужно, чтобы генератор выдавал что-то, к чему их вообще можно применить;
в остальных случаях они игнорируются:

- `order=` / `cycle=` — порядок значений (по умолчанию случайный или `sequential`).
  Он обходит список, поэтому работает на [`text`](../generators/text.md#top) и
  [`file`](../generators/file.md#top). [`number`](../generators/number.md#top) и
  [`date`](../generators/date.md#top) берут значение из диапазона, а не из списка, и
  этот атрибут не читают.
- `anomaly=` — вытолкнуть часть значений за пределы диапазона, умножив их. Правило
  про **значение**, а не про генератор: умножается всё, что читается как число, в том
  числе числовая строка из [`text`](../generators/text.md#top),
  [`file`](../generators/file.md#top) или пака. Всё остальное — имя, город — проходит без
  изменений и **без предупреждения**, потому что «ещё дальше» для него не существует.
  См. [Аномалии и пропуски](../guides/anomalies.md#top).

См. также [Обзор генераторов](../generators/overview.md#top).

---

← Назад: [Атрибуты](./attributes.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Compute-функции](./compute.md#top) →

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/reference/generators)**
