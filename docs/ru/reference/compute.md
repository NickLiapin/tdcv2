<a name="top"></a>

[English](../../reference/compute.md#top) · **Русский** · [Español](../../es/reference/compute.md#top)

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/reference/compute)**

← Назад: [Генераторы](./generators.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Встроенные значения](./builtins.md#top) →

---

# Справочник compute-функций

Все теги подъязыка [`<compute>`](../compute/overview.md#top), по группам. Раздел
[Язык вычислений](../compute/overview.md#top) объясняет, как они складываются вместе.

Как читать колонку «Сигнатура»: `int|str|list` — любой из трёх типов, `…` — любое число
детей, `?` — необязательный атрибут, `1` — ровно одно дочернее выражение, `—` — тег сам
по себе значения не даёт. Слоты — дети с должностью — стоят по имени в сигнатуре того
тега, которому они принадлежат.

## Литералы и ссылки

Подробно: [Язык вычислений](../compute/overview.md#top)

| Тег                                                                  | Сигнатура                  | Что делает                                                     |
| :------------------------------------------------------------------- | :------------------------- | :------------------------------------------------------------- |
| [`<int>`](../compute/overview.md#top)                                   | `v=` → `int`               | Целочисленный литерал (атрибут `v`)                            |
| [`<str>`](../compute/strings.md#str--строковый-литерал)             | `v=` → `str`               | Строковый литерал (атрибут `v`)                                |
| [`<list>`](../compute/lists.md#list--литерал-список-значений)       | `v=` или `int…` → `list`   | Литерал-список целых или из вложенных выражений                |
| [`<field>`](../compute/overview.md#значение-из-field--строка)       | `name=` → `str`            | Значение последовательности в области видимости — как `${{X}}` |
| [`<use>`](../compute/overview.md#let-и-var--не-два-вида-переменной) | `name=` → `int\|str\|list` | Значение, связанное `<let>`                                    |
| [`<let>`](../compute/overview.md#let-и-var--не-два-вида-переменной) | `name=` + 1 → `—`          | Назвать промежуточный результат для соседних тегов             |
| [`<current>`](../compute/lists.md#each--перебор-списка)             | → `int\|str`               | Текущий элемент перебора (внутри `<do>`)                       |
| [`<current_index>`](../compute/lists.md#each--перебор-списка)       | → `int`                    | Номер текущего элемента, с нуля                                |
| [`<acc>`](../compute/lists.md#reduce--свёртка-в-одно-значение)      | → `int\|str\|list`         | Накопитель (внутри `<reduce>`)                                 |

## Списки и перебор

Подробно: [Списки и перебор](../compute/lists.md#top)

| Тег                                                                | Сигнатура                                   | Что делает                                |
| :----------------------------------------------------------------- | :------------------------------------------ | :---------------------------------------- |
| [`<each>`](../compute/lists.md#each--перебор-списка)              | `<over>` `<do>` → `list`                    | Преобразовать каждый элемент → список     |
| [`<reduce>`](../compute/lists.md#reduce--свёртка-в-одно-значение) | `<over>` `<init>` `<do>` → `int\|str\|list` | Свернуть список в одно значение (`<acc>`) |
| [`<join>`](../compute/lists.md#join--список-в-строку)             | `list` + `sep=?` → `str`                    | Список → строка (атрибут `sep`)           |
| [`<split>`](../compute/lists.md#split--строка-в-список)           | `str` + `sep=` → `list`                     | Строка → список, рез по `sep` (обязателен) |
| [`<at>`](../compute/lists.md#at--доступ-по-индексу)               | `<in>` `<index>` + `default=?` → `int\|str` | Элемент по индексу (атрибут `default`)    |
| [`<length>`](../compute/lists.md#length--длина-строки-или-списка) | `str\|list` → `int`                         | Длина строки или списка                   |

## Арифметика

Подробно: [Арифметика](../compute/arithmetic.md#top)

| Тег                                                | Сигнатура           | Что делает                             |
| :------------------------------------------------- | :------------------ | :------------------------------------- |
| [`<add>`](../compute/arithmetic.md#add)           | `int…` → `int`      | Сумма всех детей (пусто → 0)           |
| [`<subtract>`](../compute/arithmetic.md#subtract) | `int…` → `int`      | Первое минус сумма остальных           |
| [`<multiply>`](../compute/arithmetic.md#multiply) | `int…` → `int`      | Произведение (пусто → 1)               |
| [`<divide>`](../compute/arithmetic.md#divide)     | `int` `int` → `int` | Целочисленное деление к −∞ (2 ребёнка) |
| [`<mod>`](../compute/arithmetic.md#mod)           | `int` `int` → `int` | Остаток по Евклиду, всегда ≥ 0         |

## Строки, кодирование и форматирование

Подробно: [Строки и форматирование](../compute/strings.md#top)

| Тег                                                                                                                                                         | Сигнатура                              | Что делает                                  |
| :---------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------- | :------------------------------------------ |
| [`<encode>`](../compute/arithmetic.md#encode-as)                                                                                                           | `str`(1) + `as=` → `str`               | Символ → число (`base36`/`ascii`/`hex`/…)   |
| [`<to_number>`](../compute/arithmetic.md#to_number)                                                                                                        | `str` → `int`                          | Строку из цифр → целое                      |
| [`<pad>`](../compute/strings.md#pad--дополнить-слева-до-фиксированной-ширины)                                                                              | `int\|str` + `width=` `fill=?` → `str` | Дополнить слева до ширины (`width`, `fill`) |
| [`<concat>`](../compute/strings.md#concat--склеить-части-в-строку)                                                                                         | `int\|str…` → `str`                    | Склеить несколько частей в строку           |
| [`<upper>`](../compute/strings.md#upper--lower--capitalize--title--регистр) / [`<lower>`](../compute/strings.md#upper--lower--capitalize--title--регистр) | `str` → `str`                          | ВЕРХНИЙ / нижний регистр                    |
| [`<capitalize>`](../compute/strings.md#upper--lower--capitalize--title--регистр)                                                                           | `str` → `str`                          | Первая буква заглавная                      |
| [`<title>`](../compute/strings.md#upper--lower--capitalize--title--регистр)                                                                                | `str` → `str`                          | Первая буква каждого слова заглавная        |
| [`<mask>`](../compute/strings.md#mask--разбить-и-переставить-по-шаблону)                                                                                   | `str` + `pattern=` → `str`             | Маска оформления (`pattern`: `x`/`w`/`*`)   |
| [`<slice>`](../compute/strings.md#slice--подстрока-по-индексам)                                                                                            | `str` + `from=` `to=?` → `str`         | Подстрока `[from, to)`                      |
| [`<replace>`](../compute/strings.md#replace--заменить-все-вхождения)                                                                                       | `str` + `from=` `to=` → `str`          | Заменить все вхождения (`from`, `to`)       |
| [`<trim>`](../compute/strings.md#trim--убрать-крайние-пробелы)                                                                                             | `str` → `str`                          | Убрать крайние пробелы                      |
| [`<group>`](../compute/strings.md#group--сгруппировать-символы-справа)                                                                                     | `str` + `size=?` `sep=?` → `str`       | Сгруппировать справа (`size`, `sep`)        |

## Условие

Подробно: [Условия](../compute/conditionals.md#top)

| Тег                                                                               | Сигнатура                                  | Что делает                                   |
| :-------------------------------------------------------------------------------- | :----------------------------------------- | :------------------------------------------- |
| [`<choose>`](../compute/conditionals.md#choose--выбрать-первую-подходящую-ветку) | `<when>…` `<otherwise>` → `int\|str\|list` | Выбор ветки; нужен `<otherwise>`             |
| [`<when>`](../compute/conditionals.md#when--одна-ветка)                          | `<test>` `<then>` → `—`                    | Ветка: предикат `<test>` и значение `<then>` |
| [`<otherwise>`](../compute/conditionals.md#otherwise-обязателен--ошибка-tdc184)  | 1 → `int\|str\|list`                       | Ветка «иначе» (обязательна)                  |
| [`<test>`](../compute/conditionals.md#test--место-для-условия)                   | 1 → `yes\|no`                              | Держит один предикат, даёт «да/нет»          |
| [`<then>`](../compute/conditionals.md#when--одна-ветка)                          | 1 → `int\|str\|list`                       | Значение сработавшей ветки                   |
| [`<equals>`](../compute/conditionals.md#equals--два-целых-равны)                 | `int` `int` → `yes\|no`                    | Предикат: два целых равны                    |
| [`<greater_than>`](../compute/conditionals.md#greater_than--строго-a--b)         | `int` `int` → `yes\|no`                    | Предикат: A > B                              |
| [`<less_than>`](../compute/conditionals.md#less_than--строго-a--b)               | `int` `int` → `yes\|no`                    | Предикат: A < B                              |
| [`<is_digit>`](../compute/conditionals.md#is_digit--символ-09)                   | `str`(1) → `yes\|no`                       | Предикат: символ — цифра 0–9                 |

## Обёртки и спецтеги

| Тег                                                                   | Сигнатура            | Что делает                                          |
| :-------------------------------------------------------------------- | :------------------- | :-------------------------------------------------- |
| [`<over>`](../compute/lists.md#each--перебор-списка)                 | 1 → `str\|list`      | Вход-список для `<each>` / `<reduce>`               |
| [`<do>`](../compute/lists.md#each--перебор-списка)                   | 1 → `int\|str\|list` | Тело перебора для `<each>` / `<reduce>`             |
| [`<init>`](../compute/lists.md#reduce--свёртка-в-одно-значение)      | 1 → `int\|str\|list` | Начальное значение накопителя для `<reduce>`        |
| [`<in>`](../compute/lists.md#at--доступ-по-индексу)                  | 1 → `list`           | Список для `<at>`                                   |
| [`<index>`](../compute/lists.md#at--доступ-по-индексу)               | 1 → `int`            | Номер элемента для `<at>`                           |
| [`<result>`](../compute/overview.md#top)                                 | 1 → `int\|str\|list` | Итоговое значение `<compute>`                       |
| [`<valid>`](../compute/conditionals.md#valid--отбросить-и-повторить) | 1 → `—`              | Reject-and-retry: перегенерировать, пока не валидно |

Проработанные примеры — в разделе [Язык вычислений](../compute/overview.md#top).

---

← Назад: [Генераторы](./generators.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Встроенные значения](./builtins.md#top) →

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/reference/compute)**
