<a name="top"></a>

[English](../../generators/file.md#top) · **Русский** · [Español](../../es/generators/file.md#top)

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/generators/file)**

← Назад: [Шаблон](./template.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Дата](./date.md#top) →

---

# Генератор `file`

**Когда пригодится** — значения уже лежат в файле: справочник городов, выгрузка,
CSV — и не хочется переносить их в конфиг руками. Атрибут [`src`](../reference/attributes.md#top)
говорит генератору, откуда их читать, а ещё один атрибут,
[`column`](../reference/attributes.md#top), решает, простой это список или таблица.

Примеры вывода ниже иллюстративные — конкретные значения случайны и могут
отличаться от версии к версии ядра; важны только форма и количество строк.

![](../../img/concepts/csv-row-link.svg)

*Один CSV, прочитанный дважды, по шесть строк.*

- **A** — исходный файл: четыре строки, три колонки
- **B** — без row= каждое поле выбирает свою строку, и запись собирается из кусков, которые никогда не были вместе (серые ячейки)
- **C** — с row= все три поля читают одну строку, поэтому каждая запись — настоящая строка файла

## Коротко

| Атрибут                                    | Обязательный | Что делает                                                                |
| :----------------------------------------- | :----------- | :------------------------------------------------------------------------ |
| [`src`](../reference/attributes.md#top)       | да           | Где файл — относительный путь, `@data`, `pkg:` или абсолютный путь        |
| [`column`](../reference/attributes.md#top)    | нет          | Читать одну колонку CSV, по имени или номеру (с 1) — включает CSV-режим   |
| [`delimiter`](../reference/attributes.md#top) | нет          | Разделитель ячеек в CSV-режиме — по умолчанию запятая                     |
| [`header`](../reference/attributes.md#top)    | нет          | Пропустить первую строку, когда колонка выбрана **по номеру**             |
| [`row`](../reference/attributes.md#top)       | нет          | Связать несколько полей с **одной** CSV-строкой (запись остаётся цельной) |

## `src` — где файл

`src` **обязателен**. Это либо обычный путь, либо резолвер-источник:

| `src`                              | Куда разрешается                                |
| :--------------------------------- | :---------------------------------------------- |
| `src="names.txt"`                  | Рядом с файлом конфига `.tdc`                   |
| `src="@data/names.txt"`            | Ищется в папках, переданных через `--data-path` |
| `src="pkg:@tdc/data-ru/names.txt"` | Файл из пакета в `node_modules`                 |
| `src="/absolute/path/names.txt"`   | Абсолютный путь                                 |

Файл читается как UTF-8. Если путь не удаётся разрешить, рендер завершается с
ошибкой, а не молча выдаёт пустоту.

## Два режима — список или CSV

Один и тот же `src` читает файл в одном из двух режимов, и режим выбирается не
самим `src`, а тем, присутствует ли [`column`](../reference/attributes.md#top):

- **без `column`** — файл читается как простой список: каждая непустая строка это
  одно значение;
- **с `column`** — файл читается как CSV, и значения берутся из указанной колонки.

### Режим списка — одна строка, одно значение

**Проблема.** Нужен пул городов, но зашивать длинный список прямо в `value="…"`
неудобно: его тяжело править и невозможно переиспользовать.

**Инструмент.** Кладём по одному значению на строку в файл — `data/cities.txt`:

```text
Москва
Казань
Пермь
Омск
Тверь
```

```xml
<sequence name="City">
  <gen type="file" src="@data/cities.txt"/>
</sequence>
...
<data>${{City}}</data>
```

Папку с данными передаём при запуске через `--data-path`:

```bash
./run example.tdc --data-path ./data
```

**Результат.** Строки выбираются равномерно случайно (с повторами — `Пермь`
выпала дважды):

`./run example.tdc --data-path ./data`

```
Омск
Москва
Пермь
Пермь
Казань
```

Пустые строки в режиме списка пропускаются. Чтобы получить строгий порядок файла
вместо случайного выбора, добавьте `order="sequential"` — он выдаёт строки ровно
в том порядке, в каком они идут в файле (см. [Маски и регистр](../guides/masks-and-case.md#top)).

### Режим CSV — значение из колонки

**Проблема.** В файле не один столбец, а таблица, и нужен всего один столбец —
например только адреса. Пусть `data/users.csv`:

```text
first_name,last_name,email,city
Анна,Орлова,anna.orlova@example.com,Москва
Борис,Петров,boris.petrov@example.com,Казань
Вера,Сидорова,vera.sidorova@example.com,Пермь
Григорий,Иванов,grigori.ivanov@example.com,Омск
```

**Инструмент.** Тот же `src` плюс [`column`](../reference/attributes.md#top) — само
его наличие переключает генератор в CSV-режим:

```xml
<sequence name="Email">
  <gen type="file" src="@data/users.csv" column="email"/>
</sequence>
...
<data>${{Email}}</data>
```

**Результат.** Первая строка считается заголовком и в вывод не попадает;
значения берутся только из колонки `email`:

`./run example.tdc --data-path ./data`

```
anna.orlova@example.com
grigori.ivanov@example.com
anna.orlova@example.com
boris.petrov@example.com
anna.orlova@example.com
```

## `column` — по имени или по номеру

Само наличие `column` превращает файл из списка «строка = значение» в CSV. Без
него генератор взял бы строку целиком
(`Анна,Орлова,anna.orlova@example.com,Москва`) как одно значение. Адресовать
колонку можно двумя способами.

### По имени

Имя из строки-заголовка. Строка-заголовок отбрасывается автоматически, значения
начинаются со второй строки:

```xml
<gen type="file" src="@data/users.csv" column="email"/>
```

`./run example.tdc --data-path ./data`

```
anna.orlova@example.com
grigori.ivanov@example.com
anna.orlova@example.com
boris.petrov@example.com
anna.orlova@example.com
```

### По номеру (с 1)

Вместо имени задайте номер, начиная с единицы. `column="2"` — это **второй**
столбец (`last_name`): нумерация с единицы, поэтому первый столбец это
`column="1"`, а не `column="0"`. При адресации по номеру у TDC нет имён колонок,
чтобы их распознать, поэтому добавьте [`header="true"`](../reference/attributes.md#top),
чтобы пропустить строку-заголовок:

```xml
<gen type="file" src="@data/users.csv" column="2" header="true"/>
```

`./run example.tdc --data-path ./data`

```
Сидорова
Петров
Петров
Орлова
Орлова
```

Тот же файл с `column="3"` читает третий столбец, `email` — данные те же, что и
при `column="email"`, просто адресуемся по позиции. Нужен `header="true"` по той же
причине, что и для `column="2"`: при обращении по номеру заголовок распознать не по
чему, и без него само слово `email` попадёт в выборку как значение.

```xml
<gen type="file" src="@data/users.csv" column="3" header="true"/>
```

`./run example.tdc (column=&quot;3&quot; header=&quot;true&quot;)`

```
vera.sidorova@example.com
boris.petrov@example.com
boris.petrov@example.com
anna.orlova@example.com
anna.orlova@example.com
```

### Крайние случаи

- `column="0"` **не** является номером (нумерация с 1) — он трактуется как
  буквальное имя `0`, которого нет в заголовке, поэтому получаете
  `error[TDC062]: CSV column "0" was not found in the header row`.
- Номер за пределами последней колонки (`column="9"` на файле из четырёх колонок)
  падает с `error[TDC062]: CSV column "9" ... has no values`.
- Если разделитель файла не запятая, задайте [`delimiter`](../reference/attributes.md#top)
  — иначе вся строка попадёт в одну ячейку и колонка не найдётся.

## `delimiter` — чем разделены ячейки

**Проблема.** Не каждая таблица разделена запятой. Выгрузки из Excel часто идут
через точку с запятой или табуляцию. Не скажете TDC ничего — он разобьёт строку
по запятым, не найдёт ячеек и посчитает всю строку одним полем, так что колонка
не найдётся.

`delimiter` принимает либо один символ (`delimiter=";"`), либо один из
алиасов-имён:

| Значение    | Разделитель                  |
| :---------- | :--------------------------- |
| `comma`     | запятая `,` (умолчание)      |
| `semicolon` | точка с запятой `;`          |
| `pipe`      | вертикальная черта           |
| `tab`       | табуляция (TSV-файлы)        |
| `\t`        | табуляция (то же, что `tab`) |

Для TSV-файла (колонки разделены табуляцией) `delimiter="tab"` и `delimiter="\t"`
равнозначны — оба читают табуляцию как разделитель.

### Точка с запятой — частый случай

Возьмём тех же пользователей, но с разделителем `;` — `data/users_semicolon.csv`:

```text
first_name;last_name;email;city
Анна;Орлова;anna.orlova@example.com;Москва
Борис;Петров;boris.petrov@example.com;Казань
Вера;Сидорова;vera.sidorova@example.com;Пермь
Григорий;Иванов;grigori.ivanov@example.com;Омск
```

**Без `delimiter`** (подразумевается запятая) вся строка становится одной
ячейкой, и колонка `email` не находится:

```xml
<gen type="file" src="@data/users_semicolon.csv" column="email"/>
```

`./run example.tdc --data-path ./data`

```
error[TDC062]: file generator: CSV column "email" was not found in the header row
note: For CSV files, use a header name like column="email" or a 1-based index like column="2".
```

**С `delimiter="semicolon"`** (или `delimiter=";"`) ячейки разбираются верно:

```xml
<gen type="file" src="@data/users_semicolon.csv" column="email" delimiter="semicolon"/>
```

`./run example.tdc --data-path ./data`

```
anna.orlova@example.com
grigori.ivanov@example.com
anna.orlova@example.com
boris.petrov@example.com
```

### Вертикальная черта

Файл, где колонки разделены `|`, читается через `delimiter="pipe"`:

```xml
<gen type="file" src="@data/users_pipe.csv" column="email" delimiter="pipe"/>
```

`./run example.tdc --data-path ./data`

```
boris.petrov@example.com
boris.petrov@example.com
anna.orlova@example.com
```

### Табуляция (TSV)

Файл с разделителем-табуляцией читается через `delimiter="tab"` (или
`delimiter="\t"`):

```xml
<gen type="file" src="@data/users.tsv" column="email" delimiter="tab"/>
```

`./run example.tdc --data-path ./data`

```
anna.orlova@example.com
boris.petrov@example.com
anna.orlova@example.com
```

## `header` — пропустить заголовок для числовой колонки

**Проблема.** В CSV первая строка обычно это заголовок (`first_name,last_name,…`).
Когда вы выбираете колонку **по имени**, TDC знает, что первая строка — заголовок,
и отбрасывает её. Но при выборе **по номеру** имён колонок неоткуда взять — TDC не
может отличить заголовок от данных, поэтому по умолчанию берёт всё, включая строку
заголовка, и мусор вроде `first_name` протекает в вывод.

`header` принимает `true` или `false` (по умолчанию `false`). Он влияет только на
**числовую** `column`.

**Без `header`** — ячейка заголовка `first_name` считается обычным значением и
показывается в выводе:

```xml
<gen type="file" src="@data/users.csv" column="1"/>
```

`./run example.tdc --data-path ./data`

```
Борис
Борис
Борис
first_name
first_name
```

**С `header="true"`** — первая строка отбрасывается, остаются только настоящие
значения:

```xml
<gen type="file" src="@data/users.csv" column="1" header="true"/>
```

`./run example.tdc --data-path ./data`

```
Вера
Борис
Борис
Анна
Анна
```

### Когда `header` не нужен

Для колонки, выбранной **по имени** (`column="email"`), `header="true"` не нужен
никогда: именованная колонка всегда ищется в первой строке, а данные читаются
начиная со второй. `header` важен только для числовой `column`.

## `row` — держать запись вместе

**Проблема.** Несколько полей должны браться из **одной и той же** строки CSV. Без
`row` каждый генератор `file` выбирает независимо, и запись рассыпается: имя из
одной строки, фамилия из другой, город из третьей.

`row` принимает любой непустой ключ, например `row="user"`. Все генераторы
`type="file"` с одинаковым `row` — тем же `src`, тем же `delimiter` и тем же
режимом header — читают **одну и ту же строку** для каждой записи. На запись
выбирается одна строка, а разные значения `column` читают из неё разные ячейки.

**Без `row`** — три независимых генератора, поэтому записи не сходятся (Вера с
фамилией Петров из Москвы, Борис — с фамилией Сидорова):

```xml
<sequence name="User">
  <gen name="First" type="file" src="@data/users.csv" column="first_name"/>
  <gen name="Last"  type="file" src="@data/users.csv" column="last_name"/>
  <gen name="City"  type="file" src="@data/users.csv" column="city"/>
</sequence>
...
<data>${{User.First}} ${{User.Last}} — ${{User.City}}</data>
```

`./run example.tdc --data-path ./data`

```
Вера Петров — Москва
Анна Орлова — Казань
Борис Сидорова — Омск
Борис Иванов — Казань
Борис Петров — Омск
```

**С `row="user"`** — все три поля берутся из одной строки, поэтому каждая запись
согласована:

```xml
<sequence name="User">
  <gen name="First" type="file" src="@data/users.csv" column="first_name" row="user"/>
  <gen name="Last"  type="file" src="@data/users.csv" column="last_name"  row="user"/>
  <gen name="City"  type="file" src="@data/users.csv" column="city"       row="user"/>
</sequence>
```

`./run example.tdc --data-path ./data`

```
Вера Сидорова — Пермь
Григорий Иванов — Омск
Борис Петров — Казань
Борис Петров — Казань
Анна Орлова — Москва
```

Теперь `first_name`, `last_name` и `city` всегда берутся из одной CSV-строки —
поля не могут разъехаться. Это работает на **любом** движке (по умолчанию —
потоковый, так что память не растёт с числом строк).

### Взвешенные строки — `row` + `weight`

По умолчанию связанная строка выбирается **равномерно**. Добавьте
[`weight="колонка"`](../reference/attributes.md#top) на одно поле группы — и строку
выберет **взвешенный жребий** по этой колонке (точно, как `percent`), а остальные
поля по-прежнему возьмут значения из той же выбранной строки. Тогда товар выпадает
по своей настоящей частоте продаж, а его цена и категория берутся с его же строки
— `data/catalog.csv`:

```text
name,category,price,sales
Ручка,Канцелярия,1.10,500
Кофе,Напитки,4.50,1200
Рюкзак,Сумки,45.00,80
```

```xml
<sequence name="Item">
  <gen name="Name"  type="file" src="@data/catalog.csv" column="name"     row="i" weight="sales"/>
  <gen name="Price" type="file" src="@data/catalog.csv" column="price"    row="i"/>
  <gen name="Cat"   type="file" src="@data/catalog.csv" column="category" row="i"/>
</sequence>
...
<data>${{Item.Name}} | ${{Item.Cat}} | ${{Item.Price}}</data>
```

`./run example.tdc --data-path ./data`

```
Кофе | Напитки | 4.50
Ручка | Канцелярия | 1.10
Кофе | Напитки | 4.50
```

**Про движок.** Без `weight` связанная группа работает на любом движке. **С
`weight`** такой конфиг всегда считает движок в памяти: потоковый не может
взвесить выбор строки, не зная сначала итогов по файлу. Если принудительно задать
`--engine 2`, TDC честно скажет об этом, а не выдаст молча несвязные колонки.
Цена этому — память, которая теперь растёт вместе с `count`; см. [Какой движок считает
ваш конфиг](../guides/large-outputs.md#какой-движок-запустит-ваш-конфиг). Про сами
связанные группы — в **[Согласованные и связанные
данные](../guides/coherent-data.md#top)**.

### Ограничения (v1)

- `row` работает только внутри `<sequence>`. В блоке вывода генераторов нет вовсе,
  поэтому вопрос там не возникает.
- `row` требует [`column`](../reference/attributes.md#top) — это возможность для CSV,
  а не для простого текстового списка.
- Один и тот же ключ `row` с **разными** источниками не связывает их между собой:
  TDC заводит отдельную группу строк на каждое сочетание источника, разделителя и
  режима заголовка. Это не ошибка, просто стоит иметь в виду.

## Смотрите также

- [`src`](../reference/attributes.md#top), [`column`](../reference/attributes.md#top),
  [`delimiter`](../reference/attributes.md#top), [`header`](../reference/attributes.md#top),
  [`row`](../reference/attributes.md#top) и [`weight`](../reference/attributes.md#top) в
  справочнике атрибутов.
- **[Файлы и CSV](../guides/files-and-csv.md#top)** — сквозное руководство по загрузке
  внешних данных.
- **[Согласованные и связанные данные](../guides/coherent-data.md#top)** — связывание
  целых записей и взвешенные строки.

---

← Назад: [Шаблон](./template.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Дата](./date.md#top) →

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/generators/file)**
