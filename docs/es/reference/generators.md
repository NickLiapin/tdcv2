<a name="top"></a>

[English](../../reference/generators.md#top) · [Русский](../../ru/reference/generators.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/reference/generators)**

← Anterior: [Atributos](./attributes.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Funciones de cálculo](./compute.md#top) →

---

# Referencia de generadores

Todos los valores de `type` para [`<gen>`](../generators/overview.md#top). Cada uno enlaza a su página completa.

| `type`                                                  | Qué produce                                                         |
| :------------------------------------------------------ | :------------------------------------------------------------------ |
| [`text`](../generators/text.md#top)                        | Un valor de un conjunto — uniforme o por `percent` exactos          |
| [`number`](../generators/number.md#top)                    | Un entero dentro de un rango, o una cadena de dígitos de ancho fijo |
| [`template`](../generators/template.md#top)                | Datos realistas integrados e identificadores técnicos               |
| [`file`](../generators/file.md#top)                        | Valores de sus propios archivos y columnas de CSV                   |
| [`date`](../generators/date.md#top)                        | Una fecha o fecha-hora en un rango y formato dados                  |
| [`symbol`](../generators/symbol.md#top)                    | Una cadena de caracteres de un conjunto o de un alfabeto con nombre |
| [`regex`](../generators/regex.md#top)                      | Una cadena que coincide con una expresión regular finita            |
| [`advanced_regex`](../generators/advanced-regex.md#top)    | Regex más elección ponderada entre alternativas                     |
| [`increment` / `decrement`](../generators/counters.md#top) | Contadores ascendentes y descendentes                               |
| [`timeseries`](../generators/timeseries.md#top)            | Una serie de tiempo — tendencia + estacionalidad + ruido            |
| [`pattern`](../generators/pattern.md#top)                  | Una distribución con la forma de una curva dibujada                 |
| [`http`](../generators/http.md#top)                        | Un valor de un servicio suyo, vía HTTP                              |
| [`pool`](../pools/overview.md#top)                         | Un miembro entero de un `<pool>` — un registro, no un valor         |
| [`running`](../generators/running.md#top)                  | Un total acumulado por la columna, no sorteado                      |
| [`stat`](../generators/stat.md#top)                        | Un número sobre toda la ejecución, en cada fila                     |

## Atributos transversales

Estos funcionan con **cualquier** generador (vea [Máscaras y mayúsculas](../guides/masks-and-case.md#top)):

- `case=` / `mask=` — mayúsculas/minúsculas y máscaras de despliegue;
- `missing=` — deja en blanco una parte de las celdas.

Estos dos necesitan que el generador produzca algo sobre lo que puedan actuar, y a
partir de ahí se separan: `order=`/`cycle=` se RECHAZAN en los demás casos, mientras que
`anomaly=` mira el valor y no el generador:

- `order=` / `cycle=` — orden de los valores (aleatorio por omisión, o `sequential`).
  Recorre algo, así que lo leen exactamente tres generadores:
  [`text`](../generators/text.md#top), [`file`](../generators/file.md#top) y
  [`date`](../generators/date.md#top) — un rango de fechas se recorre paso a paso. **En
  cualquier otro tipo se rechaza** ([TDC015](errors.md#top)), no se ignora:
  [`number`](../generators/number.md#top) toma su valor de un rango y no tiene nada que
  recorrer, y lo mismo vale para una expresión regular, una plantilla, un símbolo, un
  contador, un dibujo, una serie o un estadístico.
- `anomaly=` — empuja una parte de los valores fuera del rango multiplicándolos. La
  regla es sobre el **valor**, no sobre el generador: se multiplica todo lo que se lea
  como número, incluida una cadena numérica de [`text`](../generators/text.md#top),
  [`file`](../generators/file.md#top) o un pack. Lo demás — un nombre, una ciudad — pasa sin
  cambios y **sin aviso**, porque para eso no existe un «más afuera».
  Vea [Anomalías y valores faltantes](../guides/anomalies.md#top).

Vea también la [descripción general de los generadores](../generators/overview.md#top).

---

← Anterior: [Atributos](./attributes.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Funciones de cálculo](./compute.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/reference/generators)**
