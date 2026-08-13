<a name="top"></a>

[English](../../guides/coherent-data.md#top) · **Русский** · [Español](../../es/guides/coherent-data.md#top)

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/guides/coherent-data)**

← Назад: [Иерархические зависимости](./hierarchical-dependencies.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Без повторов в строке (distinct)](./distinct.md#top) →

---

# Связные и реляционные данные

Обычные fake-генераторы заполняют поля независимо, и получаются невозможные пары:
марка `Fiat` с моделью `Altima` (это модель Nissan), город из одного региона с
индексом из другого. TDC умеет иначе.

Приём простой: **адрес шаблона может подставлять значение другого поля**.
Родитель называет файл, из которого берётся потомок:

```text
value="common.vehicle.model.${{Brand}}"
```

Выпал бренд `Fiat` → адрес превращается в `common.vehicle.model.Fiat`, и модель берётся
**именно из файла Fiat**. Никаких «Fiat Altima».

> [!NOTE]
> **Вывод иллюстративен**
>
> Значения ниже получены с фиксированным `seed`, поэтому воспроизводимы, но точные
> строки и пропорции могут отличаться между версиями ядра. Считайте их примерами
> _формы_, а не гарантией.

## Как это выглядит

Две [последовательности](../core-concepts/sequences.md#top): бренд и модель. Модель
объявляет [`parent="Brand"`](../core-concepts/sequences.md#top) (чтобы видеть выпавший
бренд) и подставляет его в адрес [`template`](../generators/template.md#top) через
`${{Brand}}`:

```xml
<tdc>
  <env count="5" seed="showroom" local="en">
    <sequence name="Brand"><gen type="template" value="common.vehicle.brand"/></sequence>
    <sequence name="Model" parent="Brand"><gen type="template" value="common.vehicle.model.${{Brand}}"/></sequence>
  </env>
  <block><line><data>${{Brand}} ${{Model}}</data></line></block>
</tdc>
```

`./run showroom.tdc`

```
Honda CR-V
Toyota Corolla
Ford Maverick
Chevrolet Bolt EV
Nissan Kicks
```

Каждая модель принадлежит своему бренду. Причём `common.vehicle.brand` — **взвешенный**
пакет (Toyota частая, Maybach редкий), так что и марки выпадают в реальных
пропорциях — вы получаете и связные пары, _и_ правдоподобный срез рынка в одном
конфиге.

## Один потомок на родителя — кухня и её блюдо

Та же форма работает для любой пары «родитель/потомок». Кухня тянет своё блюдо
(`food.cuisine` → `food.dishByCuisine.<кухня>`). **Используйте это, когда** два
поля выглядели бы абсурдно, выпав независимо — «корейский фалафель» никого не
убедит:

```xml
<sequence name="Cuisine"><gen type="template" value="food.cuisine"/></sequence>
<sequence name="Dish" parent="Cuisine"><gen type="template" value="food.dishByCuisine.${{Cuisine}}"/></sequence>
```

`./run menu.tdc`

```
Lebanese: Falafel
Korean: Bulgogi
Indian: Rogan Josh
Chinese: Peking Duck
Greek: Souvlaki
```

## Один родитель, несколько связанных потомков

Один родитель может кормить **сразу несколько** потомков. Каждый потомок
подставляет одно и то же значение родителя в свой адрес, так что все поля строки
остаются согласованными между собой. Здесь страна (взвешенная по населению) тянет
и столицу, и валюту:

```xml
<sequence name="Country"><gen type="template" value="geo.country"/></sequence>
<sequence name="Capital" parent="Country"><gen type="template" value="geo.capitalByCountry.${{Country}}"/></sequence>
<sequence name="Currency" parent="Country"><gen type="template" value="geo.currencyByCountry.${{Country}}"/></sequence>
```

`./run atlas.tdc`

```
China — Beijing — Renminbi
United States — Washington — US Dollar
India — New Delhi — Indian Rupee
Indonesia — Jakarta — Rupiah
China — Beijing — Renminbi
```

**Используйте это, когда** несколько полей зависят от одного ключа: части адреса,
привязанные к региону; детали товара, привязанные к категории; данные
подразделения, привязанные к отделу. Объявите каждого потомка с одним и тем же
`parent`, и все они прочитают одно выбранное значение.

## Как устроены данные

Родитель — обычный список; у каждого его значения есть **свой файл-потомок**,
названный ровно этим значением:

```text
data/packs/common/vehicle/
  brand.txt                 # список брендов (родитель)
  model/
    Toyota.txt              # модели Toyota
    Fiat.txt                # модели Fiat
    Mercedes-Benz.txt       # имена с дефисом и пробелом тоже работают
```

Адрес файла — путь через точку: `model/Fiat.txt` → `common.vehicle.model.Fiat`. В
шаблоне `${{Brand}}` подставляет имя файла, и TDC находит нужный список. Чтобы
добавить бренд, положите `model/НовыйБренд.txt` и допишите строку в `brand.txt`.
Готовые связные наборы поставляются для марок авто, `food.cuisine`,
`medical.specialtyCoherent`, `work.industryCoherent`,
`common.dev.languageCoherent`, `sport.sportCoherent` и `geo.country`.

## Что важно помнить

- **Родитель объявляется раньше потомка** — TDC материализует
  [последовательности](../core-concepts/sequences.md#top) сверху вниз, поэтому
  `${{Brand}}` берёт уже посчитанное значение. Потомок, подставляющий поле,
  объявленное _ниже_ себя, не найдёт что читать.
- **`parent="Brand"`** связывает потомка с родителем и задаёт порядок. Для простой
  подстановки этого достаточно; более строгий отбор по _конкретному_ значению
  (`parent="Brand.Fiat"`) описан в
  [Иерархических зависимостях](hierarchical-dependencies.md#top).
- **У каждого значения родителя должен быть свой файл-потомок**, иначе адрес не
  найдётся и будет ошибка. Поэтому список-родитель обычно содержит ровно те
  значения, для которых файлы есть (как `common.vehicle.brand`).
- **Движок.** Такой конфиг всегда считает in-memory движок (единственный, кто
  умеет разрешать адрес по строке), поэтому память растёт вместе с `count`. Это про
  реалистичную связность, а не про потоковую генерацию гигабайтов; [Какой движок считает
  ваш конфиг](large-outputs.md#какой-движок-запустит-ваш-конфиг) перечисляет и эту форму,
  и остальные пять, которые уходят тем же путём.

## CSV-родственник — `row` + `weight`

Когда связанные поля лежат в одном **CSV**, а не в отдельных файлах на каждое
значение, свяжите их через [`row`](../generators/file.md#top): несколько генераторов
[`file`](../generators/file.md#top) с одинаковым `row` читают **одну и ту же строку**
на запись, так что поля остаются в пределах одной строки настоящих данных.
Добавьте `weight` к одному из них, чтобы тянуть строку по её реальной частоте:

```xml
<sequence name="Place">
  <gen name="City"   type="file" src="cities.csv" column="city"   row="loc" weight="population"/>
  <gen name="Region" type="file" src="cities.csv" column="region" row="loc"/>
</sequence>
```

`./run cities.tdc`

```
Москва, Московская обл.
Казань, Татарстан
Новосибирск, Новосибирская обл.
Москва, Московская обл.
Екатеринбург, Свердловская обл.
```

Поскольку оба генератора делят `row="loc"`, город и его регион никогда не
расходятся по разным записям; `weight="population"` у города делает так, что
крупные пункты выпадают чаще. Подробности — в
[Генераторе file](../generators/file.md#top).

## Числовой родственник — колонка, вычисленная из другой

Оба механизма выше держат вместе **вытянутые** значения: один файл решает, из какого
файла берётся другой, или одна строка CSV кормит несколько полей. Число часто держится
иначе — оно не вытягивается вовсе, а **вычисляется** из соседней колонки. Вес следует за
ростом; площадь — за ценой; итог — за количеством и ставкой.

Это [`formula`](../generators/formula.md#top):

```xml
<sequence name="Height"><gen type="number" distribution="normal" mean="170" sd="10" decimals="1"/></sequence>
<sequence name="Noise"> <gen type="number" distribution="normal" mean="0" sd="1" decimals="4"/></sequence>
<sequence name="Weight"><gen type="formula" expr="0.75 * Height - 58 + 6 * Noise" decimals="1"/></sequence>
```

`./run clinic.tdc`

```
171.2, 77.5
177.6, 83.4
164.6, 76.9
164.4, 68.4
175.8, 74.8
```

`Noise` — это то, что не даёт паре превратиться в прямую линию, и его вообще не обязательно
печатать: последовательность, не попавшая в `<block>`, всё равно участвует в вычислении. Две
колонки, которые движутся вместе, — это то, на чём модель действительно может учиться;
два независимых розыгрыша из тех же диапазонов — нет.

Третий вход — **параметр распределения**: `lambda="Traffic * 0.1"` задаёт форму самого
розыгрыша по другой колонке, а не вычисляет значение постфактум. См.
[Параметр может следовать за другой колонкой](statistical-distributions.md#параметр-может-следовать-за-другой-колонкой).

## Смотрите также

- **[Иерархические зависимости](hierarchical-dependencies.md#top)** — фильтрация потомка по конкретному значению родителя.
- **[Последовательности](../core-concepts/sequences.md#top)** — объявление полей и связь `parent`.
- Генераторы **[Template](../generators/template.md#top)** и **[File](../generators/file.md#top)**.

---

← Назад: [Иерархические зависимости](./hierarchical-dependencies.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Без повторов в строке (distinct)](./distinct.md#top) →

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/guides/coherent-data)**
