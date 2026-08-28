<a name="top"></a>

[English](../../reference/cli.md#top) · [Русский](../../ru/reference/cli.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/reference/cli)**

← Anterior: [Cree su propio paquete](../data-packs/writing-your-own.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Etiquetas](./tags.md#top) →

---

# Referencia de la CLI

Toma un config `.tdc`, genera y escribe el resultado en un archivo o en stdout — sin escribir código.

```bash
tdcv2 <input.tdc> [options]
```

> [!NOTE]
> **De dónde sale `tdcv2`**
>
> `npm install -D tdcv2`, `pip install tdcv2` y `cargo install tdcv2` dejan el comando
> `tdcv2` en su PATH desde el mismo paquete que lleva la biblioteca. Maven y NuGet no tienen
> equivalente del `bin` de npm, así que en Java y C# la línea de comandos es un segundo
> artefacto; [Instalación](../getting-started/installation.md#top) tiene la pestaña de cada
> uno. Un alias hace que todos los comandos de esta página se lean igual. Todo lo de abajo
> funciona igual en cualquier implementación.

Además de generar, la CLI tiene `tdcv2 init` y `tdcv2 pack` para la configuración inicial
y los datos — vea [Instalar packs](../data-packs/installing-packs.md#top) — más `tdcv2 check`
([abajo](#tdcv2-check)) y `tdcv2 format` ([abajo](#tdcv2-format)).

## Opciones

| Opción                  | Qué hace                                                 |
| :---------------------- | :------------------------------------------------------- |
| `-o, --output <path>`   | Escribe en un archivo. Sin ella, imprime en stdout. Una ruta terminada en `.parquet` selecciona el escritor [Parquet](../guides/typed-output-parquet.md#top) — es la única forma de obtenerlo |
| `--seed <seed>`         | Sobrescribe el `seed` de `<env>`                         |
| `--count <n>`           | Sobrescribe el `count` de `<env>` — un entero no negativo |
| `--locale <loc>`        | Sobrescribe el locale (por omisión `en`)                 |
| `--now <date>`          | Fija el reloj que leen `today`, `now` y `b_day`          |
| `--data-path <dir>`     | Agrega una carpeta de datos para `@data/…` (repetible)   |
| `--jobs <n>`            | Cantidad de hilos de trabajo, un entero positivo (por omisión lo decide TDC) |
| `--mode <memory\|disk>` | Motor: `disk` (por omisión) o `memory`                   |
| `--engine <1\|2\|3>`    | Forzar un motor específico (avanzado)                    |
| `--disk`                | Atajo de `--mode disk` — ya es el valor por omisión      |
| `--progress`            | Escribe `<output>.progress`, un pequeño archivo JSON de estado (necesita `-o`) |
| `--stream`              | Alias heredado de `--engine 2`                           |
| `-h, --help`            | Muestra la ayuda                                         |
| `-v, --version`         | Muestra la versión                                       |

Las opciones largas también aceptan `=`: `tdcv2 demo.tdc --output=out.csv --count=100`.

En los ejemplos de abajo se usa este `demo.tdc`:

```xml
<tdc>
  <env count="10" seed="demo" local="en">
    <sequence name="Id"><gen type="increment" value="1"/></sequence>
    <sequence name="City"><gen type="text" value="Moscow,Berlin,Paris" order="sequential"/></sequence>
    <sequence name="Status"><gen type="text" value="new,active,closed"/></sequence>
    <before><line><data>Id,City,Status</data></line></before>
  </env>
  <block><line><data>${{Id}},${{City}},${{Status}}</data></line></block>
</tdc>
```

`./run demo.tdc`

```
Id,City,Status
1,Moscow,closed
2,Berlin,new
3,Paris,closed
4,Moscow,new
5,Berlin,closed
6,Paris,new
7,Moscow,new
8,Berlin,active
9,Paris,active
10,Moscow,active
```

## `--seed` — cambiar la aleatoriedad

El config trae una semilla fija, pero usted quiere otro conjunto de valores sin tocar el
archivo. `--seed` lo sobrescribe: las columnas de contador (`Id`) y de recorrido cíclico
(`City`) no dependen de la semilla, así que solo cambia `Status`.

## `--count` — cuántas filas

`--count 4` renderiza cuatro filas. Las columnas posicionales (contador, texto cíclico)
son un prefijo; las columnas de proporción exacta (`percent`, `<mix>`) y las de `uniq`
se recalculan a partir del nuevo total.
Vea [Determinismo y proporciones](../core-concepts/determinism.md#top).

## `--output` — escribir en un archivo

`-o` (o `--output`) escribe en un archivo; a stdout no sale nada:

```bash
tdcv2 demo.tdc -o out.csv
```

## `--locale` — el idioma de los datos de plantilla

Los generadores de plantilla (nombres, ciudades) usan inglés por omisión; `--locale ru`
cambia todo el archivo al ruso, posición por posición.

## `--now` — fijar el reloj

Algunos generadores leen el reloj: `value="today"`, `value="now"`, `person.b_day` (una
ventana de edad medida hacia atrás desde hoy) y un generador `date` al que no se le dieron
límites. Está pensado así — un cumpleaños que sigue a la fecha de hoy es justamente el
punto. Pero eso vuelve al reloj una entrada de la corrida junto al config y la semilla,
y la única que no se puede anotar. El mismo archivo con la misma semilla le da otras
filas mañana.

`--now` la anota:

```bash
tdcv2 people.tdc --seed demo --now 2026-04-23 -o out.csv
```

Corra eso dentro de un año y obtiene los mismos bytes. Quite la bandera y la corrida lee
el reloj real, que es lo que quiere en producción y no lo que quiere en una prueba.

El valor es una fecha en la misma sintaxis que toma `<gen type="date" value="…">`:
`2026-04-23`, o `2026-04-23T09:30:00` cuando importa la hora. No hay zona horaria: toda
fecha en TDC es UTC. Un valor que TDC no puede leer es un error, no un regreso silencioso
al reloj real:

```
tdcv2: invalid --now "yesterday" — expected YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss (UTC)
```

## `--data-path` — datos externos

Cuando un config lee `src="@data/…"`, la CLI necesita saber dónde está la carpeta
`data/`. Se le indica con `--data-path` (es repetible — las carpetas se recorren en orden):

```bash
tdcv2 demo.tdc --data-path ./data --data-path ./private-data -o out.csv
```

Una ruta relativa simple como `src="names.txt"` se busca primero junto al archivo `.tdc`
y después en las carpetas de `--data-path`.

## Velocidad y motores — `--jobs`, `--mode`, `--engine`

Normalmente no necesita ninguno de estos: TDC elige el motor a partir del config y decide
por su cuenta si paralelizar. En resumen:

- **`--jobs N`** — fija a mano la cantidad de hilos de trabajo. Esto es **solo cuestión
  de velocidad**: la salida es byte por byte idéntica a la de una corrida de un solo hilo.
- **`--mode memory`** — el motor pequeño en RAM (una salida de emergencia para datos
  chicos y para la API de objetos). Da **los mismos valores** que los demás motores
  ([determinismo](../core-concepts/determinism.md#top)); simplemente mantiene cada columna en
  RAM en vez de transmitirla.
- **`--engine 1|2|3`** — fuerza un motor específico; `--stream` es un alias heredado de
  `--engine 2`. `--mode` describe un coste, y una ejecución que describe un coste todavía
  puede acabar en otro motor.

  `--engine 2` **rechaza** todo lo que no puede transmitir, así que una medición mide lo que
  dice medir. `--engine 3` rechaza en un solo caso — un `uniq` demasiado ajustado para su
  reparación acotada — y en los demás cae al motor en memoria e imprime sus bytes: código 0 y
  ni una palabra. Es angosto a propósito: las formas en las que el motor 3 cae son justo las
  que el camino perezoso no puede expresar, y cubrirlas es para lo que existe. Eso sí implica
  que una medición de memoria hecha con `--engine 3` sobre un `stat`, un total acumulado o un
  `uniq` simple es una medición del motor 1. [Qué motor ejecuta su
  configuración](../guides/large-outputs.md#qué-motor-corre-su-configuración) lista las formas.

TDC calcula cuántos hilos caben en la RAM de esta máquina y toma esa cantidad — en una
máquina débil la corrida simplemente va más lenta, no se cae a la mitad. Todo el detalle
está en [Volúmenes grandes](../guides/large-outputs.md#top).

## `--progress` — observar una ejecución larga

Una ejecución de cien millones de filas guarda silencio durante mucho tiempo, y el silencio
se parece exactamente a un cuelgue. `--progress` escribe un pequeño archivo JSON junto a la
salida — `<output>.progress` — y lo reescribe aproximadamente una vez por segundo:

```bash
tdcv2 demo.tdc -o out.csv --progress
```

```json
{
  "phase": "render",
  "done": 4200000,
  "total": 10000000,
  "percent": 42,
  "startedAt": 1787871050458,
  "updatedAt": 1787871083822,
  "pid": 51234
}
```

`startedAt` y `updatedAt` son milisegundos desde la época. El que conviene mirar es
`updatedAt`: se mueve en cada escritura, así que distingue una corrida viva de una detenida
sin preguntarle al sistema de archivos por la hora de modificación.

Cada refresco escribe `<output>.progress.tmp` y lo renombra sobre `<output>.progress`, así
que un lector nunca alcanza un archivo a medio escribir. El `.tmp` queda visible junto a la
salida mientras dura la corrida. `tdcv2 format -w` hace lo mismo con `<file>.tmp`.

Las fases, en este orden cuando ocurren: `uniq-scan` (se calcula el hash de la tupla de cada
fila), `uniq-sort` (se ordenan los montones), `uniq-repair` (se comprueban y reordenan las
tuplas repetidas) y `render` (se escriben las filas).

**Cuáles informa una corrida depende del motor y no se sabe de antemano.** Medido sobre una
configuración con `<uniq>`: el motor en memoria informa solo `render`; el de streaming a
300.000 filas informa `uniq-repair` y luego `render`; la misma configuración a 1.500.000
filas, donde la corrida se reparte entre workers, informa las cuatro. Y el plan no queda
fijo ni siquiera al arrancar: el motor de streaming puede encontrar una configuración que no
sabe expresar, rendirse a mitad de camino y entregarle la corrida entera al motor en
memoria, que informa `render` y nada más.

Por eso el archivo no trae un NÚMERO de fases. Una "fase 2 de 4" publicada al principio
sería un número al que esta corrida quizá nunca llegue, y una barra construida sobre él
saltaría, que es lo único que una barra no debe hacer. Dibuje la fase y sus propios números:
esos siempre son ciertos.

`uniq-repair` no trae `done`/`total` en una corrida paralela: allí el arreglo se calcula en
una sola llamada y no en pasos contables. En una
ejecución `uniq` grande ninguna de ellas domina: medida en 6.000.000 de filas sobre
900.000.000 de pares posibles, escribir las filas llevó 17 segundos, calcular el hash de cada
tupla 12, ordenar los montones 3 y la reparación 7, de unos 40 en total.

Dentro de una fase los números solo suben, y la fase termina en su propio total: una
barra
dibujada a partir de ellos nunca salta hacia atrás ni se queda corta. `uniq-repair` son
varios pasos de distinta naturaleza informados sobre una única escala creciente, así que su
total es el trabajo que la reparación lleva asumido hasta ese momento y no una cifra
conocida de antemano.

La última escritura es `{"phase":"done","percent":100,...}` con los
segundos de reloj que duró la ejecución.

La primera escritura es `{"phase":"starting"}`, antes de que el trabajo tenga un número que
informar. Está ahí para que el archivo EXISTA desde el primer momento: quien no encuentra
archivo no puede distinguir "aún no empezó" de "murió", y levantar una docena de workers en
una configuración grande lleva segundos. En una corrida paralela `uniq-repair` no trae
`done`/`total`: allí el arreglo se calcula en una sola llamada y no en pasos contables.

Dos cosas hacen que sea seguro consultarlo. El archivo se reemplaza de forma atómica, así
que quien lo lee nunca ve medio JSON. Y se **reescribe al menos una vez por segundo** —el
mismo estado otra vez, con un `updatedAt` fresco— tenga o no el trabajo algo nuevo que
decir. Por eso un archivo que no se mueve durante minutos significa que el proceso ya no
está, diga lo que diga su contenido.

Ese latido es en la medida de lo posible, y conviene saberlo con precisión. El temporizador
vive en el mismo proceso, así que un tramo de cómputo ininterrumpido puede retenerlo: medido
en una corrida de 1.500.000 filas con `<uniq>`, el silencio más largo fue de 10,9 segundos,
durante el arreglo. Antes de que existiera el temporizador, la misma corrida pasó 2 minutos
16 segundos sin escribir estando perfectamente sana, suficiente para que quien siguiera esta
página la diera por muerta. Juzgue la vida en minutos y no en segundos, y la regla se
sostiene.

Necesita `-o`: el archivo de estado vive junto a la salida, así que sin salida no hay dónde
ponerlo, y el comando lo dice en vez de aceptar la bandera y descartarla.

Una ejecución repartida entre workers se cuenta entera. Cada worker informa las filas que ha
escrito y el coordinador las suma, así que el porcentaje es el del archivo y no el de un
worker — lo cual importa, porque por encima de cien mil filas TDC reparte la ejecución por
su cuenta salvo que se indique otra cosa.

Una salida [Parquet](../guides/typed-output-parquet.md#top) también informa, una vez por grupo
de filas, es decir cada cincuenta mil. Más grueso que en el camino de texto y a propósito:
un grupo de filas es la unidad con la que trabaja ese escritor, y dentro de uno no hay
ningún momento en el que un grupo a medias signifique algo. Si el porcentaje llega al final
y vuelve a empezar, es que la ejecución se está recorriendo dos veces: convendría
reportarlo como un fallo en vez de convivir con ello.

El mismo canal está en la biblioteca en todas las implementaciones, como una devolución de
llamada que recibe `(phase, done, total)`.

## `tdcv2 check`

Lee una configuración, la valida y no genera nada. Es lo que quiere en un hook de
pre-commit o en un paso de CI: responde «¿esto correría?» sin gastar el tiempo de
correrlo.

```bash
tdcv2 check demo.tdc
```

Todo sale por stderr — una configuración válida recibe una línea, y una inválida los
mismos diagnósticos que imprimiría `tdcv2 demo.tdc`. **Por stdout no sale nada**, a
propósito: el stdout de un hook es ruido, y quien quiera los datos ejecuta el generador.

`tdcv2 check demo.tdc`

```
tdcv2: demo.tdc is valid
```

Las advertencias no hacen fallar la comprobación — se imprimen y el código de salida sigue
siendo `0`, porque una advertencia describe algo que funciona pero probablemente no es lo
que usted quería. Solo un error sale con `1`.

`--brief` es la única bandera que acepta `check`. Imprime una línea por diagnóstico —
código, posición, mensaje, pista — sin el extracto del fuente, para editores, CI y
cualquier otra cosa que lea la salida en vez de mirarla:

`tdcv2 check --brief demo.tdc`

```
TDC041 1:70 unknown gen type "nosuch" :: Allowed types: text, file, template, number, regex, advanced_regex, … (11 more).
```

## `tdcv2 format`

Deja ordenado un `.tdc` — sangría, espaciado de los atributos, tablas `<map>` alineadas —
con el mismo formateador del editor.

```bash
tdcv2 format demo.tdc        # imprime el config formateado en stdout
tdcv2 format -w demo.tdc     # reescribe el archivo en su lugar (-w / --write)
```

Formatear **nunca cambia** lo que genera un config. Un error de sintaxis se muestra y el
archivo queda intacto (código de salida 1).

## Códigos de salida

| Código | Significado                                      |
| -----: | :----------------------------------------------- |
|    `0` | Generación exitosa, `--help` o `--version`       |
|    `1` | Error de lectura, parseo, validación o ejecución |
|    `2` | Argumentos de CLI incorrectos — y cualquier fallo de `pack` o `init` (una descarga, una suma de verificación, una configuración ya existente) |

## Vea también

- **[Instalar packs](../data-packs/installing-packs.md#top)** — `tdcv2 init`, `tdcv2 pack`.
- **[Volúmenes grandes](../guides/large-outputs.md#top)** — `--jobs`, `--mode`, `--engine` a fondo.

---

← Anterior: [Cree su propio paquete](../data-packs/writing-your-own.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Etiquetas](./tags.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/reference/cli)**
