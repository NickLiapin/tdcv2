<a name="top"></a>

[English](../../generators/timeseries.md#top) · [Русский](../../ru/generators/timeseries.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/generators/timeseries)**

← Anterior: [Contadores (increment / decrement)](./counters.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Pattern (dibujo)](./pattern.md#top) →

---

# El generador `timeseries`

**Se usa cuando** hacen falta valores que se muevan como una señal real en el tiempo:
ventas diarias, lecturas de un sensor, tráfico web. Las series reales no son ruido
plano ni una sola distribución: son **capas** — una tendencia general (que sube o
baja), una estación que se repite (semanal, anual) y ruido aleatorio encima.
`timeseries` arma el valor de una fila exactamente así:

```text
value(i) = base + trend·i + amplitude·sin(2π·i / period) + noise·random
```

donde `i` es el número de fila (el eje del tiempo), contado desde cero — así que la
primera fila (`i = 0`) es exactamente `base`.

Las salidas de ejemplo de abajo son ilustrativas: los dígitos exactos pueden variar
según la versión del núcleo y el `seed`, pero lo que importa es la forma — la
tendencia, la onda, el temblor.

![](../../img/concepts/timeseries-layers.svg)

*El mismo generador, cuatro veces, agregando un atributo cada vez — 120 filas por panel.*

- **A** — solo base: una línea plana
- **B** — se agrega trend: la línea empieza a subir
- **C** — se agregan period y amplitude: una onda cabalga sobre la tendencia
- **D** — se agrega noise: la onda deja de ser perfecta

## Por qué no simplemente números aleatorios

Un generador [`number`](number.md#top) común produce **ruido blanco**: valores que
brincan alrededor de una media sin ninguna memoria. Aquí está `number` con una
distribución normal centrada en `1000`:

```xml
<sequence name="Noise"><gen type="number" distribution="normal" mean="1000" sd="120"/></sequence>
```

`./run noise.tdc`

```
Day 1     841
Day 2     1341
Day 3     1047
Day 4     1010
Day 5     1086
Day 6     1077
Day 7     862
Day 8     1072
Day 9     1114
Day 10    782
Day 11    979
Day 12    1014
```

Ni subida, ni bajada, ni repetición: cada día simplemente da vueltas alrededor de 1000. Las métricas reales no se ven así: las ventas tienen una tendencia (el negocio
crece), un ritmo semanal (los fines de semana no son como los días hábiles) y solo
_encima de eso_ algo de desviación aleatoria. Esas tres capas son justamente lo que
agrega `timeseries`.

## Atributos

```xml
<gen type="timeseries" base="1000" trend="20" period="7" amplitude="150" noise="30"/>
```

| Atributo    | Qué define                                                      |
| :---------- | :-------------------------------------------------------------- |
| `base`      | Nivel inicial (por omisión `0`)                                 |
| `trend`     | Pendiente: cuánto sube el valor en cada paso                    |
| `period`    | Largo de la onda estacional, en filas (p. ej. `7` = una semana) |
| `amplitude` | Altura de la onda estacional                                    |
| `noise`     | Fuerza del ruido aleatorio (desviación estándar)                |
| `decimals`  | Dígitos después del punto decimal (por omisión `0` — entero)    |

Todas las capas son opcionales. Las secciones siguientes las toman una por una: qué
hace cada una y cuándo conviene echarle mano.

### `base` — el nivel inicial

`base` fija el valor de la primerísima fila (`i = 0`) y el nivel desde el que se mide
todo lo demás. Por sí solo — sin `trend`, sin onda, sin `noise` — es apenas una línea
plana.

```xml
<gen type="timeseries" base="500"/>
```

`./run base.tdc`

```
500
500
500
500
500
```

Sirve para anclar una métrica en un nivel realista — una tienda que promedia 500
pedidos al día, un sensor que reposa en 20 grados — antes de agregarle movimiento.

### `trend` — la dirección

`trend` es la pendiente: cada fila le suma `trend` a la anterior. Positiva sube,
negativa baja. Con solo `base` + `trend` sale una línea perfectamente recta.

```xml
<gen type="timeseries" base="1000" trend="20"/>
```

`./run trend.tdc`

```
1000
1020
1040
1060
1080
```

Sirve para crecimientos o caídas que se quieren ver a simple vista: una cuenta de
suscriptores que gana 20 al día, una batería que se descarga una cantidad fija por
ciclo.

### `period` y `amplitude` — la onda estacional

Estos dos trabajan en pareja, y ninguno hace nada sin el otro. `period` es cuántas
filas dura un ciclo completo (`7` = ritmo semanal, `365` = anual); `amplitude` es
cuánto se aleja la onda por arriba y por abajo de la línea de tendencia. Juntos
recuestan una onda `sin` que se repite sobre lo que dé `base` + `trend`.

```xml
<gen type="timeseries" base="1000" trend="20" period="7" amplitude="150"/>
```

`./run season.tdc`

```
1000
1137
1186
1125
1015
954
1003
```

Dentro de cada ventana de 7 filas el valor sube hasta un pico y cae hasta un valle, y
luego se repite. Como la tendencia sigue levantando toda la línea, cada ciclo queda
más alto que el anterior: la onda cabalga cuesta arriba. Sirve para cualquier cosa con
ritmo de calendario: tráfico entre semana contra fin de semana, demanda de verano
contra invierno.

### `noise` — la aspereza del mundo real

`noise` es la desviación estándar de un bamboleo aleatorio que se suma a cada fila. Es
la diferencia entre una curva de libro de texto y una medición real.

```xml
<gen type="timeseries" base="1000" trend="20" period="7" amplitude="150" noise="30"/>
```

`./run noise-layer.tdc`

```
985
1087
1192
1107
936
966
1031
```

Compare con la onda limpia de arriba: la forma es la misma, pero cada punto tiembla un
poco (`1000 → 985`). Súbalo para un sensor ruidoso, bájelo para un agregado suave. El
temblor es reproducible — vea [Detalles](#detalles).

### `decimals` — valores fraccionarios

Por defecto la salida se redondea a un número entero. `decimals` conserva esa cantidad
de dígitos después del punto — para temperaturas, precios o cualquier magnitud medida.

```xml
<gen type="timeseries" base="20" trend="0.5" noise="0.3" decimals="1"/>
```

`./run decimals.tdc`

```
20.0
20.4
21.2
21.4
22.1
```

## Ármelo capa por capa

La forma más clara de sentir el generador es prender las capas de a una. Abajo, tres
columnas [`<sequence>`](../core-concepts/sequences.md#top) corren sobre los mismos
«días»: **trend** (solo `trend`), **+season** (agrega `period` + `amplitude`) y
**+noise** (agrega `noise`).

```xml
<sequence name="A"><gen type="timeseries" base="1000" trend="20"/></sequence>
<sequence name="B"><gen type="timeseries" base="1000" trend="20" period="7" amplitude="150"/></sequence>
<sequence name="C"><gen type="timeseries" base="1000" trend="20" period="7" amplitude="150" noise="30"/></sequence>
...
<data>Day ${{Day}}   trend=${{A}}   +season=${{B}}   +noise=${{C}}</data>
```

`./run series.tdc`

```
Day   trend   +season   +noise
01    1000     1000      985
02    1020     1137      1087
03    1040     1186      1192
04    1060     1125      1107
05    1080     1015      936
06    1100     954       966
07    1120     1003      1031
08    1140     1140      1087
09    1160     1277      1311
10    1180     1326      1347
11    1200     1265      1261
12    1220     1155      1126
```

Leyendo las columnas:

- **trend** — una línea perfectamente recta: `+20` cada día, `1000, 1020, 1040 …`. Hay
  dirección, pero nada de vida.
- **+season** — una onda semanal (`period="7"`) recostada sobre la línea. Dentro de
  cada semana el valor sube a un pico y cae a un valle: los picos caen en los días
  **3** y **10** (1186 → 1326), el valle en el día **6** (954). Picos y valles se
  repiten cada 7 filas, y cada uno queda más alto que el anterior por exactamente
  `trend · period = 20 · 7 = 140` — la onda cabalga cuesta arriba sobre la tendencia.
- **+noise** — la misma forma, pero tiembla un poco (`1000 → 985`), como lo hacen las
  mediciones reales.

Cada columna es la anterior más **un** atributo: dirección, luego ritmo, luego
aspereza del mundo real. Así se arma una serie realista.

## Detalles

- **Determinista:** el mismo `seed` da la misma serie. El ruido también es
  reproducible: se calcula a partir del número de fila, no se tira al vuelo.
- **Cualquier tamaño, cualquier motor:** un valor se calcula a partir de su número de
  fila, así que la memoria no crece (vea
  [Salidas grandes](../guides/large-outputs.md#top)). Mil millones de puntos no son
  problema.
- El eje del tiempo es el número de fila. Se lleva de forma natural con un
  [`increment`](counters.md#top) (un contador de días) o una columna
  [`date`](date.md#top) al lado, para que cada valor cargue una fecha real.

> [!NOTE]
> **Planeado**
>
> Hoy es una tendencia + una onda estacional + ruido. Planeado: varias estacionalidades
> a la vez (semanal **y** anual) y ruido AR (correlacionado en el tiempo).

## Vea también

- **[Number](number.md#top)** — valores aleatorios sueltos, con distribuciones estadísticas.
- **[Pattern](pattern.md#top)** — cuando la forma no se describe con tendencia + estación.
- **[Contadores](counters.md#top)** / **[Date](date.md#top)** — un índice de día o una fecha
  real para poner junto a la serie.

---

← Anterior: [Contadores (increment / decrement)](./counters.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Pattern (dibujo)](./pattern.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/generators/timeseries)**
