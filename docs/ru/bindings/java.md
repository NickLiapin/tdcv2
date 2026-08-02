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

> [!NOTE]
> **Перед релизом**
>
> Реализация на Java готова и проходит все межъязыковые фикстуры, но **в Maven Central её
> пока нет**. Собирайте из репозитория:
>
> ```bash
> cd java && ./gradlew build
> ```
>
> После первого релиза та же библиотека станет одной зависимостью — полная картина, включая
> отдельный jar с командной строкой, на странице
> [Установка](../getting-started/installation.md#top).

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
