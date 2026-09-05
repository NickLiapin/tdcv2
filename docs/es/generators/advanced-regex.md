<a name="top"></a>

[English](../../generators/advanced-regex.md#top) · [Русский](../../ru/generators/advanced-regex.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/generators/advanced-regex)**

← Anterior: [Regex](./regex.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Contadores (increment / decrement)](./counters.md#top) →

---

# El generador `advanced_regex`

**Se usa cuando** hace falta todo lo que hace [`regex`](regex.md#top), pero además la
forma misma del string carga una **distribución estadística** de variantes: por
ejemplo, exactamente 70% de los códigos empiezan con `RU`, 20% con `US` y 10% con
`DE`.

El [`regex`](regex.md#top) normal elige una alternativa `(RU|US|DE)` **al azar**, así que
el reparto solo sale bien en promedio. `advanced_regex` agrega la **elección
ponderada** (en inglés, _weighted choice_), que acomoda las variantes hasta cantidades
**exactas**.

```xml
<gen type="advanced_regex" value="(?%{70:RU;20:US;10:DE})-[0-9]{6}"/>
```

`advanced_regex` es un superconjunto de `regex`: el generador común
[`type="regex"`](regex.md#top) se mantiene estable y neutral respecto a TDC, mientras que
`advanced_regex` le suma encima potencia específica de TDC sobre el mismo motor
finito y portable. Hoy ese extra es exactamente una construcción — la **elección
ponderada** — y todo lo demás en esta página se hereda sin cambios de
[Regex](regex.md#top).

## Para qué sirve

Sin elección ponderada, «70% `RU`, 20% `US`, 10% `DE`, cada uno seguido de seis
dígitos aleatorios» requeriría varias secuencias o un
[`<mix>`](../reference/tags.md#distribuciones-y-selección) para expresarse. Con
`advanced_regex` todo eso se colapsa en un solo generador. Encaja de manera natural
en:

- códigos de países, sucursales, regiones o niveles de cliente;
- identificadores de prueba que deben variar en estructura pero mantener proporciones fijas;
- números de documento donde una parte del string tiene que repetir otra;
- datos sintéticos donde las **participaciones** importan tanto como los valores;
- archivos `.tdc` generados por IA, donde a un agente le resulta más fácil emitir un
  patrón compacto que un árbol de secuencias.

Las salidas de ejemplo de abajo son ilustrativas — las filas exactas dependen de la semilla
y pueden cambiar levemente entre versiones del núcleo — pero las **cantidades** que
promete una distribución sí son exactas.

## La elección ponderada

La construcción es:

```text
(?%{PERCENT:BRANCH;PERCENT:BRANCH;...})
```

Desglosada:

```text
(?%{   70:RU   ;   20:US   ;   10:DE   })
 │      │  │        │  │        │  │        │
 │      │  rama     │  rama     │  rama     │
 │      porcentaje  porcentaje  porcentaje  │
 └── inicio de la elección ponderada        ┘
```

Las reglas:

- los porcentajes deben ser números y **no negativos**;
- los porcentajes deben **sumar 100**;
- una rama puede estar vacía;
- una rama es en sí misma una expresión `advanced_regex` completa (así que se anidan);
- `;`, `}` y `:` son los caracteres de control —
  [escápelos](#escapes-dentro-de-una-elección-ponderada) si una rama los necesita de
  forma literal.

## Proporciones exactas, por omisión

Esto es lo principal: la elección ponderada promete porcentajes **exactos**
(exactamente 70 de 100, no «alrededor de 70»), y TDC los entrega **de fábrica** — no
hay que activar nada.

Para medir el reparto con exactitud, el motor construye **toda la columna de una vez**
y reparte las ramas con el método de Hamilton (mayor resto). Lo hace automáticamente
en cuanto aparece un `(?%{…})` en el patrón, incluso bajo el modo `disk` por omisión.
Usted solo pone el patrón; las participaciones salen parejas.

```xml
<env count="100" seed="countries">
  <sequence name="CountryCode">
    <gen type="advanced_regex" value="(?%{70:RU;20:US;10:DE})-[0-9]{2}"/>
  </sequence>
</env>
```

Cuente los prefijos en las 100 filas: exactamente 70/20/10.

`./run countries.tdc (100 filas, por prefijo)`

```
RU   70
US   20
DE   10
```

> [!NOTE]
> **El costo de la exactitud es memoria**
>
> Para medir el reparto con exactitud, una columna con elección ponderada se construye
> entera en RAM. Está bien para conjuntos chicos y medianos. Si necesita
> participaciones exactas mientras hace **streaming** (memoria O(1), cualquier tamaño de
> salida), [`<mix percent>`](../reference/tags.md#distribuciones-y-selección) y
> [`<gen type="text" percent="…">`](text.md#proporciones-exactas-con-percent) dan
> proporciones exactas en un flujo, sin retener la columna completa. Y si _a mano_ se
> fuerza el motor de streaming puro (`mode="stream"` en `<env>`, un alias heredado que solo
> existe como atributo, o `--engine 2` en la línea de comandos; `--mode stream` no existe),
> TDC no va a
> arruinar los porcentajes en silencio: como no puede contarlos fila por fila, se niega
> con un error claro. Quite la anulación y vuelve a ser exacto.

## Los pesos realmente mueven la distribución

Los porcentajes no son adorno: son la composición real de la columna. Tome un mismo
patrón, `(?%{…})-[0-9]{2}` con `count="1000"`, cambie **solo los pesos** y cuente los
prefijos:

```xml
<gen type="advanced_regex" value="(?%{70:RU;20:US;10:DE})-[0-9]{2}"/>  <!-- variante 1 -->
<gen type="advanced_regex" value="(?%{34:RU;33:US;33:DE})-[0-9]{2}"/>  <!-- variante 2 -->
<gen type="advanced_regex" value="(?%{10:RU;10:US;80:DE})-[0-9]{2}"/>  <!-- variante 3 -->
```

`./run weights.tdc (1000 filas, por prefijo)`

```
pesos            RU     US     DE
70 / 20 / 10     700    200    100
34 / 33 / 33     340    330    330
10 / 10 / 80     100    100    800
```

Sobre 1000 filas las cantidades reproducen los pesos uno a uno. Cambie los pesos y la
composición de la columna cambia con ellos.

## `regex` vs `advanced_regex`

| Capacidad                                 | `regex` | `advanced_regex` |
| :---------------------------------------- | :------ | :--------------- |
| Generar un string a partir de un patrón   | sí      | sí               |
| Clases de caracteres                      | sí      | sí               |
| Alfabetos Unicode con nombre              | sí      | sí               |
| Grupos y retrorreferencias                | sí      | sí               |
| Tope de longitud vía `regex_max_length`   | sí      | sí               |
| **Porcentajes exactos dentro del patrón** | no      | **sí**           |
| **Anidar variantes ponderadas**           | no      | **sí**           |
| Elección ponderada en el bloque de salida | no      | no               |

La diferencia se ve mejor lado a lado. El [`regex`](regex.md#top) simple elige cada
carácter libremente: la forma es fija, las participaciones no:

```xml
<gen type="regex" value="[A-Z]{2}[0-9]{6}"/>
```

`./run plain.tdc`

```
FZ399441
YH481897
LR586083
YA900972
WT831899
```

`advanced_regex` mantiene el mismo tipo de código pero fija las participaciones del
prefijo: 70% `RU`, 20% `US`, 10% `DE` a lo largo de toda la corrida:

```xml
<gen type="advanced_regex" value="(?%{70:RU;20:US;10:DE})-[0-9]{6}"/>
```

`./run coded.tdc (primeras 8 de 100 filas)`

```
RU-441627
RU-476822
RU-948319
US-450875
RU-398584
RU-131212
RU-418648
RU-830959
```

En resumen: use `regex` para un string con una forma dada; use `advanced_regex` cuando
la forma misma carga una distribución estadística.

## Hereda todo el lenguaje de regex

Toda construcción finita de [`regex`](regex.md#top) funciona también aquí: literales,
escapes, clases de caracteres, rangos BMP, alfabetos con nombre `\a{…}`, `\d`/`\w`/`\s`
y sus inversos, `.`, alternancia, grupos, retrorreferencias, cuantificadores acotados
y el tope [`regex_max_length`](../reference/attributes.md#top). Un reparto ponderado
simple sobre códigos latinos:

```xml
<gen type="advanced_regex" value="(?%{70:[A-Z]{2};30:[A-Z]{3}})-[0-9]{4}"/>
```

`./run mixed.tdc`

```
QY-3500
ZT-3381
GSK-1914
VO-5921
DW-7570
SO-1660
MSE-2247
```

**Demostración con Unicode.** Como las ramas aceptan
[alfabetos con nombre](symbol.md#alfabetos-con-nombre-mediante-alphabet), se pueden mantener
participaciones exactas entre distintas escrituras. Aquí 7 de cada 10 códigos toman un
prefijo cirílico y 3 toman uno latino — un ejemplo deliberado de
Unicode/localización, que muestra que la maquinaria de porcentajes exactos es
independiente de la escritura:

```xml
<gen type="advanced_regex" value="(?%{70:\a{cyrillic.ru.upper}{2};30:\a{latin.upper}{2}})-[0-9]{4}"/>
```

`./run unicode.tdc (count=10)`

```
ЭЗ-2477
WJ-0170
ЧП-8026
СЦ-1020
ЫЦ-2747
FJ-7879
РЛ-6827
ЩЕ-4485
ПВ-0297
UD-1550
```

## Elecciones ponderadas anidadas

Como las ramas son expresiones completas, las elecciones ponderadas se anidan — y el
reparto interior se calcula **dentro del subconjunto** que llegó a la rama exterior:

```xml
<gen type="advanced_regex" value="(?%{50:A(?%{80:X;20:Y});50:B})"/>
```

Con `count="100"`:

`./run nested.tdc (100 filas)`

```
AX   40
AY   10
B    50
```

El 80% de las 50 filas `A` son 40 `AX`; el 20% son 10 `AY`. Este comportamiento de
«porcentajes dentro de un subconjunto» coincide exactamente con la filosofía de
[jerarquía de secuencias](../core-concepts/sequences.md#top) de TDC.

## Varias elecciones ponderadas en un mismo patrón

```xml
<gen type="advanced_regex" value="(?%{60:M;40:F})-(?%{25:00;75:99})"/>
```

Cada distribución se mide con exactitud sobre las filas actuales. Con `count="100"`:

`./run two.tdc (100 filas)`

```
M-99   44
F-99   31
M-00   16
F-00    9
```

Sume cada parte y las dos son exactas: `M` = 44 + 16 = 60 y `F` = 31 + 9 = 40
(60/40); `99` = 44 + 31 = 75 y `00` = 16 + 9 = 25 (75/25). Dos elecciones
independientes, cada una acomodada por el mismo método de porcentajes exactos.

## Con un filtro `parent`

`advanced_regex` vive dentro del modelo normal de dependencias entre secuencias. Si la
secuencia está filtrada por
[`parent`](../core-concepts/sequences.md#secuencias-dependientes-parent), los porcentajes
cuentan **solo dentro del subconjunto filtrado**:

```xml
<sequence name="Gender">
    <gen type="text" value="M,F" percent="50,50"/>
</sequence>

<sequence name="MaleCode" parent="Gender.M">
    <gen type="advanced_regex" value="M-(?%{40:A;60:B})-[0-9]{2}"/>
</sequence>
```

Con `count="100"` (50 hombres):

`./run parent.tdc (100 filas)`

```
F      50    (MaleCode vacío)
M-A    20
M-B    30
```

El reparto 40/60 se mide contra las **50 filas filtradas**, no contra las 100
completas.

## Capturas y retrorreferencias

Una retrorreferencia repite un grupo que ya se generó. Esto funciona exactamente igual
que en el [`regex`](regex.md#top) normal: los primeros tres dígitos se repiten al final:

```xml
<gen type="advanced_regex" value="([0-9]{3})-[A-Z]{2}-\1"/>
```

`./run backref.tdc`

```
299-YZ-299
929-UE-929
462-VR-462
905-BC-905
876-JF-876
```

**Una rama ponderada se puede capturar** y repetir con `\1`: la parte capturada se
repite tal cual y los porcentajes se siguen cumpliendo. Con `count="40"`:

```xml
<gen type="advanced_regex" value="((?%{25:AB;75:CD}))-\1"/>
```

`./run branch-capture.tdc (40 filas)`

```
AB-AB   10
CD-CD   30
```

El par capturado se repite literalmente, y el reparto 25/75 sobrevive.

**Una captura hecha antes de una elección ponderada** se puede usar dentro de una
rama. Aquí la mitad de las filas repite las dos letras capturadas y la otra mitad
imprime el fijo `XX` (`count="8"`):

```xml
<gen type="advanced_regex" value="([A-W]{2})-(?%{50:\1;50:XX})"/>
```

`./run capture-in-branch.tdc`

```
TV-XX
GR-GR
RN-XX
OU-OU
WM-WM
SS-XX
CL-XX
QG-QG
```

**Una retrorreferencia puede vivir dentro de una rama.** Donde se tomó la rama
`(A[0-9])`, `\1` repite su captura; donde se tomó la rama `B` no hay captura, así que
`\1` queda vacío (`count="20"`):

```xml
<gen type="advanced_regex" value="(?%{40:(A[0-9]);60:B})-\1"/>
```

`./run optional-capture.tdc`

```
A2-A2
B-
B-
A1-A1
B-
A8-A8
B-
```

No es un `if` completo, pero ya es un vínculo lógico útil: una parte del string puede
depender de un grupo ya generado.

## Escapes dentro de una elección ponderada

`;`, `}` y `:` son los caracteres de control de una elección ponderada. Para usarlos
como texto literal en una rama, hay que escaparlos (`count="6"`):

```xml
<gen type="advanced_regex" value="(?%{50:A\;\}\:;50:B})"/>
```

`./run escape.tdc`

```
A;}:
A;}:
B
B
A;}:
B
```

La rama `A\;\}\:` imprime el literal `A;}:`, y la rama `B` imprime solo `B`.

## Dónde funciona la elección ponderada

La elección ponderada fija un reparto porcentual exacto, así que el runtime tiene que
saber cuántas filas le tocan a cada rama. Eso se conoce en todos los lugares donde
puede aparecer un `<gen>`:

- dentro de una [`<sequence>`](../core-concepts/sequences.md#top) — por `count`, o por un
  subconjunto `parent`;
- dentro de un `<case>` de un
  [`<mix>`](../reference/tags.md#distribuciones-y-selección) — por el tamaño de ese
  caso.

Los dos son válidos:

```xml
<sequence name="CountryCode">
    <gen type="advanced_regex" value="(?%{70:RU;20:US;10:DE})-[0-9]{2}"/>
</sequence>

<mix name="Country" percent="50,50">
    <case><gen type="advanced_regex" value="(?%{70:RU;30:US})"/></case>
    <case><data>-</data></case>
</mix>
```

**No hay generadores en el bloque de salida** — una
[`<line>`](../core-concepts/output-formatting.md#top) solo da formato — así que la
elección ponderada nunca aterriza ahí. Para imprimir una, declárela como secuencia e
interpólela con `${{Nombre}}`:

```xml
<tdc>
    <env count="100" seed="demo" inject="${{%}}">
        <sequence name="Code">
            <gen type="advanced_regex" value="(?%{70:A;30:B})-[0-9]{4}"/>
        </sequence>
    </env>
    <block>
        <line><data>code=${{Code}}</data></line>
    </block>
</tdc>
```

Primeras filas, con la corrida repartida exactamente en 70 `A` / 30 `B`:

`./run code.tdc (primeras filas de 100)`

```
code=A-8870
code=B-2495
code=B-1961
code=A-8865
code=A-9221
code=A-3234
```

El orden de las filas se baraja de forma determinista según el `seed`; los totales
siguen siendo exactos.

## Ejemplos prácticos

**Código de cliente por segmento** — `count="1000"`, contando los prefijos:

```xml
<gen type="advanced_regex" value="(?%{80:REG;15:VIP;5:TEST})-[A-Z]{2}[0-9]{4}"/>
```

`./run segment.tdc (1000 filas, por prefijo)`

```
REG    800
VIP    150
TEST    50
```

**Documento con un bloque que se repite** — los primeros tres dígitos y los últimos
tres siempre coinciden, mientras que la parte del medio se reparte 60% `A` / 40% `B`
(`count="100"`):

```xml
<gen type="advanced_regex" value="([0-9]{3})-(?%{60:A;40:B})-\1"/>
```

`./run doc.tdc (primeras filas de 100)`

```
924-B-924
419-B-419
788-A-788
692-B-692
```

**Códigos técnicos cortos vs largos** — 85% cortos, 15% largos (`count="100"`):

```xml
<gen type="advanced_regex" value="(?%{85:[A-Z]{2}[0-9]{2};15:[A-Z]{4}[0-9]{8}})"/>
```

`./run codes.tdc (100 filas, por longitud)`

```
longitud  4    85    (AB42)
longitud 12    15    (ABCD12345678)
```

## ¿`<mix>` o `advanced_regex`?

Los dos hacen porcentajes exactos, para trabajos distintos.

Use [`<mix>`](../reference/tags.md#distribuciones-y-selección) cuando las ramas tienen
**estructura diferente** — cada una con sus propios generadores y su texto literal (y
`<mix percent>` da participaciones exactas mientras hace **streaming**, sin retener la
columna en memoria):

```xml
<mix name="Kind" percent="70,30">
    <case><data>{"type":"regular"}</data></case>
    <case><data>{"type":"vip","bonus":true}</data></case>
</mix>
```

Use `advanced_regex` cuando todo cabe en un solo patrón (exacto por omisión; la
columna se construye en RAM — para salidas muy grandes es preferible
`<mix percent>`):

```xml
<gen type="advanced_regex" value="(?%{70:REG;30:VIP})-[0-9]{6}"/>
```

## Patrones inválidos

```xml
<gen type="advanced_regex" value="(?%{70:A;20:B})"/>   <!-- suma 90, necesita 100 -->
<gen type="advanced_regex" value="[a-z]+"/>            <!-- sin cota, como en regex normal -->
```

Los dos se rechazan antes de generar — el segundo:

`./run bad.tdc`

```
error: invalid advanced_regex generator pattern: unbounded "+"
quantifier is not allowed; use "{1,n}"
```

## Ponerle nombre a un grupo — `(?<name>…)`

Un grupo puede llevar un nombre además de un número:

```text
(?<sex>(?%{50:male;50:female}))
```

Es un grupo de captura corriente — `\1` lo sigue leyendo — con una etiqueta. La
etiqueta existe para que algo MÁS ADELANTE en el patrón pueda preguntar qué produjo
este grupo, que es de lo que trata la sección siguiente.

Los nombres empiezan con una letra o `_` y llevan letras, dígitos y `_`. Dos grupos no
pueden compartir un nombre: `(?if{sex=…})` sería entonces un volado entre ellos.

## Que una parte siga a otra — `(?if{…})`

**Úselo cuando** dos partes del mismo valor tienen que concordar. Todo lo demás en
este generador decide un valor solo a partir del azar, y por eso un patrón podía
describir un código postal o un identificador pero nunca un tratamiento que
concuerde con un sexo elegido dos caracteres antes. Eso significaba abandonar
`advanced_regex` y rehacer la columna como un [`<switch>`](../reference/tags.md#top).

```xml
<gen type="advanced_regex" value="(?<sex>(?%{50:male;50:female}))/(?if{sex=male:Mr;sex=female:Ms})"/>
```

`./run titles.tdc (count=8, seed=titles)`

```
female/Ms
male/Mr
male/Mr
female/Ms
male/Mr
female/Ms
female/Ms
male/Mr
```

Cada fila concuerda consigo misma. A `male` nunca le sigue `Ms`.

### Cómo se lee

`(?if{nombre=valor:rama;nombre=valor:rama})`. Las ramas se separan con `;`, y cada una
es `qué se prueba`, luego `:`, luego `qué se produce`. Se prueban **en el orden
escrito** y gana **la primera que coincide**.

Una rama es una expresión `advanced_regex` completa, así que dentro se anidan
elecciones ponderadas y más condicionales:

```xml
<gen type="advanced_regex" value="(?<country>(?%{60:RU;30:US;10:DE}))-(?if{country=RU:[0-9]{3};country=US:[A-Z]{3};*:[A-Z]{2}[0-9]})"/>
```

`./run plates.tdc (count=10, seed=plates)`

```
RU-683
US-NGS
DE-ZQ5
US-VNS
RU-867
RU-722
RU-372
RU-890
US-SEA
RU-589
```

`*` es la rama que coincide con **todo lo demás** — aquí las filas `DE`. Sin ella, una
fila que no coincide con ninguna rama produce **nada en absoluto** en ese lugar:

```text
(?<c>(?%{50:a;50:b}))-(?if{c=zzz:NEVER})     →  a-   b-   a-   b- …
```

Es deliberado. El patrón no dijo nada sobre qué debía producir una fila `a`, y caer en
silencio en la primera rama emparejaría cosas equivocadas en un archivo que por lo
demás se ve bien. Escriba una rama `*` para decir lo que quería.

### Lo que no hace

- **No lee un grupo declarado después.** El patrón se construye de izquierda a
  derecha, así que un grupo más adelante no ha producido nada con qué comparar y la
  rama nunca podría tomarse. Se rechaza, en vez de dejarla producir mitades vacías.
- **No lee nada más que un grupo con nombre** — ni otra columna, ni `${{…}}`. Para
  lógica entre columnas están [`<switch>`](../reference/tags.md#top) y el filtro
  [`parent`](../core-concepts/sequences.md#secuencias-dependientes-parent); esto es
  para partes de UN valor.
- **No compara más que texto.** La prueba es `nombre=valor`, una coincidencia exacta
  con lo que produjo el grupo. Un valor no puede contener `:` — ahí empieza la rama.

### Las cuotas siguen exactas

El condicional lee la elección ponderada; no la altera. Sobre 200 filas
`(?<c>(?%{70:RU;20:US;10:DE}))` sigue dando exactamente 140, 40 y 20 — y la segunda
mitad de cada fila se sigue de su propia primera mitad.

## Vea también

- **[Regex](regex.md#top)** — las construcciones finitas que hereda esta página.
- **[Symbol](symbol.md#alfabetos-con-nombre-mediante-alphabet)** — los alfabetos con nombre
  (`\a{name}`).
- [`regex_max_length`](../reference/attributes.md#top) en la referencia de atributos.
- [`<mix>`](../reference/tags.md#distribuciones-y-selección) — porcentajes exactos
  entre ramas de estructura distinta.

---

← Anterior: [Regex](./regex.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Contadores (increment / decrement)](./counters.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/generators/advanced-regex)**
