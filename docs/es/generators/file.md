<a name="top"></a>

[English](../../generators/file.md#top) · [Русский](../../ru/generators/file.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/generators/file)**

← Anterior: [template](./template.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Date](./date.md#top) →

---

# El generador `file`

**Se usa cuando** los valores ya viven en un archivo — una lista de ciudades, una
exportación, un CSV — y no se quiere pegarlos dentro de la configuración. El atributo
[`src`](../reference/attributes.md#top) le dice al generador dónde leerlos, y un atributo
más, [`column`](../reference/attributes.md#top), decide si ese archivo es una lista simple
o una tabla.

Las salidas de ejemplo de abajo son ilustrativas — los valores exactos son aleatorios y
pueden cambiar según la versión del core; lo que importa es la forma y las cantidades.

![](../../img/concepts/csv-row-link.svg)

*Un mismo CSV leído dos veces, seis filas cada vez.*

- **A** — el archivo fuente: cuatro líneas, tres columnas
- **B** — sin row= cada campo elige su propia línea, así que el registro se arma con pedazos que nunca estuvieron juntos (las celdas grises)
- **C** — con row= los tres campos leen una misma línea, así que cada registro es una línea real del archivo

## De un vistazo

| Atributo                                   | Obligatorio | Qué hace                                                                        |
| :----------------------------------------- | :---------- | :------------------------------------------------------------------------------ |
| [`src`](../reference/attributes.md#top)       | sí          | Dónde está el archivo — ruta relativa, `@data` o absoluta                       |
| [`column`](../reference/attributes.md#top)    | no          | Lee una columna del CSV, por nombre o por número desde 1 (activa CSV)           |
| [`delimiter`](../reference/attributes.md#top) | no          | Separador de celdas en modo CSV — coma por omisión                              |
| [`header`](../reference/attributes.md#top)    | no          | Omite la primera línea cuando la columna se elige **por número**                |
| [`row`](../reference/attributes.md#top)       | no          | Liga varios campos a la **misma** línea del CSV (mantiene el registro completo) |

## `src` — dónde está el archivo

`src` es **obligatorio**. Puede ser una ruta simple o una fuente del resolvedor:

| `src`                              | Se resuelve como                                   |
| :--------------------------------- | :------------------------------------------------- |
| `src="names.txt"`                  | Junto al archivo de configuración `.tdc`           |
| `src="@data/names.txt"`            | Se busca en las carpetas pasadas con `--data-path` |
| `src="/absolute/path/names.txt"`   | Una ruta absoluta                                  |

El archivo se lee como UTF-8. Si la ruta no se puede resolver, la generación se detiene
con un error en vez de producir nada en silencio.

## Dos modos — lista o CSV

El mismo `src` lee un archivo en uno de dos modos, y el modo no lo elige `src` sino la
presencia de [`column`](../reference/attributes.md#top):

- **sin `column`** — el archivo es una lista simple: cada línea no vacía es un valor;
- **con `column`** — el archivo es un CSV y los valores vienen de la columna indicada.

### Modo lista — una línea, un valor

**Problema.** Se necesita un conjunto de ciudades, pero escribir a mano una lista larga
dentro de `value="…"` es incómodo de editar e imposible de reutilizar.

**Herramienta.** Ponga un valor por línea en un archivo — `data/cities.txt`:

```text
Guadalajara
Monterrey
Puebla
Mérida
Tijuana
```

```xml
<sequence name="City">
  <gen type="file" src="@data/cities.txt"/>
</sequence>
...
<data>${{City}}</data>
```

Pase la carpeta de datos al ejecutar, con `--data-path`:

```bash
./run example.tdc --data-path ./data
```

**Resultado.** Las líneas se eligen de forma uniforme al azar (con repeticiones —
`Tijuana` salió dos veces):

`./run example.tdc --data-path ./data`

```
Puebla
Mérida
Tijuana
Tijuana
Monterrey
```

Las líneas vacías se omiten en modo lista. Una CELDA vacía en modo columna es otra cosa y se rechaza: omitirla sacaría la fila entera del conjunto, así que las proporciones del propio archivo dejarían de ser las de la corrida. Rellénela, quite la fila o apunte `column=` a una columna completa. Para respetar el orden estricto del archivo
en lugar de elegir al azar, agregue `order="sequential"` — emite las líneas exactamente
en el orden en que aparecen en el archivo (vea [`order=` / `cycle=`](overview.md#top)).

> [!WARNING]
> **Al pasar del final del archivo, vuelve a empezar**
>
> `order="sequential"` recorre el archivo y **vuelve a la primera línea**, así que un
> `count` mayor que el archivo repite filas — en silencio, sin aviso. Para una lista de
> días de la semana eso es lo deseado; para un archivo de registros reales son duplicados
> en la salida que nada señala.
>
> Ponga `cycle="false"` cuando quedarse sin líneas deba detener la ejecución en lugar de
> repetirla. Nombra la fila que se quedó sin valor y no escribe nada.

### Modo CSV — un valor de una columna

**Problema.** El archivo no es una sola columna sino una tabla, y solo se quiere un
campo — digamos únicamente los correos. Sea `data/users.csv`:

```text
first_name,last_name,email,city
Juan,García,juan.garcia@example.com,Guadalajara
María,Rodríguez,maria.rodriguez@example.com,Monterrey
Carlos,Fernández,carlos.fernandez@example.com,Puebla
Lucía,Martínez,lucia.martinez@example.com,Mérida
```

**Herramienta.** El mismo `src`, más [`column`](../reference/attributes.md#top) — su sola
presencia cambia el generador a modo CSV:

```xml
<sequence name="Email">
  <gen type="file" src="@data/users.csv" column="email"/>
</sequence>
...
<data>${{Email}}</data>
```

**Resultado.** La primera línea se toma como encabezado y nunca aparece en la salida;
los valores vienen solo de la columna `email`:

`./run example.tdc --data-path ./data`

```
carlos.fernandez@example.com
lucia.martinez@example.com
juan.garcia@example.com
lucia.martinez@example.com
maria.rodriguez@example.com
```

## `column` — por nombre o por número

La presencia de `column` es lo que convierte al archivo de una lista de un valor por
línea en un CSV. Sin ella, el generador tomaría la línea completa
(`Juan,García,juan.garcia@example.com,Guadalajara`) como un solo valor. La columna se
puede direccionar de dos maneras.

### Por nombre

Use un nombre de la línea de encabezado. La fila de encabezado se descarta
automáticamente y los valores empiezan desde la segunda línea:

```xml
<gen type="file" src="@data/users.csv" column="email"/>
```

`./run example.tdc --data-path ./data`

```
carlos.fernandez@example.com
lucia.martinez@example.com
juan.garcia@example.com
lucia.martinez@example.com
maria.rodriguez@example.com
```

### Por número (empezando en 1)

Dé un índice que empieza en 1 en lugar de un nombre. `column="2"` es la **segunda**
columna (`last_name`) — la numeración arranca en uno, así que la primera columna es
`column="1"`, nunca `column="0"`. Al direccionar por número, TDC no tiene nombres de
columna que reconocer, así que agregue [`header="true"`](../reference/attributes.md#top)
para omitir la línea de encabezado:

```xml
<gen type="file" src="@data/users.csv" column="2" header="true"/>
```

`./run example.tdc --data-path ./data`

```
Martínez
Martínez
Martínez
Rodríguez
Rodríguez
```

El mismo archivo con `column="3"` lee la tercera columna, `email` — los mismos datos que
`column="email"`, solo que direccionados por posición. Necesita `header="true"` por la
misma razón que `column="2"`: cuando una columna se direcciona por número, TDC no tiene
encabezado que reconocer, y sin eso la palabra `email` misma se sortea como un valor.

```xml
<gen type="file" src="@data/users.csv" column="3" header="true"/>
```

`./run example.tdc (column=&quot;3&quot; header=&quot;true&quot;)`

```
carlos.fernandez@example.com
lucia.martinez@example.com
juan.garcia@example.com
lucia.martinez@example.com
maria.rodriguez@example.com
```

### Casos límite

- `column="0"` **no** es un índice válido (la numeración empieza en 1) — se lee como el
  nombre literal `0`, que no está en el encabezado, así que se obtiene
  `error[TDC062]: file generator: CSV column "0" was not found in the header row`.
- Un número más allá de la última columna (`column="9"` en un archivo de cuatro
  columnas) falla con `error[TDC062]: file generator: CSV column "9" is past the last column — the file has 4`.
- Si el separador del archivo no es una coma, configure
  [`delimiter`](../reference/attributes.md#top) — de lo contrario toda la línea cae en una
  sola celda y no se encuentra ninguna columna.

## `delimiter` — cómo se separan las celdas

**Problema.** No toda tabla está separada por comas. Las exportaciones de hojas de
cálculo suelen usar punto y coma o tabulador. Si no se le dice nada a TDC, corta por
comas, no encuentra celdas y trata toda la línea como un único campo — la columna nunca
aparece.

`delimiter` acepta un solo carácter (`delimiter=";"`) o alguno de estos alias con
nombre:

| Valor       | Separador                       |
| :---------- | :------------------------------ |
| `comma`     | coma `,` (el valor por omisión) |
| `semicolon` | punto y coma `;`                |
| `pipe`      | barra vertical                  |
| `tab`       | tabulador (archivos TSV)        |
| `\t`        | tabulador (igual que `tab`)     |

Para un archivo TSV (columnas separadas por tabulador), `delimiter="tab"` y
`delimiter="\t"` son equivalentes — ambos leen el tabulador como separador.

### Punto y coma — el caso más común

Tome los mismos usuarios, pero separados por punto y coma —
`data/users_semicolon.csv`:

```text
first_name;last_name;email;city
Juan;García;juan.garcia@example.com;Guadalajara
María;Rodríguez;maria.rodriguez@example.com;Monterrey
Carlos;Fernández;carlos.fernandez@example.com;Puebla
Lucía;Martínez;lucia.martinez@example.com;Mérida
```

**Sin `delimiter`** (se asume la coma) toda la línea es una sola celda, así que la
columna `email` no se encuentra:

```xml
<gen type="file" src="@data/users_semicolon.csv" column="email"/>
```

`./run example.tdc --data-path ./data`

```
error[TDC062]: file generator: CSV column "email" was not found in the header row
note: For CSV files, use a header name like column="email" or a 1-based index like column="2".
```

**Con `delimiter="semicolon"`** (o `delimiter=";"`) las celdas se separan
correctamente:

```xml
<gen type="file" src="@data/users_semicolon.csv" column="email" delimiter="semicolon"/>
```

`./run example.tdc --data-path ./data`

```
carlos.fernandez@example.com
lucia.martinez@example.com
juan.garcia@example.com
lucia.martinez@example.com
```

### Barra vertical

Un archivo cuyas columnas se separan con `|` se lee con `delimiter="pipe"`:

```xml
<gen type="file" src="@data/users_pipe.csv" column="email" delimiter="pipe"/>
```

`./run example.tdc --data-path ./data`

```
carlos.fernandez@example.com
lucia.martinez@example.com
juan.garcia@example.com
```

### Tabulador (TSV)

Un archivo separado por tabuladores se lee con `delimiter="tab"` (o `delimiter="\t"`):

```xml
<gen type="file" src="@data/users.tsv" column="email" delimiter="tab"/>
```

`./run example.tdc --data-path ./data`

```
carlos.fernandez@example.com
lucia.martinez@example.com
juan.garcia@example.com
```

## `header` — omitir la fila de encabezado con una columna numérica

**Problema.** En un CSV la primera línea suele ser un encabezado
(`first_name,last_name,…`). Cuando se elige una columna **por nombre**, TDC sabe que la
primera línea es el encabezado y la descarta. Pero cuando se elige **por número**, no
hay nombres de columna que reconocer — TDC no puede distinguir el encabezado de los
datos, así que por omisión conserva todo, incluida la línea de encabezado, y basura como
`first_name` se cuela en la salida.

`header` es `true` o `false` (por omisión `false`). Solo afecta a un `column`
**numérico**.

**Sin `header`** — la celda de encabezado `first_name` se trata como un valor común y
aparece en la salida:

```xml
<gen type="file" src="@data/users.csv" column="1"/>
```

`./run example.tdc --data-path ./data`

```
first_name
Lucía
María
Lucía
Juan
```

**Con `header="true"`** — la primera línea se descarta y quedan solo valores reales:

```xml
<gen type="file" src="@data/users.csv" column="1" header="true"/>
```

`./run example.tdc --data-path ./data`

```
Juan
Lucía
María
Lucía
María
```

### Cuándo no hace falta `header`

Para una columna elegida **por nombre** (`column="email"`), nunca hace falta
`header="true"`: una columna con nombre siempre se busca en la primera línea, y los
datos se leen a partir de la segunda. `header` importa solo para un `column` numérico.

## `row` — mantener un registro unido

**Problema.** Varios campos tienen que venir de la **misma** línea del CSV. Sin `row`,
cada generador `file` elige de forma independiente, así que el registro se desarma — el
nombre de una línea, el apellido de otra, la ciudad de una tercera.

`row` acepta cualquier clave no vacía, por ejemplo `row="user"`. Todo generador
`type="file"` que comparta el mismo `row` — con el mismo `src`, `delimiter` y modo de
encabezado — lee la **misma línea** para cada registro. Se elige una línea por registro,
y distintos valores de `column` leen distintas celdas de esa línea. Una clave sobre dos
archivos distintos la rechaza `check`: un enlace es una línea de UN archivo, así que no hay
línea que pertenezca a ambos.

**Sin `row`** — tres generadores independientes, así que los registros no cuadran (María
con el apellido de Juan, Lucía en la ciudad de otro):

```xml
<sequence name="User">
  <gen name="First" type="file" src="@data/users.csv" column="first_name"/>
  <gen name="Last"  type="file" src="@data/users.csv" column="last_name"/>
  <gen name="City"  type="file" src="@data/users.csv" column="city"/>
</sequence>
...
<data>${{User.First}} ${{User.Last}} — ${{User.City}}</data>
```

`./run example.tdc --data-path ./data`

```
María García — Mérida
Lucía Fernández — Monterrey
Carlos Rodríguez — Puebla
Carlos Fernández — Monterrey
Carlos Rodríguez — Mérida
```

**Con `row="user"`** — los tres campos vienen de una misma línea, así que cada registro
es coherente:

```xml
<sequence name="User">
  <gen name="First" type="file" src="@data/users.csv" column="first_name" row="user"/>
  <gen name="Last"  type="file" src="@data/users.csv" column="last_name"  row="user"/>
  <gen name="City"  type="file" src="@data/users.csv" column="city"       row="user"/>
</sequence>
```

`./run example.tdc --data-path ./data`

```
Lucía Martínez — Mérida
María Rodríguez — Monterrey
Carlos Fernández — Puebla
Carlos Fernández — Puebla
Lucía Martínez — Mérida
```

Ahora `first_name`, `last_name` y `city` siempre vienen de una misma línea del CSV — los
campos ya no se pueden separar. Esto funciona en **cualquier** motor (el de omisión es
el de streaming, así que la memoria no crece con la cantidad de filas).

### Filas ponderadas — `row` + `weight`

Por omisión la fila ligada se elige de forma **uniforme**. Agregue
[`weight="column"`](../reference/attributes.md#top) a uno de los campos del grupo y la fila
se sortea por **cuota ponderada** según esa columna (exacta, igual que `percent`),
mientras los demás campos siguen leyendo de la misma línea elegida. Así un artículo
aparece con su frecuencia real de ventas, y su precio y su categoría vienen de su propia
fila — `data/catalog.csv`:

```text
name,category,price,sales
Bolígrafo,Oficina,1.10,500
Café,Bebidas,4.50,1200
Mochila,Bolsos,45.00,80
```

```xml
<sequence name="Item">
  <gen name="Name"  type="file" src="@data/catalog.csv" column="name"     row="i" weight="sales"/>
  <gen name="Price" type="file" src="@data/catalog.csv" column="price"    row="i"/>
  <gen name="Cat"   type="file" src="@data/catalog.csv" column="category" row="i"/>
</sequence>
...
<data>${{Item.Name}} | ${{Item.Cat}} | ${{Item.Price}}</data>
```

`./run example.tdc --data-path ./data`

```
Café | Bebidas | 4.50
Café | Bebidas | 4.50
Bolígrafo | Oficina | 1.10
```

**Nota sobre el motor.** Sin `weight`, un grupo ligado corre en cualquier motor. **Con
`weight`**, la configuración siempre corre en el motor en memoria: un motor de streaming
no puede ponderar la elección de la fila sin conocer primero los totales del archivo. Si
se fuerza `--engine 2`, TDC lo dice sin rodeos en vez de emitir columnas incoherentes en
silencio. El costo es que entonces la memoria crece con `count` — vea [Qué motor corre su
configuración](../guides/large-outputs.md#qué-motor-corre-su-configuración). Los grupos
ligados en sí se cubren en **[Datos coherentes y
relacionales](../guides/coherent-data.md#top)**.

### Limitaciones (v1)

- `row` funciona solo dentro de un `<sequence>`. El bloque de salida no tiene
  generadores, así que ahí la pregunta ni siquiera surge.
- `row` requiere [`column`](../reference/attributes.md#top) — es una función de CSV, no de
  listas de texto plano.
- La misma clave `row` con fuentes **distintas** no las liga: TDC mantiene un grupo de
  filas aparte para cada combinación de fuente, delimitador y modo de encabezado. No es
  un error, solo algo que conviene tener presente.

## `read="quantile"` — una muestra medida como distribución

Todo lo anterior trata el archivo como una **bolsa de valores**: saca uno y ponlo
en la celda. Eso es exactamente lo correcto cuando los valores son contables — una
ciudad, un estado, un número de pedidos — y `weight=` incluso respeta sus
proporciones fila a fila.

Es equivocado para una **medición**. Un archivo con mil importes reales, leído como
bolsa, da mil importes distintos por muchas filas que pida. Un millón de filas
sigue teniendo mil valores y nada entre ellos: un peine. El dinero real no tiene
esa forma, y un modelo entrenado con esa salida aprende una estructura que los
datos reales nunca tuvieron.

`read="quantile"` lee el mismo archivo al revés: lo ordena una vez y lo trata como
una regla graduada. Una fila cae en cualquier punto de ella y, si cae entre dos
observaciones, toma el valor intermedio.

```text title="amounts.txt"
23.10
25.40
25.40
31.00
40.75
```

```xml
<sequence name="Amount"><gen type="file" src="amounts.txt" read="quantile"/></sequence>
```

Medido sobre una muestra de 951 importes, 100 000 filas:

| | origen | `read="quantile"` | elección normal |
| :-- | --: | --: | --: |
| percentil 10 | 25.25 | 25.13 | 25.12 |
| mediana | 53.30 | 52.98 | 53.64 |
| percentil 99 | 227.66 | 227.39 | 231.52 |
| **valores distintos** | **951** | **15 083** | **951** |

De esta lectura se siguen tres cosas, y cada una es una razón para preferirla en
una magnitud medida:

- **La resolución sigue a la masa, no al rango.** Una cola de seis órdenes de
  magnitud cuesta los mismos puntos que una joroba estrecha: la densidad del propio
  archivo decide dónde está el detalle.
- **Un valor repetido sigue siendo un átomo.** `25.40` dos veces en la muestra de
  arriba es un escalón plano en la regla, así que conserva exactamente su parte de
  la ejecución mientras todo a su alrededor sigue siendo continuo.
- **No se inventa nada fuera de la muestra.** El rango generado es exactamente el
  observado: una muestra no puede responder por valores que nunca vio.

**La precisión la decide su archivo, no una suposición.** Interpolar entre 31 y 40
da 35.4, correcto para dinero y equivocado para un número de pedidos. Por eso la
respuesta se escribe con tantos decimales como usó el origen: una muestra de
números enteros da enteros; una escrita al céntimo, céntimos.
[`decimals`](../reference/attributes.md#top) lo sobrescribe.

> [!NOTE]
> **Lo que la lectura por cuantiles NO promete**
>
>
> Reproduce la **forma**, no la proporción de cada valor concreto. La interpolación
> toma masa de los puntos observados y se la da a los valores intermedios — esa es
> justamente la cura del peine, y no se consigue sin ese intercambio. En una muestra
> de veinte enteros, el valor `46` (uno de veinte, o sea el 5% de la muestra) sale en
> el 0.4% de las filas; el resto se fue a 47, 48 y 49, que la muestra nunca vio pero
> que la magnitud continua a la que representa sí contiene.
>
> Lo que decide es la DISTANCIA al siguiente valor observado, no cuántas veces se
> repite uno. Medido sobre ocho observaciones, cada una presente exactamente una vez
> — cuatro separadas por uno y cuatro lejanas:
>
> ```
> 10 → 12.500%   11 → 12.500%   12 → 12.500%   13 → 6.481%
> 40 → 0%        80 → 0%       160 → 0%       320 → 0%
> ```
>
> A cada una le corresponde el 12.5%. Las tres con vecino a ambos lados lo conservan
> entero; `13` conserva la mitad, porque de un lado hay densidad y del otro un hueco;
> las cuatro lejanas se disuelven en los valores intermedios. Un átomo grande
> sobrevive por la misma razón: un 40% de ceros exactos vuelve como 39.997%, porque
> su meseta es mucho más ancha que las rampas de sus bordes.
>
> De ahí la comprobación que puede hacer sobre su propio archivo sin generar nada:
>
> - **Sin huecos en el paso de la propia muestra** — enteros seguidos, céntimos
>   seguidos — y todas las proporciones salen exactas. Medido sobre los enteros 0…20
>   sin un solo hueco: peor desviación 0.0003 puntos porcentuales en los 21 valores.
> - **Con huecos** — se reproduce la forma, y la proporción de un valor concreto se
>   reparte por el hueco tanto más cuanto más ancho sea.
>
> Y si lo que hace falta es la proporción exacta de cada valor listado, eso es
> [`weight=`](#filas-ponderadas--row--weight) y su cuota exacta. La lectura por cuantiles
> es para cuando la muestra representa algo continuo.
>

### `sample="exact"` — reproducir la muestra sin ruido de muestreo

Por defecto cada fila tira sus propios dados, así que las proporciones oscilan lo
que oscila cualquier muestra. Con `sample="exact"` no se tiran dados en absoluto:
la fila `i` toma su propio punto de la regla y, a lo largo de la ejecución, los
puntos la cubren de forma uniforme.

```xml
<sequence name="Amount">
  <gen type="file" src="amounts.txt" read="quantile" sample="exact"/>
</sequence>
```

El mismo archivo y las mismas 100 000 filas, peor error entre 99 percentiles:

| | peor error |
| :-- | --: |
| sorteado (por defecto) | 0.600% |
| `sample="exact"` | **0.024%** |

y ese 0.024% restante es el redondeo al céntimo, no muestreo.

La columna **no** sale ordenada — los puntos se dispersan con la misma permutación
sembrada que usa [`uniq`](../constructs/unique-values.md#top) — y la ejecución sigue
siendo reproducible, transmisible y paralela: los tres motores producen los mismos
bytes y `--jobs 7` equivale a `--jobs 1`.

### Qué lectura usar

| su columna | archivo | qué escribir |
| :-- | :-- | :-- |
| contable (ciudad, estado, número de pedidos) | `value,count` | [`weight="count"`](#filas-ponderadas--row--weight) — cuota exacta |
| medida (dinero, peso, duración) | la muestra cruda, uno por línea | `read="quantile"`, más `sample="exact"` para quitar el ruido |

`read="quantile"` no se combina con `weight=`, `row=` ni `order="sequential"`:
cada uno es una forma distinta de leer el mismo archivo, y pedir dos a la vez es
[`TDC297`](../reference/errors.md#top).

## Vea también

- [`src`](../reference/attributes.md#top), [`column`](../reference/attributes.md#top),
  [`delimiter`](../reference/attributes.md#top), [`header`](../reference/attributes.md#top),
  [`row`](../reference/attributes.md#top) y [`weight`](../reference/attributes.md#top) en la
  referencia de atributos.
- **[Archivos y CSV](../guides/files-and-csv.md#top)** — la guía completa para cargar datos
  externos.
- **[Datos coherentes y relacionales](../guides/coherent-data.md#top)** — cómo ligar
  registros enteros y las filas ponderadas.

---

← Anterior: [template](./template.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Date](./date.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/generators/file)**
