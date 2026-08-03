<a name="top"></a>

[English](../../guides/performance.md#top) · [Русский](../../ru/guides/performance.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/guides/performance)**

← Anterior: [Escribir un generador de servicio](./writing-a-service.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Descripción general](../data-packs/overview.md#top) →

---

# Rendimiento

Cuánto tarda una ejecución y cuánta memoria pide. Cada número de esta página se midió en una
máquina ejecutando las cinco líneas de comandos publicadas sobre la misma configuración: ni
estimado, ni recordado de una versión anterior.

La respuesta corta, si es lo único que necesita: **dos millones de registros de seis campos
tardan entre nueve y quince segundos**, y en el motor de flujo la memoria no crece con el
número de filas. Python es la excepción, con unos noventa segundos.

## Qué se midió y cómo

La prueba ejecuta la línea de comandos que entrega cada registro, instalada en un directorio
desechable. Nada aquí lee una copia del repositorio, que es también lo que permite a un
tercero repetirla.

Cada regla existe para que esto siga siendo una medición y no un anuncio:

- **El mismo archivo de configuración**, byte a byte, sustituyendo solo `count` y `engine`.
- **El motor se elige en la configuración**, no en la línea de comandos, así se pregunta a las
  cinco de la única forma que todas entienden con seguridad.
- **`--now` fijado**, para que un generador de fechas no se desvíe entre ejecuciones.
- **`--jobs 1` en todas.** TypeScript es la única que reparte una ejecución entre procesos;
  medir eso contra cuatro implementaciones de un solo hilo mediría una funcionalidad, no un
  motor.
- **El reloj y la memoria máxima salen de `/usr/bin/time -l`**, fuera del proceso, para que
  ninguna se mida a sí misma.
- **Cada salida se resume con un hash y los hashes deben coincidir.** Un número de velocidad
  para una ejecución que produjo datos distintos no vale nada, así que una discrepancia tumba
  la fila en vez de aparecer en el informe. Todos los números de abajo vienen de ejecuciones
  que coincidieron byte a byte.

### La máquina

| | |
| :--- | :--- |
| Procesador | Apple M2 Max, 12 núcleos (8 de rendimiento, 4 de eficiencia) |
| Memoria | 32 GB |
| Almacenamiento | Apple SSD AP1024Z, 1 TB, APFS, TRIM activo — al 94% de ocupación |
| Sistema | macOS 26.5.1 |

**El almacenamiento importa menos de lo que parece, y conviene demostrarlo en vez de
afirmarlo.** La escritura secuencial en este volumen mide 810 MB/s en frío y unos 1,3 GB/s en
caliente. La ejecución más grande de esta página produce 147 MB, que a esa velocidad se
escriben en **0,031 segundos** dentro de una ejecución de nueve a quince segundos: dos décimas
de un uno por ciento, y tres centésimas para Python. Estos números los limita el procesador,
así que puede escalarlos a su máquina por la velocidad de núcleo y olvidarse del disco. No se
lee nada grande: los paquetes de datos pesan kilobytes y quedan en caché tras el primer uso.

### Las versiones

Cuatro implementaciones son la 0.1.4 publicada, exactamente como la instala un usuario. Rust
está compilado desde el código con una corrección aún no publicada: el motor de flujo retenía
la ejecución entera al escribir a un archivo. Publicar el número antiguo habría documentado un
comportamiento que ya no existe en el código; esta nota desaparece con la 0.1.5.

## Los tres motores, en breve

No hay nada que elegir: **TDC toma el motor de su configuración, de forma determinista, y la
misma configuración obtiene el mismo motor en cualquier máquina.** Las tablas se separan por
motor solo porque eso explica la forma de los números.

| Motor | Qué hace | Qué cuesta |
| :---- | :------- | :--------- |
| **1 — en memoria** | Guarda columnas enteras y responde al instante | La memoria crece con el número de filas |
| **2 — de flujo** | Resuelve una fila cada vez | La memoria se mantiene plana; aquí corre casi todo |
| **3 — exacto en disco** | Cumple promesas sobre una **columna terminada**, como `uniq` | La memoria queda acotada, a cambio de una ordenación externa |

La diferencia entre el 2 y el 3 es la que conviene retener, y no es de grado. La unicidad es
una promesa sobre el **conjunto terminado**, no sobre una fila cualquiera, así que no puede
resolverse fila a fila: el motor de flujo tendría que saber qué viene después. Por eso la
segunda tabla compara el motor 1 con el motor **3**: el 2 ni siquiera es candidato para esa
configuración.

[Salidas grandes](large-outputs.md#top) tiene el relato completo, incluidas las cinco formas de
configuración que devuelven una ejecución al motor 1.

## Una configuración corriente

Seis campos elegidos para costar cosas distintas, no para parecer realistas: un contador, dos
sorteos ponderados de un paquete de datos, un reparto porcentual exacto, un número con
decimales, una fecha y un valor montado a partir de otros dos.

```xml
<sequence name="Id"><gen type="increment" value="1"/></sequence>
<sequence name="First"><gen type="template" value="person.male.firstName"/></sequence>
<sequence name="Last"><gen type="template" value="person.lastName"/></sequence>
<sequence name="Status"><gen type="text" value="active,trial,closed" percent="70,20,10"/></sequence>
<sequence name="Balance"><gen type="number" value="0..99999" decimals="2"/></sequence>
<sequence name="Joined"><gen type="date" range="2015-01-01..2025-12-31" format="YYYY-MM-DD"/></sequence>
```

### Tiempo

Segundos, el mejor de tres ejecuciones (de dos en el tamaño mayor). Menos es mejor.

| | 10 000 filas | 200 000 filas | 2 000 000 filas |
| :--- | ---: | ---: | ---: |
| **Rust** | 0,05 / 0,04 | 0,87 / 0,89 | **8,97 / 8,82** |
| **Java** | 0,30 / 0,29 | 1,21 / 1,19 | 9,62 / 9,50 |
| **Node.js** | 0,22 / 0,23 | 1,21 / 1,41 | 12,97 / 14,37 |
| **C#** | 0,30 / 0,29 | 1,78 / 1,76 | 14,37 / 15,34 |
| **Python** | 0,55 / 0,66 | 8,35 / 10,24 | 91,30 / 112,11 |

Cada celda es *motor 1 / motor 2*.

![](../../img/guides/performance-time.svg)

*Segundos para dos millones de filas, motor 1 (pálido) frente al motor 2 (verde). Escala logarítmica, porque Python queda a un orden de magnitud del resto.*

- **A** — Rust — crates.io
- **B** — Java — Maven Central
- **C** — Node.js — npm
- **D** — C# — NuGet
- **E** — Python — PyPI

Con diez mil filas se mide sobre todo el arranque: una JVM levantándose, un intérprete de
Python importando. Por debajo de unas cien mil filas, la implementación elegida apenas importa.

### Memoria

Memoria residente máxima, en megabytes. Menos es mejor.

| | 10 000 filas | 200 000 filas | 2 000 000 filas |
| :--- | ---: | ---: | ---: |
| **Rust** | 10,6 / **3,7** | 146 / **3,7** | 1322 / **3,7** |
| **C#** | 53,6 / 48,5 | 187 / 49,4 | 1375 / 49,4 |
| **Python** | 40,0 / 32,1 | 197 / 32,2 | 1529 / 32,3 |
| **Node.js** | 97,6 / 98,0 | 190 / 154 | 1188 / 190 |
| **Java** | 147 / 120 | 885 / 395 | 4140 / 397 |

![](../../img/guides/performance-memory.svg)

*Memoria máxima para dos millones de filas, motor 1 (pálido) frente al motor 2 (verde). Las barras pálidas crecen con el número de filas; las verdes no.*

- **A** — Rust — crates.io
- **B** — Java — Maven Central
- **C** — Node.js — npm
- **D** — C# — NuGet
- **E** — Python — PyPI

**Si solo va a leer una tabla, lea esta.** En el motor 1 la memoria sigue al número de filas:
diez veces más filas, unas diez veces más memoria, en todas las implementaciones. En el motor 2
no se mueve en absoluto: Rust ocupa 3,7 MB tanto con diez mil filas como con dos millones, C#
unos 49 MB y Python unos 32 MB.

Ese es el trato que ofrece el motor de flujo, y no es «más rápido». A veces es incluso algo más
lento. Lo que compra con esas fracciones de segundo es una ejecución cuya memoria puede
predecir antes de lanzarla.

## Una configuración con `uniq`

Combinaciones que no se repiten en toda la ejecución: 150 × 150 × 150 posibilidades, y 200 000
filas ocupan alrededor del seis por ciento del espacio.

```xml
<sequence name="Pair" uniq="true">
  <gen type="text" name="City" value="C000,C001,…,C149"/>
  <gen type="text" name="Grade" value="G000,G001,…,G149"/>
  <gen type="text" name="Slot" value="S000,S001,…,S149"/>
</sequence>
```

200 000 filas, segundos y megabytes máximos, *motor 1 / motor 3*:

| | Tiempo | Memoria |
| :--- | ---: | ---: |
| **Java** | 0,96 / 1,32 | 793 / 637 |
| **Rust** | 1,03 / 1,22 | 216 / 138 |
| **Node.js** | 1,26 / 1,91 | 264 / 204 |
| **C#** | 1,35 / 1,60 | 188 / **113** |
| **Python** | 4,79 / 8,23 | 209 / **76** |

![](../../img/guides/performance-uniq.svg)

*Memoria máxima con una configuración uniq y doscientas mil filas: motor 1 (pálido) frente al motor 3 (verde). El motor 2 no puede ejecutar esta configuración.*

- **A** — Rust — crates.io
- **B** — Java — Maven Central
- **C** — Node.js — npm
- **D** — C# — NuGet
- **E** — Python — PyPI

Aquí el motor 3 es más lento y más ligero, que es justamente el trato para el que existe. Su
coste además crece más deprisa que el del motor 1 a medida que suben las filas, porque verifica
con una ordenación externa. Por eso una ejecución muy grande con `uniq` es el único caso de
esta página en el que conviene medir su propia configuración en vez de leer una tabla.

> [!NOTE]
> **Los dos motores producen datos distintos — y no pasa nada**
>
> Con una configuración `uniq`, los motores 1 y 3 disponen los valores de forma distinta. Ambos
> resultados son válidos, ambos son exactamente reproducibles y, dentro de cada motor, las cinco
> implementaciones coinciden byte a byte. Difieren entre sí porque llegan a la unicidad por
> caminos distintos.
>
> En la práctica no puede sorprenderle: el motor se elige a partir de la configuración, así que
> una configuración obtiene siempre un motor y por tanto una respuesta. Tendría que forzar el
> motor a mano para ver la diferencia, que es también la razón para no forzarlo a la ligera.

## Repetirlo usted mismo

El arnés está en el repositorio e instala por sí solo las líneas de comandos publicadas:

```bash
python3 bench/cli_bench.py --config customers --tier all --repeats 3
```

`python3 bench/cli_bench.py --config customers --tier medium`

```
=== customers medium: 200 000 rows
  npm        e1     1.21s     189.9 MB  3bca9c07410bf117
  pypi       e1     8.35s     196.9 MB  3bca9c07410bf117
  crates.io  e1     0.87s     146.1 MB  3bca9c07410bf117
  nuget      e1     1.78s     187.0 MB  3bca9c07410bf117
  maven      e1     1.21s     885.2 MB  3bca9c07410bf117

every implementation produced identical bytes, on every engine it ran
```

El hash al final de cada línea es lo importante: es el mismo en las cinco, así que los tiempos
son comparables porque el trabajo lo era.

## Vea también

- **[Salidas grandes](large-outputs.md#top)** — los motores al completo y cómo mantener una
  ejecución grande dentro de su memoria.
- **[Valores únicos](../constructs/unique-values.md#top)** — qué promete `uniq` y qué cuesta.
- **[Referencia de la CLI](../reference/cli.md#top)** — `--jobs`, `--engine`, `--now`.

---

← Anterior: [Escribir un generador de servicio](./writing-a-service.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Descripción general](../data-packs/overview.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/guides/performance)**
