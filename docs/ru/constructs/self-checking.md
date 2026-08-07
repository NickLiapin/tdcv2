<a name="top"></a>

[English](../../constructs/self-checking.md#top) · **Русский** · [Español](../../es/constructs/self-checking.md#top)

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/constructs/self-checking)**

← Назад: [Уникальность (uniq, distinct)](./unique-values.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Обзор](../compute/overview.md#top) →

---

# `<assert>` — конфиг проверяет свой собственный вывод

**Когда нужно:** форма данных важна тому, кто их получит, и вы хотите, чтобы запуск
остановился, а не отдал файл, который незаметно «поехал».

Утверждение описывает свойство, которым готовый запуск обязан обладать. Держится —
ничего не происходит. Не держится — запуск останавливается вашей же фразой, до того как
записана хоть одна строка.

```xml
<assert that="Tracked == 700" says="у каждого отправленного заказа должен быть трек-номер"/>
```

Живёт в `<env>`, рядом с [`<uniq>` и `<distinct>`](unique-values.md#top): как и они, это
высказывание про весь запуск целиком, а не про одну колонку.

## Что стоит утверждать

Не то, что конфиг и так написал. Вы написали `percent="70"` и утверждаете 70 процентов —
вы проверили, что TDC умеет считать.

Ценность в том, чего конфиг **не** говорит. Здесь фильтр и условие накладываются друг на
друга, и доля, доехавшая до файла, нигде в тексте не написана:

```xml
<tdc>
  <env count="1000" seed="orders" local="en">
    <sequence name="Status"><gen type="text" value="shipped,pending" percent="70,30"/></sequence>
    <sequence name="Tracking" parent="Status.shipped">
      <gen type="regex" value="[A-Z]{2}[0-9]{9}" if="Status == 'shipped' && _count % 4 != 0"/>
    </sequence>
    <sequence name="Tracked"><gen type="stat" of="Tracking" op="count"/></sequence>

    <assert that="Tracked == 700" says="every shipped order should carry a tracking number"/>
  </env>
  <block>
    <line><data>${{Status}},${{Tracking}}</data></line>
  </block>
</tdc>
```

`./run orders.tdc`

```
tdcv2: assert failed: every shipped order should carry a tracking number
  Tracked == 700   with Tracked = 522
```

Больше ничто в TDC про этот конфиг мнения не имеет. Он разбирается, проходит проверку,
запускается — и 178 отправленных заказов выходят с пустым трек-номером. Ровно ради такого
сбоя утверждение и существует.

Код возврата — 1, поэтому CI на нём останавливается.

## Кратко

| Атрибут | Обязателен | Что делает                                                          |
| :------ | :--------- | :------------------------------------------------------------------ |
| `that`  | да         | Условие, на том же языке, что и [`if=`](../reference/expressions.md#top) |
| `says`  | да         | Фраза, которую получит читатель, когда условие не сойдётся            |

Оба обязательны. Утверждение, которое срабатывает, показывая одно лишь выражение,
заставляет читателя месяцы спустя разбираться в CI-логе, ради чего оно было написано.

**Флага нет.** Утверждение работает потому, что оно написано: проверка, которую нужно
не забыть включить, — это проверка, которую никто не запускал, на конфиге, который
выглядит проверенным.

## Откуда берутся числа

`that=` читает колонки, и читать обычно стоит
[`<gen type="stat">`](../generators/stat.md#top) — одно число на весь запуск.

```xml
<env count="500" seed="clinic" local="en">
    <sequence name="Visit"><gen type="date" from="2026-01-01" to="2026-06-30" format="YYYY-MM-DD"/></sequence>
    <sequence name="Follow"><gen type="date" of="Visit" plus="7..30d" format="YYYY-MM-DD"/></sequence>
    <sequence name="Ward"><gen type="text" value="A,B,C" percent="50,30,20"/></sequence>

    <sequence name="Rows"><gen type="stat" of="Visit" op="count"/></sequence>
    <sequence name="Wards"><gen type="stat" of="Ward" op="count"/></sequence>

    <assert that="Rows == _total" says="у каждой строки есть дата визита"/>
    <assert that="Wards == _total" says="у каждой строки есть отделение"/>
</env>
```

`_total` — число строк, и это единственная встроенная величина, которую утверждению
разрешено читать.

## Правило, которое не даёт себя обмануть

**Каждое имя в `that=` должно быть одинаковым на всех строках.** Колонка `stat` такова по
построению. Колонка `text` с одним значением — по факту. Вытянутая колонка — нет, и её
отвергают:

```xml
<sequence name="Amount"><gen type="number" value="1..500"/></sequence>
<assert that="Amount > 0" says="every amount is positive"/>
```

`./run amounts.tdc`

```
tdcv2: assert ("Amount > 0"): "Amount" is not the same on every row, so this would have checked the first row and called the run verified. An assertion reads whole-run values: give it a <gen type="stat" of="Amount" op="…"/> column, or _total.
```

Без этого правила `that="Amount > 0"` прочитало бы нулевую строку и отчиталось об одной
строке из пятисот — проверка прошла потому, что почти не смотрела, но носит значок
«проверено». Это ровно та болезнь, ради которой вся эта возможность и сделана.

Колонку, которую фильтр `parent=` оставляет **пустой** на части строк, отвергают по той же
причине: у запуска нет для неё одного значения, и условие сравнивало бы с тем, что
случайно оказалось в нулевой строке. Сверните её через `op="count"`.

## Чего пока нет

- **Построчных утверждений** («каждая сумма положительна»). Это другая возможность: нужен
  проход по строкам и отчёт, называющий сбойные строки, а не одно число.
- **Проверки контрольной цифры.** Вот это ловушка: её посчитал
  [`<compute>`](../compute/overview.md#top), и пересчёт утверждает лишь то, что один и тот же
  код согласен сам с собой.

## Движки

Утверждение читает колонки `stat`, а `stat` и так отправляет конфиг на движок в памяти.
Значит, своих последствий для движков утверждения не добавляют — см.
[большие выгрузки](../guides/large-outputs.md#top).

## См. также

- [`stat`](../generators/stat.md#top) — откуда берутся числа
- [Выражения](../reference/expressions.md#top) — язык, на котором пишется `that=`
- [Уникальность](unique-values.md#top) — другие высказывания про весь запуск

---

← Назад: [Уникальность (uniq, distinct)](./unique-values.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Обзор](../compute/overview.md#top) →

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/constructs/self-checking)**
