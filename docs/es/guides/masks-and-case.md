<a name="top"></a>

[English](../../guides/masks-and-case.md#top) · [Русский](../../ru/guides/masks-and-case.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/guides/masks-and-case)**

← Anterior: [Formatos de salida (CSV, JSON, SQL…)](./output-formats.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Distribuciones estadísticas](./statistical-distributions.md#top) →

---

# Máscaras y mayúsculas

Un generador produce valores **crudos** — exactamente como se construyen. Un número de
seguro social de EE. UU. son nueve dígitos seguidos, una fecha es `2020-05-14`, un
nombre es como esté puesto en la lista. Al generador le importa **qué** son los datos,
no **cómo se ven**: los separadores, las mayúsculas y el orden de las palabras no son su
trabajo.

Esto es lo que emite un generador [`text`](../generators/text.md#top) a secas para un lote
de SSN (`order="sequential"` para que los valores de abajo se mantengan estables y se
repitan en orden):

```xml
<gen type="text" value="378984323,889735724,852139753,263243158" order="sequential"/>
```

`./run demo.tdc`

```
378984323
889735724
852139753
263243158
```

Los valores son **válidos**, pero leerlos así es doloroso. El formato le da forma a un
valor ya generado, camino a la salida. Siempre son tres partes:

**valor crudo → procesador → apariencia final** — por ejemplo `378984323` → máscara
`xxx-xx-xxxx` → `378-98-4323`.

Hay dos procesadores independientes:

- **mask** — corta la cadena en piezas y coloca separadores entre ellas (`x`, `w`, `*`);
- **case** — `upper`, `lower`, `capitalize`, `title`.

Además están las operaciones `slice`, `replace`, `trim`, `group`, `compact` (abajo), los
filtros de escape `csv` / `sql`, y `order="sequential"` — para tomar los datos **en
orden** en vez de al azar.

> [!NOTE]
> Las salidas de ejemplo son ilustrativas — los valores exactos pueden variar entre
> versiones del core. Lo que importa es la forma de cada transformación.

![](../../img/concepts/mask.svg)

*Un valor real pasando por una máscara real.*

- **A** — el valor generado, antes de la máscara
- **B** — la máscara: una x es una ranura, cualquier otra cosa es un literal que se conserva tal cual
- **C** — el resultado — las curvas muestran qué carácter del origen llenó cada ranura

## Tres rutas, un mismo comportamiento

El mismo formato está disponible de tres maneras — mismo resultado, elija la que le
convenga:

| Ruta                                                   | Cómo se escribe              | Mejor cuando                              |
| :----------------------------------------------------- | :--------------------------- | :---------------------------------------- |
| Un filtro en la interpolación                          | `${{X \| mask:…}}`           | un valor en un punto específico del texto |
| Un atributo en [`<gen>`](../generators/overview.md#top)   | `<gen … mask="…" case="…"/>` | se formatea el generador **entero**       |
| Una etiqueta en [`<compute>`](../compute/overview.md#top) | `<mask pattern="…">…</mask>` | el formato es un paso de un cálculo       |

La mayoría de los ejemplos de abajo usan la ruta del filtro, que vive en la
[interpolación](../core-concepts/output-formatting.md#filtros). Cada etiqueta de compute
tiene además su casa en [Cadenas y formato](../compute/strings.md#top).

## Máscara — cortar y espaciar

**Problema.** Un número llega como una sola cadena pegada (`378984323`) — no se ve dónde
están los grupos.

**Herramienta.** Una máscara recorre su patrón de izquierda a derecha. Cada **ranura** se
come un pedazo de la entrada; todo lo demás se imprime como literal:

| Ranura              | Toma de la entrada                                                            |
| :------------------ | :---------------------------------------------------------------------------- |
| `x`                 | un carácter                                                                   |
| `w`                 | una palabra (letras hasta un espacio) y **se traga un** espacio               |
| `*`                 | todo lo que aún no se ha consumido                                            |
| `x[0]` `w[-1]`      | una posición **nombrada** — ver [Mover piezas](#mover-piezas--x0-w0-y-rangos) |
| `\`                 | escapa el siguiente carácter (`\x` → una `x` literal)                         |
| cualquier otra cosa | un literal: guion, punto, espacio, paréntesis — se imprime tal cual           |

Los mismos dígitos bajo dos patrones:

```xml
<sequence name="Ssn">
  <gen type="text" value="378984323,889735724,852139753,263243158" order="sequential"/>
</sequence>
...
<data>${{Ssn}}  ->  ${{Ssn | mask:xxx-xx-xxxx}}   |   ${{Ssn | mask:xxx.xx.xxxx}}</data>
```

`./run demo.tdc`

```
378984323  ->  378-98-4323   |   378.98.4323
889735724  ->  889-73-5724   |   889.73.5724
852139753  ->  852-13-9753   |   852.13.9753
263243158  ->  263-24-3158   |   263.24.3158
```

A la izquierda está el valor crudo; luego el mismo SSN bajo dos máscaras. Cambie los
separadores del patrón y obtiene otra apariencia — con los **mismos datos**.

### La ranura `w` — trabajar por palabras

**Problema.** A partir de `first last` hay que armar un acomodo propio. La ranura `w`
toma una palabra y se traga un espacio después de ella:

```xml
<sequence name="Name"><gen type="text" value="juan lópez,rosa pérez,luis gómez" order="sequential"/></sequence>
...
<data>${{Name}}  ->  ${{Name | mask:w:w}}</data>
```

`./run demo.tdc`

```
juan lópez  ->  juan:lópez
rosa pérez  ->  rosa:pérez
luis gómez  ->  luis:gómez
```

`w` agarró `juan`, se comió el espacio, imprimió el literal `:`, y la segunda `w` agarró
`lópez`. No hay espacio antes del `:` — la primera `w` se lo tragó. El detalle completo
de los casos límite vive en [`<mask>`](../compute/strings.md#reestructuración).

## Mover piezas — `x[0]`, `w[0]` y rangos

**Problema.** El valor llega **entero** y en el orden equivocado. Un nombre sale de un
pack como `juan lópez`, y la exportación quiere primero el apellido. Una dirección es
`12 Baker St`, y el país para el que genera escribe el número al final. Las partes
nunca fueron suyas para ordenarlas: la cadena salió de una columna de un archivo, de
una dirección de pack o de un regex, así que no puede simplemente generar dos
secuencias e imprimirlas al revés.

**Herramienta.** Ponga un índice entre corchetes en la ranura. Nombra una posición de
la entrada **original**:

| Ranura    | Toma                                                          |
| :-------- | :------------------------------------------------------------ |
| `x[7]`    | el carácter en el índice 7 — el octavo, contando desde `x[0]` |
| `x[5..7]` | los caracteres 5, 6 y 7 — **ambos** extremos incluidos        |
| `x[-1]`   | el último carácter                                            |
| `w[1]`    | la palabra en el índice 1 — la segunda                        |
| `w[-1]`   | la última palabra                                             |

Los índices empiezan en **0**, como en el filtro
[`slice`](#slice--cortar-una-parte-por-índice). Los rangos se escriben con `..`, igual
que en todo TDC (`value="10..99"`, `repeat="1..5"`); un guion sería ambiguo junto a
`x[-1]`.

Eso es todo lo que se agrega. Dos ejemplos, y cada uno es un problema real:

```xml
<data>${{Name}}  ->  ${{Name | mask:w[-1], w[0]}}</data>
<data>${{Addr}}  ->  ${{Addr | mask:w[1..-1] w[0]}}</data>
```

`./run demo.tdc`

```
james miller   ->  miller, james
mary jones     ->  jones, mary
anna lee       ->  lee, anna

12 Baker St -> Baker St 12
7 Elm Road -> Elm Road 7
140 Oak Lane -> Oak Lane 140
```

Ninguno depende de lo largas que sean las palabras — para eso se cuenta por palabras y
no por caracteres. `w[-1]` es la última palabra tenga el nombre dos partes o cuatro, y
`w[1..-1]` es "todo menos la primera".

### Qué ocurre en realidad: el pool

Una máscara con índices corre en dos canales que no se interfieren.

![](../../img/guides/mask-move.svg)

*ABCDE bajo la máscara x[4]-xxxx. La ranura con índice tira de un carácter hacia el frente; las ranuras sin índice toman después lo que queda, en su orden original.*

- **A** — el valor original, con cada posición numerada
- **B** — lo que produjo la máscara
- **drawn** — la posición que nombró un índice, y dónde aterrizó
- **made** — lo que tomaron las ranuras sin índice, en el orden en que estaban

El primer canal es **qué se imprime**: un índice lee esa posición del original, y nada
lo cambia. El segundo es **con qué se quedan las ranuras sin índice `x` / `w` / `*`**, y
es lo único que el consumo toca. Una posición que un índice tomó sale del pool:

![](../../img/guides/mask-pool.svg)

*La misma corrida vista como pool: antes de la toma con índice y después de ella.*

- **A** — el valor original, antes de la toma con índice
- **B** — el pool del que tiran las ranuras sin índice — la posición que tomó un índice ya no está
- **drawn** — la posición que nombró x[4]

Por eso conviene releer qué es `*`: significa **todo lo que aún no se consumió**, no "la
cola de la cadena". Mueva dos dígitos al frente y `*` sigue imprimiendo los otros nueve:

```xml
<data>${{Phone}}  ->  ${{Phone | mask:x[9]x[10] xxx-xxx-xxx}}</data>
```

`./run demo.tdc`

```
26324315851  ->  51 263-243-158
19875550142  ->  42 198-755-501
44207946001  ->  01 442-079-460
```

### El mismo índice dos veces — una copia en vez de un movimiento

Nada impide que dos ranuras nombren una misma posición. Cuando lo hacen, esa parte se
**imprime dos veces** — y sale solo un código de almacén cuya cabeza se repite al final:

![](../../img/guides/mask-copy.svg)

*AB1234 bajo x[0..1]-*-x[0..1]. De las mismas dos celdas salen dos flechas: la cabeza se imprime al frente y otra vez al final.*

- **A** — el código original, con cada posición numerada
- **B** — el resultado — diez caracteres a partir de seis
- **drawn** — los dos caracteres nombrados dos veces, impresos en ambos extremos
- **made** — el resto, tomado por * en su orden original

```xml
<data>${{Sku}}  ->  ${{Sku | mask:x[0..1]-*-x[0..1]}}</data>
```

`./run demo.tdc`

```
AB1234  ->  AB-1234-AB
CD5678  ->  CD-5678-CD
EF9012  ->  EF-9012-EF
```

De ahí sale lo único que la notación no puede decir por sí sola: **`x[2]` no dice si es
un movimiento o una copia.** Copia si alguna otra ranura recoge también esa posición, y
se lee como movimiento si ninguna lo hace. Se descubre leyendo la máscara entera, no la
ranura.

> [!NOTE]
> **Un rango descendente corre hacia atrás**
>
> `x[-1..0]` es "del último carácter al primero" — una inversión a la que no le importa
> cuán largo sea el valor. `AB1234` se vuelve `4321BA`. Sirve para fabricar datos de
> prueba deliberadamente estropeados; fuera de eso, no es algo que convenga buscar.

### Tres cosas con las que va a tropezar

**Un corchete es índice solo justo después de `x` o `w`.** En cualquier otro lugar es un
literal corriente, así que `mask="[tel.] xxx-xxx"` no necesita escape alguno. Si de
verdad quiere un corchete literal justo después de una ranura, escápelo:
`mask="x[1]\[*\]"` sobre `ABC` da `B[AC]`.

**Un índice más allá del final no imprime nada, y no avisa.** `w[4]` sobre un valor de
dos palabras es una cadena vacía, igual que una `x` pasada del final de un valor corto.
El largo de la entrada no se conoce hasta generar la fila, así que no hay nada que
comprobar de antemano — y detener una corrida de un millón de filas por un valor corto
sería peor. Vigile las celdas vacías cuando use un índice fijo sobre datos de forma
variable; `w[-1]` suele ser la manera más segura de decir "la última".

**Un guion en un rango se rechaza, no se adivina.** `x[1-2]` es el error de tipeo fácil,
y si se tratara como texto literal produciría datos equivocados en silencio. En su lugar
es [`TDC199`](../reference/errors.md#top), informado antes de generar una sola fila:

`./run demo.tdc`

```
error[TDC199]: mask: invalid index "[1-2]" after "x" — use x[0], x[0..4] or x[-1]
```

## Case — upper / lower / capitalize / title

**Problema.** Los datos llegan con mayúsculas y minúsculas mezcladas (fuentes distintas,
importaciones): `iPhone CASE`, `maría LÓPEZ`. Se necesita una sola forma consistente.

| Nombre       | Qué hace                                                          |
| :----------- | :---------------------------------------------------------------- |
| `upper`      | TODO EN MAYÚSCULAS                                                |
| `lower`      | todo en minúsculas                                                |
| `capitalize` | **solo la primera** letra en mayúscula, el resto igual            |
| `title`      | la primera letra de **cada palabra** en mayúscula, el resto igual |

La misma cadena a través de los cuatro:

```xml
<sequence name="W"><gen type="text" value="iPhone CASE,maría LÓPEZ,ANNA von lee" order="sequential"/></sequence>
...
<data>${{W}}  ->  upper=${{W | upper}} | lower=${{W | lower}} | capitalize=${{W | capitalize}} | title=${{W | title}}</data>
```

`./run demo.tdc`

```
iPhone CASE   ->  upper=IPHONE CASE | lower=iphone case | capitalize=IPhone CASE | title=IPhone CASE
maría LÓPEZ   ->  upper=MARÍA LÓPEZ | lower=maría lópez | capitalize=María LÓPEZ | title=María LÓPEZ
ANNA von lee  ->  upper=ANNA VON LEE | lower=anna von lee | capitalize=ANNA von lee | title=ANNA Von Lee
```

`capitalize` toca únicamente el primerísimo carácter (`iPhone CASE` queda casi igual — su
`i` inicial se vuelve `I`), mientras que `title` levanta la primera letra de **cada**
palabra (`von` → `Von`, `lee` → `Lee`). `upper`/`lower` cambian todo.

### Distinto case según una condición, sobre los mismos datos

Como el formato ocurre en la salida, se puede aplicar un case **distinto** por fila desde
un solo generador — digamos los apellidos masculinos capitalizados y los femeninos en
mayúsculas:

```xml
<line if="Gender == M"><data>${{Gender}} ${{Word}}  ->  ${{Word | capitalize}}</data></line>
<line if="Gender == F"><data>${{Gender}} ${{Word}}  ->  ${{Word | upper}}</data></line>
```

`./run demo.tdc`

```
F garcía  ->  GARCÍA
M garcía  ->  García
F ruiz  ->  RUIZ
F moreno  ->  MORENO
M lópez  ->  López
M ruiz  ->  Ruiz
```

Un solo generador `Word`, pero su apariencia depende de `Gender`. Esto no se puede hacer
dentro del generador mismo — el formato en la salida lo resuelve en una sola línea.

## Como atributo de `<gen>` — formatear la columna entera

**Problema.** Uno no quiere envolver cada sustitución — quiere que la columna **entera**
salga ya formateada.

**Herramienta.** Ponga `mask="…"` / `case="…"` directamente en el
[`<gen>`](../generators/overview.md#top). A la izquierda, el mismo generador sin el atributo
(crudo); a la derecha, el mismo con `mask=`:

```xml
<sequence name="Raw"><gen type="text" value="378984323,889735724,852139753,263243158" order="sequential"/></sequence>
<sequence name="Nice"><gen type="text" value="378984323,889735724,852139753,263243158" order="sequential" mask="xxx-xx-xxxx"/></sequence>
...
<data>${{Raw}}  ->  ${{Nice}}</data>
```

`./run demo.tdc`

```
378984323  ->  378-98-4323
889735724  ->  889-73-5724
852139753  ->  852-13-9753
263243158  ->  263-24-3158
```

Así es exactamente como se le da a un generador de plantilla su apariencia «bonita»:

```xml
<gen type="template" value="usa.docs.ssn" mask="xxx-xx-xxxx"/>
<gen type="template" value="common.payment.card.pan" mask="xxxx xxxx xxxx xxxx"/>
```

Ambas rutas vienen del generador
[`template`](../generators/template.md#identificadores-técnicos). Si se definen los dos
atributos, el orden es **primero mask, luego case**.

## Cadenas de filtros — varias operaciones seguidas

**Problema.** Se necesita más de una transformación — por ejemplo, reacomodar con una
máscara **y** subir el case.

**Herramienta.** Encadene filtros uno tras otro con `|`, de izquierda a derecha: crudo →
mask → case:

```xml
<sequence name="Name"><gen type="text" value="juan lópez,rosa pérez,luis gómez" order="sequential"/></sequence>
...
<data>${{Name}}  ->  ${{Name | mask:w:w}}  ->  ${{Name | mask:w:w | upper}}</data>
```

`./run demo.tdc`

```
juan lópez  ->  juan:lópez  ->  JUAN:LÓPEZ
rosa pérez  ->  rosa:pérez  ->  ROSA:PÉREZ
luis gómez  ->  luis:gómez  ->  LUIS:GÓMEZ
```

La columna del medio es después de la máscara; la de la derecha es después de la máscara
**y** de `upper`. Cada filtro recibe el resultado anterior.

> [!NOTE]
> El argumento de una máscara se lee hasta el siguiente `|` o hasta el `}}` de cierre, así
> que los espacios y los dos puntos viven felices dentro de él (`mask:w:w`,
> `mask:xxx-xx-xxxx`).

## Más filtros: slice, replace, trim, group

Las mismas tres rutas (filtro / atributo de `<gen>` / etiqueta de
[`<compute>`](../compute/strings.md#top)). Cada uno de abajo sigue el camino crudo →
herramienta → resultado, con una variación.

### `slice` — cortar una parte por índice

**Problema.** De la fecha `2020-05-14` solo se necesita el año, o solo el mes.

```xml
<sequence name="D"><gen type="text" value="2020-05-14,2022-11-03,2021-07-19" order="sequential"/></sequence>
...
<data>${{D}}  ->  year=${{D | slice:0,4}} | month=${{D | slice:5,7}} | tail=${{D | slice:5}}</data>
```

`./run demo.tdc`

```
2020-05-14  ->  year=2020 | month=05 | tail=05-14
2022-11-03  ->  year=2022 | month=11 | tail=11-03
2021-07-19  ->  year=2021 | month=07 | tail=07-19
```

`slice:0,4` son los caracteres 0–3 (el año), `slice:5,7` son 5–6 (el mes), y `slice:5` sin
segundo número significa «del 5 hasta el final». Son índices de caracteres, empezando en
cero. Vea [`<slice>`](../compute/strings.md#reestructuración).

### `replace` — reemplazar todas las apariciones

**Problema.** La fecha trae guiones, pero se necesita otro separador.

```xml
<data>${{D}}  ->  slash=${{D | replace:-,/}} | dot=${{D | replace:-,.}}</data>
```

`./run demo.tdc`

```
2020-05-14  ->  slash=2020/05/14 | dot=2020.05.14
2022-11-03  ->  slash=2022/11/03 | dot=2022.11.03
2021-07-19  ->  slash=2021/07/19 | dot=2021.07.19
```

El formato es `replace:from,to` — se reemplazan **todas** las apariciones. Hay tres cosas
que no hace, y cada una falla en silencio en vez de avisar:

- **`from` se busca literalmente, nunca como expresión regular.** `replace:[abc],Z` busca
  los cinco caracteres `[abc]` y, al no encontrarlos, no cambia nada.
- **`from` no puede contener una coma.** La primera coma lo termina, así que todo lo que
  sigue pertenece a `to`: `replace:-,+,x` reemplaza cada `-` por `+,x`.
- **Un `from` vacío no hace nada.** `replace:,+` devuelve el valor intacto.

Donde algo de esto importe, use la etiqueta
[`<replace>`](../compute/strings.md#reestructuración) dentro de `<compute>`: toma `from=`
y `to=` como atributos separados, así que una coma es solo un carácter.

### `trim` — quitar los espacios de los extremos

**Problema.** Los datos que vienen de un archivo o de un CSV a veces cargan espacios
sueltos en los bordes. Aquí los espacios se agregan a propósito (como si vinieran de una
fuente), y los corchetes del texto solo sirven para hacerlos visibles:

```xml
<sequence name="City"><gen type="text" value="Toluca,Mérida,Colima" order="sequential"/></sequence>
<!-- pega espacios extra en los bordes, imitando datos "sucios" -->
<sequence name="Padded">
  <compute><result><concat><str v="  "/><field name="City"/><str v="   "/></concat></result></compute>
</sequence>
...
<data>[${{Padded}}]  ->  [${{Padded | trim}}]</data>
```

`./run demo.tdc`

```
[  Toluca   ]  ->  [Toluca]
[  Mérida   ]  ->  [Mérida]
[  Colima   ]  ->  [Colima]
```

Solo los extremos — los espacios internos se dejan en paz. Vea
[`<trim>`](../compute/strings.md#reestructuración).

### `group` — agrupar dígitos desde la derecha

**Problema.** Un número largo es ilegible: `1234567`.

```xml
<sequence name="N"><gen type="text" value="1234567,89150000,42" order="sequential"/></sequence>
...
<data>${{N}}  ->  group:3=${{N | group:3}} | group:3,-=${{N | group:3,-}} | group:4=${{N | group:4}}</data>
```

`./run demo.tdc`

```
1234567   ->  group:3=1 234 567 | group:3,-=1-234-567 | group:4=123 4567
89150000  ->  group:3=89 150 000 | group:3,-=89-150-000 | group:4=8915 0000
42        ->  group:3=42 | group:3,-=42 | group:4=42
```

La agrupación corre desde la **derecha**, así que el grupo corto termina a la izquierda
(`1 234 567`). `group:3` da miles (el separador por omisión es un espacio), `group:3,-`
define un separador propio, y `group:4` se lee como bloques de tarjeta. Un `42` corto es
más chico que un grupo, así que vuelve sin cambios. Vea
[`<group>`](../compute/strings.md#reestructuración).

### Resumen

| Operación | Filtro                   | Etiqueta de `<compute>`                                                |
| :-------- | :----------------------- | :--------------------------------------------------------------------- |
| `slice`   | `slice:from[,to]`        | [`<slice from="0" to="4">`](../compute/strings.md#reestructuración)   |
| `replace` | `replace:from,to`        | [`<replace from="-" to="/">`](../compute/strings.md#reestructuración) |
| `trim`    | `trim`                   | [`<trim>`](../compute/strings.md#reestructuración)                    |
| `group`   | `group:size[,sep]`       | [`<group size="3" sep=" ">`](../compute/strings.md#reestructuración)  |
| `compact` | `compact` o `compact:16` | —                                                                      |
| `csv`     | `csv`                    | — (sin etiqueta)                                                       |
| `sql`     | `sql`                    | — (sin etiqueta)                                                       |

## Orden — `order="sequential"`

**Problema.** Por omisión, [`text`](../generators/text.md#top) y
[`file`](../generators/file.md#top) eligen valores **al azar**. A veces los datos tienen un
orden pensado (una lista en un archivo, una serie especial) y hay que conservarlo.

**Herramienta.** `order="sequential"`: la fila `i` toma el `i`-ésimo valor en orden,
**dando la vuelta**. A la izquierda está el generador común (aleatorio); a la derecha, la
misma lista `Ene,Feb,Mar` en orden:

```xml
<sequence name="Rand"><gen type="text" value="Ene,Feb,Mar"/></sequence>
<sequence name="Seq"><gen type="text" value="Ene,Feb,Mar" order="sequential"/></sequence>
...
<data>random=${{Rand}}   sequential=${{Seq}}</data>
```

`./run demo.tdc`

```
random=Feb   sequential=Ene
random=Feb   sequential=Feb
random=Mar   sequential=Mar
random=Ene   sequential=Ene
random=Ene   sequential=Feb
random=Feb   sequential=Mar
random=Mar   sequential=Ene
```

La columna de la derecha corre estrictamente `Ene, Feb, Mar, Ene, Feb, Mar, Ene…` — vuelta
tras vuelta.

- `order="random"` — el valor por omisión.
- `order="sequential"` — estrictamente en orden, dando la vuelta.
- `cycle="false"` — falla con un error claro cuando los datos se acaban, en vez de dar la
  vuelta.
- Funciona igual con archivos: `<gen type="file" src="@data/cities.txt" order="sequential"/>`
  emite las líneas del archivo estrictamente en su orden.

## `compact` — un número largo, escrito corto

Convierte un entero a base 36 (dígitos + letras minúsculas). Útil donde un número es una
**cola única** que además una persona tiene que leer:

```xml
<data>${{F|lower}}.${{L|lower}}.${{Id|compact}}@example.com</data>
```

`./run demo.tdc`

```
carlos.rivera.1@example.com          <- primera fila
ana.molina.lfls@example.com          <- la millonésima
pablo.serrano.x2qxvk@example.com     <- la dos mil millonésima
```

|            Número |    Decimal |                 `compact` |
| ----------------: | ---------: | ------------------------: |
|         1 000 000 |  7 dígitos |     `lfls` — 4 caracteres |
|     2 000 000 000 | 10 dígitos |   `x2qxvk` — 6 caracteres |
| 1 000 000 000 000 | 13 dígitos | `cre66i9s` — 8 caracteres |

Seis caracteres cubren 2170 millones de filas; siete cubren 78 mil millones. El mapeo es
uno a uno, así que números distintos siempre dan cadenas distintas — la unicidad por la
que agregó el número se conserva por completo.

> [!NOTE]
> **Solo minúsculas, a propósito.** La base 62 (con mayúsculas) sería aún más corta, pero
> muchos sistemas pasan el correo a minúsculas — entonces `aB` y `Ab` colapsarían en una
> sola dirección y los duplicados volverían en silencio.

Defina la base con `compact:16` (hexadecimal). Un valor que no sea entero se deja intacto.

## Escape para un formato: `csv` y `sql`

`<data>` construye **texto** y no sabe nada del archivo que se está escribiendo, así que
un valor con una coma parte en silencio una fila de CSV, y un apóstrofo rompe el SQL. Esto
no es teoría: un solo nombre de producto como `Juego de cuchillos, 3 pzas` puede convertir miles de
filas en registros con un campo de más — la categoría se desliza al precio, el precio a la
cantidad, y no se levanta ni un solo error. Dos filtros cierran ambos casos.

### `csv` — un campo según el RFC 4180

```xml
<data>${{Id}},${{Name | csv}},${{Category}}</data>
```

`./run demo.tdc`

```
7,"Juego de cuchillos, 3 pzas",Cocina
2,"Café ""Arábica"" 250 g",Alimentación
```

Las comillas se agregan **siempre**, no «cuando hacen falta» — una regla sin excepciones
le gana a una adivinanza que tarde o temprano se topa con una coma o un salto de línea, y
cualquier lector de CSV acepta las comillas de más. Vea también
[Formatos de salida → CSV](../guides/output-formats.md#csv).

Lo que el filtro deliberadamente **no** hace: los valores que empiezan con `=`, `+`, `-`
o `@` se convierten en fórmulas vivas al abrir el archivo en una hoja de cálculo. Los
datos generados conservan sus bytes tal cual — si el archivo va a Excel y eso importa,
agrégueles un prefijo usted mismo con el filtro `replace`.

### `sql` — el cuerpo de un literal de cadena

```xml
<data>INSERT INTO t VALUES ('${{Last | sql}}');</data>
```

`./run demo.tdc`

```
INSERT INTO t VALUES ('O''Brien');
```

El filtro duplica el apóstrofo y devuelve **solo el contenido**, sin comillas externas —
esas las escribe usted, así que la forma de la consulta sigue siendo visible en la
configuración. Para [JSON](../guides/output-formats.md#json) no hay un filtro aparte:
escape la comilla con una barra invertida usando el mismo filtro `replace`.

Este es el entrecomillado del **SQL estándar** (PostgreSQL, SQLite, Oracle, ANSI). MySQL
en su modo por defecto también trata `\` como carácter de escape — habilite allí
`NO_BACKSLASH_ESCAPES`, o duplique antes las barras invertidas con `replace`.

## Vea también

- **[Cadenas y formato](../compute/strings.md#top)** — las mismas operaciones como etiquetas de compute.
- **[Salida y formato](../core-concepts/output-formatting.md#top)** — dónde viven la interpolación y los filtros.
- **[Formatos de salida](../guides/output-formats.md#top)** — CSV, JSON y SQL de principio a fin.

---

← Anterior: [Formatos de salida (CSV, JSON, SQL…)](./output-formats.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Distribuciones estadísticas](./statistical-distributions.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/guides/masks-and-case)**
