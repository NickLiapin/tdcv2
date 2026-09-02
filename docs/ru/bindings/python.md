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

> [!TIP]
> **На PyPI — версия 0.3.0**
>
>
> ```bash
> pip install tdcv2
> ```
>
> Ставит и библиотеку, и команду `tdcv2`, а стартовый набор паков лежит внутри колеса.
> Полная картина — на странице
> [Установка](../getting-started/installation.md#top).

## Как пользоваться

```python
from tdcv2 import TDC

data = TDC(config_file="users.tdc")
print(data)

for row in data:
    print(row["Gender"])

data.write_file("users.csv")
```

Весь вывод — это `str(data)`, строки — то, по чему идёт цикл, одна строка — `data[3]`,
а сколько их всего — `len(data)`: объект ведёт себя как обычный питоновский.

Рядом с этим пакет отзывается на имена, общие для всех реализаций — `to_string`,
`to_array`, `iterate`, `get_at`, `to_columns`, `write_file`, `seed_info`, `preflight`, —
так что пример, написанный на другом языке, читается здесь без перевода. См.
[одни и те же имена везде](same-names.md#top). Собственные питоновские `to_list`, `rows`,
`uses_http`, `diagnostics`, `count` и `engine` не затронуты и не устарели.

Разбираться в диагностике удобно через [CLI](../reference/cli.md#top): `tdcv2 check`
печатает те же ошибки с подсветкой места в конфиге.

## Одно значение без конфига

Пакет экспортирует ещё и `tdc` — он вытягивает одно значение из тех же пакетов данных,
которые читает конфиг: ни файла, ни `<env>`, один вызов.

```python
from tdcv2 import tdc

tdc.person.lastName()                             # Jones
tdc.country.usa.docs.ssn()                        # 699209702, с настоящими контрольными цифрами
tdc.person.lastName.many(5)                       # сразу пять
tdc.seed("demo").locale("ru").person.lastName()   # закреплено и по-русски
```

Сегменты здесь остаются в camelCase, в отличие от имён методов выше. Это адреса, которые
уже несут пакеты, а не идентификаторы, выбранные этим пакетом: `person.lastName` обязан
читаться одинаково в конфиге, в справочнике и в четырёх других реализациях. Вся
поверхность — на странице [По одному значению](../core-concepts/quick-api.md#top).

---

← Назад: [TypeScript](./typescript.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Java](./java.md#top) →

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/bindings/python)**
