<a name="top"></a>

[English](../../pools/linking.md#top) · **Русский** · [Español](../../es/pools/linking.md#top)

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/pools/linking)**

← Назад: [Отбор через filter](./filter.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Обзор](../constructs/overview.md#top) →

---

# Связывание пулов

Один пул даёт строке согласованную запись. Несколько пулов дают строке согласованный
**мир**: клиники, которые существуют, врачи, работающие в одной из них, медсёстры,
работающие рядом с этими врачами. Эта страница о том, как части соединяются.

Способов связать ровно два, и отвечают они на разные вопросы:

| Связь | Где закрепляется | Как пишется |
| :---- | :--------------- | :---------- |
| **Пул разыгрывает из пула** | на члене — этот врач работает в той клинике, всегда | `<gen type="pool">` внутри `<pool>` |
| **Две ссылки в строке согласованы** | на строке — медсестра этого пациента из клиники его врача | `filter=`, называющий поле другой ссылки |

Первое строит мир. Второе держит вместе одну строку.

## Пул, разыгрывающий из пула

Член одного пула может держать целого члена другого. Врачи принадлежат клиникам:

```xml
<tdc>
  <env count="8" seed="probe" local="en">
    <pool name="Clinics" count="3">
      <sequence name="city" uniq="true"><gen type="text" value="North,South,East"/></sequence>
      <sequence name="phone"><gen type="number" value="100..999"/></sequence>
    </pool>

    <pool name="Doctors" count="5">
      <sequence name="name"><gen type="template" value="person.lastName"/></sequence>
      <sequence name="at"><gen type="pool" value="Clinics"/></sequence>
    </pool>

    <sequence name="Seen"><gen type="pool" value="Doctors"/></sequence>
  </env>
  <block>
    <line><data>Dr. ${{Seen.name}} @ ${{Seen.at.city}} (tel ${{Seen.at.phone}})</data></line>
  </block>
</tdc>
```

`./run clinics.tdc`

```
Dr. Brown @ North (tel 695)
Dr. Brown @ North (tel 695)
Dr. Jones @ East (tel 300)
Dr. Smith @ South (tel 428)
Dr. Smith @ South (tel 428)
Dr. Jones @ East (tel 300)
Dr. Johnson @ East (tel 300)
Dr. Jones @ East (tel 300)
```

> [!NOTE]
> **Вывод показан для примера**
>
> Значения получены с фиксированным `seed`, то есть воспроизводимы, но конкретные строки
> могут отличаться между версиями ядра. Смотрите на них как на пример *формы*, а не как на
> гарантию.

Из этого вывода читаются три факта:

- **Точка уходит на уровень глубже.** `at` называет целую клинику, поэтому своего
  значения у неё нет; её поля — это `${{Seen.at.city}}` и `${{Seen.at.phone}}`. Написать
  `${{Seen.at}}` нельзя по той же причине, по которой нельзя `${{Seen}}`.
- **Связь закреплена на члене, а не на строке.** Доктор Джонс в восточной клинике в
  каждой строке, где он появляется, потому что клиника решилась тогда, когда строился
  *врач*.
- **Поля самой клиники ездят вместе.** East — это всегда 300: телефон принадлежит записи
  клиники, а не строке.

### Правило порядка

Пул может разыгрывать только из пула, **объявленного выше**. Пулы строятся в том порядке,
в каком написаны, поэтому у пула, названного ниже, таблицы ещё нет:

`./run clinics.tdc`

```
error[TDC236]: pool "Doctors" draws from "Clinics", which is not declared above it
 --> clinics.tdc:5:7
  |
5 |       <sequence name="at"><gen type="pool" value="Clinics"/></sequence>
  |       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  |
note: Pools are built in declaration order, so a pool can only read the pools above it. Move "Clinics" above "Doctors". That order is also why a cycle between pools cannot be written down.
```

Это правило заодно делает вторую работу: **цикл между пулами невозможно записать.**
Никакой проверки на циклы в TDC нет, потому что нечего проверять — `Doctors`,
дотягивающийся до `Clinics`, это поиск в таблице, а `Clinics`, дотягивающийся до
`Doctors`, это имя, которого ещё не существует. Пул, назвавший сам себя, получает тот же
код по той же причине.

### Насколько глубоко это идёт

Насколько напишете. Каждый уровень — обычный пул, который просто держит ссылку, поэтому
`${{Seen.at.region.name}}` не особый случай: это три таблицы и две связи.

Цена остаётся там, где хочется: каждый пул строится один раз до прогона, поэтому цепочка
в три уровня — это три небольшие таблицы и никакой работы на строку сверх самих выборов.

## Две согласованные ссылки

Второй вид связи — между двумя ссылками **в одной строке**. `filter` читает столбцы
текущей строки, а поля ссылки — такие же столбцы, как все остальные, поэтому медсестру
можно отобрать по клинике, в которой работает врач этой строки:

```xml
<tdc>
  <env count="8" seed="clinic" local="en">
    <pool name="Clinics" count="3">
      <sequence name="city" uniq="true"><gen type="text" value="North,South,East"/></sequence>
    </pool>
    <pool name="Doctors" count="6">
      <sequence name="name"><gen type="template" value="person.lastName"/></sequence>
      <sequence name="at"><gen type="pool" value="Clinics"/></sequence>
    </pool>
    <pool name="Nurses" count="9">
      <sequence name="name"><gen type="template" value="person.female.firstName"/></sequence>
      <sequence name="city"><gen type="text" value="North,South,East"/></sequence>
    </pool>

    <sequence name="Seen"><gen type="pool" value="Doctors"/></sequence>
    <sequence name="Assisted"><gen type="pool" value="Nurses" filter="city == Seen.at.city"/></sequence>
  </env>
  <block>
    <line><data>Dr. ${{Seen.name}} (${{Seen.at.city}}) + nurse ${{Assisted.name}} (${{Assisted.city}})</data></line>
  </block>
</tdc>
```

`./run team.tdc`

```
Dr. Williams (South) + nurse Susan (South)
Dr. Jones (East) + nurse Mary (East)
Dr. Johnson (South) + nurse Patricia (South)
Dr. Garcia (North) + nurse Dorothy (North)
Dr. Jones (East) + nurse Mary (East)
Dr. Jones (East) + nurse Mary (East)
Dr. Brown (East) + nurse Mary (East)
Dr. Williams (South) + nurse Linda (South)
```

Фильтр в одном выражении дотягивается через две связи: `Seen.at.city` — это город клиники
врача этой строки. Ничего специального для этого не сделано: к моменту, когда строится
`Assisted`, `Seen.at.city` уже столбец строки, потому что ссылки разрешаются в **порядке
объявления**, ровно как последовательности.

А значит, здесь действует то же правило, что и везде в `<env>`: **ссылка, по которой вы
фильтруете, должна быть объявлена выше той, которая фильтрует.** Поменяйте `Seen` и
`Assisted` местами — и фильтр прочитает имя, которого ещё никто не произвёл.

## Разобранный пример

Три уровня, четыре вида связи, один конфиг. Клиники существуют; врачи принадлежат клинике
и имеют специальность в заданной доле; пациенту нужна специальность, и его принимает
врач, у которого она есть.

```xml
<tdc>
  <env count="10" seed="clinic" local="en">
    <pool name="Clinics" count="3">
      <sequence name="city" uniq="true"><gen type="text" value="North,South,East"/></sequence>
      <sequence name="phone"><gen type="number" value="200..299"/></sequence>
    </pool>

    <pool name="Doctors" count="8">
      <sequence name="name"><gen type="template" value="person.lastName"/></sequence>
      <mix name="role" percent="25,75">
        <case><gen type="text" value="surgeon"/></case>
        <case><gen type="text" value="therapist"/></case>
      </mix>
      <sequence name="at"><gen type="pool" value="Clinics"/></sequence>
    </pool>

    <sequence name="Patient"><gen type="template" value="person.female.firstName"/></sequence>
    <sequence name="Needs"><gen type="text" value="surgeon,therapist" percent="30,70"/></sequence>
    <sequence name="Seen"><gen type="pool" value="Doctors" filter="role == Needs"/></sequence>
  </env>
  <block>
    <line><data>${{Patient}} needs a ${{Needs}} -> Dr. ${{Seen.name}}, ${{Seen.at.city}} clinic, tel ${{Seen.at.phone}}</data></line>
  </block>
</tdc>
```

`./run clinic.tdc`

```
Barbara needs a therapist -> Dr. Johnson, South clinic, tel 284
Mary needs a therapist -> Dr. Jones, North clinic, tel 278
Dorothy needs a therapist -> Dr. Davis, South clinic, tel 284
Jennifer needs a therapist -> Dr. Smith, East clinic, tel 239
Elizabeth needs a surgeon -> Dr. Williams, South clinic, tel 284
Patricia needs a surgeon -> Dr. Williams, South clinic, tel 284
Susan needs a therapist -> Dr. Garcia, North clinic, tel 278
Sarah needs a surgeon -> Dr. Williams, South clinic, tel 284
Margaret needs a therapist -> Dr. Davis, South clinic, tel 284
Linda needs a therapist -> Dr. Smith, East clinic, tel 239
```

Каждое условие этого конфига выполняется в каждой строке, и ни одно не написано дважды:

- Двое из восьми врачей — хирурги, потому что `percent="25,75"` применяется к **членам**.
- Тридцати процентам пациентов нужен хирург, потому что `percent="30,70"` применяется к
  **строкам**. Это разные совокупности, и обе точные.
- Пациент, которому нужен хирург, к хирургу и попадает, потому что `filter="role == Needs"`
  сужает кандидатов.
- Телефон всегда принадлежит названному городу, потому что клиника — это запись, которую
  держит врач.

Добавьте четвёртый уровень — регион, которому принадлежит клиника, — и форма конфига не
изменится. В этом и смысл конструкции.

## Чего нет

- **`<pool>` внутри `<pool>`.** Отклоняется (`TDC230`). Пул остаётся плоской таблицей,
  которую можно распечатать; вложенность сделала бы его деревом, и каждый следующий
  вопрос — уникальность, отбор, потолок памяти — пришлось бы задавать с уточнением «на
  какой глубине?». Вместо этого один пул ссылается на другой — о чём эта страница.
- **Пул, разыгрывающий из пула ниже себя или из самого себя.** Отклоняется (`TDC236`),
  как выше.
- **Веса у членов.** Собственного веса у члена пула нет. Используйте
  [`<mix>`](../constructs/mix.md#top) внутри пула — это то же самое, сказанное языком, на
  котором пул уже говорит, и оно точное, а не приблизительное.
- **Ссылка с `parent=` на потоковом движке.** Это не отказ: такой конфиг направляется на
  движок в памяти, которому нужен весь столбец родителя, чтобы знать, какие строки вообще
  существуют.

## Рядом

- [Обзор](overview.md#top) — что такое пул и потолок размера
- [Отбор через `filter`](filter.md#top) — язык выражений, на котором записывается связь
- [Иерархические зависимости](../guides/hierarchical-dependencies.md#top) — `parent`, другой
  способ связать строки между собой

---

← Назад: [Отбор через filter](./filter.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Обзор](../constructs/overview.md#top) →

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/pools/linking)**
