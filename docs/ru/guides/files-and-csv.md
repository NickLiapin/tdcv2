<a name="top"></a>

[English](../../guides/files-and-csv.md#top) · **Русский** · [Español](../../es/guides/files-and-csv.md#top)

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/guides/files-and-csv)**

← Назад: [Без повторов в строке (distinct)](./distinct.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Форматы вывода (CSV, JSON, SQL…)](./output-formats.md#top) →

---

# Файлы и CSV

Когда значения уже лежат в файле — справочник, который ведёт команда, выгрузка,
таблица, сохранённая как CSV — читайте их генератором
[`file`](../generators/file.md#top), а не вставляйте в конфиг вручную. Это
руководство проходит типичный сценарий работы с CSV от начала до конца: простой
список, одна колонка, правильный разделитель и сохранение записи целиком. Каждый
атрибут разобран во всех подробностях на странице
[Генератор file](../generators/file.md#top); здесь же в центре внимания сама задача.

> [!NOTE]
> Примеры вывода иллюстративны — точные значения случайны и могут отличаться от
> версии к версии ядра. Важна форма каждого шага и количество строк.

![](../../img/concepts/csv-row-link.svg)

*Один CSV, прочитанный дважды, по шесть строк.*

- **A** — исходный файл: четыре строки, три колонки
- **B** — без row= каждое поле выбирает свою строку, и запись собирается из кусков, которые никогда не были вместе (серые ячейки)
- **C** — с row= все три поля читают одну строку, поэтому каждая запись — настоящая строка файла

## Подготовка: папка с данными

Все примеры ниже читают из папки `data/` рядом с конфигом, которая передаётся при
запуске через `--data-path`. В ней лежат два файла — простой список и CSV.

`data/cities.txt` (одно значение на строку):

```text
Moscow
Kazan
Perm
Omsk
Tver
```

`data/users.csv` (строка-заголовок, затем записи):

```text
first_name,last_name,email,city
Anna,Orlova,anna.orlova@example.com,Moscow
Boris,Petrov,boris.petrov@example.com,Kazan
Vera,Sidorova,vera.sidorova@example.com,Perm
Grigori,Ivanov,grigori.ivanov@example.com,Omsk
```

Любой конфиг запускается одинаково:

```bash
./run example.tdc --data-path ./data
```

## Простой список — одна строка, одно значение

**Когда пригодится:** у вас есть плоский набор значений (города, названия
товаров, теги), который неудобно зашивать в `value="…"`. Направьте
[`src`](../generators/file.md#top) на файл и не указывайте
[`column`](../generators/file.md#top) — каждая непустая строка станет одним
значением:

```xml
<sequence name="City">
  <gen type="file" src="@data/cities.txt"/>
</sequence>
...
<data>${{City}}</data>
```

`./run example.tdc --data-path ./data`

```
Omsk
Moscow
Perm
Perm
Kazan
```

Строки выбираются равномерно случайно, с повторами (`Perm` выпал дважды). Пустые
строки пропускаются. Чтобы читать строго в порядке файла, а не случайно, добавьте
`order="sequential"` — тогда строки выдаются ровно в том порядке, в каком идут в
файле (см. [Маски и регистр](masks-and-case.md#top)).

## Колонка CSV — одно поле из таблицы

**Когда пригодится:** файл — это таблица, а вам нужно одно поле — например, только
адреса почты. Добавление [`column`](../generators/file.md#top) как раз и переключает
генератор из режима списка в режим CSV: строка-заголовок отбрасывается, а значения
берутся только из указанной колонки.

### По имени

Укажите колонку по имени из строки-заголовка:

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

Заголовок (`first_name,last_name,email,city`) в вывод никогда не попадает — он
распознаётся как заголовок и используется только для поиска колонки.

### По номеру (с единицы)

Ту же колонку можно адресовать по позиции. `column="2"` — это **второй** столбец
(`last_name`); нумерация начинается с единицы, поэтому первый столбец — это
`column="1"`, а не `column="0"`. При адресации по номеру TDC не видит имён из
заголовка, поэтому добавьте [`header="true"`](../generators/file.md#top), чтобы
отбросить первую строку:

```xml
<gen type="file" src="@data/users.csv" column="2" header="true"/>
```

`./run example.tdc --data-path ./data`

```
Sidorova
Petrov
Petrov
Orlova
Orlova
```

Тот же файл с `column="3"` читает третий столбец, `email` — те же данные, что и
`column="email"`, просто адресованные по позиции, а не по имени.

### Частые ошибки

Пара промахов на единицу и с разделителем падает громко, а не тихо, поэтому их
легко заметить:

`./run example.tdc --data-path ./data`

```
column="0"  ->  error[TDC062]: CSV column "0" was not found in the header row
column="9"  ->  error[TDC062]: CSV column "9" ... has no values
```

- `column="0"` — не номер (нумерация с 1): он читается как буквальное имя `0`,
  которого нет в заголовке.
- Номер за пределами последней колонки (`column="9"` для файла из четырёх
  столбцов) не имеет ячеек для чтения.
- Если разделитель в файле не запятая, задайте его (см. ниже) — иначе вся строка
  попадёт в одну ячейку и колонка не найдётся.

## Разделитель — запятые, точки с запятой, табы

**Когда пригодится:** выгрузка разделена не запятой. Таблицы часто сохраняются с
точкой с запятой или табом. Если разделитель не задан, TDC режет по запятым, не
находит ячеек и считает всю строку одним полем — так что колонка никогда не
находится. Задайте [`delimiter`](../generators/file.md#top) под ваш файл. Возьмём тех
же пользователей, сохранённых с точкой с запятой, `data/users_semicolon.csv`:

```text
first_name;last_name;email;city
Anna;Orlova;anna.orlova@example.com;Moscow
Boris;Petrov;boris.petrov@example.com;Kazan
Vera;Sidorova;vera.sidorova@example.com;Perm
Grigori;Ivanov;grigori.ivanov@example.com;Omsk
```

Без `delimiter` предполагается запятая, и колонка `email` не находится:

`./run example.tdc --data-path ./data`

```
error[TDC062]: file generator: CSV column "email" was not found in the header row
note: For CSV files, use a header name like column="email" or a 1-based index like column="2".
```

С `delimiter="semicolon"` (или `delimiter=";"`) ячейки режутся правильно:

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

`delimiter` принимает один символ или имя-алиас — `comma` (по умолчанию),
`semicolon`, `pipe`, `tab`. Для файла с табами (TSV) `delimiter="tab"` и
`delimiter="\t"` эквивалентны. Полная таблица алиасов — на странице
[Генератор file](../generators/file.md#top).

## Сохранить запись целиком — ключ `row`

**Когда пригодится:** несколько полей должны браться из **одной и той же** строки
CSV. Этот шаг пропускают чаще всего. Независимые генераторы
[`file`](../generators/file.md#top) каждый выбирает свою строку, и запись
рассыпается: имя из одной строки, фамилия из другой, город из третьей.

**Без `row`** — три независимых генератора, и записи не сходятся (Вера с фамилией
Петров, Борис — не в своём городе):

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
Vera Petrov — Moscow
Anna Orlova — Kazan
Boris Sidorova — Omsk
Boris Ivanov — Kazan
Boris Petrov — Omsk
```

**С общим `row="user"`** — каждый генератор с этим же ключом читает **одну и ту
же** выбранную строку, а разные колонки берут из неё разные ячейки. Записи
согласованы:

```xml
<sequence name="User">
  <gen name="First" type="file" src="@data/users.csv" column="first_name" row="user"/>
  <gen name="Last"  type="file" src="@data/users.csv" column="last_name"  row="user"/>
  <gen name="City"  type="file" src="@data/users.csv" column="city"       row="user"/>
</sequence>
```

`./run example.tdc --data-path ./data`

```
Vera Sidorova — Perm
Grigori Ivanov — Omsk
Boris Petrov — Kazan
Boris Petrov — Kazan
Anna Orlova — Moscow
```

Теперь `first_name`, `last_name` и `city` всегда берутся из одной строки CSV —
поля не могут разъехаться. Ключ — любая непустая строка (`row="user"`); генераторы
связываются, когда у них совпадают `row`, `src`, `delimiter` и режим заголовка. Это
работает на **любом** движке (по умолчанию — потоковый, поэтому память не растёт с
числом строк).

### Взвешенные строки — тянем строку по частоте

**Когда пригодится:** связанную строку нужно выбирать по реальной частоте, а не
равномерно — товар с его настоящей частотой продаж, а его цена и категория
приходят вместе с ним. Добавьте [`weight="колонка"`](../generators/file.md#top) на
одно из полей группы — и строка выбирается взвешенным жребием по этой колонке
(точно, как разбивка [`percent`](../generators/text.md#top)), а остальные поля
по-прежнему читают из той же выбранной строки. Пусть `data/catalog.csv` будет:

```text
name,category,price,sales
Pen,Office,1.10,500
Coffee,Drinks,4.50,1200
Backpack,Bags,45.00,80
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
Coffee | Drinks | 4.50
Pen | Office | 1.10
Coffee | Drinks | 4.50
```

Coffee (продажи 1200) выпадает чаще всего, Backpack (продажи 80) — редко, и цена и
категория каждого товара всегда совпадают с его собственной строкой.

**Про движок.** Без `weight` связанная группа работает на любом движке. **С
`weight`** конфиг всегда считает движок в памяти: потоковый движок не может
взвесить выбор строки, не зная сначала общих итогов по файлу. При явном
`--engine 2` TDC честно об этом скажет, а не выдаст молча несвязные колонки. Полную
картину см. в [Согласованные и связанные данные](coherent-data.md#top).

### Ограничения (v1)

- `row` работает только внутри [`<sequence>`](../core-concepts/sequences.md#top). В
  блоке вывода генераторов нет, поэтому там вопрос не возникает.
- `row` требует [`column`](../generators/file.md#top) — это возможность для CSV, а не
  для простого текстового списка.
- Один и тот же ключ `row` с **разными** источниками их не связывает: TDC заводит
  отдельную группу строк на каждое сочетание источника, разделителя и режима
  заголовка. Это не ошибка, просто нужно иметь в виду.

## Запись CSV обратно

Прочитать CSV — половина дела, **записать** его безопасно — вторая половина.
Значение с запятой или кавычкой сломало бы строку. Фильтр
[`csv`](masks-and-case.md#top) заключает поле по RFC 4180:

```xml
<data>${{Id}},${{Name | csv}},${{Category}}</data>
```

`./run example.tdc`

```
7,"Набор ножей, 3 шт",Кухня
2,"Кофе ""Арабика"" 250 г",Бакалея
```

Запятая внутри `Набор ножей, 3 шт` больше не разбивает строку, а внутренние кавычки
в `Кофе "Арабика" 250 г` удваиваются. Фильтры экранирования
[`csv`](masks-and-case.md#top) и [`sql`](masks-and-case.md#top), а также сборка целых
файлов CSV/JSON/SQL, разобраны в [Масках и регистре](masks-and-case.md#top) и в
[Форматах вывода](output-formats.md#top).

## Где ищутся файлы

`src="@data/…"` ищется в папках, переданных через `--data-path`; голый
`src="names.txt"` берётся рядом с конфигом; пути пакетов `pkg:` и абсолютные пути
тоже работают. Файлы читаются как UTF-8, а неразрешённый путь останавливает рендер
с ошибкой, а не тихо выдаёт пустоту. Полная таблица разрешения путей — на странице
[Генератор file](../generators/file.md#top).

## Смотрите также

- **[Генератор file](../generators/file.md#top)** — каждый атрибут во всех
  подробностях.
- **[Согласованные и связанные данные](coherent-data.md#top)** — связывание
  зависимых полей и взвешенные строки.
- **[Маски и регистр](masks-and-case.md#top)** — фильтры экранирования `csv` / `sql`
  и `order="sequential"`.
- **[Форматы вывода](output-formats.md#top)** — сборка CSV/JSON/SQL вокруг ваших
  данных.

---

← Назад: [Без повторов в строке (distinct)](./distinct.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Форматы вывода (CSV, JSON, SQL…)](./output-formats.md#top) →

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/guides/files-and-csv)**
