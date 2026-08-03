<a name="top"></a>

[English](../../constructs/mix.md#top) · [Русский](../../ru/constructs/mix.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/constructs/mix)**

← Anterior: [Visión general](./overview.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Tablas de consulta (switch)](./switch.md#top) →

---

# El bloque `<mix>`

**Úselo cuando** las proporciones de una columna no son iguales _y_ además cada
variante es más que una sola palabra. Los datos reales son desparejos: casi todos
los pedidos están `paid` y muy pocos `cancelled`; casi todas las cuentas son `free`
y muy pocas `premium`. Usted quiere una columna donde las variantes aparezcan en
**proporciones fijas** — ni repartidas por igual, ni como ruido aleatorio.

`<mix>` es una **distribución**: una fuente con nombre que reparte sus variantes —
las ramas [`<case>`](#una-distribución-con-nombre) — entre las filas en porcentajes
exactos. Piénselo como una [`<sequence>`](../core-concepts/sequences.md#top) cuyos
valores se distribuyen por `percent`, salvo que cada rama puede ser todo un
compuesto de literales y generadores en vez de un único valor simple. El reparto es
determinista para una [`seed`](../core-concepts/determinism.md#top) dada.

Las salidas de ejemplo que siguen son ilustrativas — los valores exactos que produce
una `seed` dada pueden cambiar entre versiones del core, pero los **conteos** que
garantiza una máscara `percent` nunca cambian.

![](../../img/guides/mix-percent.svg)

*Lo declarado frente a lo producido, sobre 1000 filas. No de manera aproximada: los conteos caen exactamente en las proporciones declaradas.*

- **band** — los porcentajes escritos en la configuración
- **made** — la proporción que realmente se produjo

## Una distribución con nombre

`<mix>` va **directamente en [`<env>`](../core-concepts/configuration.md#top)**, justo
al lado de `<sequence>` — no hace falta ningún envoltorio, basta con darle un
`name`. El valor se lee con `${{Nombre}}`, exactamente igual que cualquier otra
fuente con nombre:

```xml
<env count="100" seed="demo" inject="${{%}}">
    <mix name="Code" percent="25,70">
        <case><gen type="text" value="A"/></case>
        <case><gen type="text" value="B"/></case>
        <case><gen type="text" value="C"/></case>
    </mix>
</env>
<block>
    <line><data>${{Code}}</data></line>
</block>
```

Las primeras filas no dicen nada — las proporciones solo se ven a lo largo de toda
la muestra:

`./run code.tdc (primeras 6 filas)`

```
A
B
A
B
B
A
```

Cuente las 100 filas y el reparto es exacto:

`./run code.tdc (count=100, con conteo)`

```
A   25
B   70
C    5
```

Exactamente `25 / 70 / 5`. La máscara fija las dos primeras proporciones; la tercera
rama se lleva el **resto**, `100 − 25 − 70 = 5`. Esto no es «como 25 %»: es un
reparto exacto por el método de Hamilton (mayores restos), el mismo que gobierna
[`percent`](../generators/text.md#top) en el generador `text`.

### Cambie las proporciones y cambia el reparto

Las mismas ramas `A/B/C`, pero con `percent="60,30"`:

```xml
<mix name="Code" percent="60,30">
    <case><gen type="text" value="A"/></case>
    <case><gen type="text" value="B"/></case>
    <case><gen type="text" value="C"/></case>
</mix>
```

`./run code.tdc (count=100, con conteo)`

```
A   60
B   30
C   10
```

`60 / 30`, y el sobrante `10` se va a la tercera rama. Un solo número de la máscara
vuelve a cortar la columna entera.

## Cuándo se necesita `<mix>` — y cuándo basta con `text`

Para una simple distribución de cadenas ya hechas, `<mix>` es excesivo: el generador
[`text`](../generators/text.md#top) ya reparte proporciones exactas con `percent`.

```xml
<sequence name="Gender">
    <gen type="text" value="Hombre,Mujer" percent="50,50"/>
</sequence>
```

`./run gender.tdc (count=20, con conteo)`

```
Hombre   10
Mujer    10
```

`<mix>` se gana su lugar solo cuando las ramas son **compuestas** — cuando cada
variante se arma con su propia mezcla de texto literal y generadores. Ese es el caso
al que llevan las secciones siguientes.

## Atributos

| Atributo  | Obligatorio | Qué hace                                                                                                        |
| :-------- | :---------- | :-------------------------------------------------------------------------------------------------------------- |
| `name`    | **sí**      | El nombre para interpolar con `${{Nombre}}`                                                                     |
| `percent` | no          | La proporción de cada `<case>`; omítalo para un reparto uniforme                                                |
| `parent`  | no          | Una secuencia padre — el reparto se calcula dentro de su subconjunto                                            |
| `flag`    | no          | Agrega una columna de respuestas que marca la rama atípica (ver [más abajo](#marcar-valores-atípicos-con-flag)) |
| `comment` | no          | Una nota libre para el autor de la configuración; nunca se renderiza                                            |

Un `<mix>` debe contener al menos un **[`<case>`](#ramas-compuestas)** — una rama.
Todo lo demás es opcional.

## `percent` — opcional, y las máscaras cortas

Deje `percent` fuera por completo y las ramas se reparten de forma **uniforme**.
Tres casos sobre 99 filas dan 33 cada uno:

```xml
<mix name="Bucket">
    <case><gen type="text" value="low"/></case>
    <case><gen type="text" value="mid"/></case>
    <case><gen type="text" value="high"/></case>
</mix>
```

`./run bucket.tdc (count=99, con conteo)`

```
low    33
mid    33
high   33
```

Cuando sí se da una máscara, esta sigue la **misma gramática** que
[`percent` en `text`](../generators/text.md#top): un número fija la proporción de esa
rama, y cada **posición vacía** — una coma suelta dentro de la máscara (`"25,,70"`) o
una coma final (`"25,70,"`) — reparte por igual lo que falta para llegar a 100. Los
dos ejemplos del inicio de esta página ya se apoyan en esa regla: `percent="25,70"`
deja que la tercera rama absorba el resto.

## `parent` — una distribución dentro de un subconjunto

Déle un `parent` a un `<mix>` y los porcentajes se cuentan contra el **subconjunto
filtrado** de filas, no contra el `count` completo — la misma regla que gobierna una
[`<sequence>`](../core-concepts/sequences.md#top) dependiente. Aquí las cuentas de paga
reciben un desglose por nivel; las cuentas gratuitas dejan la columna vacía:

```xml
<sequence name="Segment">
    <gen type="text" value="Free,Paid" percent="70,30"/>
</sequence>

<mix name="Tier" parent="Segment.Paid" percent="60,30">
    <case><gen type="text" value="Silver"/></case>
    <case><gen type="text" value="Gold"/></case>
    <case><gen type="text" value="Platinum"/></case>
</mix>
```

Sobre `count="100"`, 30 filas son `Paid`. La máscara `60 / 30` se aplica **a esas 30
filas**, así que `Tier` se reparte `18 / 9 / 3`:

`./run tier.tdc (solo las filas Paid, con conteo)`

```
Silver     18
Gold        9
Platinum    3
```

`18 + 9 + 3 = 30` — todo el subconjunto de paga, y no un porcentaje del total de 100. Este es el corazón del modelo jerárquico; el tratamiento completo, con niveles
anidados, está en
**[Dependencias jerárquicas](../guides/hierarchical-dependencies.md#top)**.

### `<mix>` se anida

Un `<case>` puede contener a su vez un `<mix>` anidado, y el reparto anidado se
cuenta contra las filas que eligieron la rama **externa** — la misma regla de
subconjunto, un nivel más adentro. Aquí un tercio de todas las filas son `error`, y
dentro de ellas un `<mix>` interno gradúa la severidad:

```xml
<mix name="Status" percent="34,33">
    <case>
        <gen type="text" value="ok"/>
    </case>
    <case>
        <gen type="text" value="warn"/>
    </case>
    <case>
        <mix percent="70,20">
            <case><data>error/minor</data></case>
            <case><data>error/major</data></case>
            <case><data>error/fatal</data></case>
        </mix>
    </case>
</mix>
```

Sobre `count="100"` el reparto externo es `34 ok / 33 warn / 33 error`. La máscara
interna `70 / 20` divide entonces **esas 33 filas de error** en `23 / 7 / 3`:

`./run status.tdc (count=100, con conteo)`

```
ok            34
warn          33
error/minor   23
error/major    7
error/fatal    3
```

`23 + 7 + 3 = 33` — exactamente el subconjunto de errores.

## Ramas compuestas

Esto es lo que `<mix>` le da y una lista pelada de cadenas no puede dar: un `<case>`
puede armar su valor con varias piezas — un fragmento literal
[`<data>`](../core-concepts/output-formatting.md#top), uno o más
[generadores](../generators/overview.md#top) y `<mix>` anidados. En este contexto
`<data>` es solo un **trozo literal del valor** (texto de pegamento), no formato de
salida — para eso vea
[Máscaras y mayúsculas](../guides/masks-and-case.md#top).

```xml
<mix name="Charge" percent="10,12,34,">
    <case><data>reembolso: </data><gen type="number" value="1..10"/></case>
    <case><data>contracargo: </data><gen type="number" value="11..20"/></case>
    <case><gen type="number" value="21..40"/></case>
    <case><gen type="number" value="41..100"/><data> (marcado)</data></case>
</mix>
```

`./run charge.tdc (primeras 8 filas)`

```
36
reembolso: 4
contracargo: 18
66 (marcado)
reembolso: 8
reembolso: 1
73 (marcado)
82 (marcado)
```

Cada rama armó su propia forma: `reembolso: 4` es el literal `reembolso: ` más un
[`number`](../generators/number.md#top) en `1..10`; `66 (marcado)` es un número en
`41..100` seguido del literal ` (marcado)`; la tercera rama es un número pelado sin
ningún envoltorio. Agrupe las 100 filas por rama y las proporciones siguen siendo
exactas:

`./run charge.tdc (count=100, con conteo por rama)`

```
reembolso     10
contracargo   12
simple        34
marcado       44
```

`10 / 12 / 34 / 44`. La última rama no tiene porcentaje propio — la coma final de
`percent="10,12,34,"` la deja abierta, así que se lleva el resto, `44`.

## Una distribución genera — no da formato

`<mix>` **produce datos**, así que vive únicamente en `<env>`. No se puede poner
dentro del bloque de salida: un `<mix>` directamente en un `<line>` se rechaza antes
de la corrida con el error `TDC132`, porque el
[bloque de salida](../core-concepts/output-formatting.md#top) es solo para la
disposición. Declare `<mix name="…">` en `<env>` e interpole `${{Nombre}}` donde
quiera el valor.

Si necesita una elección que **no** sea por porcentaje, dos vecinos la cubren:

- **`<switch>`** elige por una **clave** — una tabla de consulta, como
  `país → moneda`.
- Una [`<sequence>`](../core-concepts/sequences.md#top) con ramas condicionales
  [`<gen if="…">`](../core-concepts/sequences.md#top) elige por una **condición
  arbitraria** — gana la primera rama verdadera.

## Marcar valores atípicos con `flag`

Una rama se puede etiquetar como anómala — `<case anomaly="true">` — y usted puede
pedirle al mix una columna de respuestas mediante `flag`. El resultado es un
conjunto de datos contra el cual **probar un detector de anomalías**: los valores
atípicos están ahí, y una columna acompañante registra exactamente en qué filas
cayeron.

```xml
<mix name="Temp" percent="75,25" flag="Bad">
    <case><gen type="number" value="20..24"/></case>
    <case anomaly="true"><gen type="number" value="90..99"/></case>
</mix>
```

`${{Bad}}` vale `true` justo en las filas que salieron de la rama etiquetada — el
25 % de ellas — y `false` en todas las demás. La etiqueta se deriva de la **misma
decisión** que eligió la rama, así que nunca puede contradecir al valor.
`anomaly="true"` es solo una etiqueta: el valor atípico en sí es lo que produzca el
generador de esa rama, y por eso usted conserva el control total sobre cómo se ve.
Este es apenas un rincón de un tema más amplio — la inyección de valores atípicos y
la columna `flag` reciben su tratamiento completo en la guía de anomalías.

## Siguiente paso

- **[Generador text](../generators/text.md#top)** — proporciones `percent` exactas para
  una lista simple de opciones, cuando las ramas son palabras sueltas.
- **[Secuencias](../core-concepts/sequences.md#top)** — la fuente con nombre junto a la
  cual vive `<mix>`, y el modelo `parent` que comparten.
- **[Dependencias jerárquicas](../guides/hierarchical-dependencies.md#top)** — la
  historia completa de `parent`, con porcentajes anidados en varios niveles.

---

← Anterior: [Visión general](./overview.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Tablas de consulta (switch)](./switch.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/constructs/mix)**
