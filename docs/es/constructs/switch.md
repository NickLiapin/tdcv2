<a name="top"></a>

[English](../../constructs/switch.md#top) · [Русский](../../ru/constructs/switch.md#top) · **Español**

← Anterior: [Elegir entre valores (mix)](./mix.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Salida condicional (if)](./conditional-output.md#top) →

---

# Tablas de consulta — `<switch>`

**Úselo cuando** un campo deba **derivarse de otro**, en lugar de sortearse por su
cuenta. Usted tiene una columna `Country` y necesita a su lado una `Currency` que sea
*siempre* consistente: `US` → `USD`, `JP` → `JPY`. Un segundo generador aleatorio es
justo lo contrario de lo que hace falta: le entregaría una moneda que no corresponde
al país. Lo que usted quiere es una **tabla de consulta**: leer un campo y devolver el
valor asociado a esa clave.

Eso es `<switch>`. Para cada fila toma el valor de una
[secuencia](../core-concepts/sequences.md#top) sujeto (indicada por
[`on`](#el-sujeto--on)) y sustituye el valor hallado bajo esa clave. A diferencia de
[`<mix>`](../reference/tags.md#top), que reparte un campo **al azar por porcentaje**,
`<switch>` es **determinista**: el resultado queda fijado por el valor del sujeto.

```xml
<tdc>
  <env count="8" seed="demo" local="en">
    <sequence name="Country">
      <gen type="text" value="US,FR,DE,JP" percent="40,25,20,15"/>
    </sequence>

    <switch name="Currency" on="Country">
      <map>US:USD, FR:EUR, DE:EUR, JP:JPY</map>
    </switch>
  </env>
  <block><line><data>${{Country}} -> ${{Currency}}</data></line></block>
</tdc>
```

`./run currency.tdc`

```
US -> USD
US -> USD
FR -> EUR
DE -> EUR
US -> USD
JP -> JPY
FR -> EUR
DE -> EUR
```

> [!NOTE]
> **Las salidas son ilustrativas**
>
> Los valores de abajo provienen de una `seed` fija, así que son reproducibles, pero
> las cadenas exactas pueden diferir entre versiones del core. Tómelos como ejemplos de
> *forma*, no como garantías.

Cada fila: TDC lee `Country` y devuelve la moneda asociada a esa clave. Este es el
trabajo de «derivar un campo a partir de otro» que tanto
[`<mix>`](../reference/tags.md#top) (aleatorio) como las cadenas de `if` (verbosas)
hacen de manera torpe.

![](../../img/guides/switch.svg)

*Una tabla de consulta de tres filas y 24 filas generadas a través de ella.*

- **A** — la tabla: cada clave lleva un valor
- **B** — las filas generadas — la misma clave siempre trae el mismo número, todas las veces

## De un vistazo

`<switch>` vive **directamente en `<env>`**, junto a
[`<sequence>`](../core-concepts/sequences.md#top) y
[`<mix>`](../reference/tags.md#top). Toma dos atributos y contiene una o más ramas.

| Atributo  | Obligatorio | Qué hace                                            |
| :-------- | :---------- | :-------------------------------------------------- |
| `name`    | sí          | El nombre que se interpola con `${{name}}`          |
| `on`      | sí          | La secuencia sujeto cuyo valor se consulta          |
| `comment` | no          | Nota de texto libre                                 |

| Etiqueta hija         | Qué es                                                          |
| :-------------------- | :-------------------------------------------------------------- |
| `<map>`               | Tabla compacta `CLAVE:VALOR` de **literales**                   |
| `<case is="…">`       | Una rama cuyo valor es un **generador o un compuesto**          |
| `<default>`           | La rama «si no» — se usa cuando ninguna clave coincidió          |

Se necesita **al menos una** rama (una fila de `<map>` o un `<case>`).

## El sujeto — `on`

`on` nombra el **sujeto**: la secuencia cuyo valor se consulta en cada fila. Es
**obligatorio** en `<switch>` y debe apuntar a una secuencia
[declarada antes](../core-concepts/sequences.md#top) en el mismo `<env>` (una secuencia
simple, un campo compuesto `Parent.Field` o una integrada como `_count`). Un sujeto
no declarado es el error `TDC134`.

```xml
<sequence name="Country">
  <gen type="text" value="US,CA,MX,FR,DE,JP"/>
</sequence>

<switch name="Currency" on="Country">
  <case is="US|CA|MX"><data>USD</data></case>
  <case is="FR|DE"><data>EUR</data></case>
  <case is="JP"><data>JPY</data></case>
</switch>
```

`./run currency.tdc`

```
CA -> USD
MX -> USD
FR -> EUR
JP -> JPY
US -> USD
JP -> JPY
FR -> EUR
DE -> EUR
```

El valor que `Country` haya sacado en una fila decide el resultado: `JP` siempre da
`JPY`, y cualquiera de `US/CA/MX` da `USD`. **Por qué importa:** el sujeto es la
única entrada. Apunte `on` a otra secuencia y la misma tabla empieza a leer *sus*
valores — la lógica de consulta es reutilizable.

## `<map>` — una tabla compacta de literales

Cuando todos los valores son literales simples, no escriba una pila de ramas casi
idénticas: colápselas en un solo `<map>`. Su cuerpo es **texto escrito a mano** (como
[`<data>`](../reference/tags.md#top)): no es marcado, sino registros `CLAVE:VALOR`.

```xml
<switch name="Currency" on="Country">
  <map>US:USD, FR:EUR, DE:EUR, JP:JPY</map>
</switch>
```

Esto es byte por byte equivalente a cuatro ramas separadas
`<case is="US"><data>USD</data></case>` — solo que más corto. Las reglas del formato:

- Los registros se separan con una **coma** `,`.
- La clave y el valor se dividen en los **primeros dos puntos** `:` — así que los dos
  puntos *dentro* de un valor se conservan (`US:Down : Left` → `Down : Left`).
- **Varias claves → un valor** con `|`: `CA|MX:USD` coincide tanto con `CA` como con
  `MX`.
- Los espacios y los saltos de línea alrededor de los registros se ignoran, así que
  usted puede repartir la tabla en varias líneas para que se lea mejor.
- El valor es **siempre un literal**. ¿Necesita un generador? Eso es un
  [`<case>`](#case--una-rama-con-un-generador), no una fila de `<map>`.

```xml
<switch name="Currency" on="Country">
  <map>
    US:USD, FR:EUR, DE:EUR, JP:JPY,
    CA|MX:USD
  </map>
</switch>
```

`./run currency.tdc`

```
FR -> EUR
DE -> EUR
JP -> JPY
MX -> USD
US -> USD
MX -> USD
JP -> JPY
CA -> USD
```

La fila multiclave `CA|MX:USD` coincide con `CA` y con `MX` — ambas imprimen `USD`.

> [!NOTE]
> **Un límite: las comas**
>
> Un valor que contenga una coma no cabe en un `<map>` (la coma es el separador de
> registros). Para esos casos use un [`<case is="…">`](#case--una-rama-con-un-generador).
> Una línea sin dos puntos no es un registro en absoluto, y el validador avisa
> (`TDC136`).

## `<case>` — una rama con un generador

Una fila de `<map>` solo puede contener un literal. Cuando una rama necesita
**generar** su valor — un monto aleatorio, un contador, un prefijo más un generador —
eche mano de `<case>`. Su contenido se arma de izquierda a derecha con literales
[`<data>`](../reference/tags.md#top) y generadores
[`<gen>`](../generators/overview.md#top), exactamente igual que una rama de
[secuencia](../core-concepts/sequences.md#top).

Dentro de `<switch>`, un `<case>` necesita
[`is`](#claves-de-coincidencia--is) — la clave o claves con las que coincide. Aquí el
nivel del cliente determina un *rango* de descuento, algo que una tabla plana no
puede expresar:

```xml
<sequence name="Tier">
  <gen type="text" value="gold,silver,bronze" percent="20,30,50"/>
</sequence>

<switch name="Discount" on="Tier">
  <case is="gold"><gen type="number" value="15..25"/></case>
  <case is="silver"><gen type="number" value="5..10"/></case>
  <default><data>0</data></default>
</switch>
```

`./run discount.tdc`

```
silver -> 7
gold   -> 22
bronze -> 0
gold   -> 18
silver -> 5
bronze -> 0
```

`gold` saca un número nuevo en `15..25` en cada fila coincidente, `silver` en `5..10`,
y `bronze` cae al literal `0` de `<default>`. **Por qué importa:** el valor se calcula
por fila, no se toma de una cadena fija — esa es toda la razón de que `<case>` exista
junto a `<map>`.

### Claves de coincidencia — `is`

`is` le da a un `<case>` su clave o claves: los valores del sujeto con los que la rama
se dispara.

- Es **obligatorio** en un `<case>` dentro de `<switch>` — sin él la rama nunca puede
  coincidir (error `TDC137`).
- **Varias claves** mediante `|`: `is="US|CA|MX"` coincide si el sujeto es igual a
  **cualquiera** de ellas, plegando todo un grupo de valores en una sola rama.
- La comparación es de igualdad de **cadenas** contra el valor del sujeto.

```xml
<switch name="Currency" on="Country">
  <case is="US|CA|MX"><data>USD</data></case>
  <case is="FR|DE"><data>EUR</data></case>
  <case is="JP"><data>JPY</data></case>
</switch>
```

`./run currency.tdc`

```
CA -> USD
MX -> USD
FR -> EUR
JP -> JPY
US -> USD
DE -> EUR
```

> [!NOTE]
> **Dentro de `<mix>` no hay `is`**
>
> La misma etiqueta [`<case>`](../reference/tags.md#top) se usa también dentro de
> [`<mix>`](../reference/tags.md#top), pero ahí las ramas se eligen **al azar por
> porcentaje** y no llevan `is`. `<case>` nunca admite `if` ni `default` en ninguno de
> los dos padres — para condiciones arbitrarias, use una
> [secuencia](../core-concepts/sequences.md#top) con ramas `<gen if="…">`.

## `<default>` — el respaldo

`<default>` es la rama «si no»: su valor se usa cuando el sujeto no coincide con
**ninguna** clave. Es una etiqueta y no un atributo, precisamente para que pueda
contener un generador — el mismo contenido `<data>` / `<gen>` que un `<case>`.

Sin un `<default>`, una clave sin coincidencia produce un valor **vacío** (los
corchetes de abajo están solo para hacer visible el hueco):

```xml
<switch name="Currency" on="Country">
  <map>US:USD, FR:EUR</map>
</switch>
```

`./run currency.tdc`

```
FR -> [EUR]
FR -> [EUR]
JP -> []
GB -> []
US -> [USD]
GB -> []
DE -> []
JP -> []
```

Cinco filas de ocho quedan en blanco — un defecto silencioso en una exportación real.
Agregue un `<default>` para cubrir a todos los que la tabla dejó fuera:

```xml
<switch name="Currency" on="Country">
  <map>US:USD, FR:EUR</map>
  <default><gen type="text" value="XXX"/></default>
</switch>
```

`./run currency.tdc`

```
FR -> EUR
FR -> EUR
JP -> XXX
GB -> XXX
US -> USD
GB -> XXX
DE -> XXX
JP -> XXX
```

Las mismas claves sin coincidencia (`DE`, `JP`, `GB`) ahora dan `XXX` — ya no quedan
huecos. Si el respaldo es apenas un literal, póngalo en `<data>`:
`<default><data>Other</data></default>`.

- Colóquelo **al final**, donde la vista lo busca (como en un `switch` de
  programación).
- Es **opcional.** Sin `<default>` y sin clave coincidente, el valor queda vacío en
  esa fila.

## Reglas de selección

- Gana la **primera** rama que coincide. Las filas de `<map>` se revisan primero (en
  el orden en que están escritas), luego las ramas `<case>`. Si una clave aparece en
  ambas, se la lleva la de más arriba — la fila del map.
- Las claves se comparan como **cadenas** contra el valor del sujeto.
- Una clave múltiple `A|B|C` coincide cuando el sujeto es igual a `A`, a `B` o a `C`.

Una pequeña demostración de precedencia — la misma clave `CA` en una fila del map y
en un case:

```xml
<switch name="Label" on="Country">
  <map>CA:from-map</map>
  <case is="CA"><data>from-case</data></case>
</switch>
```

`./run precedence.tdc`

```
CA -> from-map
CA -> from-map
CA -> from-map
```

Gana la fila del map porque las filas del map se revisan antes que los cases.

## Todo junto

Los tres tipos de rama en un solo `<switch>` — una tabla de literales, una rama
generada y un respaldo:

```xml
<switch name="Currency" on="Country">
  <!-- 1. Literales — compactos, multiclave mediante | -->
  <map>
    US:USD, FR:EUR, DE:EUR, JP:JPY,
    CA|MX:USD
  </map>

  <!-- 2. Una rama cuyo valor se genera -->
  <case is="TR|BR"><data>REG-</data><gen type="number" value="100..999"/></case>

  <!-- 3. El respaldo para cuando nada coincidió -->
  <default><gen type="text" value="XXX"/></default>
</switch>
```

`./run currency.tdc (sujeto en US,FR,CA,MX,TR,BR,GB)`

```
GB -> XXX
CA -> USD
GB -> XXX
TR -> REG-473
US -> USD
BR -> REG-208
MX -> USD
TR -> REG-819
FR -> EUR
MX -> USD
```

`CA` y `MX` se resuelven por la fila `CA|MX:USD` del map, `TR`/`BR` arman un código
generado `REG-###`, y `GB` — que no está en ninguna rama — cae en `<default>`.

## Determinista en todos los motores

Un valor de `<switch>` es una **función pura** de su sujeto: mismo valor del sujeto en
una fila, mismo resultado, siempre. No hay sorteo aleatorio por fila que mantener
sincronizado, así que una tabla de consulta se comporta de forma idéntica en los tres
motores (memoria / flujo / disco) — vea
[Salidas grandes](../guides/large-outputs.md#top) para el camino de streaming, y
[Determinismo](../core-concepts/determinism.md#top) para la garantía.

## `<switch>` es generación, no formato

Igual que [`<mix>`](../reference/tags.md#top), `<switch>` **produce un valor** y vive
**solo en `<env>`**. **No** se permite dentro del bloque de salida (`<line>`) — eso es
el error `TDC132`. Declárelo en `<env>`, déle un `name` e interpole `${{name}}` donde
lo quiera.

El contraste de una línea que conviene recordar:

- [`<mix>`](../reference/tags.md#top) elige **al azar, por porcentaje** — para
  proporciones realistas.
- `<switch>` elige **de forma determinista, por clave** — para un valor derivado de
  otro campo.

## Vea también

- **[Datos coherentes y relacionales](../guides/coherent-data.md#top)** — la otra manera de mantener
  dos campos consistentes: una secuencia hija tomada de un archivo por padre.
- **[Secuencias](../core-concepts/sequences.md#top)** — cómo declarar el sujeto y los
  demás campos.
- **[Text](../generators/text.md#top)** y **[Number](../generators/number.md#top)** — los
  generadores que se usan dentro de `<case>` y `<default>`.
- **[Referencia de etiquetas](../reference/tags.md#top)** — `<mix>`, `<case>` y la lista
  completa de etiquetas.

---

← Anterior: [Elegir entre valores (mix)](./mix.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Salida condicional (if)](./conditional-output.md#top) →
