<a name="top"></a>

[English](../../constructs/multiple-values.md#top) · [Русский](../../ru/constructs/multiple-values.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/constructs/multiple-values)**

← Anterior: [Salida condicional (if)](./conditional-output.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Una fila por elemento (each)](./relational-tables.md#top) →

---

# Varios valores en una celda (`repeat`)

**Conviene usarlo cuando** un campo no siempre tiene un solo valor. Un pedido lleva un
artículo o cinco. Un artículo carga una sola etiqueta o cuatro. Un sensor reporta tres
lecturas a la vez. `repeat` hace que un mismo [`<gen>`](../generators/overview.md#top) emita
**varios** valores dentro de una celda en lugar de uno — y la cantidad puede variar de
fila en fila.

Antes de `repeat`, la única manera de fingir un campo de longitud variable eran cinco
secuencias separadas con la mitad de las filas en blanco. Ahora es un atributo en el
generador.

Las salidas de ejemplo de abajo son ilustrativas — los valores exactos que produce un
`seed` dado pueden cambiar entre versiones del core, pero la **estructura** que garantiza
cada forma (cuántos valores caen en una celda, y cómo se unen) no cambia.

![](../../img/concepts/repeat-lists.svg)

*Las primeras ocho filas de una corrida de 2000 filas, y la longitud de cada lista en ella.*

- **A** — una celda por fila, con entre uno y cuatro valores
- **B** — cuántas filas salieron con cada longitud — los conteos son una cuota exacta, no una aproximación

## De un vistazo

| Atributo        | Qué significa                                                          |
| :-------------- | :--------------------------------------------------------------------- |
| `repeat="3"`    | exactamente tres valores                                               |
| `repeat="1..5"` | entre uno y cinco — cada longitud recibe una parte exacta de las filas |
| `repeat="0..3"` | se permite el cero — la celda puede salir vacía                        |
| `separator=" "` | con qué unirlos; por omisión es una coma                               |

El límite superior es **64**. `separator` sin `repeat` es un error — no hay nada que unir.

> [!NOTE]
> **Un rango es una cuota, no un volado**
>
> `repeat="1..4"` **no** tira un dado por fila. TDC le da a cada longitud una parte exacta
> de la corrida, igual que [`percent`](../generators/text.md#top): 200 filas salen
> 50 / 50 / 50 / 50. Cuando el count no divide exacto, el resto va a una de las longitudes y
> la [semilla](../core-concepts/determinism.md#top) decide a cuál, así que 201 filas salen
> 51 / 50 / 50 / 50 en algún orden. Las longitudes siempre suman el count, que es lo que
> mantiene exactas
> también las proporciones de los valores (vea «Listas de palabras y proporciones exactas»
> más abajo).
>
> El precio es el mismo que paga todo diseño que abarca la corrida entera: **cambie
> `count` y las longitudes se reparten de nuevo**, así que una corrida corta no es el
> comienzo de una larga. Vea
> [Determinismo y proporciones](../core-concepts/determinism.md#top).

## `repeat="1..5"` — una cantidad que varía por fila

Este es el caso de todos los días. Una línea de pedido debería llevar la cantidad de
artículos que el pedido haya tenido. Aquí cada canasta saca de uno a cuatro SKU, unidos
por espacios:

```xml
<env count="8" seed="basket-7">
    <sequence name="Id"><gen type="increment" value="1"/></sequence>
    <sequence name="Items">
        <gen type="regex" value="SKU-[0-9]{4}" repeat="1..4" separator=" "/>
    </sequence>
</env>
<block>
    <line><data>order ${{Id}}: ${{Items}}</data></line>
</block>
```

`./run basket.tdc (count=8)`

```
order 1: SKU-5365 SKU-2241 SKU-0758 SKU-9382
order 2: SKU-2033 SKU-3412 SKU-3799
order 3: SKU-3278
order 4: SKU-3984 SKU-4578
order 5: SKU-5351 SKU-5903
order 6: SKU-3412
order 7: SKU-0258 SKU-3326 SKU-1157
order 8: SKU-3205 SKU-4821 SKU-3618 SKU-2450
```

El tamaño de la canasta se mueve entre uno y cuatro artículos — como en los pedidos
reales. **Por qué:** cualquier campo cuya cardinalidad en el mundo real varíe (artículos
de un pedido, etiquetas, números telefónicos, direcciones) se traduce directo a un rango
`min..max`.

## `repeat="3"` — una cantidad fija de valores

Dé un solo entero y cada celda llevará exactamente esa cantidad de valores. Útil para
tokens de forma fija — un código de tres grupos, una terna (x, y, z), un conjunto de tres
lecturas:

```xml
<sequence name="Code">
    <gen type="regex" value="[A-Z]{2}" repeat="3" separator="-"/>
</sequence>
```

`./run code.tdc (count=6)`

```
QR-LM-ZP
BX-TT-KD
WM-AE-RH
NP-CC-JU
FL-GO-VS
DK-HY-QN
```

**Por qué:** cuando la forma es fija y solo varían los valores, `repeat="3"` es más claro
que tres campos separados pegados en el bloque de salida.

## `repeat="0..3"` — se permite el cero

Un rango que empieza en `0` deja que una celda salga **vacía**. Eso es justo lo correcto
para una lista opcional — algunos artículos no tienen ninguna etiqueta:

```xml
<sequence name="Tags">
    <gen type="text" value="news,tech,sport,food,travel" repeat="0..2" separator=", "/>
</sequence>
```

`./run tags.tdc (count=6)`

```
article 1: tech, news
article 2:
article 3: sport
article 4:
article 5: travel, food
article 6: news
```

Los artículos 2 y 4 sacaron longitud cero, así que su celda queda en blanco — no es un
valor especial, solo una lista vacía. **Por qué:** «a veces presente, a veces ausente» es
una forma real de los datos, y `0..n` la modela sin una segunda secuencia.

## `lengths=` — qué proporción de filas recibe cada cantidad

Sin él todas las longitudes son igual de probables, y "igual" aquí es **exacto**, no
aproximado: las longitudes se reparten como una cuota, así que `repeat="0..5"` da a cada una
de las seis un sexto de las filas, sin ninguna variación de muestreo.

Los datos reales de uno-a-muchos nunca se ven así. Pedidos por cliente, visitas por
paciente, transacciones por cuenta: la mayoría de los padres tienen uno o dos hijos, unos
pocos tienen veinte. `lengths=` da la proporción de filas que recibe cada cantidad,
empezando por la menor:

```xml
<gen type="number" value="100..999" repeat="0..5" lengths="40,25,15,10,7,3" separator=";"/>
```

`./run orders.tdc (8 filas)`

```
[896;648;701;334]
[]
[765]
[342;706]
[447;991;569]
[]
[148]
[]
```

Sobre 20 000 filas las proporciones salen hasta la centésima, porque son una cuota y no un
sorteo:

`./run orders.tdc (20 000 filas, contadas)`

```
0: 40.00%  1: 25.00%  2: 15.00%  3: 10.00%  4: 7.00%  5: 3.00%
```

Una proporción por cada longitud posible, y deben sumar 100 — la misma aritmética que usa
`percent=`. Cinco proporciones para seis longitudes se rechazan en vez de repararse: un
config escrito así tenía una forma en mente, y adivinar cuál de las seis se olvidó no es
tarea del motor.

> [!NOTE]
> **Exacto, a diferencia de una distribución dibujada**
>
> `lengths=` es una **cuota**: 40% significa 40.00%. Una forma dibujada con
> [`<gen type="pattern" mode="density">`](../generators/pattern.md#top) reproduce una *forma* con
> una precisión de décimas de punto — la herramienta correcta para "más o menos así" y la
> incorrecta para "exactamente esta cantidad".

## `separator=` — cómo se unen los valores

Sin `separator`, los valores se unen con una coma. Póngale cualquier cadena para que
coincida con el formato que está construyendo — un espacio, una barra vertical, `" | "`,
`"; "`, lo que necesite la columna.

```xml
<sequence name="Letters">
    <gen type="text" value="a,b,c,d,e" repeat="3"/>          <!-- coma por omisión -->
</sequence>
<sequence name="Piped">
    <gen type="text" value="a,b,c,d,e" repeat="3" separator=" | "/>
</sequence>
```

`./run sep.tdc (count=3) — por omisión y con barra vertical`

```
d,a,c        d | a | c
b,e,b        b | e | b
a,c,e        a | c | e
```

**Por qué:** la celda unida es apenas texto, así que el separador es la manera de hacerla
encajar en una columna de CSV, en una lista en línea estilo JSON o en una línea legible
para una persona.

## `accumulate=` — un total acumulado a lo largo de la lista

Muchas veces los valores de una celda son pasos de una misma cosa, no tres sorteos
independientes: las líneas de un ticket, los tramos de un viaje, los minutos de una
sesión. `accumulate=` reemplaza la lista por su total acumulado.

```xml
<gen type="number" value="150..900" decimals="2" repeat="3" separator=", " accumulate="sum"/>
```

`./run cart.tdc`

```
239.10, 568.84, 809.63
791.92, 1059.68, 1593.11
473.43, 785.34, 1006.51
```

A la izquierda, el mismo generador sin `accumulate=`; a la derecha, con él. El último
elemento es el total, y cada uno antes de él es el subtotal en ese paso.

| `accumulate=` | Cada elemento pasa a ser                     |
| :------------ | :------------------------------------------- |
| `sum`         | la suma de todo lo anterior, incluido él     |
| `max`         | el mayor visto hasta ahí — un récord parcial |
| `min`         | el menor visto hasta ahí                     |

`./run peaks.tdc`

```
pico 22,22,22,83,83
pico 11,48,54,54,54
pico 57,60,62,62,93
```

**La aritmética es exacta, también con centavos.** La suma se hace sobre enteros
escalados por la fracción más ancha de la lista, nunca en punto flotante — por eso
`19.99 + 0.01` da `20.00` y no `20.000000000000004`, y da el mismo `20.00` en las cinco
implementaciones.

**`min` y `max` devuelven un elemento que ya existe**, así que conservan su escritura. Un
valor sorteado como `007` sigue siendo `007`, no se convierte en `7`.

**Un elemento vacío se saltea.** [`missing=`](../guides/missing-data.md#top) deja celdas en
blanco, y una vacía deja el acumulador quieto en vez de contar como cero: «ese día no se
tomó la lectura» no debería poner el contador en cero.

`accumulate=` necesita una lista, o sea `repeat=` (`TDC237`), y la operación tiene que ser
una de esas tres (`TDC238`).

> [!NOTE]
> **¿Y si hace falta por columna?**
>
> Acá la acumulación ocurre **dentro de un registro**. Para un total que se arrastra de fila
> en fila —el saldo de una cuenta, un contador que solo sube— la construcción es otra:
> [`<gen type="running">`](../generators/running.md#top).

## Los valores faltantes, las anomalías y el formato actúan **por elemento**

Esto es lo único que hay que recordar: como `repeat` vive en el **generador**, todo lo que
ese generador hace le pasa a **cada valor por separado**, no a la celda como un todo. Los
huecos de datos faltantes, la inyección de anomalías y el
[formato de salida](../guides/masks-and-case.md#top) operan todos elemento por elemento.

La ventaja práctica se ve con una columna de banderas. Cuando un generador marca
anomalías, su campo de bandera se vuelve una lista de la **misma longitud** que las
lecturas — una bandera por lectura, alineadas exactamente:

`./run sensors.tdc (lecturas -> banderas de anomalía)`

```
5,500,100     ->   false,true,true
800,200,1     ->   true,true,false
6,8,7         ->   false,false,false
100,300,900   ->   true,true,true
```

La bandera queda precisamente donde está el valor atípico. Se puede probar un detector no
al nivel grueso de «algo en este lote andaba mal», sino exactamente — **qué lectura se
rompió**.

Si en cambio lo que quiere es «el registro entero está corrupto», ese es otro trabajo para
otra herramienta: una rama de `<mix>` con un `flag` a nivel de registro, no `repeat`.

## Listas de palabras y proporciones exactas

La lista más común es un conjunto de etiquetas, y `repeat` funciona directo sobre el
generador [`text`](../generators/text.md#top):

```xml
<sequence name="Tags">
    <gen type="text" value="news,tech,sport,food,travel" repeat="1..3" separator=", "/>
</sequence>
```

`./run tags.tdc (count=6)`

```
article 1: [food]
article 2: [tech, news]
article 3: [news, tech, travel]
article 4: [sport, tech]
article 5: [travel, travel, news]
article 6: [sport]
```

Aquí viene la parte sutil. [`text`](../generators/text.md#top) acomoda sus valores en
proporciones **exactas** mediante una máscara [`percent`](../generators/text.md#top), no
aproximadas — y esa garantía **sobrevive** a `repeat`, tanto con una cantidad fija como con
un rango.

Funciona porque TDC **decide primero todas las longitudes** (también por una cuota exacta)
y solo después llena las ranuras resultantes. Como las longitudes se conocen de antemano,
también se conoce la cantidad total de ranuras — no se genera nada en vano y no se pierde
ninguna cuota.

Comprobado sobre 120 000 filas con `repeat="1..4"` y `percent="40,30,20,10"`:

`./run tags-big.tdc (count=120000, con conteo)`

```
row lengths:   30000 x1    30000 x2    30000 x3    30000 x4     (exactamente un cuarto cada una)
values:       120000 news   90000 tech   60000 sport  30000 food   (exactamente 40/30/20/10)
```

300 000 ranuras en total, y la distribución cae exacta. Ejecútelo con `--jobs 7` y obtiene
los mismos números — el archivo es idéntico byte por byte.

> [!NOTE]
> **Los valores dentro de una celda pueden repetirse**
>
> El `[travel, travel, news]` de arriba está bien, no es un error. Cada ranura se llena de
> forma independiente, así que el mismo valor puede caer dos veces — dos lecturas de `40` o
> dos veces el mismo artículo en un carrito son datos normales. Cuando necesite lo contrario,
> dígalo de forma explícita:
> [`distinct="true"`](#sin-repeticiones-dentro-de-una-celda-distinct).

## Sin repeticiones dentro de una celda: `distinct`

A veces un valor repetido no es solo poco interesante, sino directamente erróneo. El caso
más claro es un nombre doble: `Jesus Jesus Gonzales` no es un nombre.

`distinct="true"` toma los valores de la fila **sin reemplazo**, de modo que una celda no
puede contener el mismo valor dos veces:

```xml
<gen name="First" type="template" value="person.male.firstName"
     repeat="2" separator=" " distinct="true"/>
```

`./run names.tdc (count=5)`

```
William Robert Jones
Matthew Tyrone Smith
James Zachery Williams
Devin Jacob Brown
Thomas Preston Johnson
```

Las mismas cinco etiquetas, una al lado de la otra, sin el atributo y con él:

```xml
<gen name="Tags"   type="text" value="news,tech,sport,food,travel" repeat="1..3" separator=", "/>
<gen name="Unique" type="text" value="news,tech,sport,food,travel" repeat="1..3" separator=", " distinct="true"/>
```

`./run tags.tdc (count=6)`

```
tech   |   sport, tech, news
news, food, food   |   travel, tech
sport   |   news
news, travel   |   sport, travel
tech, travel   |   tech
sport, sport, tech   |   travel, news, food
```

`food, food` y `sport, sport` a la izquierda; nunca a la derecha.

### Lo que cuesta

`distinct` no es gratis, y conviene entender el precio antes de recurrir a él.

Sin él, una columna de valores listados se acomoda a lo largo de **toda la ejecución** como
una cuota exacta — eso es lo que hace que `percent` caiga justo. Una fila que no puede
repetirse no puede leer una ranura decidida de antemano: tiene que **elegir**. Así que bajo
`distinct` la columna sortea fila por fila, y sus frecuencias globales pasan a ser
**aproximadas en lugar de exactas**.

Un [pack de datos](../data-packs/overview.md#top) ponderado sigue funcionando y sigue
apoyándose en sus valores frecuentes — los nombres comunes siguen siendo comunes. Solo que
ya no caen en un recuento exacto sobre la ejecución.

Por eso `percent` y `distinct` no pueden estar en el mismo generador: `percent` promete una
exactitud que la columna ya no puede dar, y TDC rechaza el par
([`TDC291`](../reference/errors.md#top)) en vez de cumplir uno en silencio y descartar el otro.
Si quiere proporciones sobre las **longitudes** de las listas, póngalas en un
[`<mix>`](./mix.md#top) o un `<switch>` por fuera, con `repeat` en el
generador de dentro.

Todo lo demás sobre `repeat` no cambia: las filas siguen siendo independientes, así que el
streaming y `--jobs` siguen funcionando.

### Cuando no se puede

Cinco valores no pueden dar seis distintos. TDC lo dice en vez de devolver en silencio una
lista más corta:

| lo que escribió | lo que ocurre |
| :--- | :--- |
| `distinct="true"` sin `repeat=` | `TDC290` — un valor no puede repetirse a sí mismo |
| `percent=` y `distinct=` juntos | `TDC291` — véase arriba |
| `repeat="1..10"` sobre una lista de cinco | `TDC292`, antes de la ejecución — la lista está en la configuración |
| lo mismo, desde un pack o un archivo | el mismo rechazo, en tiempo de ejecución — el conjunto solo se conoce entonces |

La última fila explica la división. Una lista `value="a,b,c"` se puede contar desde la
configuración, así que la detecta `tdcv2 check`; un archivo de pack o una columna CSV se leen
mientras se genera, de modo que el rechazo tiene que esperar. En ambos casos es un rechazo,
nunca una celda corta.

## Dónde `repeat` no funciona

Unos cuantos generadores atan cada valor al **número de fila**, y `repeat` no se les puede
aplicar:

| Generador                                                                            | Por qué no                                   |
| :----------------------------------------------------------------------------------- | :------------------------------------------- |
| [`increment`](../generators/counters.md#top), `decrement`                               | el valor depende de la posición de la fila   |
| [`timeseries`](../generators/timeseries.md#top), [`pattern`](../generators/pattern.md#top) | lo mismo — el valor está atado a la posición |

Para estos, el índice de un elemento dependería de qué tan largas resultaron **todas las
filas anteriores** — una cantidad aleatoria. Eso haría imposible calcular una fila sin sus
vecinas, rompiendo el streaming y `--jobs`. TDC se niega con un error claro (`TDC204`) en
vez de hacer lo incorrecto en silencio.

## Qué más no acepta TDC

| Lo que escribió                      | Lo que dice                                                       |
| :----------------------------------- | :---------------------------------------------------------------- |
| `repeat="many"`, `repeat="1.5"`      | `TDC195` — se requiere un entero                                  |
| `repeat="-1"`, `repeat="5..2"`       | `TDC195` — el mínimo no puede ser negativo ni mayor que el máximo |
| `repeat="1..65"`                     | `TDC195` — el límite superior es 64                               |
| `separator=";"` sin `repeat`         | `TDC198` — no hay nada que unir                                   |
| `repeat` o `separator` en un `<mix>` | `TDC196` — un mix elige una rama, no construye una lista          |

Sobre esa última: un `<mix>` **elige** entre ramas, así que «repítelo» no tiene un
significado bien definido. Si quiere una lista dentro de una rama, ponga `repeat` en el
[`<gen>`](../generators/overview.md#top) que está dentro del `<case>`.

## A gran escala

`repeat` no le estorba ni al streaming ni a `--jobs`: una fila se sigue calculando de forma
independiente de sus vecinas. Dos cosas distintas lo hacen posible, y es fácil
confundirlas:

- **La longitud** de la lista de cada fila viene de la cuota sobre la corrida entera
  (arriba). Una fila puede deducirla de su propio número — no necesita a sus vecinas.
- **Los valores** se sacan luego para el **máximo** (para `repeat="1..5"`, cinco) y los
  sobrantes se descartan, de modo que la posición en el flujo aleatorio depende solo del
  número de fila y nunca de qué longitud tuvieron las filas anteriores.

Eso es lo que permite calcular una fila sin calcular las anteriores, y es la razón por la
que la salida multihilo coincide byte por byte con la de un solo hilo.

De ahí sale también el tope de 64: un `repeat` grande es trabajo real gastado, aunque la
fila termine con solo dos elementos. Vea
**[Salidas grandes](../guides/large-outputs.md#top)**.

## En Parquet, una lista de verdad

Cuando se exporta a Parquet, una columna con `repeat` se vuelve una **lista real**, no una
cadena unida. El tipo del elemento se infiere automáticamente:

`esquema parquet`

```
id       INT64       REQUIRED
items    LIST of BYTE_ARRAY (UTF8)
prices   LIST of INT64
city     BYTE_ARRAY  REQUIRED
```

`filas parquet (como JSON)`

```
{"id":1,"items":["bread","cheese"],        "prices":[262],         "city":"Boston"}
{"id":3,"items":["cheese","milk"],         "prices":[469,241,188], "city":"Boston"}
{"id":6,"items":["milk","bread","coffee"], "prices":[81,262],      "city":"Denver"}
```

Una lista vacía sigue siendo una lista vacía — no desaparece. Y un valor faltante dentro de
una lista produce un **`null` real** en el lugar del elemento: en texto eso es
indistinguible de una cadena vacía, pero Parquet lo registra con exactitud.

`parquet — un elemento null`

```
{"t":[6,5,null]}
```

También se puede definir el tipo a mano: `type="[]int64"`,
`type="[]decimal(18,2)"`. Escribir `type="[]int64|null"` significa «una lista cuyo
**elemento** puede ser null» — precisamente lo que produce un valor faltante por elemento.

## Vea también

- **[`text`](../generators/text.md#top)** — listas separadas por comas y las proporciones
  exactas de `percent`, que `repeat` conserva.
- **[Contadores](../generators/counters.md#top)** — `increment` / `decrement`, los generadores
  atados a la posición a los que `repeat` no se les puede aplicar.
- **[Máscaras y mayúsculas](../guides/masks-and-case.md#top)** — el formato por elemento que se aplica a
  cada valor de una celda con `repeat`.
- **[Salidas grandes](../guides/large-outputs.md#top)** — por qué `repeat` sigue siendo seguro para
  streaming e idéntico entre distintos `--jobs`.

---

← Anterior: [Salida condicional (if)](./conditional-output.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Una fila por elemento (each)](./relational-tables.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/constructs/multiple-values)**
