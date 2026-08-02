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
  <version>0.1.3</version>
</dependency>
```

Gradle, в `build.gradle.kts`:

```kotlin
implementation("io.github.nickliapin:tdcv2:0.1.3")
```

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

Имена методов повторяют [TypeScript API](typescript.md#top).

---

← Назад: [Python](./python.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [C#](./csharp.md#top) →

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/bindings/java)**
