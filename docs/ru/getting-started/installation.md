<a name="top"></a>

[English](../../getting-started/installation.md#top) · **Русский** · [Español](../../es/getting-started/installation.md#top)

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/getting-started/installation)**

← Назад: [Введение](../intro.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Первый датасет](./first-data.md#top) →

---

# Установка

TDC задуман для пяти экосистем — **npm** (Node.js / TypeScript), **pip**
(Python), **Maven** (Java), **NuGet** (.NET) и **Cargo** (Rust), — и все они дают
байт-в-байт одинаковый вывод из одного и того же конфига, сида, версии и режима вывода
(см. [Детерминизм и пропорции](../core-concepts/determinism.md#top)).

**Все пять реализаций готовы.** У них одна грамматика, один набор кодов
диагностики и общий набор фикстур, который держит их на одинаковых байтах:
гигабайт вывода из одного конфига получается в каждой одинаковым. В каждой есть
и одна и та же командная строка, так что ни одному конфигу не нужен инструментарий
чужого языка.

Выберите свою экосистему ниже. Если хочется просто попробовать TDC, не выбирая
язык, откройте вкладку npm — там есть однокомандная обёртка, которой не нужна ни
строчки кода.

#### Node.js — npm

**Требования:** Node.js **20.0.0** или новее.

```bash
npm install -D tdcv2
npx tdcv2 init
```

Это вся установка. `init` пишет конфиг и папку `tdcv2-examples/` с тремя разобранными
примерами, а в конце печатает команду, которая запускает первый. Пакеты данных
`common`, `en` и США идут вместе с пакетом, поэтому они работают без единой загрузки.

`npx` здесь не украшение: `npm install -D` кладёт команду в `node_modules/.bin`, а не
в PATH. Остальные четыре экосистемы ниже ставят её настоящей командой, поэтому там в
примерах просто `tdcv2`.

Если же вы хотите работать над самим движком, запускайте его из копии репозитория.
Соберите его один раз:

```bash
npm --workspace typescript run build
```

Дальше любой конфиг запускается указанием Node на собранный CLI:

```bash
node typescript/dist/cli/main.js tdcv2-examples/01-starter.tdc
```

В корне репозитория есть и однокомандная обёртка, чтобы не запоминать этот путь:

```bash
./run demo.tdc        # прогнать любой файл, который вы укажете
```

`./run` — самый быстрый способ увидеть вывод: укажите файл и читайте результат
прямо в терминале. Под капотом вызывается тот же CLI. Полный список опций — `--seed`, `--count`, `--output`,
`--locale` и остальные — в [справочнике CLI](../reference/cli.md#top).

#### Python — pip

**Требования:** Python **3.10** или новее.

Одна команда даёт и библиотеку, и команду `tdcv2`:

```bash
pip install tdcv2
tdcv2 init
```

Это вся настройка. Стартовый набор паков едет внутри колеса, поэтому пример выше
работает без всего остального.

DSL и поведение идентичны npm-версии: тот же `.tdc`-конфиг, запущенный с тем же
`seed`, даёт те же байты. API описан в разделе
[Языковые привязки — Python](../bindings/python.md#top).

#### Java — Maven

**Требования:** Java **17** или новее.

Библиотека — одна зависимость:

```xml
<dependency>
  <groupId>io.github.nickliapin</groupId>
  <artifactId>tdcv2</artifactId>
  <version>0.2.0</version>
</dependency>
```

Gradle, в `build.gradle.kts`:

```kotlin
implementation("io.github.nickliapin:tdcv2:0.2.0")
```

Стартовый набор паков едет внутри jar, так что пример выше работает без всякой
доустановки.

**Командная строка — отдельный артефакт.** У Maven нет
аналога npm-овского `bin`: добавление библиотеки в проект не кладёт команду в PATH,
— поэтому CLI поставляется одним самодостаточным jar, которому нужен только JDK.
Лежит он по тем же координатам, что и библиотека, и отличается классификатором `cli`:

```bash
curl -LO https://repo1.maven.org/maven2/io/github/nickliapin/tdcv2/0.2.0/tdcv2-0.2.0-cli.jar
java -jar tdcv2-0.2.0-cli.jar init
```

Стоит завести алиас: `alias tdcv2='java -jar /path/to/tdcv2-cli.jar'` — после этого
все команды на этих страницах читаются так же, как везде.

DSL и поведение идентичны npm-версии. API описан в разделе
[Языковые привязки — Java](../bindings/java.md#top).

#### .NET — NuGet

**Требования:** .NET **6.0** или новее.

Библиотека — один пакет:

```bash
dotnet add package Tdcv2
```

Стартовый набор паков вшит в сборку, поэтому пакет работает без всего остального.

**Командная строка — отдельный пакет.** У NuGet нет аналога npm-овского `bin`,
поэтому CLI — собственный пакет-инструмент .NET: ставите глобально, и команда
оказывается в PATH:

```bash
dotnet tool install --global Tdcv2.Cli
tdcv2 init
```

DSL и поведение идентичны npm-версии.

#### Rust — Cargo

**Требования:** Rust **1.74** или новее.

Один крейт даёт сразу и библиотеку, и командную строку:

```bash
cargo add tdcv2      # как зависимость
cargo install tdcv2  # как команда
tdcv2 init
```

Стартовые паки вшиты в бинарник, поэтому установленному крейту не нужно ничего на
диске.

Или сборка из репозитория:

```bash
cd rust && cargo build --release
./target/release/tdcv2 init
```

У крейта **нет зависимостей**, так что для сборки не нужно ничего, кроме самого
Rust. Единственное исключение — HTTPS: `tdcv2 pack` запускает `curl` и, если его
нет, подскажет, как поставить.

DSL и поведение — те же, что в npm-версии.

## Проверяем, что всё работает

`init` уже оставил вам что запустить — `tdcv2-examples/01-starter.tdc` и ещё два рядом.
**Эти файлы появляются только после `init`**: при установке их никто не создаёт, и после
они ваши — правьте как хотите.

Запуск первого и есть проверка, что установка живая:

```bash
tdcv2 tdcv2-examples/01-starter.tdc
```

Дальше в этом разделе то же самое собирается руками, чтобы было видно, откуда берётся
каждая строка. Создайте файл `demo.tdc`. В нём две колонки — имя,
выбранное из списка через [`type="text"`](../generators/text.md#top), и возраст из
диапазона через [`type="number"`](../generators/number.md#top), — и однострочный
шаблон вывода:

```xml
<tdc>
    <env count="3" seed="demo">
        <sequence name="Name">
            <gen type="text" value="Анна,Борис,Клара,Дмитрий,Елена"/>
        </sequence>
        <sequence name="Age">
            <gen type="number" value="18..65"/>
        </sequence>
    </env>

    <block>
        <line>
            <data>${{Name}}, возраст ${{Age}}</data>
        </line>
    </block>
</tdc>
```

Запустите той командой, которую дала ваша установка. Три экосистемы кладут `tdcv2` в
PATH из того же пакета, что несёт библиотеку; у Maven и NuGet нет аналога npm-овского
`bin`, поэтому там командная строка — отдельный артефакт:

| Язык    | Команда                                                                                                         |
| :------ | :-------------------------------------------------------------------------------------------------------------- |
| Node.js | `npx tdcv2 tdcv2-examples/01-starter.tdc`                                                                                            |
| Python  | `tdcv2 tdcv2-examples/01-starter.tdc`                                                                                                |
| Rust    | `tdcv2 tdcv2-examples/01-starter.tdc`, после `cargo install tdcv2`                                                                   |
| C#      | `tdcv2 tdcv2-examples/01-starter.tdc`, после `dotnet tool install --global Tdcv2.Cli`                                                |
| Java    | `java -jar tdcv2-0.2.0-cli.jar tdcv2-examples/01-starter.tdc` — классификатор `cli` у координат самой библиотеки                     |

Из корня репозитория короче всех — `./run demo.tdc`.

`tdcv2 demo.tdc`

```
Елена, возраст 59
Дмитрий, возраст 18
Клара, возраст 53
```

> [!IMPORTANT]
> Конкретные имена и числа приведены для примера — от версии ядра они могут
> отличаться. Важно другое: `seed="demo"` делает прогон воспроизводимым — тот же
> конфиг с тем же сидом каждый раз даёт тот же вывод.

Если вы получили три строки вида `Имя, N лет`, установка работает. Проверьте
воспроизводимость, запустив команду второй раз, — три строки будут теми же.
Затем переопределите число строк и сид прямо из командной строки, не трогая файл:

```bash
tdcv2 demo.tdc --count 20 --seed alt
```

## Или совсем без конфига

Конфиг — это способ описать целый набор данных. Но та же установка отвечает и на одно
значение, как это делает faker: без файла, без `<env>`, одним вызовом:

#### TypeScript

```typescript
import { tdc } from 'tdcv2';

tdc.person.lastName(); // Jones
tdc.person.male.firstName(); // Robert
tdc.common.finance.iban(); // DE62299399441396459682
tdc.country.usa.docs.ssn(); // 699209702 — с настоящими контрольными цифрами
tdc.lang.ru.person.lastName(); // после `tdcv2 pack add ru`
```

#### Python

```python
from tdcv2 import tdc

tdc.person.lastName()           # Jones
tdc.person.male.firstName()     # Robert
tdc.common.finance.iban()       # DE62299399441396459682
tdc.country.usa.docs.ssn()      # 699209702 — с настоящими контрольными цифрами
tdc.lang.ru.person.lastName()   # после `tdcv2 pack add ru`
```

#### Java

```java
import io.github.nickliapin.tdc.quick.Quick;

Quick tdc = Quick.tdc();

tdc.get("person.lastName");        // Jones
tdc.get("person.male.firstName");  // Robert
tdc.get("common.finance.iban");    // DE62299399441396459682
tdc.get("usa.docs.ssn");           // 699209702 — с настоящими контрольными цифрами
tdc.get("ru.person.lastName");     // после `java -jar tdcv2-cli.jar pack add ru`
```

#### C#

```csharp
using Tdcv2.Quick;

dynamic tdc = Quick.Tdc;

tdc.person.lastName();          // Jones
tdc.person.male.firstName();    // Robert
tdc.common.finance.iban();      // DE62299399441396459682
tdc.country.usa.docs.ssn();     // 699209702 — с настоящими контрольными цифрами
tdc.lang.ru.person.lastName();  // после `tdcv2 pack add ru`
```

#### Rust

```rust
use tdcv2::quick::Quick;

let mut tdc = Quick::new();

tdc.get("person.lastName")?;        // Jones
tdc.get("person.male.firstName")?;  // Robert
tdc.get("common.finance.iban")?;    // DE62299399441396459682
tdc.get("usa.docs.ssn")?;           // 699209702 — с настоящими контрольными цифрами
tdc.get("ru.person.lastName")?;     // после `tdcv2 pack add ru`
```

Оба пути читают одни и те же пакеты данных, так что фамилия из однострочного вызова и
фамилия из конфига на миллион строк приходят из одного списка. Что выбрать — зависит от
того, должны ли значения согласовываться между собой: конфиг связывает город со страной
и держит долю ровно в 30%, а одиночный вызов не связывает ничего ни с чем.

Вся поверхность — `.many(n)`, `seed()`, `locale()` и способ дотянуться до конкретного
пакета в каждом языке — на странице [API одного
значения](../core-concepts/quick-api.md#top).

> [!NOTE]
> **Значения здесь взяты из сида**
>
> Сама по себе каждая из пяти реализаций случайна на каждый запуск процесса — как faker.
> В комментариях стоит то, что разыгрывает сид `demo`, так что `tdc.seed('demo')` — в Java
> и Rust `Quick.seeded("demo")` — повторит их в точности.

## Установка пакетов данных (необязательно)

Имена, города, регионы, компании и прочие списки значений поставляются как
**пакеты данных** — отдельно от движка, чтобы обновление библиотеки никогда не
затирало ваши данные. Разумный набор по умолчанию (например, топ-1000 имён) идёт
из коробки, поэтому пример из проверки выше работает без каких-либо докачек.
Полные и дополнительные наборы скачиваются по требованию.

Настраивается это двумя командами — по одному разу каждая:

```bash
tdcv2 init            # выбрать, где лежат пакеты, и локаль по умолчанию
tdcv2 pack list       # посмотреть, что предлагает реестр
tdcv2 pack add en usa # скачать и подключить нужные пакеты
```

> [!NOTE]
> При установке через npm каждая из них — это `npx tdcv2 …`: команда живёт в
> `node_modules/.bin`. pip, cargo и `dotnet tool install -g` кладут `tdcv2` в PATH, там
> строки выше набираются ровно так, как написаны.

`tdcv2 pack list` печатает каталог, отмечая уже установленное:

`tdcv2 pack list`

```
Available data packs:

common ✓ installed Common (locale-agnostic) (0.0 MB)
Generators bound to neither a language nor a country: uuid,
hashes, ISBN/ISSN, GTIN/UPC/EAN, card PANs, MRZ, IPv4/IPv6/MAC,
semver, and more.

…

usa ✓ installed Usa (country) (0.0 MB)
Data specific to the USA regardless of the language it is
written in: SSN/ITIN/EIN, ZIP codes, states, street names, ABA
routing numbers, phone format, license plates.
```

Пакеты **компонуются** по независимым осям — язык, страна и локаль-независимый
`common`, — так что данные для США по-английски = `common` + `en` + `usa`.
Полный порядок работы (файл конфигурации, затенение пакетов, удаление) описан в
разделе [Установка пакетов данных](../data-packs/installing-packs.md#top).

## Что дальше

- **[Ваш первый набор данных](first-data.md#top)** — написать, запустить и расширить конфиг за три минуты.
- **[Справочник CLI](../reference/cli.md#top)** — все флаги: `--seed`, `--count`, `--output`, `--locale`, `--data-path` и коды выхода.
- **[Установка пакетов данных](../data-packs/installing-packs.md#top)** — полный процесс `init` / `pack`.

---

← Назад: [Введение](../intro.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Первый датасет](./first-data.md#top) →

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/getting-started/installation)**
