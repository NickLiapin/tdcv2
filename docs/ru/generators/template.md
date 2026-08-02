<a name="top"></a>

[English](../../generators/template.md#top) · **Русский** · [Español](../../es/generators/template.md#top)

← Назад: [number](./number.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Файл](./file.md#top) →

---

# Генератор `template`

**Используйте, когда** нужны реалистичные «настоящие» данные — имена, даты
рождения, страны — или технические идентификаторы — UUID, e-mail, IBAN,
налоговые номера, — которые не хочется выдумывать руками. `type="template"` берёт
значение из встроенного источника; атрибут [`value`](../reference/attributes.md#top) —
это **адрес через точку**, выбирающий конкретный источник, и многие шаблоны
учитывают [локаль](../core-concepts/configuration.md#top).

Неизвестный адрес приводит к ошибке рендера: `unknown template path "..."`.

> [!NOTE]
> **Вывод — иллюстративный**
>
> Значения на этой странице получены с фиксированным `seed`, поэтому они
> воспроизводимы, но точные строки могут отличаться между версиями ядра. Считайте их
> примерами *формы*, а не гарантией.

## Зачем это, а не обычный список

С [`text`](text.md#top) имена приходится **писать руками** — короткий список, который
повторяется и не локализован. `template` вместо этого достаёт значения из большого
встроенного пула, на нужном языке и без единой строки данных в конфиге:

```xml
<sequence name="Manual"><gen type="text" value="Иван,Пётр,Анна"/></sequence>
<sequence name="Tpl"><gen type="template" value="person.male.firstName"/></sequence>
```

`./run demo.tdc`

```
руками=Иван   шаблон=Олег
руками=Пётр   шаблон=Владимир
руками=Анна   шаблон=Андрей
руками=Иван   шаблон=Пётр
руками=Пётр   шаблон=Сергей
```

Ручной список крутит одни и те же три значения; шаблон достаёт из большого
встроенного пула.

## Целая карточка человека

Несколько шаблонов вместе собирают согласованную запись: пол берётся первым, а имя
подтягивается под него через [`parent`](../core-concepts/sequences.md#top). Итоговая
строка собирается в блоке [`<data>`](../core-concepts/output-formatting.md#top):

```xml
<env count="6" seed="demo" local="ru">
  <sequence name="Gender"><gen type="template" value="person.gender"/></sequence>
  <sequence name="Man" parent="Gender.мужчина">
    <gen name="First" type="template" value="person.male.firstName"/>
    <gen name="Last"  type="template" value="person.lastName"/>
  </sequence>
  <sequence name="Woman" parent="Gender.женщина">
    <gen name="First" type="template" value="person.female.firstName"/>
    <gen name="Last"  type="template" value="person.lastName"/>
  </sequence>
  <sequence name="Bday">
    <gen type="template" value="person.b_day" youngest="18" oldest="70" format="DD.MM.YYYY"/>
  </sequence>
</env>
```

`./run person.tdc`

```
женщина: Юлия Батый, 28.11.1985
мужчина: Дмитрий Яблоков, 31.08.2001
женщина: Екатерина Троян, 25.04.1984
мужчина: Олег Верста, 20.05.1998
мужчина: Владимир Кравчук, 28.08.1981
женщина: Ольга Верста, 20.04.1970
```

Мужским строкам достаются мужские имена, женским — женские, и всё это нигде не
написано руками. Дальше страница проходит по каждому семейству шаблонов с реальным
выводом.

## Персональные данные

| Адрес                     | Что выдаёт                                     | Зависит от локали |
| :------------------------ | :--------------------------------------------- | :---------------: |
| `person.male.firstName`   | Мужское имя                                    |    `en`, `ru`     |
| `person.female.firstName` | Женское имя                                    |    `en`, `ru`     |
| `person.lastName`         | Фамилия (мужские + общие фамилии локали)       |    `en`, `ru`     |
| `person.male.diagnosis`   | Мужской диагноз + общие диагнозы               |    `en`, `ru`     |
| `person.female.diagnosis` | Женский диагноз + общие диагнозы               |    `en`, `ru`     |
| `person.gender`           | Случайный пол; ярлык берётся из локали         |    `en`, `ru`     |
| `person.b_day`            | Дата рождения в заданном формате               |   только формат   |

> [!NOTE]
> **Почему `lastName` смешивает два пула**
>
> `person.lastName` склеивает мужские фамилии с **общими** фамилиями локали (теми,
> что одинаковы для обоих полов). В некоторых языках это различие важно: склоняемые
> фамилии имеют отдельные мужскую и женскую формы, а несклоняемые — общие. Поэтому
> пул собран именно так, а не строго «только мужские».

### Имена — мужские и женские

Один и тот же генератор, по одному адресу на каждый пол:

```xml
<sequence name="M"><gen type="template" value="person.male.firstName"/></sequence>
<sequence name="F"><gen type="template" value="person.female.firstName"/></sequence>
```

`./run names.tdc (local=ru)`

```
муж=Дмитрий    жен=Анна
муж=Андрей     жен=Мария
муж=Максим     жен=Екатерина
муж=Олег       жен=Ольга
муж=Сергей     жен=Юлия
муж=Владимир   жен=Ирина
```

Два отдельных адреса нужны, когда пол строки уже задан (как в примере с
согласованной карточкой выше). Если же пол хочется выбрать случайно, сначала берут
один жребий по `person.gender` (см. раздел ниже).

### Фамилии и диагнозы

`person.lastName` и гендерные адреса `person.*.diagnosis` работают так же — выбираете
адрес, получаете значение из пула:

```xml
<sequence name="L"><gen type="template" value="person.lastName"/></sequence>
<sequence name="D"><gen type="template" value="person.male.diagnosis"/></sequence>
```

`./run patient.tdc (local=ru)`

```
фамилия=Яблоков    диагноз=Гипертония
фамилия=Кравчук    диагноз=Сахарный диабет 2 типа
фамилия=Верста     диагноз=Бронхиальная астма
фамилия=Строяков   диагноз=Хронический гастрит
фамилия=Салогуб    диагноз=Мигрень
фамилия=Долгих     диагноз=Гипертония
```

Пулы диагнозов разделены по полу для правдоподобия — `person.female.diagnosis`
берёт из женского списка, смешанного с общими состояниями, — поэтому у них тот же
раздел `male` / `female`, что и у имён. Используйте их для синтетических медицинских
фикстур, где ярлык должен просто *выглядеть* правдоподобно, а не быть клинически
точным.

### `person.gender` — ярлык, зависящий от локали

`person.gender` — это не фиксированная строка `Male` / `Female`, а ярлык из списка
текущей локали (примерно 50/50). Именно эти строки вы передаёте ключом в
[`parent`](../core-concepts/sequences.md#top), так что смена локали меняет и ключ, на
который вы сопоставляетесь:

```xml
<sequence name="Gender"><gen type="template" value="person.gender"/></sequence>
```

`./run gender.tdc (локализация: en и ru)`

```
local="en"     local="ru"
Male           мужчина
Male           мужчина
Female         женщина
Male           мужчина
Female         женщина
Male           мужчина
```

Под `local="en"` ключи — `Male` / `Female`; под `local="ru"` тот же жребий даёт
`мужчина` / `женщина`. В первом случае сопоставляйтесь через `parent="Gender.Male"`,
во втором — `parent="Gender.мужчина"`.

### Локализация — один адрес, два языка

Адрес не меняется — меняется только [`local`](../core-concepts/configuration.md#top) у
`<env>`. Вот `person.male.firstName` + `person.lastName`, отрендеренные один раз
по-английски и один раз по-русски, чтобы показать, как **один и тот же конфиг** даёт
локализованный вывод:

`./run names.tdc (локализация: en и ru)`

```
local="en"           local="ru"
Ahmed Spangler       Пётр Строяков
Griffin Richey       Дмитрий Строяков
Zavier Fong          Михаил Строяков
Emilio Halstead      Дмитрий Салогуб
Cullen Bristol       Андрей Долгих
Titan Bryant         Андрей Белкин
```

Русская колонка — демонстрация локализации: суть в том, что один адрес ложится на тот
пакет данных, который выбирает локаль. Под `local="en"` по умолчанию берётся
английский.

## Местоположение

| Адрес              | Что выдаёт      | Зависит от локали |
| :----------------- | :-------------- | :---------------: |
| `location.country` | Название страны | все 9 локалей     |

```xml
<sequence name="C"><gen type="template" value="location.country"/></sequence>
```

`./run country.tdc (local=en)`

```
Libya
Japan
Wallis and Futuna Islands
Colombia
Lesotho
Iceland
```

Список локализован: под `local="ru"` выходят русские названия (`Словения`, `Латвия`,
`Лаос`), под `local="es"` — испанские.

> [!NOTE]
> **Во всех локалях, у которых есть пакет**
>
> `location.country` есть во всех девяти локалях с пакетом данных — **en**, **es**, **de**,
> **it**, **pt**, **fr**, **ru**, **ar** и **zh-cn**, — и везде это одни и те же 233 страны
> и территории (в английском — 237). У локали без пакета списка нет: адрес выдаёт ошибку, а
> не откатывается на английский. Города и регионы запланированы.

## Даты

Оба шаблона дат используют те же токены формата (и зависящие от локали `L` / `LL`),
что и [генератор `date`](date.md#top).

### `person.b_day` — дата рождения

| Атрибут    | По умолчанию   | Описание                                       |
| :--------- | :------------- | :--------------------------------------------- |
| `oldest`   | `80`           | Максимальный возраст (лет)                     |
| `youngest` | `10`           | Минимальный возраст (лет)                      |
| `format`   | `L`            | Формат вывода (TDC date-format)                |
| `local`    | из `<env>`     | Локаль для локализованных форматов (`L`, `LL`) |

Используйте, когда записи нужна дата рождения с ограничением по возрасту — окно
`youngest` / `oldest` держит всех внутри правдоподобного возрастного диапазона.

```xml
<gen type="template" value="person.b_day" youngest="18" oldest="65" format="YYYY-MM-DD"/>
```

`./run bday.tdc`

```
1999-11-18
1973-02-22
1999-04-15
1971-04-30
1986-06-17
1988-09-17
```

#### Локализованные названия месяцев через `LL`

Формат `LL` пишет месяц словом на языке локали — сама дата не меняется, меняется
только её написание:

`./run bday.tdc (format=LL, локализация: en и ru)`

```
local="en"            local="ru"
November 18, 1999     18 ноября 1999 г.
February 22, 1973     22 февраля 1973 г.
April 15, 1999        15 апреля 1999 г.
April 30, 1971        30 апреля 1971 г.
June 17, 1986         17 июня 1986 г.
September 17, 1988    17 сентября 1988 г.
```

### `date.range` — дата из диапазона

| Атрибут  | По умолчанию | Описание                                      |
| :------- | :----------- | :-------------------------------------------- |
| `range`  | —            | **Обязательный.** `"YYYY.MM.DD - YYYY.MM.DD"` |
| `format` | `L`          | Формат вывода                                 |
| `local`  | из `<env>`   | Локаль для локализованных форматов            |

Используйте для любой даты, кроме дня рождения — дата заказа, регистрации, события —
везде, где нужен равномерный жребий между двумя явными границами.

```xml
<gen type="template" value="date.range" range="2020.01.01 - 2025.12.31" format="DD.MM.YYYY"/>
```

`./run event.tdc`

```
08.12.2023
05.11.2020
23.02.2023
30.10.2024
03.08.2024
16.05.2020
```

Та же локализация `LL` работает и здесь — поменяйте на `format="LL"`, и месяц
напечатается словом на активной локали (`December 8, 2023` под `en`,
`8 декабря 2023 г.` под `ru`).

## Технические идентификаторы

Тот же `type="template"` строит и **алгоритмические идентификаторы** — UUID, e-mail,
IBAN, номера карт, налоговые и документные номера с контрольной суммой. Два правила
именования:

- **Глобальные** идентификаторы несут префикс `common.` — `common.id.uuid`,
  `common.finance.iban`, `common.payment.card.pan`, `common.phone.e164`.
- **Привязанные к стране** начинаются с названия страны — `russia.tax.inn_org`,
  `russia.docs.snils`, `brazil.tax.cpf`, `poland.docs.pesel`.

### Почему это не просто случайные цифры

У большинства «номеров-идентификаторов» есть **контрольная цифра**, посчитанная из
остального номера (Луна, mod-11, ISO 7064, …). Десять случайных цифр забракует первая
же проверка формата, так что тесты на них бесполезны. Эти шаблоны выдают значения,
которые **проходят свою контрольную сумму**, но при этом заведомо ненастоящие —
зарезервированные тестовые диапазоны, вымышленные префиксы, — поэтому их безопасно
класть в демо, фикстуры и CI.

### Идентификаторы и интернет

```xml
<gen type="template" value="common.id.uuid"/>
<gen type="template" value="common.id.ulid"/>
<gen type="template" value="common.internet.email"/>
<gen type="template" value="common.internet.ipv4"/>
<gen type="template" value="common.system.semver"/>
```

`./run ids.tdc`

```
common.id.uuid          b04b0159-d6a6-441f-b3cb-8941d2742bd0
common.id.ulid          609Q13BKAVCMD292YSS7RQ1HK9
common.internet.email   uak1benwm6@fixture-odkd82.test
common.internet.ipv4    192.168.102.101
common.system.semver    7.0.7
```

E-mail и домены используют зарезервированные IANA домены верхнего уровня (`.test`,
`.invalid`, `.example`), а IP — частные диапазоны, так что ничего здесь не может
столкнуться с реальным адресом. Также доступны: `common.id.nanoid`,
`common.id.object_id`, `common.internet.url`, `common.internet.mac`,
`common.internet.slug`, `common.internet.username`.

### Финансы и платежи

```xml
<gen type="template" value="common.finance.iban"/>
<gen type="template" value="common.finance.bic"/>
<gen type="template" value="common.payment.card.pan"/>
<gen type="template" value="russia.bank.account"/>
```

`./run finance.tdc`

```
common.finance.iban       DE68702701363846402097
common.finance.bic        SAHTDENW5OW
common.payment.card.pan   4242420270136385
russia.bank.account       40802810546402097727
```

IBAN несёт корректную контрольную сумму ISO 7064 mod-97, номер карты (PAN) — корректную
проверку Луна в тестовом диапазоне Visa (`4242…`), а российский счёт — корректный
межполевой ключ mod-10; каждый проходит проверку формата, оставаясь ненастоящим.

### Товары и устройства

```xml
<gen type="template" value="common.book.isbn13"/>
<gen type="template" value="common.product.ean13"/>
<gen type="template" value="common.device.imei"/>
<gen type="template" value="common.vehicle.vin"/>
```

`./run products.tdc`

```
common.book.isbn13     9790270136387
common.product.ean13   7027013638467
common.device.imei     702701363846407
common.vehicle.vin     0AK1BDNX8L5640209
```

Также доступны: `common.book.isbn10`, `common.product.gtin14`, `common.product.upc_a`,
`common.periodical.issn`, `common.device.iccid`.

### Безопасность и хеши

```xml
<gen type="template" value="common.security.api_key"/>
<gen type="template" value="common.security.otp"/>
<gen type="template" value="common.security.sha256"/>
<gen type="template" value="common.git.sha"/>
```

`./run security.tdc`

```
common.security.api_key   tdc_i1Hk26NbKrPdP5H5xnmFlk3XbH5rBSI9
common.security.otp       702701
common.security.sha256    b04b01595d6a6141fcc3cb08941d2742bd0800d71700...
common.git.sha            b04b01595d6a6141fcc3cb08941d2742bd0800d7
```

Также доступны: `common.security.jwt`, `common.security.md5`, `common.security.sha1`,
`common.security.totp_secret`.

### Телефоны

`common.phone.e164` выбирает случайную страну; у каждой страны есть и свой адрес. Все
выдают форму E.164 и используют вымышленные диапазоны, зарезервированные для
кино/тестов (российские мобильные `+7 9XX`, британский Ofcom `07700 900xxx`, …):

```xml
<gen type="template" value="russia.phone"/>
<gen type="template" value="common.phone.e164"/>
```

`./run phones.tdc`

```
russia.phone        +79702701363
russia.phone        +79682926087
common.phone.e164   +447700900829
common.phone.e164   +33670270136
```

### Национальные налоговые и документные номера

У каждой страны есть своё семейство номеров с контрольной суммой. Одного российского
набора хватает для большинства нужд:

```xml
<gen type="template" value="russia.docs.snils"/>
<gen type="template" value="russia.tax.inn_org"/>
<gen type="template" value="russia.tax.inn_person"/>
<gen type="template" value="russia.tax.ogrn"/>
```

`./run ru-ids.tdc`

```
russia.docs.snils       70270136346
russia.tax.inn_org      7027136386
russia.tax.inn_person   702713638455
russia.tax.ogrn         1707038464021
```

Десятки других стран доступны по тому же принципу — `usa.docs.ssn`, `brazil.tax.cpf`,
`poland.docs.pesel`, `germany.tax.vat`, `france.tax.siren` и многие другие. Полный
каталог по странам — в [Справочнике](../reference/generators.md#top).

```xml
<gen type="template" value="brazil.tax.cpf"/>
<gen type="template" value="poland.docs.pesel"/>
<gen type="template" value="germany.tax.vat"/>
<gen type="template" value="france.tax.siren"/>
```

`./run world-ids.tdc`

```
brazil.tax.cpf       64173916477
poland.docs.pesel    18302310570
germany.tax.vat      DE153363548
france.tax.siren     860356302
```

Четыре страны, четыре схемы, один тег: у CPF пара контрольных цифр по mod-11, у PESEL
внутри дата рождения и цифра по mod-10, у немецкого VAT свой mod-11, у SIREN проверка по
Луну. Все проходят проверку формата и при этом никому не принадлежат.

### Параметры

Многие идентификаторы принимают **параметры** — передавайте их обычными атрибутами на
[`<gen>`](../reference/tags.md#top). Любой параметр, который вы опустили, берётся
случайно; заданный — закрепляется во всех строках. Например, зафиксируем домен
e-mail:

```xml
<gen type="template" value="common.internet.email" domain="example.test"/>
```

`./run email.tdc`

```
uak1benwm6@example.test
j3k8iya414@example.test
p7m2nqx8v0@example.test
z0k4hya3c1@example.test
r5t9bd6l2e@example.test
```

Страновые генераторы принимают свои параметры — код налоговой (`tax_office`), пол
(`sex`), префикс, — и контрольная цифра всегда пересчитывается, чтобы остаться
верной. Какие параметры принимает конкретный адрес, определяет стоящий за ним
[пакет данных](../data-packs/overview.md#top): каждая локальная `<sequence name="…">` в
пакете — это один параметр. Неверный параметр — понятная ошибка (`TDC072`), никогда не
тихая: TDC сообщает, что адрес на самом деле принимает.

> [!NOTE]
> **Упрощённые варианты**
>
> При переезде этих генераторов в редактируемые пакеты часть редких параметров и
> «форматированных» вариантов (со скобками или дефисами) были сведены к основному виду.
> Контрольные суммы и основной формат сохранены; убрана только косметическая обёртка.

### Как устроены контрольные цифры

Логика контрольной суммы не спрятана в скомпилированном коде — каждый пакет считает свою
контрольную цифру **декларативно** тегом [`<compute>`](../reference/compute.md#top),
прямо рядом с данными. Поменялись правила в стране — вы правите текстовый файл пакета, а
не движок. Как устроен пакет — см. [Пакеты данных](../data-packs/overview.md#top).

## Где хранятся данные шаблонов

Сейчас пулы шаблонов поставляются вместе с библиотекой и доступны через встроенные
адреса, перечисленные выше. В планах — загружать *любой* файл с данными
«декларативно» (с метаданными: что это, чем разделено, какой класс это разбирает),
чтобы вы могли регистрировать свои пулы так же, как зарегистрированы встроенные.
Пока же доступны ровно те встроенные шаблоны, что описаны здесь.

## См. также

- **[Дата](date.md#top)** — токены формата, которые используют эти шаблоны дат.
- **[`<compute>`](../reference/compute.md#top)** — как определяются контрольные суммы.
- **[Справочник: генераторы](../reference/generators.md#top)** — полный каталог идентификаторов.
- **[Пакеты данных](../data-packs/overview.md#top)** — откуда берутся данные шаблонов и как добавить свои.

---

← Назад: [number](./number.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Файл](./file.md#top) →
