<a name="top"></a>

[English](../../reference/compute.md#top) · [Русский](../../ru/reference/compute.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/reference/compute)**

← Anterior: [Generadores](./generators.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Valores integrados](./builtins.md#top) →

---

# Referencia de funciones de cálculo

Todas las etiquetas del sublenguaje [`<compute>`](../compute/overview.md#top), agrupadas. La
sección [Lenguaje de cálculo](../compute/overview.md#top) explica cómo encajan entre sí.

Cómo leer la columna «Firma»: `int|str|list` es cualquiera de los tres tipos, `…` es
cualquier cantidad de hijos, `?` marca un atributo opcional, `1` es exactamente una
expresión hija y `—` significa que la etiqueta no da un valor propio. Las ranuras — los
hijos con un puesto — aparecen por nombre en la firma de la etiqueta que las posee.

## Literales y referencias

A fondo: [El sublenguaje compute](../compute/overview.md#top)

| Etiqueta                                                                   | Firma                      | Qué hace                                                        |
| :------------------------------------------------------------------------- | :------------------------- | :-------------------------------------------------------------- |
| [`<int>`](../compute/overview.md#top)                                         | `v=` → `int`               | Un literal entero (atributo `v`)                                |
| [`<str>`](../compute/strings.md#str--un-literal-de-string)                | `v=` → `str`               | Un literal de cadena (atributo `v`)                             |
| [`<list>`](../compute/lists.md#list--una-lista-literal-de-valores)        | `v=` o `int…` → `list`     | Una lista literal de enteros, o armada con expresiones anidadas |
| [`<field>`](../compute/overview.md#un-valor-de-un-field-es-un-string)     | `name=` → `str`            | El valor de una secuencia en el ámbito — como `${{X}}`          |
| [`<use>`](../compute/overview.md#let-nombra-un-valor-una-vez-use-lo-vuelve-a-leer) | `name=` → `int\|str\|list` | Un valor ligado con `<let>`                                     |
| [`<let>`](../compute/overview.md#let-nombra-un-valor-una-vez-use-lo-vuelve-a-leer) | `name=` + 1 → `—`          | Nombra un resultado intermedio para las etiquetas hermanas      |
| [`<current>`](../compute/lists.md#each--mapear-sobre-una-lista)           | → `int\|str`               | El elemento actual de la iteración (dentro de `<do>`)           |
| [`<current_index>`](../compute/lists.md#each--mapear-sobre-una-lista)     | → `int`                    | El índice del elemento actual, desde cero                       |
| [`<acc>`](../compute/lists.md#reduce--plegar-a-un-solo-valor)             | → `int\|str\|list`         | El acumulador (dentro de `<reduce>`)                            |

## Listas e iteración

A fondo: [Listas e iteración](../compute/lists.md#top)

| Etiqueta                                                               | Firma                                       | Qué hace                                    |
| :--------------------------------------------------------------------- | :------------------------------------------ | :------------------------------------------ |
| [`<each>`](../compute/lists.md#each--mapear-sobre-una-lista)          | `<over>` `<do>` → `list`                    | Transforma cada elemento → una lista        |
| [`<reduce>`](../compute/lists.md#reduce--plegar-a-un-solo-valor)      | `<over>` `<init>` `<do>` → `int\|str\|list` | Pliega una lista en un solo valor (`<acc>`) |
| [`<join>`](../compute/lists.md#join--de-lista-a-string)               | `list` + `sep=?` → `str`                    | Lista → cadena (atributo `sep`)             |
| [`<split>`](../compute/lists.md#split--una-cadena-a-una-lista)        | `str` + `sep=` → `list`                     | Cadena → lista, corte por `sep` (obligatorio) |
| [`<at>`](../compute/lists.md#at--indexar-una-lista)                   | `<in>` `<index>` + `default=?` → `int\|str` | Elemento por índice (atributo `default`)    |
| [`<length>`](../compute/lists.md#length--medir-un-string-o-una-lista) | `str\|list` → `int`                         | Largo de una cadena o de una lista          |

## Aritmética

A fondo: [Aritmética](../compute/arithmetic.md#top)

| Etiqueta                                           | Firma               | Qué hace                              |
| :------------------------------------------------- | :------------------ | :------------------------------------ |
| [`<add>`](../compute/arithmetic.md#add)           | `int…` → `int`      | Suma de todos los hijos (vacío → 0)   |
| [`<subtract>`](../compute/arithmetic.md#subtract) | `int…` → `int`      | El primero menos la suma de los demás |
| [`<multiply>`](../compute/arithmetic.md#multiply) | `int…` → `int`      | Producto (vacío → 1)                  |
| [`<divide>`](../compute/arithmetic.md#divide)     | `int` `int` → `int` | División entera hacia −∞ (2 hijos)    |
| [`<mod>`](../compute/arithmetic.md#mod)           | `int` `int` → `int` | Residuo euclidiano, siempre ≥ 0       |

## Cadenas, codificación y formato

A fondo: [Cadenas y formato](../compute/strings.md#top)

| Etiqueta                                                                                                                                                                                    | Firma                                  | Qué hace                                                |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------- | :------------------------------------------------------ |
| [`<encode>`](../compute/arithmetic.md#encode-as)                                                                                                                                           | `str`(1) + `as=` → `str`               | Carácter → número (`base36`/`ascii`/`hex`/…)            |
| [`<to_number>`](../compute/arithmetic.md#to_number)                                                                                                                                        | `str` → `int`                          | Cadena de dígitos → entero                              |
| [`<pad>`](../compute/strings.md#pad--rellenar-a-la-izquierda-hasta-un-ancho-fijo)                                                                                                          | `int\|str` + `width=` `fill=?` → `str` | Rellena a la izquierda hasta un ancho (`width`, `fill`) |
| [`<concat>`](../compute/strings.md#concat--pegar-partes-en-un-string)                                                                                                                      | `int\|str…` → `str`                    | Une varias partes en una cadena                         |
| [`<upper>`](../compute/strings.md#upper--lower--capitalize--title--mayúsculas-y-minúsculas) / [`<lower>`](../compute/strings.md#upper--lower--capitalize--title--mayúsculas-y-minúsculas) | `str` → `str`                          | Mayúsculas / minúsculas                                 |
| [`<capitalize>`](../compute/strings.md#upper--lower--capitalize--title--mayúsculas-y-minúsculas)                                                                                           | `str` → `str`                          | Primera letra en mayúscula                              |
| [`<title>`](../compute/strings.md#upper--lower--capitalize--title--mayúsculas-y-minúsculas)                                                                                                | `str` → `str`                          | Primera letra de cada palabra en mayúscula              |
| [`<mask>`](../compute/strings.md#mask--dividir-y-reacomodar-según-un-patrón)                                                                                                               | `str` + `pattern=` → `str`             | Máscara de despliegue (`pattern`: `x`/`w`/`*`)          |
| [`<slice>`](../compute/strings.md#slice--substring-por-índices)                                                                                                                            | `str` + `from=` `to=?` → `str`         | Subcadena `[from, to)`                                  |
| [`<replace>`](../compute/strings.md#replace--reemplazar-todas-las-apariciones)                                                                                                             | `str` + `from=` `to=` → `str`          | Reemplaza todas las apariciones (`from`, `to`)          |
| [`<trim>`](../compute/strings.md#trim--quitar-los-espacios-de-las-orillas)                                                                                                                 | `str` → `str`                          | Quita los espacios de los extremos                      |
| [`<group>`](../compute/strings.md#group--agrupar-caracteres-desde-la-derecha)                                                                                                              | `str` + `size=?` `sep=?` → `str`       | Agrupa desde la derecha (`size`, `sep`)                 |

## Condicionales

A fondo: [Condicionales](../compute/conditionals.md#top)

| Etiqueta                                                                              | Firma                                      | Qué hace                                      |
| :------------------------------------------------------------------------------------ | :----------------------------------------- | :-------------------------------------------- |
| [`<choose>`](../compute/conditionals.md#choose--elegir-la-primera-rama-que-coincida) | `<when>…` `<otherwise>` → `int\|str\|list` | Elige una rama; requiere `<otherwise>`        |
| [`<when>`](../compute/conditionals.md#when--una-rama)                                | `<test>` `<then>` → `—`                    | Una rama: predicado `<test>` + valor `<then>` |
| [`<otherwise>`](../compute/conditionals.md#otherwise-es-obligatorio--error-tdc184)   | 1 → `int\|str\|list`                       | La rama «si no» (obligatoria)                 |
| [`<test>`](../compute/conditionals.md#test--la-ranura-de-la-condición)               | 1 → `yes\|no`                              | Contiene un predicado, da sí/no               |
| [`<then>`](../compute/conditionals.md#when--una-rama)                                | 1 → `int\|str\|list`                       | El valor de la rama que coincidió             |
| [`<equals>`](../compute/conditionals.md#equals--dos-enteros-son-iguales)             | `int` `int` → `yes\|no`                    | Predicado: dos enteros son iguales            |
| [`<greater_than>`](../compute/conditionals.md#greater_than--a--b-estricto)           | `int` `int` → `yes\|no`                    | Predicado: A > B                              |
| [`<less_than>`](../compute/conditionals.md#less_than--a--b-estricto)                 | `int` `int` → `yes\|no`                    | Predicado: A < B                              |
| [`<is_digit>`](../compute/conditionals.md#is_digit--un-carácter-es-09)               | `str`(1) → `yes\|no`                       | Predicado: un carácter es un dígito 0–9       |

## Envoltorios y especiales

| Etiqueta                                                              | Firma                | Qué hace                                             |
| :-------------------------------------------------------------------- | :------------------- | :--------------------------------------------------- |
| [`<over>`](../compute/lists.md#each--mapear-sobre-una-lista)         | 1 → `str\|list`      | La lista de entrada para `<each>` / `<reduce>`       |
| [`<do>`](../compute/lists.md#each--mapear-sobre-una-lista)           | 1 → `int\|str\|list` | El cuerpo de la iteración para `<each>` / `<reduce>` |
| [`<init>`](../compute/lists.md#reduce--plegar-a-un-solo-valor)       | 1 → `int\|str\|list` | El valor inicial del acumulador para `<reduce>`      |
| [`<in>`](../compute/lists.md#at--indexar-una-lista)                  | 1 → `list`           | La lista para `<at>`                                 |
| [`<index>`](../compute/lists.md#at--indexar-una-lista)               | 1 → `int`            | El índice del elemento para `<at>`                   |
| [`<result>`](../compute/overview.md#top)                                 | 1 → `int\|str\|list` | El valor final de un `<compute>`                     |
| [`<valid>`](../compute/conditionals.md#valid--rechazar-y-reintentar) | 1 → `—`              | Rechaza y reintenta hasta obtener algo válido        |

Vea la sección [Lenguaje de cálculo](../compute/overview.md#top) para ejemplos resueltos.

---

← Anterior: [Generadores](./generators.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Valores integrados](./builtins.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/reference/compute)**
