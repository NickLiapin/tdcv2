<a name="top"></a>

[English](../../constructs/conditional-output.md#top) · [Русский](../../ru/constructs/conditional-output.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/constructs/conditional-output)**

← Anterior: [Tablas de consulta (switch)](./switch.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Varios valores en una celda (repeat)](./multiple-values.md#top) →

---

# Salida condicional con `if`

**Úselo cuando** un valor deba decidir *si* aparece una pieza de la fila, y no solo
*qué* dice: conservar una tarjeta y descartar otra; etiquetar unas filas y dejar las
demás peladas; poner una coma después de cada registro menos el último.

Un generador siempre produce un valor. El atributo `if` es un interruptor aparte:
mira los valores actuales de la fila y decide si la etiqueta sobre la que está llega
a la salida. La expresión se vuelve a evaluar en **cada** tarjeta contra los datos de
esa tarjeta.

`if` acepta un pequeño lenguaje de expresiones — un subconjunto de la sintaxis de
JavaScript — con operadores de comparación, lógicos y aritméticos, literales de
cadena y numéricos, y nombres de secuencias. Esta página recorre el lenguaje
completo.

Las salidas de ejemplo que siguen son **ilustrativas**: muestran la forma del
resultado y pueden diferir entre versiones del core. Los ejemplos didácticos usan
[`order="sequential"`](../core-concepts/output-formatting.md#top) para que los valores
desfilen en un orden fijo y el efecto de cada condición sea fácil de ver.

## Antes / después

Tome un campo `Age` e imprima seis tarjetas sin condición alguna:

```xml
<env count="6" seed="demo">
    <sequence name="Age"><gen type="text" value="15,17,18,25,40,70" order="sequential"/></sequence>
</env>
<block>
    <line><data>${{_count}}. edad ${{Age}}</data></line>
</block>
```

`./run age.tdc (6 filas)`

```
1. edad 15
2. edad 17
3. edad 18
4. edad 25
5. edad 40
6. edad 70
```

Ahora cuelgue `if="Age >= 18"` de la propia
[`<line>`](../reference/tags.md#top). Cuando la condición es falsa, TDC descarta la
línea entera:

```xml
<block>
    <line if="Age >= 18"><data>${{_count}}. edad ${{Age}} — adulto</data></line>
</block>
```

`./run age.tdc (6 filas)`

```
3. edad 18 — adulto
4. edad 25 — adulto
5. edad 40 — adulto
6. edad 70 — adulto
```

Las dos primeras tarjetas (15 y 17) desaparecieron — ahí `Age >= 18` era falso. Note
que el contador sigue leyéndose `3, 4, 5, …`:
[`_count`](../reference/builtins.md#top) es el lugar de la tarjeta dentro del conjunto
completo, decidido antes de renderizar, así que suprimir una línea no renumera al
resto.

> [!WARNING]
> **Escriba `<`, `>` y `&` de manera literal**
>
> Dentro de `if` los operadores se escriben **tal cual**: `if="Age < 18"`,
> `if="A >= 1 && B <= 9"`. TDC **no** expande entidades XML — `if="Age &lt; 18"` se
> rompe con el error `TDC103`. Use los caracteres simples.

## Dónde aplica `if`

El mismo lenguaje de expresiones funciona en tres etiquetas, con efectos ligeramente
distintos:

| Etiqueta                                       | Efecto de un `if` falso                                                        |
| :--------------------------------------------- | :---------------------------------------------------------------------------- |
| [`<line>`](../reference/tags.md#top)              | La línea entera se suprime — incluido el separador entre filas.               |
| [`<data>`](../reference/tags.md#top)              | Solo se suprime ese trozo de texto; los demás `<data>` de la misma línea siguen. |
| [`<gen>`](../generators/overview.md#top) dentro de una `<sequence>` | Crea una **secuencia condicional** (abajo). Los generadores no se permiten en el bloque de salida. |

### Suprimir parte de una línea con `<data>`

Varios `<data if="…">` en una misma línea, cada uno con su propia etiqueta, dejan las
filas coincidentes a la vista de un vistazo:

```xml
<block>
    <line><data>edad ${{Age}}:</data><data if="Age >= 18"> adulto</data></line>
</block>
```

`./run age.tdc (6 filas)`

```
edad 15:
edad 17:
edad 18: adulto
edad 25: adulto
edad 40: adulto
edad 70: adulto
```

**Por qué / cuándo:** use `<data if>` para anotar una fila sin descartarla — el
prefijo `edad N:` siempre se imprime; la marca ` adulto` solo cuando la condición se
cumple.

### Secuencias condicionales con `<gen if>`

Cuando las etiquetas `<gen>` llevan `if` **dentro** de una `<sequence>`, la secuencia
se vuelve condicional: gana el **primer** `<gen>` cuya condición sea verdadera, y su
valor pasa a ser el valor de la secuencia en esa fila. Un `<gen>` sin `if` es el
respaldo (el «else»). Si nada coincide, la secuencia queda vacía en esa fila.

Así toda la lógica de «qué valor depende de qué» se queda en `<env>`, y el bloque de
salida sigue siendo puro formato:

```xml
<sequence name="Gender"><gen type="text" value="Hombre,Mujer" percent="42,58"/></sequence>

<sequence name="Name">
  <gen if="Gender.Hombre" type="template" value="person.male.firstName"/>
  <gen if="Gender.Mujer"  type="template" value="person.female.firstName"/>
</sequence>
```

`./run gendered-name.tdc (6 filas, local=es)`

```
Mujer:  Violeta
Hombre: Emilio
Mujer:  Lorenza
Mujer:  Susana
Hombre: Julio
Hombre: César
```

**Por qué / cuándo:** cada `${{Name}}` ya es el nombre correcto para su género — nada
de ramificar por fila dentro del bloque. Es la misma idea que exploran
[Datos coherentes y relacionales](../guides/coherent-data.md#top) y
[Dependencias jerárquicas](../guides/hierarchical-dependencies.md#top).

## Referirse a los valores

- **El nombre de una secuencia** representa su valor en la fila actual:
  `Gender == Hombre`, `Age >= 18`.
- **Un campo compuesto** usa un punto: `Person.FirstName`, `Doctor.last`.
- **El atajo `X.Value`** — si `X` es una secuencia y `X.Value` no es en sí mismo un
  campo compuesto, la expresión se lee como una prueba de igualdad `X == "Value"`.
  Así, `if="Gender.Hombre"` significa «`Gender` es actualmente `Hombre`», y
  `if="!Gender.Hombre"` significa «no es Hombre». Es exactamente la misma notación con
  punto que se usa en [`parent="X.Value"`](../core-concepts/sequences.md#top).

```text
Gender == Hombre     es lo mismo que   Gender.Hombre
Gender != Hombre     es lo mismo que   !Gender.Hombre
```

## Literales e identificadores pelados

| Tipo          | Ejemplo              |
| :------------ | :------------------- |
| Número        | `5`, `3.14`, `-42`   |
| Cadena        | `"admin"`, `'text'`  |
| Identificador | `Name`, `_count`     |

Un **identificador pelado** (sin comillas) se resuelve en dos pasos:

1. Primero TDC busca una secuencia con ese nombre y devuelve su valor en esta fila.
2. Si no existe tal secuencia, el identificador se trata como un **literal de
   cadena** igual a su propio nombre.

Por eso usted puede escribir:

```xml
<data if="Role == admin">…</data>
```

No hay ninguna secuencia llamada `admin`, así que `admin` es simplemente la palabra
`"admin"` — equivalente a `Role == "admin"`.

## Operadores de comparación

| Operador | Significado                              |
| :------- | :--------------------------------------- |
| `==`     | Igual (con promoción numérica suave)     |
| `!=`     | Distinto (espejo de `==`)                |
| `===`    | Igualdad estricta (valor **y** tipo)     |
| `!==`    | Desigualdad estricta                     |
| `<`      | Menor que                                |
| `>`      | Mayor que                                |
| `<=`     | Menor o igual                            |
| `>=`     | Mayor o igual                            |

Los operadores de orden `<`, `>`, `<=`, `>=` siempre convierten ambos operandos a
números.

```xml
<block>
    <line><data>edad ${{Age}}:</data><data if="Age < 18"> menor18</data><data if="Age >= 18"> adulto</data><data if="Age > 65"> mayor</data></line>
</block>
```

`./run age-bands.tdc (6 filas)`

```
edad 15: menor18
edad 17: menor18
edad 18: adulto
edad 25: adulto
edad 40: adulto
edad 70: adulto mayor
```

`Age < 18` se queda con las dos primeras filas, `Age >= 18` toma el resto (el límite
`18` cae en *adulto*), y `Age > 65` marca únicamente al `70`.

**Por qué / cuándo:** las comparaciones de orden son el caso de todos los días —
límites de edad, umbrales, puntos de corte de puntaje.

### Igualdad: `==` y `!=`

```xml
<sequence name="Role"><gen type="text" value="guest,user,admin,user,admin,guest" order="sequential"/></sequence>
...
<line><data>${{_count}}. ${{Role}}:</data><data if="Role == admin"> [admin]</data><data if="Role != admin"> [normal]</data></line>
```

`./run roles.tdc (6 filas)`

```
1. guest: [normal]
2. user: [normal]
3. admin: [admin]
4. user: [normal]
5. admin: [admin]
6. guest: [normal]
```

`==` y `!=` parten las filas exactamente por la mitad de la condición: donde uno es
verdadero, el otro es falso.

### El `==` suave frente al `===` estricto

`==` compara de forma **suave**: si un lado es un número y el otro una cadena
numérica, se comparan como números. `===` exige además el mismo tipo.
[`_count`](../reference/builtins.md#top) se guarda como cadena, así que frente al número
`3` los dos operadores no se ponen de acuerdo:

```xml
<line><data>_count=${{_count}}:</data><data if="_count == 3"> ==3</data><data if="_count === 3"> ===3</data><data if="_count !== 3"> !==3</data></line>
```

`./run strict.tdc (5 filas)`

```
_count=1: !==3
_count=2: !==3
_count=3: ==3 !==3
_count=4: !==3
_count=5: !==3
```

En la fila 3 la diferencia se ve: `_count == 3` es verdadero (suave: `"3"` equivale a
`3` como números), pero `_count === 3` es **falso** (la cadena `"3"` no es el número
`3` por tipo), lo que hace que `_count !== 3` sea verdadero en **todas** las filas,
la 3 incluida. La marca `===3` no aparece nunca — la igualdad estricta entre una
cadena y un número jamás coincide.

**Por qué / cuándo:** eche mano de `===` solo cuando importe la distinción de tipos.
Para las revisiones de campos corrientes, el `==` suave es lo que usted quiere,
porque los valores generados son cadenas.

### La regla de la promoción suave

Cuando un operando es un número y el otro una cadena, TDC intenta primero leer la
cadena como número:

- `_count == 5` — `_count` es la cadena `"5"`, pero `==` los compara como números. ✓
- `Age == 18` — una cadena `Age` contra el número `18` se compara numéricamente. ✓
- `Gender == Hombre` — ambos lados son cadenas, así que se comparan como cadenas. ✓

## Operadores lógicos

| Operador | Significado |
| :------- | :---------- |
| `&&`     | Y (AND)     |
| `\|\|`   | O (OR)      |
| `!`      | NO (NOT)    |

```xml
<line><data>${{_count}}. ${{Role}}/${{Age}}:</data><data if="Role == admin && Age >= 18"> admin-adulto</data><data if="Age < 18 || Age > 65"> marcado</data></line>
```

`./run logical.tdc (6 filas)`

```
1. guest/15: marcado
2. user/17: marcado
3. admin/18: admin-adulto
4. user/25:
5. admin/40: admin-adulto
6. guest/70: marcado
```

`admin-adulto` aparece únicamente donde `Role` es `admin` **y** `Age >= 18` (filas 3
y 5). `marcado` aparece donde `Age` queda fuera de `18..65` (filas 1, 2 y 6). La fila
4 (`user/25`) no cumple ninguna de las dos, así que no recibe marca alguna.

**Por qué / cuándo:** combine condiciones con `&&` / `||`, y niegue con `!` — el
mismo `!` es el que hace funcionar el atajo `!Gender.Hombre` de más arriba.

## Operadores aritméticos

| Operador | Significado                                                                |
| :------- | :------------------------------------------------------------------------- |
| `+`      | Suma (numérica si alguno de los operandos es número; si no, concatenación)  |
| `-`      | Resta (los operandos se convierten a número)                                |
| `*`      | Multiplicación                                                              |
| `/`      | División                                                                    |

La aritmética se hace cómoda justo dentro de una comparación:

```xml
<line><data>${{_count}}/${{_total}} edad ${{Age}}:</data><data if="_count * 2 > _total"> [segunda-mitad]</data><data if="Age + 5 >= 45"> [+5>=45]</data><data if="Age - 18 > 0"> [adulto]</data><data if="Age / 10 >= 4"> [/10>=4]</data></line>
```

`./run arithmetic.tdc (6 filas)`

```
1/6 edad 15:
2/6 edad 17:
3/6 edad 18:
4/6 edad 25: [segunda-mitad] [adulto]
5/6 edad 40: [segunda-mitad] [+5>=45] [adulto] [/10>=4]
6/6 edad 70: [segunda-mitad] [+5>=45] [adulto] [/10>=4]
```

`_count * 2 > _total` marca la segunda mitad del conjunto; `Age + 5`, `Age - 18` y
`Age / 10` se calculan y se comparan como números.

**Por qué / cuándo:** cuentas pequeñas (mitades, desplazamientos, razones) sin
agregar toda una secuencia extra solo para guardar el número derivado.

> [!CAUTION]
> **Operadores no soportados**
>
> `%` (resto) y `??` (nullish) lanzan un error al renderizar — por ejemplo
> `if="_count % 2 == 0"` falla con `unsupported operator "%" in if expression`.
>
> `?.` (encadenamiento opcional) es peor porque falla **en silencio**: el parser lee
> `X?.length` como un acceso con punto corriente `X.length`, que el atajo `X.Value`
> convierte en la prueba `X == "length"` — casi siempre falsa. No use `?.` dentro de
> `if`.

## El atajo `X.Value` en acción

`Role.admin` es la forma corta de `Role == admin`, y se niega con `!Role.admin`:

```xml
<line><data>${{_count}}. ${{Role}}:</data><data if="Role.admin"> [Role.admin]</data><data if="!Role.admin"> [!Role.admin]</data></line>
```

`./run dotted.tdc (6 filas)`

```
1. guest: [!Role.admin]
2. user: [!Role.admin]
3. admin: [Role.admin]
4. user: [!Role.admin]
5. admin: [Role.admin]
6. guest: [!Role.admin]
```

El resultado coincide exactamente con el ejemplo de `==` / `!=` — son dos maneras de
escribir la misma prueba.

## Veracidad de los valores

En los operadores lógicos y en el `if` como un todo, un valor pelado se lee como
booleano según estas reglas:

| Valor                 | Se lee como |
| :-------------------- | :---------: |
| `null`, `undefined`   | falso       |
| `0`, `NaN`            | falso       |
| `""` (cadena vacía)   | falso       |
| `"false"` (cadena)    | **falso**   |
| `"true"` (cadena)     | verdadero   |
| cualquier otra cadena | verdadero   |
| un número ≠ 0         | verdadero   |

El caso de `"false"` es especial: existe para que las
[secuencias integradas](../reference/builtins.md#top) `_first` / `_last`, que se guardan
como las cadenas literales `"true"` / `"false"`, se comporten de forma intuitiva
dentro de `if`.

## Las integradas dentro de `if`

Las cuatro integradas — `_count`, `_first`, `_last`, `_total` — son lo que más
comúnmente se quiere probar. Un patrón clásico: una coma después de cada tarjeta
menos la última, más un encabezado solo en la primera tarjeta.

```xml
<block>
    <line if="_first"><data>--- HEAD ---</data></line>
    <line><data>{"id": ${{_count}}}</data><data if="!_last">,</data></line>
</block>
```

`./run json-list.tdc (4 filas)`

```
--- HEAD ---
{"id": 1},
{"id": 2},
{"id": 3},
{"id": 4}
```

**Por qué / cuándo:** `if="!_last"` es el truco estándar para uniones JSON/CSV
válidas; `if="_first"` para un encabezado que aparece una sola vez;
`if="_count * 2 > _total"` para quedarse solo con la mitad trasera de un conjunto.
Vea [Secuencias integradas](../reference/builtins.md#top) para la lista completa.

## Precedencia de operadores

La precedencia sigue a JavaScript:

```text
!   →   * /   →   + -   →   < > <= >=   →   == != === !==   →   &&   →   ||
```

Los paréntesis `(…)` cambian el orden de manera explícita — por ejemplo
`if="!(Gender == Hombre)"` niega la comparación entera y no solo a `Gender`.

## Todo junto

Combine `==`, `&&`, `>=` y `!(…)` en una sola línea:

```xml
<env count="6" seed="demo" local="es">
    <sequence name="Gender"><gen type="text" value="Hombre,Mujer" percent="50,50"/></sequence>
    <sequence name="Age"><gen type="number" value="10..40"/></sequence>
    <sequence name="Name">
        <gen if="Gender.Hombre"   type="template" value="person.male.firstName"/>
        <gen if="Gender.Mujer" type="template" value="person.female.firstName"/>
    </sequence>
</env>
<block>
    <line><data>${{Name}} (${{Gender}}, ${{Age}})</data><data if="Gender == Hombre && Age >= 18"> — hombre adulto</data><data if="!(Gender == Hombre)"> — no es hombre</data></line>
</block>
```

`./run combined.tdc (6 filas)`

```
Violeta (Mujer, 36) — no es hombre
Emilio (Hombre, 10)
Lorenza (Mujer, 32) — no es hombre
Susana (Mujer, 14) — no es hombre
Julio (Hombre, 16)
César (Hombre, 20) — hombre adulto
```

La marca `hombre adulto` se muestra solo cuando ambas condiciones son verdaderas
(`Gender == Hombre` y `Age >= 18`); `no es hombre` se muestra siempre que `Gender` no
sea `Hombre`.

> [!NOTE]
> **Se compila una vez, se reutiliza barato**
>
> Cada expresión se compila una sola vez y se guarda en caché. A lo largo de miles de
> filas, volver a evaluar el mismo `if="…"` casi no cuesta nada.

## Vea también

- [Secuencias integradas](../reference/builtins.md#top) — `_count`, `_first`, `_last`,
  `_total`.
- [`if` en la referencia de atributos](../reference/attributes.md#top).
- [Datos coherentes y relacionales](../guides/coherent-data.md#top) y
  [Dependencias jerárquicas](../guides/hierarchical-dependencies.md#top) — donde las secuencias
  condicionales brillan.

---

← Anterior: [Tablas de consulta (switch)](./switch.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Varios valores en una celda (repeat)](./multiple-values.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/constructs/conditional-output)**
