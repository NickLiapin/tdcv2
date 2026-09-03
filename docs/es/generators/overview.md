<a name="top"></a>

[English](../../generators/overview.md#top) · [Русский](../../ru/generators/overview.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/generators/overview)**

← Anterior: [Determinismo y proporciones](../core-concepts/determinism.md#top) · **[Contenido](../README.md#top)** · Siguiente: [text](./text.md#top) →

---

# Generadores

Un `<gen>` es una fábrica de datos. Su atributo `type` elige **cuál** generador se
usa; todos los demás atributos son parámetros de ese generador. Un generador produce
los valores de una [secuencia](../core-concepts/sequences.md#top):

```xml
<sequence name="Status">
    <gen type="text" value="new,active,closed"/>
</sequence>
```

`./run demo.tdc`

```
active
new
closed
active
closed
```

Las salidas de ejemplo de esta página son ilustrativas: los valores exactos dependen
de la semilla y pueden cambiar entre versiones del núcleo. Lo que sí es estable es la
**forma** del resultado: el formato, las cantidades y la distribución.

## Dónde puede vivir un generador

Un `<gen>` vive **donde se declaran los datos**:

- dentro de una [`<sequence>`](../core-concepts/sequences.md#top) —simple, compuesta por
  valor, compuesta o condicional—, llenando `count` valores (o tantos como tenga el
  subconjunto filtrado, si la secuencia tiene `parent`). «Un arreglo de `count` valores»
  es el modelo con el que conviene razonar; el motor por omisión los produce fila por
  fila mientras el archivo se transmite, sin guardar nunca el arreglo;
- dentro de un [`<case>`](../reference/tags.md#top) de un [`<mix>`](../reference/tags.md#top) —
  una rama de un reparto porcentual.

Varios `<gen>` pueden compartir un mismo cuerpo de secuencia, y `name` decide en qué
se convierte cada uno. Deje un generador **sin nombre** y su valor se concatena en el
valor propio de la secuencia, junto con cualquier literal `<data>` a su lado: una
[secuencia compuesta por valor](../core-concepts/sequences.md#una-secuencia-compuesta-por-valor).
Póngale `name` y pasa a ser un campo propio, que se lee como `${{Secuencia.Campo}}`:
una [secuencia compuesta](../core-concepts/sequences.md#una-secuencia-compuesta). Los
dos se mezclan libremente en un mismo cuerpo.

**No** se permite directamente en el bloque de salida. Un `<gen>` colocado como hijo
de [`<line>`](../core-concepts/output-formatting.md#top) es el error `TDC131`: ese bloque
solo da formato al texto, no genera nada. Para poner un valor generado en la salida,
declare una secuencia con nombre y refiérase a ella con `${{Nombre}}` — vea
[Salida y formato](../core-concepts/output-formatting.md#top).

## Atributos comunes

Estos atributos funcionan en **todos** los generadores; el resto dependen de `type`.

| Atributo  | Obligatorio | Qué hace                                                                                                                                                                                                                     |
| :-------- | :---------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`    | **sí**      | Cuál generador se usa (vea la tabla de abajo)                                                                                                                                                                                |
| `name`    | no          | Convierte el generador en un **campo** de su secuencia, que se lee como `${{Secuencia.Campo}}`. Sin él, el valor se suma al [valor propio de la secuencia](../core-concepts/sequences.md#una-secuencia-compuesta-por-valor) |
| `if`      | no          | Condición de rama dentro de una [secuencia condicional](../core-concepts/sequences.md#top) — gana el primer `<gen>` verdadero                                                                                                   |
| `comment` | no          | Comentario libre, el motor lo ignora                                                                                                                                                                                         |

## Los generadores

Cada tipo tiene su propia página, con todos sus parámetros y ejemplos resueltos.

| `type`                                    | Produce                                                             |
| :---------------------------------------- | :------------------------------------------------------------------ |
| [`text`](text.md#top)                        | Un valor de un conjunto — uniforme, o con `percent` exacto          |
| [`number`](number.md#top)                    | Un entero dentro de un rango, o una cadena de dígitos de ancho fijo |
| [`template`](template.md#top)                | Datos realistas integrados e identificadores técnicos               |
| [`file`](file.md#top)                        | Valores leídos de sus propios archivos y columnas CSV               |
| [`date`](date.md#top)                        | Una fecha o fecha-hora dentro de un rango y con un formato          |
| [`symbol`](symbol.md#top)                    | Una cadena de caracteres de un conjunto o alfabeto con nombre       |
| [`regex`](regex.md#top)                      | Una cadena que corresponde a una expresión regular finita           |
| [`advanced_regex`](advanced-regex.md#top)    | Regex más elección ponderada entre alternativas                     |
| [`increment` / `decrement`](counters.md#top) | Contadores ascendentes y descendentes                               |
| [`timeseries`](timeseries.md#top)            | Una serie de tiempo — tendencia + estacionalidad + ruido            |
| [`pattern`](pattern.md#top)                  | Una distribución con la forma de una curva dibujada                 |
| [`http`](http.md#top)                        | Valores que responde su propio servicio, por lotes                  |
| [`running`](running.md#top)                  | Un total que se arrastra por la columna — un saldo, un máximo       |
| [`stat`](stat.md#top)                        | Un número para toda la ejecución — una media, un total, un máximo   |
| [`formula`](formula.md#top)                  | Aritmética sobre las demás columnas de la misma fila                |

**Sobre los presets.** El viejo `type="preset"` ya no existe. Los identificadores
algorítmicos —UUID, IBAN, números de tarjeta de crédito, SHA de git, identificaciones
nacionales— ahora son rutas de [`template`](template.md#top): las globales bajo el
prefijo `common.` (por ejemplo `common.id.uuid`) y las de cada país bajo su país (por
ejemplo `usa.docs.ssn`). El catálogo completo está en las páginas de
[`template`](template.md#top) y de la
[referencia de generadores](../reference/generators.md#top).

## Proporciones declaradas, o un sorteo de una fuente

En esa tabla conviven generadores de dos clases, y responden de forma distinta a «¿con qué
frecuencia aparece cada valor?». Vale la pena saber cuál tiene en la mano.

**Declaró las proporciones — las obtiene exactas.** Donde los valores están escritos
en la propia configuración, TDC reparte la cuota entre las filas y luego la baraja.
`percent="30,70"` es 30 y 70, no «más o menos». Si no las indica, son iguales, y iguales
también es exacto:

`10 valores sobre 1000 filas`

```
text:  100 100 100 100 100 100 100 100 100 100
```

Eso cubre [`text`](text.md#top) y [`<mix>`](../constructs/mix.md#top), y
[`number`](number.md#top) **cuando su `percent` reparte grupos de `length`**: `length="2,3"
percent="70,30"` sobre mil filas da exactamente 700 y 300.

> [!CAUTION]
> **`missing=` en el mismo generador cambia los conteos**
>
> La cuota se reparte primero sobre toda la columna, y `missing=` vacía celdas después sin
> mirar qué valor tienen. Así que `percent="90,10" missing="0.5"` sobre mil filas da unos
> 450 / 50 / 500 vacías: la PROPORCIÓN de los valores que sobreviven sigue siendo 90:10, y
> los conteos absolutos no son los que daría `percent` por sí solo.
>
> No es un desliz de redondeo, y ningún orden lo arregla: las dos peticiones son
> incompatibles. Exactamente 100 filas `fail` Y medio archivo vacío haría que `fail` fuera
> 100 de los 500 valores supervivientes, es decir un 20 %, no el 10 % pedido. Si necesita un
> número exacto de un valor en el archivo terminado, no ponga `missing=` en ese generador.

Un rango numérico simple es de la otra clase. `value="1..10"` sortea, y sobre mil filas
los diez valores salen `97 84 106 112 107 102 90 95 86 121` — la dispersión de un sorteo,
no una cuota. La regla es lo que escribió el config: las proporciones escritas se cumplen
exactamente, en un rango se mete la mano.

**Apuntó a una fuente — obtiene un sorteo.** Un [archivo](file.md#top) o un
[pool](../pools/overview.md#top) es un conjunto en el que mete la mano una vez por fila, de
forma independiente. Sobre esas mismas 1000 filas los recuentos caen donde los deja el
azar:

`los mismos 10 valores, leídos de una fuente`

```
file:   81  88  93  97  98 102 103 105 111 122
pool:   90  92  95  97 100 102 104 105 106 109
```

Esto no es una versión débil de lo primero. Nadie declaró una proporción, así que no hay
ninguna que respetar: una fuente se comporta como sacar de un sombrero, y por eso parece
uso real y no un cuadrante de turnos.

**Cuando una fuente necesita proporciones, las toma de los datos.** Un CSV que sabe con
qué frecuencia se vende cada artículo lo dice en una columna, y
[`weight="sales"`](../guides/coherent-data.md#top) hace que el sorteo la siga — exacto, como
`percent`. Ese es el lugar honesto para los números: un catálogo de 3.000 artículos tiene
sus frecuencias en el archivo, no en su configuración.

## Formato en cualquier generador

Un puñado de atributos funciona en **cualquier** `type`. El valor se genera como
siempre y luego se reacomoda de salida — al generador no le importa cuál de estos
atributos se le haya puesto.

### `case=` / `mask=` — mayúsculas/minúsculas y máscaras de presentación

**Úselo cuando** el valor crudo es correcto pero debe _verse_ de cierta manera: una
columna que tiene que ir toda en mayúsculas, o un número simple que debe leerse como
un identificador con formato.

`case=` cambia entre mayúsculas y minúsculas; `mask=` reparte y reacomoda los
caracteres dentro de una plantilla fija. Ambos envuelven al generador **completo**. El
ejemplo de abajo pasa las mismas cuatro ciudades de Estados Unidos por tres
secuencias: el valor crudo, y luego la misma lista con `case="lower"` y
`case="upper"`. `order="sequential"` mantiene las ciudades al mismo paso para que las
columnas queden alineadas.

```xml
<sequence name="Raw"><gen type="text" value="New York,Chicago,Denver,Austin" order="sequential"/></sequence>
<sequence name="Low"><gen type="text" value="New York,Chicago,Denver,Austin" order="sequential" case="lower"/></sequence>
<sequence name="Up"><gen type="text" value="New York,Chicago,Denver,Austin" order="sequential" case="upper"/></sequence>
...
<data>${{Raw}}  ->  lower: ${{Low}}  |  upper: ${{Up}}</data>
```

`./run cities.tdc`

```
New York  ->  lower: new york  |  upper: NEW YORK
Chicago   ->  lower: chicago   |  upper: CHICAGO
Denver    ->  lower: denver    |  upper: DENVER
Austin    ->  lower: austin    |  upper: AUSTIN
```

Una `mask=` hace el mismo truco para identificadores «bonitos»: un
`37898432363` pelón con `mask="xxx-xxx-xxx xx"` sale como `378-984-323 63`. Cada
ranura de máscara (`x`, `w`, `*`), cada modo de `case` y las cadenas de filtros de
varios pasos se explican a fondo en
**[Máscaras y mayúsculas](../guides/masks-and-case.md#top)**.

### `order=` / `cycle=` — el orden de los valores

**Úselo cuando** los valores deban salir en una secuencia fija y no al azar: los
nombres de los meses en orden de calendario, una lista de catálogo recorrida de
arriba abajo, o dos columnas que tienen que quedar alineadas (como en el ejemplo de
arriba).

Por omisión, `order="random"`. Ponga `order="sequential"` y la fila _i_ toma el
_i_-ésimo valor en orden, volviendo al inicio cuando la lista se acaba.
`cycle="false"` convierte esa vuelta al inicio en un error explícito — útil cuando
quedarse sin valores debe ser una falla y no una repetición silenciosa.

Ambos los leen los tres generadores que tienen **algo que recorrer**: `text` (su lista
separada por comas), `file` (sus líneas o su columna CSV) y `date` (su `range=`,
recorrido en unidades de `step=`). En cualquier otro tipo no hay nada que recorrer —un
sorteo nunca se agota—, así que el motor los rechaza (TDC015) en vez de aceptar una
petición que no puede cumplir.

```xml
<sequence name="Rand"><gen type="text" value="Jan,Feb,Mar"/></sequence>
<sequence name="Seq"><gen type="text" value="Jan,Feb,Mar" order="sequential"/></sequence>
...
<data>random=${{Rand}}   sequential=${{Seq}}</data>
```

`./run order.tdc (7 rows)`

```
random=Feb   sequential=Jan
random=Feb   sequential=Feb
random=Mar   sequential=Mar
random=Jan   sequential=Jan
random=Feb   sequential=Feb
random=Mar   sequential=Mar
random=Jan   sequential=Jan
```

Lo mismo aplica a los archivos: `<gen type="file" src="cities.txt" order="sequential"/>`
recorre el archivo línea por línea. Todos los detalles en
**[Máscaras y mayúsculas](../guides/masks-and-case.md#top)**.

### `missing=` / `anomaly=` — vacíos y valores atípicos

**Úselo cuando** necesite datos que se parezcan al mundo real, donde algunos campos
vienen vacíos y unos cuantos valores quedan muy fuera del rango normal. `missing=`
inyecta celdas vacías (huecos que faltan de manera completamente aleatoria);
`anomaly=` inyecta valores atípicos para que un pipeline o un modelo río abajo tenga
algo anormal con qué lidiar. Ambos se ponen en el generador igual que `case=` y se
aplican después de producir el valor.

Estas perillas modelan el realismo más que el valor base, y se enganchan a cualquier
generador. Se diferencian en aquello sobre lo que pueden actuar: `missing=` vacía la
celda sea cual sea su contenido, mientras que `anomaly=` **multiplica**, así que solo
muerde en valores que se leen como números. Una cadena numérica de una lista `text` se
multiplica; un nombre a su lado pasa sin cambios, y una lista sin ningún número se rechaza
de plano. Las reglas completas están en
**[Anomalías y valores faltantes](../guides/anomalies.md#top)**.

---

← Anterior: [Determinismo y proporciones](../core-concepts/determinism.md#top) · **[Contenido](../README.md#top)** · Siguiente: [text](./text.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/generators/overview)**
