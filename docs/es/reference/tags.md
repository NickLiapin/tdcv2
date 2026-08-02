<a name="top"></a>

[English](../../reference/tags.md#top) · [Русский](../../ru/reference/tags.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/reference/tags)**

← Anterior: [CLI](./cli.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Atributos](./attributes.md#top) →

---

# Referencia de etiquetas

Todas las etiquetas del DSL de TDC, con el lugar donde se explican a fondo.

## Estructura

| Etiqueta            | Qué es                                         | Ver                                                |
| :------------------ | :--------------------------------------------- | :------------------------------------------------- |
| `<!--…-->`          | Un comentario                                  | —                                                  |
| `<tdc>`             | El elemento raíz                               | [Configuración](../core-concepts/configuration.md#top) |
| `<env>`             | Entorno: parámetros, secuencias, fixtures      | [Configuración](../core-concepts/configuration.md#top) |
| `<sequence>`        | La declaración de una secuencia con nombre     | [Secuencias](../core-concepts/sequences.md#top)       |
| `<gen>`             | Un generador de datos                          | [Generadores](../generators/overview.md#top)          |
| `<data>`            | Dentro de una `<sequence>`: texto literal que se concatena en el valor de la secuencia; con `name`, un campo constante | [Secuencias](../core-concepts/sequences.md#una-secuencia-compuesta-por-valor) |
| `<compute>`         | Un valor calculado                             | [Lenguaje de cálculo](../compute/overview.md#top)     |

## Diseño de la salida

| Etiqueta            | Qué es                                         | Ver                                                |
| :------------------ | :--------------------------------------------- | :------------------------------------------------- |
| `<block>`           | El diseño de un registro de salida             | [Salida y formato](../core-concepts/output-formatting.md#top) |
| `<line>`            | Una línea dentro de un registro                | [Salida y formato](../core-concepts/output-formatting.md#top) |
| `<data>`            | Dentro de una `<line>`: texto literal con interpolación | [Salida y formato](../core-concepts/output-formatting.md#top) |
| `<before>` / `<after>` | Texto antes / después de toda la generación | [Salida y formato](../core-concepts/output-formatting.md#top) |
| `<before_block>` / `<after_block>` / `<delimiter_block>` | Texto alrededor / entre registros | [Salida y formato](../core-concepts/output-formatting.md#top) |
| `<before_line>` / `<after_line>` / `<delimiter_line>` | Texto alrededor / entre líneas | [Salida y formato](../core-concepts/output-formatting.md#top) |

## Distribuciones y selección

| Etiqueta            | Qué es                                                  | Ver                                                |
| :------------------ | :------------------------------------------------------ | :------------------------------------------------- |
| `<mix>`             | Una distribución: un valor repartido por porcentajes exactos | [Distribuciones (mix)](../constructs/mix.md#top)     |
| `<switch>`          | Elegir un valor por clave (una tabla de búsqueda)       | [Tablas de búsqueda (switch)](../constructs/switch.md#top) |
| `<map>`             | Una tabla compacta `CLAVE:VALOR` dentro de `<switch>`   | [Tablas de búsqueda (switch)](../constructs/switch.md#top) |
| `<case>`            | Una rama dentro de `<mix>` o `<switch>`                 | [Distribuciones (mix)](../constructs/mix.md#top) · [Tablas de búsqueda (switch)](../constructs/switch.md#top) |
| `<default>`         | La rama «si no» dentro de `<switch>`                    | [Tablas de búsqueda (switch)](../constructs/switch.md#top) |

## Registros enteros

| Etiqueta            | Qué es                                                  | Ver                                                |
| :------------------ | :----------------------------------------------------- | :------------------------------------------------- |
| `<pool>`            | Una tabla pequeña construida antes de las filas; una fila toma de ella un miembro entero | [Registros coherentes (pool)](../pools/overview.md#top) |

## Unicidad

| Etiqueta            | Qué es                                                  | Ver                                       |
| :------------------ | :------------------------------------------------------ | :---------------------------------------- |
| `<distinct>`        | Campos/secuencias que deben diferir dentro de una fila  | [Sin repeticiones dentro de una fila](../guides/distinct.md#top) |
| `<uniq>`            | La combinación de secuencias única en todas las filas   | [Valores únicos](../constructs/unique-values.md#top) |

`<data>` aparece dos veces porque se lee de dos maneras. Dentro de una `<line>` es
salida: texto literal en el que se interpolan los `${{…}}`. Dentro de una
`<sequence>` es dato: sin nombre, es el pegamento entre los generadores de una
[secuencia compuesta por valor](../core-concepts/sequences.md#una-secuencia-compuesta-por-valor);
con `name`, es un [campo constante](../core-concepts/sequences.md#un-campo-constante),
el único campo que no cuesta ni un sorteo.

Las etiquetas de cálculo (dentro de `<compute>`) tienen su propia lista en la
[referencia de funciones de cálculo](compute.md#top).

---

← Anterior: [CLI](./cli.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Atributos](./attributes.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/reference/tags)**
