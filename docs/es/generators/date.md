<a name="top"></a>

[English](../../generators/date.md#top) · [Русский](../../ru/generators/date.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/generators/date)**

← Anterior: [File](./file.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Symbol](./symbol.md#top) →

---

# El generador `date`

**Se usa cuando** se necesita una fecha o una fecha con hora — un cumpleaños, la fecha
de un documento, la marca de tiempo de un evento — dentro de un rango y escrita en un
formato específico.

Las fechas corren sobre el runtime de fechas portable propio de TDC: un parser estricto,
un calendario UTC y un formateador localizado, sin depender de moment.js. La misma
configuración está diseñada para producir las mismas fechas en todas las
implementaciones.

Las salidas de ejemplo de abajo son ilustrativas — los valores exactos dependen de la semilla
y pueden cambiar según la versión del core. Lo que se mantiene fijo es la forma y el
formato.

## De un vistazo

| Atributo              | Qué hace                                                                               |
| :-------------------- | :------------------------------------------------------------------------------------- |
| `value`               | `birth`, `today`, `now`, una fecha suelta o un rango `START..END`                      |
| `range`               | Un rango `START..END` — una escritura más nueva de la misma idea                       |
| `from` / `to`         | Los dos extremos de un rango, dados por separado                                       |
| `format`              | Formato de salida (vea [Formato de la salida](#formato-de-la-salida)); por omisión `L` |
| `local`               | `en`, `es`, `ru` o `zh-cn`; se hereda de [`<env>`](../reference/tags.md#top) si se omite  |
| `oldest` / `youngest` | Ventana de edad en años para `value="birth"` (por omisión `80` y `10`)                 |
| `precision`           | `day`, `second` o `millisecond`                                                        |

Solo uno de `value`, `range` o el par `from`/`to` se usa para describir un rango — son
tres escrituras de lo mismo. No dé ninguno y el rango va de `1970-01-01` al momento
actual; vea [Sin límites](#sin-límites--el-reloj-cierra-el-rango).

## Una fecha aleatoria dentro de un rango

Dele a `value` un rango en la forma `START..END` (ambos extremos **incluidos**) y
obtendrá una fecha aleatoria sorteada de manera uniforme dentro de él.

```xml
<gen type="date" value="2020-01-01..2025-12-31" format="YYYY-MM-DD"/>
```

`./run demo.tdc (5 rows)`

```
2024-08-15
2022-02-04
2020-06-21
2025-10-04
2021-03-31
```

Los extremos forman parte de la ventana. Un rango de una semana lo deja ver fácilmente —
con suficientes filas, aparecen tanto `2024-06-01` como `2024-06-07`:

```xml
<gen type="date" value="2024-06-01..2024-06-07" format="YYYY-MM-DD"/>
```

`./run demo.tdc (6 rows)`

```
2024-06-06
2024-06-03
2024-06-01
2024-06-07
2024-06-02
2024-06-02
```

Las fechas de entrada se parsean de forma **estricta**, en alguna de estas formas:

- fecha: `YYYY-MM-DD`, `YYYY.MM.DD` o `YYYY/MM/DD`;
- fecha y hora: `YYYY-MM-DDTHH:mm`, `YYYY-MM-DDTHH:mm:ss` o `YYYY-MM-DDTHH:mm:ss.SSS`;
- rango: `START..END`.

El texto libre (`June 6th`, `06/06/24`) **no** se acepta — use una de las formas
estrictas de arriba.

### El atributo `range` — la misma ventana, una escritura más nueva

`range="START..END"` significa exactamente lo mismo que `value="START..END"`. Se lee
mejor cuando `value` quedaría con aspecto de palabra clave, y es la escritura que
comparte con la plantilla [`date.range`](../generators/template.md#top).

```xml
<gen type="date" range="2020-01-01..2024-12-31" format="YYYY-MM-DD"/>
```

`./run demo.tdc (5 rows)`

```
2023-11-08
2021-09-30
2020-05-23
2024-10-19
2021-01-14
```

El atributo [`format`](../reference/attributes.md#top) solo controla cómo se escribe la
fecha — nunca cambia la ventana, y la ventana nunca depende del formato.

### `from` y `to` — los extremos dados por separado

Cuando resulta más claro nombrar cada extremo por su cuenta, use `from` y `to`. Es la
escritura más natural para ventanas de fecha y hora, donde el rango quedaría como una
cadena única muy larga.

```xml
<gen type="date"
     from="2026-05-02T09:00:00"
     to="2026-05-02T09:00:05"
     format="YYYY-MM-DDTHH:mm:ss"/>
```

`./run demo.tdc (5 rows)`

```
2026-05-02T09:00:04
2026-05-02T09:00:01
2026-05-02T09:00:03
2026-05-02T09:00:00
2026-05-02T09:00:02
```

### Sin límites — el reloj cierra el rango

Un generador `date` al que no se le dio **ningún** extremo produce una fecha igual. La
ventana va de `1970-01-01` al momento actual, así que el generador lee el reloj aunque
nada en la configuración mencione una fecha:

```xml
<gen type="date" format="YYYY-MM-DD"/>
```

`./run demo.tdc  —  la misma semilla, con un año de diferencia`

```
--now 2026-04-23    --now 2027-04-23
1972-06-01          1972-06-17
1994-11-20          1995-04-30
1972-05-06          1972-05-21
```

Esta es la forma más fácil de perder la reproducibilidad sin darse cuenta. Dele al
generador dos extremos, o fije el reloj con
[`--now`](../reference/cli.md#--now--fijar-el-reloj).

**Un** extremo no es una tercera opción. `from` sin `to` es un error (`TDC150`), y
`range="2020-01-01.."` también (`TDC151`). Un rango son los dos extremos o ninguno.

## Un cumpleaños con `value="birth"`

`value="birth"` produce una fecha de nacimiento relativa a la fecha actual, acotada por
una ventana de edad. `youngest` y `oldest` son edades **en años** (por omisión `10` y
`80`), así que `youngest="18" oldest="65"` da adultos en edad laboral.

```xml
<gen type="date" value="birth" youngest="18" oldest="65" format="MM/DD/YYYY"/>
```

`./run demo.tdc (5 rows)`

```
07/05/1997
11/23/1985
02/14/2003
09/30/1971
06/18/1990
```

**Por qué usarlo en vez de un rango fijo:** la ventana sigue al momento actual, así que
la misma configuración seguirá produciendo edades plausibles el año que viene sin tocar
las fechas. Para un cumpleaños atado a una persona sintética completa, la plantilla
[`person.b_day`](../generators/template.md#top) acepta los mismos atributos
`oldest`/`youngest`/`format`.

Por eso mismo las fechas se mueven. La ventana avanza con el reloj, así que mañana la
misma semilla da otra fecha de nacimiento: la edad se sostiene, la fecha no. Donde la
salida tenga que quedarse quieta — una prueba de snapshot, una fixture, un reporte de
bug — fije el reloj con [`--now`](../reference/cli.md#--now--fijar-el-reloj).

## `today` y `now`

`value="today"` es la fecha actual; `value="now"` es la fecha **y** la hora actuales.
Ambos leen el reloj del runtime, así que son las marcas naturales para campos del tipo
«generado el» o «vigente al».

```xml
<gen type="date" value="today" format="LL"/>
<gen type="date" value="now"   format="YYYY-MM-DDTHH:mm:ss.SSS"/>
```

`./run demo.tdc`

```
value="today" format="LL"                       April 23, 2026
value="now"   format="YYYY-MM-DDTHH:mm:ss.SSS"   2026-04-23T12:00:00.000
```

Leer el reloj es justamente el punto de ambos, y es lo que los vuelve no reproducibles:
la semilla no decide qué día es hoy. Fije el reloj con
[`--now`](../reference/cli.md#--now--fijar-el-reloj) y `today` y `now` devuelven el
instante que usted nombró, en cada corrida.

## `precision` — el paso para rangos de fecha y hora

`precision` fija el paso más pequeño con el que se mueve un rango: `day`, `second` o
`millisecond`. Para una ventana de cinco segundos avanzando de segundo en segundo:

```xml
<gen type="date"
     from="2026-05-02T09:00:00"
     to="2026-05-02T09:00:05"
     precision="second"
     format="YYYY-MM-DDTHH:mm:ss"/>
```

`./run demo.tdc (5 rows)`

```
2026-05-02T09:00:04
2026-05-02T09:00:01
2026-05-02T09:00:03
2026-05-02T09:00:00
2026-05-02T09:00:02
```

Cuando se omite `precision`, el valor por omisión sigue al tipo de rango:

| Tipo de rango             | Paso por omisión   | Qué cambia `precision`                             |
| :------------------------ | :----------------- | :------------------------------------------------- |
| solo fecha (`YYYY-MM-DD`) | un **día**         | rara vez hace falta — ya son días completos        |
| fecha y hora              | un **milisegundo** | `precision="second"` pone los milisegundos en cero |

Use `precision="second"` cuando quiera marcas de tiempo limpias y de aspecto humano en
lugar de ruido de milisegundos; use `precision="millisecond"` (el valor por omisión para
fecha y hora) cuando necesite resolución por debajo del segundo.

## Formato de la salida

`format` es una plantilla de marcadores. Cambia únicamente cómo se **escribe** una
fecha — el valor de fondo queda intacto. El valor por omisión es `L` (una fecha corta
dependiente del locale).

Todos los tokens sobre un mismo instante fijo — **martes 5 de marzo de 2024,
09:04:07**. El día y el mes son de una cifra a propósito, para que las parejas
«con cero / sin cero» se distingan a simple vista:

| Token  | Significa                         | Ejemplo                        |
| :----- | :-------------------------------- | :----------------------------- |
| `YYYY` | año de 4 dígitos                  | `2024`                         |
| `YY`   | año de 2 dígitos                  | `24`                           |
| `MMMM` | nombre completo del mes           | `March`                        |
| `MMM`  | nombre corto del mes              | `Mar`                          |
| `MM`   | mes de 2 dígitos                  | `03`                           |
| `M`    | mes sin cero inicial              | `3`                            |
| `DD`   | día de 2 dígitos                  | `05`                           |
| `D`    | día sin cero inicial              | `5`                            |
| `dddd` | nombre completo del día           | `Tuesday`                      |
| `ddd`  | nombre corto del día              | `Tue`                          |
| `HH`   | hora de 2 dígitos (24 h)          | `09`                           |
| `H`    | hora sin cero inicial             | `9`                            |
| `mm`   | minuto de 2 dígitos               | `04`                           |
| `m`    | minuto sin cero inicial           | `4`                            |
| `ss`   | segundo de 2 dígitos              | `07`                           |
| `s`    | segundo sin cero inicial          | `7`                            |
| `SSS`  | milisegundos                      | `000`                          |
| `Z`    | desplazamiento UTC con dos puntos | `+00:00`                       |
| `ZZ`   | desplazamiento UTC sin dos puntos | `+0000`                        |
| `ISO`  | fecha en formato ISO 8601         | `2024-03-05`                   |
| `L`    | fecha corta según el locale       | `03/05/2024`                   |
| `LL`   | fecha larga según el locale       | `March 5, 2024`                |
| `LLL`  | fecha larga con la hora           | `March 5, 2024 09:04`          |
| `LLLL` | la misma, con el día de la semana | `Tuesday, March 5, 2024 09:04` |

Los nombres de mes y de día, y las cuatro formas de `L`, siguen el locale — ver
[abajo](#formatos-dependientes-del-locale-l-y-ll). Todo lo demás es igual en cualquier idioma.

La misma fecha bajo cuatro formatos — misma semilla, así que la fecha es idéntica en cada
línea y solo cambia la escritura:

```xml
<gen type="date" value="2020-01-01..2024-12-31" format="YYYY-MM-DD"/>
<gen type="date" value="2020-01-01..2024-12-31" format="DD.MM.YYYY"/>
<gen type="date" value="2020-01-01..2024-12-31" format="DD MMM YYYY"/>
<gen type="date" value="2020-01-01..2024-12-31" format="LL"/>
```

`./run demo.tdc`

```
YYYY-MM-DD    DD.MM.YYYY    DD MMM YYYY    LL
2023-11-08    08.11.2023    08 Nov 2023    November 8, 2023
2021-09-30    30.09.2021    30 Sep 2021    September 30, 2021
2020-05-23    23.05.2020    23 May 2020    May 23, 2020
```

### Texto literal entre corchetes

Todo lo que va entre corchetes se copia tal cual, así que se puede envolver una fecha en
texto fijo:

```xml
<gen type="date" value="2024-03-15..2024-03-15" format="[date:] YYYY-MM-DD"/>
```

`./run demo.tdc`

```
date: 2024-03-15
```

### Formatos dependientes del locale: `L` y `LL`

`L`, `LL`, `LLL` y `LLLL` siguen al locale, tomado del atributo `local` (o de
`local` en [`<env>`](../reference/tags.md#top)), igual que los tokens de nombre `MMMM`,
`MMM`, `dddd` y `ddd`. El locale por omisión es `en`. Las plantillas
numéricas como `YYYY-MM-DD` y `DD.MM.YYYY` nunca dependen del locale — solo de la
plantilla que se escribe.

Aquí está la fecha fija `2024-03-15` con `format="LL"`, primero en el locale inglés por
omisión y luego la misma fecha renderizada de nuevo con `local="ru"` para mostrar el
nombre del mes localizado y la forma larga — una demostración deliberada de
localización:

```xml
<gen type="date" value="2024-03-15..2024-03-15" format="LL"/>            <!-- en por omisión -->
<gen type="date" value="2024-03-15..2024-03-15" format="LL" local="ru"/> <!-- ruso -->
```

`./run demo.tdc`

```
default (en)   March 15, 2024
local="ru"     15 марта 2024 г.
```

`L` se desplaza igual: `03/15/2024` en `en`, `15.03.2024` en `ru`.

## Trampas comunes, todas en un lugar

- Las fechas de entrada se parsean de forma **estricta** — use `YYYY-MM-DD` (o `.` / `/`), no texto libre.
- Ambos extremos del rango están **incluidos**.
- `value`, `range` y `from`/`to` son tres escrituras de una misma ventana — use la que mejor se lea.
- `L` / `LL` cambian con `local`; `YYYY-MM-DD` y compañía no.
- Los rangos de solo fecha avanzan por día; los de fecha y hora por milisegundo, salvo que se fije `precision`.
- `today`, `now`, `value="birth"` y un generador **sin** límites leen el reloj, así que
  la semilla sola no los reproduce — fije el reloj con
  [`--now`](../reference/cli.md#--now--fijar-el-reloj).
- `format` aplica **solo** a fechas. Sobre identificadores de plantilla (SSN, IBAN, teléfono…) es un error — dele forma a esos con [filtros de interpolación](../core-concepts/output-formatting.md#top).

## Vea también

- [`format`](../reference/attributes.md#top), [`range`](../reference/attributes.md#top) y [`local`](../reference/attributes.md#top) en la referencia de atributos.
- **[Template](../generators/template.md#top)** — `person.b_day` y `date.range` comparten este mismo formateo de fechas.

---

← Anterior: [File](./file.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Symbol](./symbol.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/generators/date)**
