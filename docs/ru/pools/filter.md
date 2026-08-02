<a name="top"></a>

[English](../../pools/filter.md#top) · **Русский** · [Español](../../es/pools/filter.md#top)

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/pools/filter)**

← Назад: [Обзор](./overview.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Связывание пулов](./linking.md#top) →

---

# Отбор через `filter`

Без `filter` строка выбирает из всего пула. С ним — только из тех членов, которых
пропускает выражение.

Очевидный случай: пациент северной клиники должен попасть к врачу, который там работает.

```xml
<tdc>
  <env count="10" seed="clinic" local="en">
    <pool name="Doctors" count="6">
      <sequence name="clinic"><gen type="text" value="North,South"/></sequence>
      <sequence name="name"><gen type="template" value="person.lastName"/></sequence>
    </pool>

    <sequence name="Clinic"><gen type="text" value="North,South" percent="50,50"/></sequence>
    <sequence name="Patient"><gen type="template" value="person.female.firstName"/></sequence>
    <sequence name="Seen"><gen type="pool" value="Doctors" filter="clinic == Clinic"/></sequence>
  </env>
  <block>
    <line><data>${{Clinic}} | ${{Patient}} -> Dr. ${{Seen.name}} (${{Seen.clinic}})</data></line>
  </block>
</tdc>
```

`./run clinic.tdc`

```
South | Barbara -> Dr. Brown (South)
North | Mary -> Dr. Williams (North)
South | Dorothy -> Dr. Brown (South)
South | Jennifer -> Dr. Brown (South)
North | Elizabeth -> Dr. Williams (North)
North | Patricia -> Dr. Williams (North)
North | Susan -> Dr. Jones (North)
South | Sarah -> Dr. Brown (South)
South | Margaret -> Dr. Brown (South)
North | Linda -> Dr. Jones (North)
```

Клиника пациента и клиника врача совпадают в каждой строке.

## Выбор остаётся равномерным

`filter` решает, **какие члены предложены**, а не какой из них взят. Среди прошедших
выбор равномерный — северный пациент может попасть к любому из северных врачей.

Это стоит сказать вслух, потому что очевидная альтернатива — «взять первого
подходящего» — отдала бы всем северным пациентам одного и того же врача и тихо разрушила
разброс, ради которого пул и строился.

## Что означает имя внутри `filter`

Выражение вычисляется **сразу в двух областях видимости**: поля кандидата и столбцы
текущей строки.

| Имя              | Что читается                       |
| :--------------- | :---------------------------------- |
| `clinic`         | **поле** кандидата, если у пула есть поле с таким именем |
| `Clinic`         | **столбец** текущей строки          |
| `Doctors.clinic` | всегда поле кандидата — уточнённая запись |
| `North`          | голое слово, читается как строковый литерал |

Порядок важен: голое имя сначала ищется среди полей члена и только потом среди столбцов
строки. Имя, которое есть и там и там, не угадывается, а отклоняется:

`./run clinic.tdc`

```
error[TDC232]: "clinic" in filter= is both a field of pool "Doctors" and a sequence — which one is meant is not decidable
 --> clinic.tdc:8:27
  |
8 |     <sequence name="Seen"><gen type="pool" value="Doctors" filter="clinic == clinic"/></sequence>
  |                           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  |
note: Rename one of them. Qualifying one side ("Doctors.clinic") does not help: the other "clinic" still reads as the member's field, so the test would compare a value with itself.
```

Уточнённое имя, которого у пула нет, тоже ловится:

`./run clinic.tdc`

```
error[TDC226]: filter= reads "Doctors.branch", but pool "Doctors" has no field "branch"
 --> clinic.tdc:7:27
  |
7 |     <sequence name="Seen"><gen type="pool" value="Doctors" filter="Doctors.branch == Site"/></sequence>
  |                           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  |
note: Fields of "Doctors": clinic.
```

**Неуточнённое** незнакомое имя намеренно не трогают: язык выражений читает голое слово
как строковый литерал, и именно так `filter="clinic == North"` говорит «только северные
врачи», ничего не объявляя.

## Это полноценное выражение

`поле == Столбец` — частая форма, но в `filter` можно писать всё, что понимает
[язык выражений](../constructs/conditional-output.md#операторы-сравнения): `!=`, `<`,
`>`, `<=`, `>=`, `&&`, `||`, `!` и арифметику.

Отсюда случаи поинтереснее клиники — покупатель берёт то, что ему по карману:

```xml
<tdc>
  <env count="8" seed="shop" local="en">
    <pool name="Catalog" count="6">
      <sequence name="item" uniq="true"><gen type="text" value="Kettle,Lamp,Chair,Desk,Rug,Clock"/></sequence>
      <sequence name="price"><gen type="number" value="10..300"/></sequence>
    </pool>

    <sequence name="Budget"><gen type="number" value="50..250"/></sequence>
    <sequence name="Buys"><gen type="pool" value="Catalog" filter="price <= Budget"/></sequence>
  </env>
  <block>
    <line><data>budget ${{Budget}} -> ${{Buys.item}} at ${{Buys.price}}</data></line>
  </block>
</tdc>
```

`./run shop.tdc`

```
budget 232 -> Chair at 227
budget 124 -> Lamp at 85
budget 61 -> Rug at 30
budget 148 -> Rug at 30
budget 208 -> Rug at 30
budget 54 -> Rug at 30
budget 102 -> Lamp at 85
budget 60 -> Rug at 30
```

Никто не покупает дороже своего бюджета, и перечислять руками ничего не пришлось.

> [!WARNING]
> **Пишите `<=` и `&&` как есть**
>
> TDC не разворачивает XML-сущности. `filter="price &lt;= Budget"` дойдёт до разборщика
> именно этими девятью символами и не сработает. Пишите тот оператор, который имеете в виду.

### Чего это стоит

Есть два пути, и какой из них сработает — решает то, как написан фильтр:

| Фильтр | Как отвечается строка |
| :----- | :--------------------- |
| `поле == Столбец` (в любом порядке) | пул **один раз** раскладывается по корзинам; строка стоит один поиск |
| всё остальное | кандидаты перебираются на каждой строке — линейно по размеру пула |

Оба варианта правильные. Разница в том и объясняет, зачем у пула вообще есть
[потолок размера](overview.md#размер): перебор миллиона членов две тысячи раз — это
реальная цена, и потолок ровно там, где инструмент об этом говорит.

## `filter` — это не `if`

Оба сужают, оба могут стоять на одном `<gen>`. Различаются они **результатом**:

| | О чём спрашивает | Что происходит при «нет» |
| :-- | :-- | :-- |
| `if`     | о **строке** — один ответ на строку | ничего не генерируется, ячейка пустая |
| `filter` | о каждом **кандидате** — один ответ на члена | подставляется подходящая запись, пустой ячейки не бывает |

То есть `if="Age >= 18"` оставит несовершеннолетних без врача, а
`filter="clinic == Clinic"` даст врача всем, но из нужной клиники. Вместе они читаются
как «только взрослые и только из своей клиники»:

```xml
<gen type="pool" value="Doctors" if="Age >= 18" filter="clinic == Clinic"/>
```

Они и спрашивают о разном — поэтому одним атрибутом обе работы делать нельзя. `if`
спрашивает один раз на строку. `filter` — один раз на каждого кандидата, то есть тридцать
вопросов на строку для пула из тридцати.

## Когда никто не подошёл

Раз `filter` не оставляет пустых ячеек, «никто не подошёл» — это ошибка, а не пропуск.
Сообщение называет строку и то значение, которое сузило выбор до нуля:

`./run clinic.tdc`

```
tdcv2: pool "Doctors": no member satisfies filter="clinic == Clinic" for row 3 (Clinic="South"). A filter narrows the members a row may draw from; when it narrows them to none there is nothing to substitute. Add a member that matches, or widen the filter.
```

Это отказ **во время прогона**, а не ошибка проверки, и иначе быть не может: валидатор не
знает, что ни один член не выйдет `South`, пока пул не разыгран. Два способа починить
названы в сообщении — добавить подходящего члена или расширить фильтр, — а есть и третий:
задать полю пула тот же конечный список, из которого разыгрывается столбец строки, чтобы
каждое значение было представлено.

## Рядом

- [Обзор](overview.md#top) — что такое пул и тот потолок размера, о котором здесь речь
- [Связывание пулов](linking.md#top) — `filter`, читающий поле *другой* ссылки на пул: так
  строится цепочка
- [Условия](../constructs/conditional-output.md#top) — `if` целиком, включая операторы,
  общие у него с `filter`

---

← Назад: [Обзор](./overview.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Связывание пулов](./linking.md#top) →

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/pools/filter)**
