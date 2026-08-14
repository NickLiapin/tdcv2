<a name="top"></a>

[English](../../reference/attributes.md#top) · [Русский](../../ru/reference/attributes.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/reference/attributes)**

← Anterior: [Etiquetas](./tags.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Generadores](./generators.md#top) →

---

# Referencia de atributos

Todos los atributos del DSL de etiquetas, con una descripción de una línea y el lugar
donde se explican.

Las etiquetas `<compute>` llevan sus propios atributos (`v`, `sep`, `as`, `width`,
`fill`, `from`, `to`, `size`, `pattern`, `default`). Cada uno pertenece a una sola
etiqueta y se explica donde se explica esa etiqueta — ver la
[referencia de compute](compute.md#top).

## Entorno y configuración

| Atributo        | Qué define                                         | Ver                                                        |
| :-------------- | :------------------------------------------------- | :--------------------------------------------------------- |
| `version` / `v` | Versión del DSL que requiere el archivo            | [Configuración](../core-concepts/configuration.md#top)        |
| `count`         | Cantidad de registros                              | [Determinismo](../core-concepts/determinism.md#top)           |
| `seed`          | Semilla del generador aleatorio (reproducibilidad) | [Determinismo](../core-concepts/determinism.md#top)           |
| `local`         | Locale de los datos de plantilla — en `<env>` para toda la ejecución y en un `<gen type="template">` para sobrescribirlo solo en esa secuencia | [Template](../generators/template.md#top)                     |
| `inject`        | Marcador de interpolación propio                   | [Salida y formato](../core-concepts/output-formatting.md#top) |
| `mode`          | `memory` / `disk` — familia de motores; `stream` es un alias heredado que fuerza el motor 2 | [Salidas grandes](../guides/large-outputs.md#top)             |
| `engine`        | `1` / `2` / `3` — forzar un motor (avanzado)       | [Salidas grandes](../guides/large-outputs.md#top)             |
| `comment`       | Comentario libre                                   | [Configuración](../core-concepts/configuration.md#top)        |

## Secuencias y dependencias

| Atributo    | Qué define                                                                                                                                                                           | Ver                                                                 |
| :---------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------ |
| `name`      | En `<sequence>`: su nombre. En `<gen>`: lo convierte en un campo, `Secuencia.Campo`. En un `<data>` dentro de una secuencia: un campo constante, el único que no cuesta ni un sorteo | [Secuencias](../core-concepts/sequences.md#un-campo-constante)     |
| `parent`    | Filtro por padre `Parent.Value`                                                                                                                                                      | [Dependencias jerárquicas](../guides/hierarchical-dependencies.md#top) |
| `uniq`      | Combinación única en todas las filas                                                                                                                                                 | [Valores únicos](../constructs/unique-values.md#top)                   |
| `on` / `is` | Sujeto / clave de rama para `<switch>`                                                                                                                                               | [Switch](../constructs/switch.md#top)                                  |
| `filter`    | En `<gen type="pool">`: de qué miembros puede sortear esta fila                                                                                                                      | [Registros coherentes](../pools/filter.md#top)                         |
| `of`        | En `<gen type="running">`: la columna que se acumula. En `<gen type="stat">`: la columna a resumir. En `<gen type="date">`: la columna desde la que medir                                                                                   | [Total acumulado](../generators/running.md#top), [Estadística](../generators/stat.md#top) |
| `plus`      | En `<gen type="date" of="…">`: cuánto desde esa columna — `7d`, `3..10d`, `1..3mo`, `-10..-3d`; un número a secas significa días | [Un intervalo](../generators/date.md#top) |
| `op`        | En `<gen type="stat">`: qué estadística — `sum`, `mean`, `median`, `min`, `max`, `count` o `stddev`                                                                                  | [Estadística](../generators/stat.md#top)                               |
| `expr`      | En `<gen type="formula">`: la aritmética que ES esta columna, escrita como se escribe una condición `if=`                                                                                  | [Fórmula](../generators/formula.md#top)                               |
| `that`      | En `<assert>`: la condición que la ejecución terminada debe cumplir, en el lenguaje de `if=`                                                                  | [Configuraciones que se comprueban solas](../constructs/self-checking.md#top) |
| `says`      | En `<assert>`: la frase que recibe quien lee cuando no se cumple                                                                                              | [Configuraciones que se comprueban solas](../constructs/self-checking.md#top) |
| `reset`     | En `<gen type="running">`: una columna cuyo cambio reinicia el total                                                                                                                 | [Total acumulado](../generators/running.md#top)                        |

## Valores de los generadores

| Atributo              | Qué define                                                                                       | Ver                                                                                                                    |
| :-------------------- | :----------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------- |
| `type`                | Qué generador se usa                                                                             | [Generadores](../generators/overview.md#top)                                                                              |
| `value`               | El valor principal del generador (según el tipo)                                                 | [Generadores](../generators/overview.md#top)                                                                              |
| `percent`             | Distribución exacta de los valores                                                               | [Text](../generators/text.md#top)                                                                                         |
| `accumulate`          | Reemplazar una lista `repeat` por su total acumulado, o decir cómo acumula una columna `running` | [Varios valores en una celda](../constructs/multiple-values.md#accumulate--un-total-acumulado-a-lo-largo-de-la-lista) |
| `alphabet`            | Alfabeto Unicode con nombre                                                                      | [Symbol](../generators/symbol.md#top)                                                                                     |
| `length`              | Largo / ancho de la salida                                                                       | [Number](../generators/number.md#top)                                                                                     |
| `first_zero`          | Permitir un cero inicial                                                                         | [Number](../generators/number.md#top)                                                                                     |
| `weekdays`            | Qué días de la semana conserva un eje de fechas recorrido: `mon..fri`, `sun,wed`                 | [Fecha](../generators/date.md#top)                                                                                        |
| `step`                | Paso del contador, o cuánto avanza un eje de fechas recorrido: `15m`, `1h30m`, `3mo`             | [Contadores](../generators/counters.md#top), [Fecha](../generators/date.md#top)                                               |
| `regex_max_length`    | Tope de longitud para el regex                                                                   | [Regex](../generators/regex.md#top)                                                                                       |
| `include` / `exclude` | Conservar o descartar valores del conjunto                                                       | [Number](../generators/number.md#top)                                                                                     |
| `decimals`            | Dígitos después del punto decimal                                                                | [Number](../generators/number.md#top)                                                                                     |
| `oldest` / `youngest` | Ventana de edad para la fecha de nacimiento                                                      | [Date](../generators/date.md#top)                                                                                         |
| `format`              | Formato de salida de la fecha                                                                    | [Date](../generators/date.md#top)                                                                                         |
| `from` / `to`         | Extremos del rango dados por separado                                                            | [Date](../generators/date.md#top)                                                                                         |
| `precision`           | Paso para un rango con fecha y hora                                                              | [Date](../generators/date.md#top)                                                                                         |
| `range`               | Rango de fechas para `date.range`                                                                | [Template](../generators/template.md#top)                                                                                 |

## Forma estadística

| Atributo         | Qué define                                    | Ver                                                       |
| :--------------- | :-------------------------------------------- | :-------------------------------------------------------- |
| `distribution`   | Distribución con nombre (`normal`, `zipf`, …) | [Distribuciones](../guides/statistical-distributions.md#top) |
| `min` / `max`    | Recortar los valores sorteados a un rango     | [Distribuciones](../guides/statistical-distributions.md#top) |
| `missing`        | Proporción de filas dejadas vacías            | [Datos faltantes](../guides/missing-data.md#top)             |
| `missing_as`     | Cómo se escribe una celda vacía               | [Datos faltantes](../guides/missing-data.md#top)             |
| `anomaly`        | Proporción de filas convertidas en atípicas   | [Anomalías](../guides/anomalies.md#top)                      |
| `anomaly_factor` | Cuán lejos se empuja un valor atípico         | [Anomalías](../guides/anomalies.md#top)                      |
| `anomaly_flag`   | Columna-respuesta que marca los atípicos      | [Anomalías](../guides/anomalies.md#top)                      |

**Cada distribución tiene sus propios parámetros**, y solo se leen cuando
`distribution=` nombra esa distribución. Todas aceptan además `decimals`, `min` y
`max`. Cada una está explicada, con un histograma, en la
[guía de distribuciones](../guides/statistical-distributions.md#top).

| `distribution=` | Parámetros        | Qué significan                                                                          |
| :-------------- | :---------------- | :-------------------------------------------------------------------------------------- |
| `normal`        | `mean` `sd`       | El centro y la dispersión                                                               |
| `lognormal`     | `meanlog` `sdlog` | El centro y la dispersión **del logaritmo** — el valor en sí queda sesgado a la derecha |
| `exponential`   | `rate`            | Eventos por unidad de tiempo; la media es `1/rate`                                      |
| `pareto`        | `alpha` `xmin`    | El grosor de la cola y el valor mínimo posible                                          |
| `weibull`       | `shape` `scale`   | `shape` menor que 1 = fallos tempranos, mayor = desgaste; `scale` fija la vida típica   |
| `poisson`       | `lambda`          | Recuento medio por intervalo (tope de 700)                                              |
| `zipf`          | `n` `s`           | Cuántos rangos, y con qué pendiente caen                                                |
| `gamma`         | `shape` `scale`   | Espera total de `shape` eventos que tardan `scale` de media                             |
| `beta`          | `alpha` `beta`    | Tiran hacia 1 y hacia 0 — el resultado queda entre 0 y 1                                |

## Series temporales

| Atributo    | Qué define                     | Ver                                               |
| :---------- | :----------------------------- | :------------------------------------------------ |
| `base`      | Nivel inicial de la serie      | [Series temporales](../generators/timeseries.md#top) |
| `trend`     | Deriva por paso                | [Series temporales](../generators/timeseries.md#top) |
| `period`    | Largo de un ciclo estacional   | [Series temporales](../generators/timeseries.md#top) |
| `amplitude` | Altura del vaivén estacional   | [Series temporales](../generators/timeseries.md#top) |
| `peak_at`   | En qué fila alcanza su máximo la onda estacional | [Series temporales](../generators/timeseries.md#top) |
| `noise`     | Ruido aleatorio añadido encima | [Series temporales](../generators/timeseries.md#top) |

## Pattern (un dibujo como fuente)

| Atributo          | Qué define                                               | Ver                                  |
| :---------------- | :------------------------------------------------------- | :----------------------------------- |
| `points`          | Pares `x,y` escritos en línea en vez de un archivo       | [Pattern](../generators/pattern.md#top) |
| `upper` / `lower` | Dos curvas límite — un corredor                          | [Pattern](../generators/pattern.md#top) |
| `mode`            | `signal` (trayectoria) / `density` (distribución)        | [Pattern](../generators/pattern.md#top) |
| `y_range`         | `min..max` — la escala vertical (**obligatorio**)        | [Pattern](../generators/pattern.md#top) |
| `fit`             | `bajo..alto` — dónde cae un dibujo de `src`              | [Pattern](../generators/pattern.md#top) |
| `interp`          | `linear` / `smooth` / `step` entre puntos                | [Pattern](../generators/pattern.md#top) |
| `spread`          | Convertir la línea en un túnel de ancho ±N               | [Pattern](../generators/pattern.md#top) |
| `ink_threshold`   | Cuán oscuro debe ser un píxel PNG para contar como tinta | [Pattern](../generators/pattern.md#top) |

`mode` son dos atributos distintos que comparten nombre: en `<env>` elige la familia de
motores; en un generador `pattern` elige la pregunta que se le hace al dibujo.

## Archivos y CSV

| Atributo    | Qué define                                  | Ver                                             |
| :---------- | :------------------------------------------ | :---------------------------------------------- |
| `src`       | Ruta a un archivo de datos                  | [File](../generators/file.md#top)                  |
| `column`    | Columna del CSV (nombre o número)           | [File](../generators/file.md#top)                  |
| `header`    | Omitir la primera fila del CSV              | [File](../generators/file.md#top)                  |
| `delimiter` | Separador del CSV                           | [File](../generators/file.md#top)                  |
| `row`       | Clave de fila vinculada                     | [File](../generators/file.md#top)                  |
| `weight`    | Columna de frecuencia para filas ponderadas | [Datos coherentes](../guides/coherent-data.md#top) |
| `read`      | `"quantile"` — leer el archivo como muestra ordenada y caer en cualquier punto | [Archivo](../generators/file.md#top) |
| `sample`    | `"exact"` — recorrer esa distribución de forma uniforme en vez de sortear | [Archivo](../generators/file.md#top) |

## Servicio HTTP

| Atributo   | Qué define                                 | Ver                                     |
| :--------- | :----------------------------------------- | :-------------------------------------- |
| `src`      | URL del servicio (también la ruta, arriba) | [Servicio HTTP](../generators/http.md#top) |
| `in`       | Secuencia cuyo valor se envía por fila     | [Servicio HTTP](../generators/http.md#top) |
| `on_error` | `fail` (def.) / `empty` ante un fallo      | [Servicio HTTP](../generators/http.md#top) |
| `timeout`  | Segundos a esperar la respuesta (def. 30)  | [Servicio HTTP](../generators/http.md#top) |
| `secret`   | Clave con la que se firma cada petición — `env:`, `file:` o un literal | [Servicio HTTP](../generators/http.md#probar-que-la-petición-viene-de-tdc) |

## Salida y formato

| Atributo               | Qué define                                           | Ver                                                        |
| :--------------------- | :--------------------------------------------------- | :--------------------------------------------------------- |
| `if`                   | Condición de despliegue (expresión)                  | [Salida y formato](../core-concepts/output-formatting.md#top) |
| `pair`                 | Marcador emparejado para un `</data>` literal        | [Salida y formato](../core-concepts/output-formatting.md#top) |
| `mask`                 | Máscara de despliegue (`x`/`w`/`*`)                  | [Máscaras y mayúsculas](../guides/masks-and-case.md#top)      |
| `case`                 | Mayúsculas y minúsculas (`upper`/`lower`/…)          | [Máscaras y mayúsculas](../guides/masks-and-case.md#top)      |
| `order`                | Orden de los valores (`random` / `sequential`) — solo `text`, `file` y `date` | [Generadores](../generators/overview.md#top)                  |
| `cycle`                | Con `sequential`: repetir el ciclo o dar error — los mismos tres tipos | [Generadores](../generators/overview.md#top)                  |
| `repeat` / `separator` | Varios valores en una misma celda                    | [Varios valores](../constructs/multiple-values.md#top)        |
| `lengths`   | Junto a `repeat="A..B"`: la proporción de filas que recibe cada longitud posible, empezando por `A` — una cuota exacta, no una aproximación                                                        | [Varios valores](../constructs/multiple-values.md#top)                  |
| `distinct` | Sin repeticiones dentro de una celda (necesita `repeat`) | [Varios valores](../constructs/multiple-values.md#top)        |
| `each`                 | Repetir una línea por cada elemento de la lista      | [Tablas relacionales](../constructs/relational-tables.md#top) |
| `flag`                 | Columna de respuesta para marcar outliers de `<mix>` | [Mix](../constructs/mix.md#top)                               |

---

← Anterior: [Etiquetas](./tags.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Generadores](./generators.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/reference/attributes)**
