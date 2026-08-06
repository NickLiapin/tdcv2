<a name="top"></a>

[English](../../reference/expressions.md#top) · [Русский](../../ru/reference/expressions.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/reference/expressions)**

← Anterior: [Códigos de error](./errors.md#top) · **[Contenido](../README.md#top)** · Siguiente: [TypeScript](../bindings/typescript.md#top) →

---

# Expresiones

El pequeño lenguaje que vive dentro de `if=` — y dentro de `filter=` en un
[pool](../pools/filter.md#top), que se lee igual. Decide si un `<gen>`, una `<line>`, un
`<case>` o un `<data>` participa en una fila.

```xml
<sequence name="Zone">
  <gen if="Country in [US, CA, MX]" type="text" value="NAFTA"/>
  <gen if="Country in [FR, DE]"     type="text" value="EU"/>
  <gen                              type="text" value="ROW"/>
</sequence>
<sequence name="Handling">
  <gen if="Weight > 20"      type="text" value="freight"/>
  <gen if="_count % 2 == 0"  type="text" value="courier-even"/>
  <gen                       type="text" value="parcel"/>
</sequence>
```

`./run shipping.tdc`

```
US NAFTA 2kg parcel
FR EU 14kg courier-even
CA NAFTA 7kg parcel
DE EU 30kg freight
MX NAFTA 5kg parcel
JP ROW 22kg freight
```

El último `<gen>` de cada secuencia no lleva `if=`, así que recoge todo lo que las
condiciones de arriba dejaron pasar — la misma forma que un `else`.

## Valores

| Usted escribe     | Qué significa                                                              |
| :---------------- | :-------------------------------------------------------------------------- |
| `Country`         | el valor que esa secuencia produjo en esta fila                             |
| `Person.Email`    | un campo de una [secuencia compuesta](../core-concepts/sequences.md#top)       |
| `Gender.Male`     | «¿Gender es Male ahora mismo?» — se lee como `parent="Gender.Male"`          |
| `Male`            | una **palabra desnuda**: un nombre que no es secuencia es su propio texto    |
| `42`, `1.5`       | un número                                                                   |
| `'texto'`         | una cadena entre comillas, cuando el texto lleva espacios o parece un nombre |
| `_count`, `_last` | un [integrado](builtins.md#top) — el número de fila, la marca de última fila    |

La palabra desnuda es lo que permite escribir `Gender == Male` sin comillas. También
significa que **una errata se compara consigo misma y no coincide con nada, en silencio** —
por eso un nombre desconocido a la derecha de un punto lanza [TDC193](errors.md#top) en vez de
pasar.

## Operadores

| Grupo          | Operadores                       |
| :------------- | :------------------------------- |
| comparación    | `== != === !== < > <= >=`        |
| lógica         | `&& \|\| !`                      |
| aritmética     | `+ - * / %`                      |
| pertenencia    | `in`                             |
| elección       | `a ? b : c`                      |

> [!CAUTION]
> **`%` es euclidiano, y eso no es lo que hace su lenguaje**
>
> `-3 % 2` es **1** aquí. JavaScript, Java, C# y Rust responden −1; Python responde 1.
>
> La razón no es de gusto. La [capa compute](compute.md#top) ya tenía `<mod>` y ya respondía 1, así
> que un `%` que tomara prestada la convención del anfitrión haría que un mismo motor diera dos
> respuestas distintas a la misma pregunta según a qué capa acudiera usted.

`in` toma una lista a su derecha y nada más — una lista en cualquier otro sitio lanza
[TDC259](errors.md#top). La comparación de dentro es tan laxa como la de `==`, así que una
columna de texto contra una lista de palabras numéricas sigue coincidiendo.

```xml
<gen if="Country in [US, CA, MX]" .../>   <!-- en vez de tres == unidos por || -->
```

## Funciones

Cada función aquí es **exacta**: está construida con comparaciones y con la aritmética que
IEEE-754 fija sin ambigüedad, así que las cinco implementaciones no pueden discrepar sobre un
resultado.

| Función                    | Toma       | Da                                                 |
| :------------------------- | :--------- | :------------------------------------------------- |
| `abs(x)`                   | 1          | magnitud                                           |
| `ceil(x)` `floor(x)`       | 1          | arriba / abajo al entero                           |
| `trunc(x)`                 | 1          | hacia cero — `trunc(-7.5)` es −7, `floor` da −8    |
| `round(x)`                 | 1          | el más cercano, la mitad **alejándose del cero**   |
| `min(…)` `max(…)`          | 1 o más    | el menor / el mayor                                |
| `len(s)`                   | 1          | cuántos caracteres                                 |
| `is_empty(s)`              | 1          | si el texto está vacío                             |
| `starts_with(s, p)`        | 2          | prueba de prefijo                                  |
| `ends_with(s, p)`          | 2          | prueba de sufijo                                   |
| `contains(s, p)`           | 2          | prueba de subcadena                                |
| `lower(s)` `upper(s)`      | 1          | mayúsculas y minúsculas                            |

> [!NOTE]
> **Dos reglas que conviene saber antes de apoyarse en ellas**
>
> **`round` manda la mitad alejándose del cero.** `round(0.5)` es 1 y `round(-0.5)` es −1.
> JavaScript redondea la mitad hacia +∞, Python al par, Java hacia arriba: tres anfitriones,
> tres respuestas, ninguna simétrica. TDC declara la suya para que una columna de negativos se
> comporte como una de positivos.
>
> **`len` cuenta puntos de código.** `len("😀")` es 1, no los 2 que daría UTF-16 — pero un
> emoji de familia hecho de varios puntos de código cuenta como varios. Los grupos de grafemas
> serían la respuesta humana y necesitan una tabla de segmentación Unicode que no toda
> implementación puede llevar, así que gana la unidad portable. `len("10")` es 2: una función
> de cadena lee su argumento como texto, nunca como número.

## Lo que falta a propósito

**Trigonometría, logaritmos, potencias.** `sin`, `cos`, `exp`, `log`, `sqrt` y sus parientes
se rechazan por nombre, con la razón:

`tdcv2 check seasonal.tdc`

```
error[TDC257]: cos() is not available yet in an if expression
```

La nota que lo acompaña explica por qué, y la razón es medible: `tan(1)` ya difiere en su
último bit entre Node y Python en la misma máquina. De setenta y siete valores muestreados,
dieciséis discrepan en al menos dos de las cinco implementaciones. En un `timeseries` eso no
se ve, porque cada número se redondea antes de convertirse en salida — pero una comparación
no tiene paso de redondeo, así que un bit se vuelve otra fila y otro archivo. Llegarán cuando
TDC las calcule por sí mismo, igual que calcula sus propios números aleatorios en vez de
confiar en los de cada lenguaje.

**Bucles y recursión.** El motor se elige a partir de la configuración antes de generar una
fila, [`preflight()`](../guides/large-outputs.md#top) estima la memoria antes de la corrida, y
`--jobs` reparte las filas entre workers. Los tres necesitan saber el trabajo por fila sin
hacerlo. Un bucle rompe los tres, y aquello para lo que se busca un bucle — «¿esta fila es
par?» — es `%`.

**Operadores de bits.** `_count & 1` es `_count % 2` escrito para una máquina. Se analizan,
para que el mensaje pueda nombrarlos, y luego se rechazan.

## Cuando una expresión no alcanza

Una [secuencia `<compute>`](compute.md#top) tiene división entera, restos, cirugía de cadenas,
codificaciones y dígitos de control. Produce un valor como cualquier otra secuencia, y `if=`
compara ese valor:

```xml
<sequence name="Checksum">
  <compute><result><mod><to_number><field name="Account"/></to_number><int v="97"/></mod></result></compute>
</sequence>
<sequence name="Flag">
  <gen if="Checksum == 0" type="text" value="divisible"/>
  <gen type="text" value="."/>
</sequence>
```

## La configuración tiene forma de XML, pero no es XML

TDC no expande entidades, así que `&lt;` son cuatro caracteres literales y no `<`. Escriba el
carácter directamente:

```xml
<gen if="Weight > 20" .../>      <!-- sí -->
<gen if="Weight &gt; 20" .../>   <!-- no: TDC100, y el mensaje explica por qué -->
```

---

← Anterior: [Códigos de error](./errors.md#top) · **[Contenido](../README.md#top)** · Siguiente: [TypeScript](../bindings/typescript.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/reference/expressions)**
