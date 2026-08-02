<a name="top"></a>

[English](../../bindings/typescript.md#top) · **Русский** · [Español](../../es/bindings/typescript.md#top)

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/bindings/typescript)**

← Назад: [Коды ошибок](../reference/errors.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [По одному значению](./quick-api.md#top) →

---

# TypeScript

Пакет для TypeScript — это эталонная реализация TDC. CLI хорош, когда нужен файл;
библиотека нужна, чтобы получить данные **прямо в коде** — как строку или как живые
JS-объекты — без запуска внешнего процесса и чтения файла.

```ts
import { TDC } from "tdcv2";
```

## Создание `TDC`

Конструктор принимает либо путь к DSL-файлу (`configFile`), либо строку с DSL
(`configString`). Runtime-параметры `seed`, `count`, `locale` и `now` можно
переопределить из кода — они бьют значения из `<env>`.

```ts
const tdc = new TDC({
  configString: `<tdc>
    <env count="4" seed="demo" local="ru">
      <sequence name="Gender"><gen type="text" value="Мужчина,Женщина"/></sequence>
      <sequence name="MaleName" parent="Gender.Мужчина"><gen type="template" value="person.male.firstName"/></sequence>
      <sequence name="FemaleName" parent="Gender.Женщина"><gen type="template" value="person.female.firstName"/></sequence>
      <before><line><data>Пол,Имя</data></line></before>
    </env>
    <block><line><data>\${{Gender}},\${{MaleName}}\${{FemaleName}}</data></line></block>
  </tdc>`,
});

console.log(tdc.toString());
```

Имя привязано к полу через `parent`: две последовательности, каждая под своей веткой, —
иначе имя разыгрывалось бы независимо и мужчине досталось бы женское имя. На каждой
строке заполнена ровно одна из них, поэтому в выводе они просто идут подряд.

`node example.js`

```
Пол,Имя
Женщина,Злата
Мужчина,Матвей
Мужчина,Павел
Женщина,Лариса
```

Переопределение из кода — эти значения бьют `<env>`:

```ts
const tdc = new TDC({
  configFile: "./patients.tdc",
  seed: "test-seed",
  count: 100,
  locale: "ru",
});
```

Для внешних файловых источников задайте папки данных (и базовую директорию для
`configString`):

```ts
const tdc = new TDC({
  configFile: "./configs/users.tdc",
  dataPaths: ["./data", "./private-data"],
});
```

При `configFile` относительные пути `src` внутри `.tdc` считаются от папки этого
файла; при `configString` базовую директорию `baseDir` задавайте вручную.

## Терминальные методы

| Метод              | Что возвращает                            | Для чего                           |
| :----------------- | :---------------------------------------- | :--------------------------------- |
| `toString()`       | весь вывод одной строкой                 | маленькие / средние результаты     |
| `writeFile(path)`  | пишет вывод в файл (частями)              | файл любой величины                |
| `toIterator()`     | генератор строк (по одной карточке)       | большой текст без общей строки     |
| `toStream()`       | Node.js `Readable`                        | `pipe` в файл / HTTP / архиватор   |
| `toArray()`        | массив объектов-строк                     | маленькие объектные фикстуры          |
| `iterate()`        | генератор объектов-строк                  | объектный вывод без массива        |
| `getAt(index)`     | одну объектную строку по индексу          | точечный доступ                    |
| `preflight(opts?)` | диагностику по памяти или `undefined`     | проверка до большого запуска       |
| `seedInfo()`       | `{ seed, generated }`                     | узнать / залогировать сид          |

`toString`/`writeFile`/`toIterator`/`toStream` — текстовый вывод через диск,
память O(числа полей). Замеры смотрите на странице
**[Большие объёмы](../guides/large-outputs.md#top)**.

## Объектный вывод

В тестах часто удобнее работать с живыми объектами, чем парсить CSV/JSON — можно
проверять `row.Gender` напрямую. Это дают `toArray()`, `iterate()` и `getAt(index)`.
Объектный вывод **игнорирует** `<block>` и текстовые обёртки — берёт только
материализованные `<sequence>`:

- простая sequence становится скалярным свойством;
- составная sequence становится **вложенным** объектом;
- sequence с фильтром по родителю даёт `undefined` в строках, где она не применима.

```ts
const tdc = new TDC({
  configString: `<tdc>
    <env count="4" seed="demo" local="ru">
      <sequence name="Gender"><gen type="text" value="Мужчина,Женщина"/></sequence>
      <sequence name="Person">
        <gen name="Code" type="regex" value="[0-9]{4}"/>
      </sequence>
      <sequence name="MaleName" parent="Gender.Мужчина"><gen type="template" value="person.male.firstName"/></sequence>
      <sequence name="FemaleName" parent="Gender.Женщина"><gen type="template" value="person.female.firstName"/></sequence>
    </env>
    <block><line><data>игнорируется</data></line></block>
  </tdc>`,
});

console.log(tdc.getAt(0)); // женская строка
console.log(tdc.getAt(1)); // мужская строка
```

`node objects.js`

```
{
  Gender: 'Женщина',
  Person: { Code: '5218' },
  MaleName: undefined,
  FemaleName: 'Милана'
}
{
  Gender: 'Мужчина',
  Person: { Code: '7698' },
  MaleName: 'Иван',
  FemaleName: undefined
}
```

`Person` — вложенный объект. `MaleName` и `FemaleName` присутствуют обе, но на каждой
строке заполнена ровно одна: вторая равна `undefined`, потому что её `parent` на этой
строке не совпал. Так в объектном выводе и выглядит фильтр по родителю.

> [!NOTE]
> **Те же значения, по одной строке**
>
> Объектные методы читают из того движка, в который конфиг направил роутер, — из того
> же, что и `toString()`. Значения совпадают, а `getAt(index)` стоит одной строки, а не
> всего прогона до неё: спросить девятимиллионную строку у конфига на десять миллионов —
> работа на одну строку.

## Смотрите также

- **[CLI](../reference/cli.md#top)** — тот же движок из командной строки.
- **[Большие объёмы](../guides/large-outputs.md#top)** — потоковые методы и память.

---

← Назад: [Коды ошибок](../reference/errors.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [По одному значению](./quick-api.md#top) →

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/bindings/typescript)**
