<a name="top"></a>

[English](../../getting-started/first-data.md#top) · **Русский** · [Español](../../es/getting-started/first-data.md#top)

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/getting-started/first-data)**

← Назад: [Quick API — по одному значению](./quick-api.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Поддержка в редакторе](./editor-support.md#top) →

---

# Первый датасет

Тестовые данные нужны постоянно — наполнить базу для демо, прогнать нагрузочный
тест, проверить экспорт в CSV, показать таблицу заказчику. Писать их руками
долго, а получаются они однобокими и неслучайными. Готовые fake-генераторы выдают
отдельные значения, но собрать из них **связный** набор — чтобы имя совпадало с
полом, а город со страной — это и есть самое трудное.

TDC переворачивает задачу: вы **описываете**, из чего состоит строка, а движок
собирает сколько угодно **правдоподобных** и **воспроизводимых** строк. Один и тот
же `seed` всегда даёт один и тот же результат — именно это и нужно как для тестов,
так и для примеров в документации. Формат вывода — обычный текст, CSV, JSON, SQL —
задаёте вы сами через шаблон строки.

Эта страница — трёхминутное «Hello, TDC». Вы напишете небольшой конфиг, запустите
его и увидите воспроизводимый вывод, а затем сделаете ещё один шаг к главной возможности
TDC — зависимым полям.

## Шаг 1 — Пишем самый простой конфиг

Создайте файл `demo.tdc`:

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
        <line><data>${{Name}}, возраст ${{Age}}</data></line>
    </block>
</tdc>
```

Что делает каждая часть:

- [`<env>`](../core-concepts/configuration.md#top) с `count="3"` — сгенерировать **3**
  строки; `seed` фиксирует случайность, чтобы результат
  [повторялся](../core-concepts/determinism.md#top) от запуска к запуску.
- [`<sequence>`](../core-concepts/sequences.md#top) — **столбец** данных; внутренний
  [`<gen>`](../generators/overview.md#top) говорит, откуда брать значения (здесь —
  случайное имя из списка).
- [`type="text"`](../generators/text.md#top) — выбрать одно значение из списка через
  запятую.
- [`type="number"`](../generators/number.md#top) с `value="18..65"` — случайное число
  из диапазона.
- [`<block>`](../core-concepts/output-formatting.md#top) / `<line>` / `<data>` —
  **шаблон одной строки вывода**; `${{Name}}` подставляет значение этого столбца.

## Шаг 2 — Запускаем

Самый быстрый способ, из корня репозитория:

```bash
./run demo.tdc        # прогнать любой свой файл
```

Под капотом это CLI движка. Полная форма:

```bash
node typescript/dist/cli/main.js demo.tdc
```

После публикации пакета его можно будет запускать откуда угодно:

```bash
npm install -D tdcv2
npx tdcv2 demo.tdc
```

Если движок ещё не собран (нет папки `typescript/dist`), соберите его один раз.
Всё это описано в разделе [Установка](installation.md#top).

## Шаг 3 — Смотрим результат

Поскольку `seed="demo"` фиксирует случайность, вывод одинаков при каждом запуске:

`./run demo.tdc`

```
Елена, возраст 59
Дмитрий, возраст 18
Клара, возраст 53
```

> [!IMPORTANT]
> Конкретные имена и числа здесь приведены для иллюстрации — от версии ядра к версии
> они могут меняться. Суть в том, что один и тот же сид всегда воспроизводит один и
> тот же вывод для заданного ядра.

### Переопределение count и seed из командной строки

Количество строк и сид можно поменять, не трогая сам файл. Это удобно, когда
конфиг зафиксирован (например, лежит в репозитории), но для разового запуска нужен
другой объём или другой случайный набор:

```bash
./run demo.tdc --count 5 --seed alt
```

`./run demo.tdc --count 5 --seed alt`

```
Анна, возраст 20
Борис, возраст 48
Клара, возраст 65
Елена, возраст 22
Дмитрий, возраст 22
```

Новый сид даёт другой, но по-прежнему воспроизводимый набор: перезапустите с
`--seed alt` — и получите ровно те же пять строк снова. Полный список флагов — в
[справочнике CLI](../reference/cli.md#top).

## Шаг дальше — зависимые поля

Главная возможность TDC в том, что поля могут **зависеть** друг от друга. Здесь имя
берётся из мужского или женского списка в зависимости от пола (атрибут `parent`), а
`${{_count}}` — это номер строки:

```xml
<tdc>
    <env count="5" seed="demo" local="ru">
        <sequence name="Gender">
            <gen type="text" value="Мужчина,Женщина" percent="50,50"/>
        </sequence>

        <sequence name="MaleName" parent="Gender.Мужчина">
            <gen type="template" value="person.male.firstName"/>
        </sequence>

        <sequence name="FemaleName" parent="Gender.Женщина">
            <gen type="template" value="person.female.firstName"/>
        </sequence>

        <sequence name="Age">
            <gen type="number" value="18..80"/>
        </sequence>
    </env>

    <block>
        <line><data>${{_count}}. ${{Gender}} — ${{MaleName}}${{FemaleName}}, возраст ${{Age}}</data></line>
    </block>
</tdc>
```

`./run people.tdc`

```
1. Мужчина — Сергей, возраст 72
2. Мужчина — Александр, возраст 18
3. Женщина — Ольга, возраст 64
4. Женщина — Елена, возраст 26
5. Мужчина — Владимир, возраст 32
```

Здесь два новых момента:

- [`percent="50,50"`](../generators/text.md#top) заставляет генератор
  [`text`](../generators/text.md#top) делить значения примерно поровну между `Мужчина` и
  `Женщина`, а не выбирать равновероятно.
- [`type="template"`](../generators/template.md#top) с `value="person.male.firstName"`
  берёт настоящее имя из встроенных данных `person.*` — с учётом активной локали,
  поэтому под `ru` это русские имена.

`MaleName` заполняется только у мужчин, а `FemaleName` — только у женщин, поэтому
`${{MaleName}}${{FemaleName}}` всегда даёт ровно одно имя, подходящее полу — два
поля никогда не «разъедутся». Это и есть ключевая идея, подробно разобранная в
разделе [Иерархические зависимости](../guides/hierarchical-dependencies.md#top).

## Использование TDC из вашего кода

Конфиг одинаков во всех языках; отличается только вызов из хост-языка.

#### TypeScript

```typescript
import { TDC } from "tdcv2";

const data = new TDC({ configFile: "demo.tdc" });
console.log(data.toString());
```

#### Python

```python
from tdcv2 import TDC

data = TDC(config_file="demo.tdc")
print(data.to_string())
```

#### Java

```java
var data = new TDC("demo.tdc");
System.out.println(data.toString());
```

#### C#

```csharp
var data = new Tdc("demo.tdc");
Console.WriteLine(data);
```

#### Rust

```rust
let data = tdcv2::Tdc::from_file("demo.tdc")?;
println!("{data}");
```

> [!NOTE]
> Все пять реализаций готовы и выдают одни и те же байты; эталон, по которому
> сверяются остальные, — TypeScript. У каждой своя страница:
> [TypeScript](../bindings/typescript.md#top), [Python](../bindings/python.md#top),
> [Java](../bindings/java.md#top), [C#](../bindings/csharp.md#top),
> [Rust](../bindings/rust.md#top).

## Что дальше

- **[Структура конфигурации](../core-concepts/configuration.md#top)** — `<tdc>`, `<env>` и как устроен конфиг.
- **[Иерархические зависимости](../guides/hierarchical-dependencies.md#top)** — главная возможность.
- **[Значения-шаблоны](../generators/template.md#top)** — `person.*`, `date.*`, `location.*` и остальные встроенные данные.
- **[Справочник CLI](../reference/cli.md#top)** — полная командная строка, теги, атрибуты и генераторы.

---

← Назад: [Quick API — по одному значению](./quick-api.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Поддержка в редакторе](./editor-support.md#top) →

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/getting-started/first-data)**
