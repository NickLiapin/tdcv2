<a name="top"></a>

[English](../../bindings/java.md#top) · **Русский** · [Español](../../es/bindings/java.md#top)

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/bindings/java)**

← Назад: [Python](./python.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [C#](./csharp.md#top) →

---

# Java

Java-пакет читает **тот же `.tdc`-конфиг** и при одном и том же сиде выдаёт **тот же
результат**, что и реализации на TypeScript, Python, C# и Rust — та же межъязыковая
гарантия.

## Где взять

Одна зависимость с Maven Central:

```xml
<dependency>
  <groupId>io.github.nickliapin</groupId>
  <artifactId>tdcv2</artifactId>
  <version>0.2.2</version>
</dependency>
```

Gradle, в `build.gradle.kts`:

```kotlin
implementation("io.github.nickliapin:tdcv2:0.2.2")
```

> [!NOTE]
> **Почему эта версия может отличаться от остальных четырёх**
>
> Maven Central ограничивает, сколько релизов принимает от проекта за месяц, и проект в
> этот предел упирается. Когда так выходит, jar остаётся на месте, а npm, PyPI, NuGet и
> crates.io уходят вперёд — пока лимит не обновится и всё накопившееся не выйдет разом.
>
> Координата выше — всегда **самый свежий jar, который реально лежит на Central**, так
> что она разрешается; просто это не всегда самый свежий TDC. Когда она отстаёт, не
> хватает только изменений движка, сделанных с тех пор: язык конфигурации, диагностика и
> вывод всего более раннего не меняются, так что конфиг, написанный под этот jar,
> продолжает работать.

Стартовые паки едут внутри jar, так что это работает без всякой доустановки.

Полная картина, включая отдельный jar с командной строкой, — на странице
[Установка](../getting-started/installation.md#top). У Maven нет аналога npm-овского
`bin`, поэтому командная строка поставляется своим самодостаточным артефактом.

## Как пользоваться

```java
var data = new TDC("users.tdc");
System.out.println(data.toString());

for (var row : data.iterate()) {
    System.out.println(row.get("Gender"));
}
```

Имена методов повторяют [TypeScript API](typescript.md#top) — таблица приведена в
[одни и те же имена везде](same-names.md#top), и наборы тестов её проверяют, а не просто
утверждают.

## Одно значение без конфига

`Quick` вытягивает одно значение из тех же пакетов данных, которые читает конфиг: ни
файла, ни `<env>`, один вызов.

```java
import io.github.nickliapin.tdc.quick.Quick;

Quick tdc = Quick.tdc();

tdc.get("person.lastName");              // Jones
tdc.get("usa.docs.ssn");                 // 699209702, с настоящими контрольными цифрами
tdc.many("person.lastName", 5);          // сразу пять
Quick.seeded("demo").locale("ru").get("person.lastName");  // закреплено и по-русски
```

Адрес здесь строка, тогда как TypeScript, Python и C# идут по нему через члены объекта.
Запись через члены требует по одному сгенерированному методу на адрес, а сгенерированная
поверхность покрыла бы только пакеты внутри jar — при том что большинство пакетов
приходит во время работы, а `get("ru.person.lastName")` заработает сразу после загрузки.
Вся поверхность — на странице [По одному значению](../core-concepts/quick-api.md#top).

---

← Назад: [Python](./python.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [C#](./csharp.md#top) →

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/bindings/java)**
