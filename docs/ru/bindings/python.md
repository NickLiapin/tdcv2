<a name="top"></a>

[English](../../bindings/python.md#top) · **Русский** · [Español](../../es/bindings/python.md#top)

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/bindings/python)**

← Назад: [TypeScript](./typescript.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Java](./java.md#top) →

---

# Python

Пакет для Python читает **тот же `.tdc`-конфиг** и при том же сиде выдаёт **тот же
результат**, что и реализации на TypeScript, Java, C# и Rust — эта межъязыковая гарантия
и есть одно из ключевых обещаний TDC.

## Где взять

> [!NOTE]
> **Перед релизом**
>
> Реализация на Python готова и проходит все межъязыковые фикстуры, но **на PyPI её пока
> нет** — `pip install tdcv2` ничего не найдёт. Ставьте из репозитория:
>
> ```bash
> pip install -e python
> ```
>
> Так вы получаете и библиотеку, и команду `tdcv2`. Полная картина — на странице
> [Установка](../getting-started/installation.md#top).

## Как пользоваться

```python
from tdcv2 import TDC

data = TDC(config_file="users.tdc")
print(data.to_string())

for row in data.iterate():
    print(row["Gender"])
```

Имена методов повторяют [TypeScript API](typescript.md#top) — `to_string`,
`write_file`, `iterate`, `to_array`, `get_at`, `preflight` — в питоновском
snake_case.

Разбираться в диагностике удобно через [CLI](../reference/cli.md#top): `tdcv2 check`
печатает те же ошибки с подсветкой места в конфиге.

---

← Назад: [TypeScript](./typescript.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Java](./java.md#top) →

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/bindings/python)**
