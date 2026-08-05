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

Lo mismo vale un nivel más arriba: un `<mix>` escrito dentro de una rama de
[`<switch>`](./switch.md#una-proporción-dentro-de-una-rama) toma su cuota sobre las
filas que esa rama capturó, no sobre la ejecución completa.

## Una proporción menor que un registro

La regla del subconjunto tiene un borde que conviene conocer de antemano. Un
porcentaje es una proporción de **las filas que llegan a la rama**, no una
probabilidad que se tira para cada fila. Cuando esa proporción resulta menor que
una fila entera, la rama puede producir un valor y puede no producir nada.

Esta configuración le da un diagnóstico a cada registro. El diez por ciento de
cada sexo recibe un diagnóstico específico de ese sexo, y el resto recibe uno
general:

```xml
<env count="10" seed="demo" local="en">
    <sequence name="Gender">
        <gen type="text" value="Male,Female" percent="50,50"/>
    </sequence>
    <switch name="Diagnosis" on="Gender">
        <case is="Male">
            <mix percent="10,90">
                <case><gen type="template" value="medical.diagnosisMale"/></case>
                <case><gen type="template" value="medical.diagnosis"/></case>
            </mix>
        </case>
        <case is="Female">
            <mix percent="10,90">
                <case><gen type="template" value="medical.diagnosisFemale"/></case>
                <case><gen type="template" value="medical.diagnosis"/></case>
            </mix>
        </case>
    </switch>
</env>
```

`./run diagnosis.tdc (count=10, seed=demo)`

```
Female,Coronary Artery Disease
Female,Tuberculosis
Male,Attention Deficit Hyperactivity Disorder
Male,Osteoarthritis
Male,Hypothyroidism
Male,Celiac Disease
Female,Anemia
Female,Postpartum Hemorrhage
Female,Tinnitus
Male,Obstructive Sleep Apnea
```

El lado femenino funcionó: `Postpartum Hemorrhage` en la fila 8 viene de
`medical.diagnosisFemale`. Del lado masculino no aparece nada de
`medical.diagnosisMale` — las cinco filas masculinas llevan condiciones generales.

Los datos son correctos, la configuración es correcta y el reparto también.
Cuente las filas masculinas: son **cinco**. El diez por ciento de cinco filas es
**media fila**.

> [!CAUTION]
> **Una proporción menor que una fila no es una probabilidad baja, es un volado invisible**
>
> `percent="10"` sobre un subconjunto de cinco filas pide 0.5 registros. TDC no
> puede emitir medio registro, así que emite uno o ninguno, y lo decide únicamente
> el `seed`. La ejecución de arriba no tuvo mala suerte. Deje la configuración
> igual, cambie solo el seed, y el diagnóstico masculino específico aparece en
> alrededor de la mitad de las ejecuciones.
>
> Cada vez que una proporción sea pequeña, multiplíquela por la cantidad de filas
> que realmente llegarán a ella. Por debajo de 1, la columna es un volado.

El volado se tira una sola vez, cuando usted elige el seed, y no otra vez en cada
ejecución. La configuración de arriba devuelve los mismos diez registros siempre:
una columna que salió vacía sigue vacía, y volver a ejecutarla no prueba nada. Es
el [determinismo](../core-concepts/determinism.md#top) funcionando tal como se
promete, y es justo lo que vuelve difícil de detectar la trampa. La salida es
estable, reproducible y no corresponde a la proporción que usted pidió.

### Aquí no hay término medio

La misma configuración, con un número cambiado; medido sobre 30 seeds por fila:

| `percent` | Filas pedidas, de 5 | Diagnósticos masculinos específicos |
| :-------- | :------------------ | :---------------------------------- |
| `5`       | 0.25                | 0 con cada seed                     |
| `9`       | 0.45                | 0 con cada seed                     |
| **`10`**  | **0.5**             | **0 o 1 — lo decide el seed**       |
| `11`      | 0.55                | 1 con cada seed                     |
| `16`      | 0.8                 | 1 con cada seed                     |
| `20`      | 1.0                 | 1 con cada seed                     |

Nada aparece ni desaparece de a poco. Por debajo del 10 % la rama no dispara
nunca, por encima del 10 % dispara exactamente una vez, y el 10 % es el único
valor del rango que varía.

La razón está en el método de reparto. Primero cada rama toma las filas enteras
que cubre su proporción, y después las filas sobrantes van a las ramas con la
parte fraccionaria más grande. Con `percent="11"` las proporciones son 0.55 y
4.45, así que la única fila sobrante va a la primera rama con cada seed. Con
`percent="9"` son 0.45 y 4.55, y va a la segunda con cada seed. Solo con
`percent="10"` ambas partes fraccionarias valen 0.5, no hay nada que las separe,
y el empate se rompe con el seed.

### Dos maneras de volverlo seguro

**Subir la proporción** para que la fracción gane sin empate. Cambia un carácter:

```xml
<mix percent="20,80">
```

`./run diagnosis.tdc (count=10, seed=demo, percent=20,80)`

```
Female,Coronary Artery Disease
Female,Tuberculosis
Male,Attention Deficit Hyperactivity Disorder
Male,Spermatocele
Male,Hypothyroidism
Male,Celiac Disease
Female,Anemia
Female,Postpartum Hemorrhage
Female,Tinnitus
Male,Obstructive Sleep Apnea
```

La fila 4 ahora lleva `Spermatocele`. Nada más en la columna se movió.

**O subir el count** y conservar el 10 %. Con `count="20"` el subconjunto
masculino tiene diez filas, y el 10 % de diez es exactamente una:

`./run diagnosis.tdc (count=20, seed=demo, solo filas masculinas)`

```
Male,Osteoarthritis
Male,Hypothyroidism
Male,Obesity
Male,Vitamin D Deficiency
Male,Cryptorchidism
Male,Obstructive Sleep Apnea
Male,Varicose Veins
Male,Vitamin D Deficiency
Male,Attention Deficit Hyperactivity Disorder
Male,Cholecystitis
```

Un `Cryptorchidism` en diez filas masculinas, con cada seed. Una vez que la
cantidad de filas pedidas es un número entero, la cuenta es exacta y el seed solo
decide a qué filas les toca.

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
