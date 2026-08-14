<a name="top"></a>

[English](../../core-concepts/quick-api.md#top) · **Русский** · [Español](../../es/core-concepts/quick-api.md#top)

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/core-concepts/quick-api)**

← Назад: [Детерминизм и пропорции](./determinism.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Обзор генераторов](../generators/overview.md#top) →

---

# По одному значению

Иногда датасет не нужен. Нужна фамилия — здесь, в этой строке теста; работа, которую
делает faker-библиотека. TDC отвечает на это из тех же пакетов данных, из которых
черпают конфиги, так что имя в юнит-тесте и имя в фикстуре на миллион строк приходят
из одного списка.

Это есть во всех пяти реализациях, и при одном сиде каждая выдаёт одно и то же
значение:

#### TypeScript

```typescript
import { tdc } from 'tdcv2';

tdc.person.lastName(); // Jones
```

#### Python

```python
from tdcv2 import tdc

tdc.person.lastName()  # Jones
```

#### Java

```java
import io.github.nickliapin.tdc.quick.Quick;

Quick tdc = Quick.tdc();

tdc.get("person.lastName");  // Jones
```

#### C#

```csharp
using Tdcv2.Quick;

dynamic tdc = Quick.Tdc;

tdc.person.lastName();  // Jones
```

#### Rust

```rust
use tdcv2::quick::Quick;

let mut tdc = Quick::new();

tdc.get("person.lastName")?;  // Jones
```

Это весь API. Всё, что ниже, — тот же вызов с чем-нибудь впереди.

Каждое значение на этой странице разыграно под сидом `demo`, так что его можно
повторить. Без сида каждый вызов свежий; сид появляется в разделе [Чтобы
повторялось](#чтобы-повторялось).

> [!NOTE]
> **Это ящик с россыпью значений**
>
> Каждый вызов независим. Ничто здесь не связывает одно значение с другим — ни `parent=`,
> ни `<switch>` по вытянутой колонке, ни `uniq`, ни `<compute>`. **Связная запись** — это
> конфиг, см. [Первый датасет](../getting-started/first-data.md#top). Берите этот API, когда
> значениям и правда незачем согласовываться между собой.

## Одно правило: точка есть точка

`person.male.firstName` в коде — это `person.male.firstName` в конфиге и в справочнике.
Второй словарь учить не придётся.

#### TypeScript

```typescript
tdc.person.lastName(); // Jones
tdc.person.male.firstName(); // Robert
tdc.person.female.firstName(); // Linda
tdc.company.industry(); // Pharmaceuticals
tdc.color.name(); // Emerald
tdc.food.dish(); // Chicken Tikka Masala
```

#### Python

```python
tdc.person.lastName()          # Jones
tdc.person.male.firstName()    # Robert
tdc.person.female.firstName()  # Linda
tdc.company.industry()         # Pharmaceuticals
tdc.color.name()               # Emerald
tdc.food.dish()                # Chicken Tikka Masala
```

#### Java

```java
tdc.get("person.lastName");          // Jones
tdc.get("person.male.firstName");    // Robert
tdc.get("person.female.firstName");  // Linda
tdc.get("company.industry");         // Pharmaceuticals
tdc.get("color.name");               // Emerald
tdc.get("food.dish");                // Chicken Tikka Masala
```

#### C#

```csharp
tdc.person.lastName();          // Jones
tdc.person.male.firstName();    // Robert
tdc.person.female.firstName();  // Linda
tdc.company.industry();         // Pharmaceuticals
tdc.color.name();               // Emerald
tdc.food.dish();                // Chicken Tikka Masala
```

#### Rust

```rust
tdc.get("person.lastName")?;          // Jones
tdc.get("person.male.firstName")?;    // Robert
tdc.get("person.female.firstName")?;  // Linda
tdc.get("company.industry")?;         // Pharmaceuticals
tdc.get("color.name")?;               // Emerald
tdc.get("food.dish")?;                // Chicken Tikka Masala
```

Сегменты пишутся так, как их пишут пакеты, включая camelCase, — и в Python, и в C#
ровно так же, как в TypeScript. Эти имена библиотека не выбирала; переименование под
каждый язык означало бы второй словарь, который придётся держать в согласии со
справочником, с конфигом и с четырьмя другими реализациями.

Адрес без префикса читается относительно **активной локали** — ровно как в конфиге.
В `en` выйдет `Jones`; смените локаль, и та же строка даст русскую фамилию.

> [!NOTE]
> **Две записи одного адреса**
>
> TypeScript, Python и C# идут по адресу через члены объекта — `tdc.person.lastName()`, —
> потому что каждый из этих языков умеет отвечать за член, которого до обращения не
> существует. Java и Rust принимают адрес строкой.
>
> Это решение, а не пробел. Запись через члены требует по одному сгенерированному методу
> на адрес, а сгенерированная поверхность способна покрыть только те пакеты, что лежат
> внутри артефакта. Большинство пакетов скачивается во время работы, поэтому
> сгенерированного `tdc.lang().ru()` для пакета, установленного минуту назад, просто не
> будет, а `get("ru.person.lastName")` заработает сразу после загрузки.

## Назвать пакет прямо

Адрес может дотянуться дальше активной локали и назвать пакет. Java и Rust пишут такой
адрес как есть. TypeScript, Python и C# ставят перед ним `common`, `country` или `lang`:
внутри адреса эти три слова смысла не несут и существуют затем, чтобы список
автодополнения после `tdc.` оставался списком категорий, а не стеной из 122 кодов
пакетов.

| Куда ведёт                              | TypeScript, Python, C#          | Java, Rust             |
| :-------------------------------------- | :------------------------------ | :--------------------- |
| активная локаль                         | `tdc.person.lastName()`         | `"person.lastName"`    |
| общий пакет — одинаковый во всех языках | `tdc.common.id.uuid()`          | `"common.id.uuid"`     |
| пакет одной страны                      | `tdc.country.usa.docs.ssn()`    | `"usa.docs.ssn"`       |
| пакет одного языка                      | `tdc.lang.ru.person.lastName()` | `"ru.person.lastName"` |

#### TypeScript

```typescript
tdc.common.id.uuid(); // 3ff6ff76-6ea7-4fad-8b99-3075a14cc7e9
tdc.common.internet.email(); // u99o89qpeo@test-qu8y3h.invalid
tdc.common.finance.iban(); // DE62299399441396459682
tdc.common.finance.currency(); // Swedish Krona

tdc.country.usa.docs.ssn(); // 699209702
tdc.country.usa.finance.aba_routing(); // 659939946
```

#### Python

```python
tdc.common.id.uuid()                   # 3ff6ff76-6ea7-4fad-8b99-3075a14cc7e9
tdc.common.internet.email()            # u99o89qpeo@test-qu8y3h.invalid
tdc.common.finance.iban()              # DE62299399441396459682
tdc.common.finance.currency()          # Swedish Krona

tdc.country.usa.docs.ssn()             # 699209702
tdc.country.usa.finance.aba_routing()  # 659939946
```

#### Java

```java
tdc.get("common.id.uuid");              // 3ff6ff76-6ea7-4fad-8b99-3075a14cc7e9
tdc.get("common.internet.email");       // u99o89qpeo@test-qu8y3h.invalid
tdc.get("common.finance.iban");         // DE62299399441396459682
tdc.get("common.finance.currency");     // Swedish Krona

tdc.get("usa.docs.ssn");                // 699209702
tdc.get("usa.finance.aba_routing");     // 659939946
```

#### C#

```csharp
tdc.common.id.uuid();                   // 3ff6ff76-6ea7-4fad-8b99-3075a14cc7e9
tdc.common.internet.email();            // u99o89qpeo@test-qu8y3h.invalid
tdc.common.finance.iban();              // DE62299399441396459682
tdc.common.finance.currency();          // Swedish Krona

tdc.country.usa.docs.ssn();             // 699209702
tdc.country.usa.finance.aba_routing();  // 659939946
```

#### Rust

```rust
tdc.get("common.id.uuid")?;             // 3ff6ff76-6ea7-4fad-8b99-3075a14cc7e9
tdc.get("common.internet.email")?;      // u99o89qpeo@test-qu8y3h.invalid
tdc.get("common.finance.iban")?;        // DE62299399441396459682
tdc.get("common.finance.currency")?;    // Swedish Krona

tdc.get("usa.docs.ssn")?;               // 699209702
tdc.get("usa.finance.aba_routing")?;    // 659939946
```

Эти два идентификатора не просто похожи на настоящие — в них настоящие контрольные
цифры, те же, что выдал бы конфиг.

## Неустановленный адрес так и скажет

`common`, `en` и пакет США входят в каждую из пяти поставок. Всё остальное — на
расстоянии одной загрузки, и запрос до установки вернёт названную ошибку, а не пустоту:

#### TypeScript

```typescript
tdc.lang.ru.person.lastName();
// TdcQuickError: the "ru" pack is not installed, so "ru.person.lastName" cannot be
// drawn. Install it with `tdcv2 pack add ru` (run `tdcv2 init` once first, to say
// where packs go).
```

#### Python

```python
tdc.lang.ru.person.lastName()
# TdcQuickError: the "ru" pack is not installed, so "ru.person.lastName" cannot be
# drawn. Install it with `tdcv2 pack add ru` (run `tdcv2 init` once first, to say
# where packs go).
```

#### Java

```java
tdc.get("ru.person.lastName");
// TdcQuickException: the "ru" pack is not installed, so "ru.person.lastName" cannot
// be drawn. Install it with `java -jar tdcv2-cli.jar pack add ru` — or `tdcv2 pack
// add ru` if you have aliased the CLI jar — after `java -jar tdcv2-cli.jar init`
// once, to say where packs go.
```

#### C#

```csharp
tdc.lang.ru.person.lastName();
// TdcQuickException: the "ru" pack is not installed, so "ru.person.lastName" cannot
// be drawn. Install it with `tdcv2 pack add ru` (run `tdcv2 init` once first, to say
// where packs go).
```

#### Rust

```rust
tdc.get("ru.person.lastName");
// Err(QuickError): the "ru" pack is not installed, so "ru.person.lastName" cannot be
// drawn. Install it with `tdcv2 pack add ru` (run `tdcv2 init` once first, to say
// where packs go).
```

Формулировка отличается только у Java, и только потому, что Maven ничего не кладёт в
`PATH`: совет запустить `tdcv2` был бы советом, который читателю на Java не набрать.
Сама командная строка во всех пяти одна и та же. См. [Установка
пакетов](../data-packs/installing-packs.md#top).

Опечатка в сегменте — это другая ошибка, и она так и говорит: на `person.lastNam`
приходит `unknown address "person.lastNam" (locale "en"). Did you mean
"en.person.lastName"?`

## Сразу несколько

Запросите `n` значений одним вызовом вместо цикла — это один розыгрыш `n` значений, а
не `n` розыгрышей по одному.

#### TypeScript

```typescript
tdc.person.lastName.many(5);
// [ 'Jones', 'Bush', 'Armstrong', 'Andrews', 'Jimenez' ]
```

#### Python

```python
tdc.person.lastName.many(5)
# ['Jones', 'Bush', 'Armstrong', 'Andrews', 'Jimenez']
```

#### Java

```java
List<String> names = tdc.many("person.lastName", 5);
// [Jones, Bush, Armstrong, Andrews, Jimenez]
```

#### C#

```csharp
IReadOnlyList<string> names = tdc.person.lastName.many(5);
// Jones, Bush, Armstrong, Andrews, Jimenez
```

#### Rust

```rust
let names = tdc.many("person.lastName", 5)?;
// ["Jones", "Bush", "Armstrong", "Andrews", "Jimenez"]
```

## Чтобы повторялось

По умолчанию каждый вызов свежий — то, что нужно в черновом скрипте. Закрепите сид, и
значения станут частью теста, а не переменной в нём. Закрепление сида к тому же
возвращает **новый** объект, а не меняет тот, у которого его вызвали, так что два теста
могут держать разные сиды одновременно.

#### TypeScript

```typescript
const t = tdc.seed('demo');
t.person.lastName(); // Jones — сегодня и через год

const ru = tdc.seed('fixtures').locale('ru');
const en = tdc.seed('fixtures').locale('en');
ru.person.lastName(); // Романенко
en.person.lastName(); // Pearson
```

#### Python

```python
t = tdc.seed("demo")
t.person.lastName()   # Jones — сегодня и через год

ru = tdc.seed("fixtures").locale("ru")
en = tdc.seed("fixtures").locale("en")
ru.person.lastName()  # Романенко
en.person.lastName()  # Pearson
```

#### Java

```java
Quick t = Quick.seeded("demo");
t.get("person.lastName");   // Jones — сегодня и через год

Quick ru = Quick.seeded("fixtures").locale("ru");
Quick en = Quick.seeded("fixtures").locale("en");
ru.get("person.lastName");  // Романенко
en.get("person.lastName");  // Pearson
```

#### C#

```csharp
dynamic t = Quick.Seed("demo");
t.person.lastName();   // Jones — сегодня и через год

dynamic ru = Quick.Seed("fixtures").locale("ru");
dynamic en = Quick.Seed("fixtures").locale("en");
ru.person.lastName();  // Романенко
en.person.lastName();  // Pearson
```

#### Rust

```rust
let mut t = Quick::seeded("demo");
t.get("person.lastName")?;   // Jones — сегодня и через год

let mut ru = Quick::seeded("fixtures").locale("ru");
let mut en = Quick::seeded("fixtures").locale("en");
ru.get("person.lastName")?;  // Романенко
en.get("person.lastName")?;  // Pearson
```

## Генераторы без пакета

Собственные генераторы движка тоже доступны — для значений, которые берутся из правила,
а не из списка. Они принимают атрибуты, а не адрес, поэтому живут под отдельным именем:
категории пакетов уже называются `date`, `text` и `word`, так что верхний уровень занят.

#### TypeScript

```typescript
tdc.gen.number('18..80'); // 66
tdc.gen.regex('[A-Z]{2}-[0-9]{4}'); // FZ-3994
```

#### Python

```python
tdc.gen.number("18..80")             # 66
tdc.gen.regex("[A-Z]{2}-[0-9]{4}")   # FZ-3994
```

#### Java

```java
tdc.gen("number", "18..80");            // 66
tdc.gen("regex", "[A-Z]{2}-[0-9]{4}");  // FZ-3994
```

#### C#

```csharp
tdc.gen.number("18..80");            // 66
tdc.gen.regex("[A-Z]{2}-[0-9]{4}");  // FZ-3994
```

#### Rust

```rust
tdc.gen("number", &[("value", "18..80")])?;            // 66
tdc.gen("regex", &[("value", "[A-Z]{2}-[0-9]{4}")])?;  // FZ-3994
```

Строка — это сокращение для `value=`. Чтобы добраться до остальных атрибутов, передайте
**объект**; а `.many(n, …)` работает у генераторов ровно так же, как у адресов:

```typescript
tdc.gen.date({ from: '2020-01-01', to: '2020-12-31', format: 'DD.MM.YYYY' }); // 12.07.2020
tdc.gen.number({ distribution: 'normal', mean: '170', sd: '10' }); // 163
tdc.gen.number.many(5, '1..9'); // [ '5', '4', '8', '2', '6' ]
```

Адрес принимает параметры так же — `tdc.usa.docs.ssn({ dashes: 'false' })`.

Все генераторы и их атрибуты — в [справочнике генераторов](../generators/number.md#top).

## Значения всегда строки

Включая числа и даты. Мир движка — это текст, именно поэтому один конфиг выдаёт и CSV,
и SQL, и JSON без переделки; а тип результата, меняющийся вместе с адресом, означал бы
разный контракт в каждой из пяти реализаций. Приводите на месте вызова, когда нужно
число:

#### TypeScript

```typescript
const age = Number(tdc.gen.number('18..80'));
```

#### Python

```python
age = int(tdc.gen.number("18..80"))
```

#### Java

```java
int age = Integer.parseInt(tdc.gen("number", "18..80"));
```

#### C#

```csharp
int age = int.Parse(tdc.gen.number("18..80"));
```

#### Rust

```rust
let age: u32 = tdc.gen("number", &[("value", "18..80")])?.parse()?;
```

## Когда нужен конфиг

Берите конфиг в тот момент, когда два значения обязаны согласоваться: город принадлежит
своей стране, сумма заказа сходится со строками, доля в 30% должна быть ровно 30%. Об
этом вся остальная документация, и начинается она с
[первого датасета](../getting-started/first-data.md#top).

## См. также

- **[TypeScript](../bindings/typescript.md#top)**, **[Python](../bindings/python.md#top)**, **[Java](../bindings/java.md#top)**, **[C#](../bindings/csharp.md#top)**, **[Rust](../bindings/rust.md#top)** — те же пять пакетов, для целых наборов данных.
- **[Пакеты данных](../data-packs/overview.md#top)** — что такое пакет и как устроены адреса.
- **[Установка пакетов](../data-packs/installing-packs.md#top)** — как добавить остальные 120.

---

← Назад: [Детерминизм и пропорции](./determinism.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Обзор генераторов](../generators/overview.md#top) →

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/core-concepts/quick-api)**
