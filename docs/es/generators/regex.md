<a name="top"></a>

[English](../../generators/regex.md#top) · [Русский](../../ru/generators/regex.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/generators/regex)**

← Anterior: [Symbol](./symbol.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Regex avanzado](./advanced-regex.md#top) →

---

# El generador `regex`

**Se usa cuando** un valor tiene una **forma estricta** — un número de teléfono, un SKU,
una placa de auto, un token, un código de pedido. Hay demasiadas posibilidades para una
lista, y demasiada estructura interna para [`number`](number.md#top): letras, dígitos y
separadores en lugares determinados.

Una expresión regular describe esa forma. El generador la lee de izquierda a derecha y
llena cada hueco con caracteres aleatorios del conjunto correcto, imprimiendo los
literales (guiones, paréntesis, `@`) tal cual.

> [!NOTE]
> **Un subconjunto finito y portable**
>
> Esto **no** es el `RegExp` completo de JavaScript. Es un subconjunto finito que se puede
> implementar de forma idéntica en cada lenguaje. La única regla dura: el
> resultado debe tener una **longitud acotada**, así que `*`, `+` y `{n,}` no están
> permitidos — siempre se escribe un tope superior explícito.

## Un ejemplo desarrollado

Un número de teléfono en formato estadounidense:

```xml
<gen type="regex" value="\+1 \([0-9]{3}\) [0-9]{3}-[0-9]{4}"/>
```

`./run phone.tdc`

```
+1 (299) 994-1396
+1 (929) 818-7014
+1 (462) 860-3781
+1 (905) 009-2500
+1 (876) 318-9991
```

Los paréntesis, los espacios y los guiones son literales (la barra invertida antes de `(`
y `)` los convierte en caracteres comunes). El `\+1` es un `+1` literal, y los grupos
`[0-9]{…}` son huecos que reciben dígitos aleatorios. La forma es siempre la misma; los
valores cambian.

Todos los ejemplos de esta página se renderizan con `seed="demo"`. Pero el sorteo lo
deciden dos cosas, y la segunda sorprende: la semilla **y el nombre de la secuencia**. Cada
columna saca de su propio flujo, derivado de ambos, para que agregar una columna nunca
desplace a las de al lado — así que el mismo patrón bajo `<sequence name="Phone">` y bajo
`<sequence name="V">` da strings distintos con la misma semilla. Si copia un patrón de esta
página a una secuencia con otro nombre, espere otros valores.

Los valores de salida son ilustrativos; los strings exactos pueden cambiar según la
versión del core, pero la forma nunca.

Otras formas de todos los días:

| Tarea                      | Patrón                              | Ejemplo                            |
| :------------------------- | :---------------------------------- | :--------------------------------- |
| SKU                        | `[A-Z]{3}-[0-9]{4}`                 | `SAH-0136`                         |
| Placa (EE. UU.)            | `[0-9][A-Z]{3}[0-9]{3}`             | `7KLM042`                          |
| Token hex de 32 caracteres | `[A-F0-9]{32}`                      | `5AE5ABF3F7040BEB966D65A23EB7C1EC` |
| Correo de prueba           | `user_[a-z0-9]{8}@test\.(com\|org)` | `user_zak0bdnw@test.com`           |

Ese mismo SKU, renderizado completo:

```xml
<gen type="regex" value="[A-Z]{3}-[0-9]{4}"/>
```

`./run sku.tdc`

```
FZY-9944
YHZ-8189
LRG-8608
YAO-0097
WTR-3189
```

## Cuándo el `regex` simple es la herramienta correcta

Use `type="regex"` para describir la **forma de un string** cuando no se necesitan
proporciones exactas dentro de él. Una alternancia como `(com|org)` se elige **al azar y
de forma independiente** en cada fila — está bien cuando el reparto exacto de las
variantes no importa.

Buenos trabajos para el `regex` simple:

- un ID técnico: `[A-Z]{2}[0-9]{6}`;
- un correo de prueba seguro: `user_[a-z0-9]{8}@test\.(com|org)`;
- un código con un bloque que se repite: `([0-9]{3})-[A-Z]{2}-\1`;
- un token de longitud fija: `[A-F0-9]{32}`.

Si se necesitan **porciones exactas** de variantes dentro del string (digamos, exactamente
70 % con un prefijo), el `regex` simple no lo hace — eche mano de
[`advanced_regex`](advanced-regex.md#top):

```xml
<gen type="advanced_regex" value="(?%{70:US;20:CA;10:UK})-[0-9]{6}"/>
```

## La sintaxis de un vistazo

| Construcción         | Ejemplo                      | Genera                                           |
| :------------------- | :--------------------------- | :----------------------------------------------- |
| Literales            | `ABC-42`                     | Exactamente esos caracteres                      |
| Caracteres escapados | `\.\+\(\)\\`                 | Punto, más, paréntesis, barra invertida          |
| Clase de caracteres  | `[ABC]`, `[a-z]`, `[A-Z0-9]` | Un carácter del conjunto                         |
| Rango Unicode BMP    | `[а-я]`, `[א-ת]`, `[ぁ-ゖ]`  | Un carácter del rango                            |
| Alfabeto con nombre  | `\a{kana.hiragana}`          | Un carácter de un alfabeto incorporado           |
| Clase negada         | `[^0-9]`                     | Un carácter ASCII imprimible, salvo esos         |
| Clase abreviada      | `\d`, `\w`, `\s`             | Dígito, carácter de palabra, espacio o tabulador |
| Abreviada inversa    | `\D`, `\W`, `\S`             | Lo inverso de lo anterior                        |
| Cualquier carácter   | `.`                          | Un carácter ASCII imprimible                     |
| Alternancia          | `cat\|dog`                   | `cat` o `dog`                                    |
| Grupo                | `(cat\|dog)`                 | Agrupación y captura                             |
| Grupo sin captura    | `(?:cat\|dog)`               | Agrupación sin captura                           |
| Retrorreferencia     | `([0-9]{3})-\1`              | Repite un grupo ya generado                      |
| Opcional             | `AB?C`                       | `AC` o `ABC`                                     |
| Repetición exacta    | `[A-Z]{4}`                   | Exactamente 4                                    |
| Repetición por rango | `[A-Z]{2,5}`                 | De 2 a 5                                         |
| Anclas               | `^ABC$`                      | Ancho cero; el resultado es `ABC`                |

El resto de esta página es la misma lista, pero con **salida real** debajo de cada
entrada.

## Clases de caracteres

`[…]` toma un carácter al azar del conjunto. Un rango `a-z` es la forma corta de decir
todas las letras de la `a` a la `z`.

```xml
<gen type="regex" value="[ABC]{6}"/>     <!-- solo A, B, C -->
<gen type="regex" value="[a-z]{6}"/>     <!-- latinas minúsculas -->
<gen type="regex" value="[A-Z0-9]{6}"/>  <!-- mayúsculas y dígitos -->
```

`./run demo.tdc`

```
[ABC]{6}      [a-z]{6}      [A-Z0-9]{6}
CAACAA        sahtbc        ZAK0BD
CCACAC        rvhyfr        Y3K7HY
AAABAC        ggaqby        IJBWC8
```

Cada hueco se elige de forma independiente, así que las letras se repiten en `[ABC]{6}` —
son seis caracteres aleatorios por separado, no una selección sin repetición.

## Clases abreviadas — `\d` `\w` `\s`

Conjuntos listos para usar: `\d` es un dígito `[0-9]`, `\w` es una letra, un dígito o
`_`, y `\s` es un espacio o un tabulador.

```xml
<gen type="regex" value="\d{6}"/>
<gen type="regex" value="\w{8}"/>
```

`./run demo.tdc`

```
\d{6}      \w{8}
702701     tBSvCGXm
682926     qyR7NqAz
220609     OQBoE7TG
```

`\s` es invisible en la salida, así que aquí los espacios y tabuladores se muestran como
`<SP>` y `<TAB>` (en la salida real son espacios en blanco comunes):

<!-- doc-check: skip los espacios se escriben como <SP>/<TAB> para que el lector los vea -->

```xml
<gen type="regex" value="A\sB\sC"/>
```

`./run demo.tdc`

```
A<TAB>B<TAB>C
A<SP>B<TAB>C
A<SP>B<SP>C
```

## Clases negadas — `[^…]` `\D` `\W` `\S`

`[^0-9]` y `\D` dan **cualquier carácter ASCII imprimible excepto** los listados. Son
equivalentes y producen la misma salida con la misma semilla:

```xml
<gen type="regex" value="[^0-9]{6}"/>
<gen type="regex" value="\D{6}"/>
```

`./run demo.tdc`

```
[^0-9]{6}    \D{6}
f"Bi#)       f"Bi#)
cnAz<b       cnAz<b
@!"%zR       @!"%zR
```

Note que el conjunto es **todo el ASCII imprimible** (letras, dígitos, puntuación), no
solo letras. Si lo que quiere es únicamente una letra que no sea dígito, escríbalo
explícitamente: `[A-Za-z]`.

## Cualquier carácter — `.`

El punto es un carácter ASCII imprimible (el mismo conjunto que `\D`, sin exclusiones):

```xml
<gen type="regex" value=".{8}"/>
```

`./run demo.tdc`

```
3|{Dy{JH
z9{Gl0mx
J^9Pp_%r
z!Tx'){i
```

## Cuantificadores — cuántas veces

`{n}` es exactamente `n`; `{n,m}` es de `n` a `m` (al azar); `?` es cero o uno (así que
`AB?C` es `AC` o `ABC`).

```xml
<gen type="regex" value="[A-Z]{4}"/>    <!-- exactamente 4 -->
<gen type="regex" value="[A-Z]{2,5}"/>  <!-- de 2 a 5 -->
<gen type="regex" value="AB?C"/>        <!-- B opcional -->
```

`./run demo.tdc`

```
[A-Z]{4}    [A-Z]{2,5}    AB?C
SAHT        SAHTB         ABC
RVHY        RVH           AC
GGAQ        GG            AC
```

Cambie el cuantificador y cambia la longitud — mismo esqueleto (letras y luego dígitos),
distinto tamaño:

```xml
<gen type="regex" value="[A-Z]{2}[0-9]{4}"/>   <!-- corto -->
<gen type="regex" value="[A-Z]{3}[0-9]{8}"/>   <!-- largo -->
```

`./run demo.tdc`

```
[A-Z]{2}[0-9]{4}    [A-Z]{3}[0-9]{8}
SA7013              SAH01363846
RV9260              RVH26087805
GG6093              GGA09313068
```

## Alternancia y grupos — `|` `(…)` `(?:…)`

`cat|dog` elige una variante **al azar** en cada fila. Los paréntesis agrupan variantes
para poder pegarles un sufijo o un cuantificador.

```xml
<gen type="regex" value="cat|dog"/>            <!-- alternancia -->
<gen type="regex" value="(cat|dog)-[0-9]{2}"/> <!-- grupo + sufijo -->
<gen type="regex" value="(?:cat|dog)[0-9]"/>   <!-- sin captura -->
```

`./run demo.tdc`

```
cat|dog    (cat|dog)-[0-9]{2}    (?:cat|dog)[0-9]
dog        dog-02               dog7
cat        cat-82               cat6
cat        cat-20               cat2
dog        dog-77               dog2
```

Un grupo simple `(…)` recuerda su elección (la captura), así que se puede volver a él con
`\1`. `(?:…)` agrupa sin recordar — úselo cuando no necesite la captura.

> [!NOTE]
> **Aleatorio, no exacto**
>
> `cat` y `dog` salen de forma despareja — es una elección **aleatoria**, no una proporción
> exacta. Para exactamente 70/30, use [`advanced_regex`](advanced-regex.md#top).

## Anclas — `^` `$`

`^` (inicio) y `$` (fin) son de ancho cero: el generador las acepta pero no agregan nada
a la salida. `^[A-Z]{3}$` produce las mismas tres letras que `[A-Z]{3}`:

```xml
<gen type="regex" value="^[A-Z]{3}$"/>
```

`./run demo.tdc`

```
FZY
YHZ
LRG
```

## Escapado

Convierta un metacarácter de regex en un literal común con `\`:

```xml
<gen type="regex" value="\.\+\(\)\[\]\{\}\\"/>
```

Aquí el string generado es constante (no hay huecos aleatorios):

`./run demo.tdc`

```
.+()[]{}\
```

Dentro de una clase de caracteres, un guion es un literal cuando va primero o último —
entonces es solo el carácter `-`, no un rango:

```xml
<gen type="regex" value="[-A-C]{8}"/>
<gen type="regex" value="[A-C-]{8}"/>
```

`./run demo.tdc`

```
[-A-C]{8}    [A-C-]{8}
B-AB--AB     CABCAABC
BCAC-B-C     C-B-ACA-
-A-B-CA-     ABACA-BA
```

El conjunto aquí son cuatro caracteres: `A`, `B`, `C` y `-`.

## Alfabetos Unicode

Las clases de caracteres no están limitadas a ASCII. La misma maquinaria acepta cualquier
rango Unicode BMP y cualquier **alfabeto con nombre** incorporado, así que el generador se
localiza sin casos especiales. Empiece por la escritura latina que sus datos suelen
necesitar — un rango simple cubre directamente las letras acentuadas de Europa
occidental:

```xml
<gen type="regex" value="[a-zà-ÿ]{8}"/>  <!-- latinas + acentos -->
```

`./run demo.tdc`

```
lþýwüýzy
ýpþyôkõü
zìpãöídø
```

Los ejemplos de abajo son una **demostración deliberada de Unicode y localización** —
escrituras no latinas escritas de la misma manera. Los rangos BMP simples funcionan
directamente dentro de una clase de caracteres:

```xml
<gen type="regex" value="[а-я]{8}"/>   <!-- cirílico -->
<gen type="regex" value="[א-ת]{6}"/>   <!-- hebreo -->
```

`./run demo.tdc`

```
[а-я]{8}      [א-ת]{6}
цайчбглу      ףאחפבג
хщиюжхаъ      עץחשוע
зибфвюкг      זחאסבש
```

Para configuraciones reales, los alfabetos con nombre son más claros — están
documentados, validados por su nombre y pueden incluir caracteres incómodos de expresar
como rango (como la `ё` rusa):

```xml
<gen type="regex" value="\a{cyrillic.ru.letters}{10}"/>
<gen type="regex" value="\a{kana.hiragana}{8}"/>
```

`./run demo.tdc`

```
\a{cyrillic.ru.letters}{10}    \a{kana.hiragana}{8}
нБСпВЖЧжХч                     まぃすめいおちふ
куСьНкАупф                     ほゆすをこぺあょ
```

Se pueden mezclar alfabetos dentro de una misma clase — el carácter se toma entonces de
la unión:

```xml
<gen type="regex" value="[\a{arabic.letters}\a{hebrew.letters}]{6}"/>
```

`./run demo.tdc`

```
خררػקר
קسרؾםح
ؿדسلנה
```

El escape `\a{name}` es un carácter de ese alfabeto y se comporta como cualquier átomo —
repítalo con `{n}` o `{n,m}`; dentro de una clase agrega el alfabeto completo al
conjunto. La lista completa de nombres está en la página
[Symbol](symbol.md#alfabetos-con-nombre-mediante-alphabet).

> [!NOTE]
> Las clases negadas (`[^...]`), `\D`, `\W`, `\S` y `.` invierten únicamente contra el
> conjunto **ASCII** imprimible. Para Unicode, escriba un conjunto positivo con `\a{name}`.

## Retrorreferencias

Una retrorreferencia ata entre sí partes de un string: `\1` repite lo que el primer grupo
`(…)` ya generó.

```xml
<gen type="regex" value="([0-9]{3})-[A-Z]{2}-\1"/>
```

`./run demo.tdc`

```
299-YZ-299
929-UE-929
462-VR-462
905-BC-905
```

Los primeros y los últimos tres dígitos **siempre coinciden** — ese es el bloque
capturado. Así se construyen números de documento donde una sección se repite.

Una referencia solo puede apuntar a un grupo ya generado a su izquierda; una referencia
hacia adelante es un error:

```xml
<gen type="regex" value="\1([0-9]{3})"/>
```

`./run bad.tdc`

```
error: invalid regex generator pattern: backreference "\1" points to
a group that is not generated yet
```

Si la captura está dentro de una repetición, la retrorreferencia usa el **último** valor
que ese grupo generó:

```xml
<gen type="regex" value="([A-Z]){3}-\1"/>
```

`./run demo.tdc`

```
FZY-Y
YHZ-Z
LRG-G
```

Aquí `([A-Z]){3}` corre el grupo tres veces, y `\1` repite solo la tercera letra que
produjo.

## El límite de longitud — `regex_max_length`

Cada resultado se contrasta con
[`regex_max_length`](../reference/attributes.md#top) (por omisión **32**). Un patrón que
pudiera excederlo se rechaza **antes** de generar:

```xml
<gen type="regex" value="[A-Z0-9]{40}"/>
```

`./run token.tdc`

```
error: invalid regex generator pattern: regex can produce 40 characters,
which exceeds regex_max_length=32
```

Suba el tope para toda la configuración en `<tdc>`. Use esto cuando una configuración
tiene varios patrones largos y quiere fijar el techo en un solo lugar:

```xml
<tdc regex_max_length="64">
    <env count="5" seed="demo">
        <sequence name="Token"><gen type="regex" value="[A-Z0-9]{40}"/></sequence>
    </env>
    <block>
        <line><data>${{Token}}</data></line>
    </block>
</tdc>
```

`./run token.tdc`

```
MURI40FXS16A2ABROOBQFGMSDBLWP3TCDTA16VVK
NPJ3PVSU1NGARTRDQHT92IHGWJZVUST4531IOEAW
66WWVKTAA2XWUQJBJA8P0SNZ6W3Q75R3CP12JIXW
```

O fíjelo **localmente**, solo en este generador, cuando un único campo es la excepción y
no quiere aflojar el techo en todos los demás:

```xml
<gen type="regex" value="[A-Z0-9]{40}" regex_max_length="40"/>
```

`./run token.tdc`

```
H88N88QPEO7XQU8Y3HSZVUVHBRNYDL22R5UYULFK
8J8P2G372CFQ09IGKO4DBWVJ7OX20A24XAGFOCA2
PXJS4YC5M13GUWUS7BVTYLT6Y3YFXOC04TLQUFZF
```

`regex_max_length` **no** vuelve finita una regex infinita — solo permite que un
resultado ya finito sea más largo.

## Qué no está permitido

| No permitido           | Por qué                                        | Use en su lugar                  |
| :--------------------- | :--------------------------------------------- | :------------------------------- |
| `*`                    | Sin tope superior                              | `{0,n}`                          |
| `+`                    | Sin tope superior                              | `{1,n}`                          |
| `{n,}`                 | Sin tope superior                              | `{n,m}`                          |
| Perezosos `*?`, `??`   | Semántica de búsqueda, no de generación        | Escriba el rango que quiere      |
| Lookahead / lookbehind | Inspeccionan texto existente, no lo construyen | Mueva la condición al DSL        |
| Capturas con nombre    | Todavía no implementadas                       | Grupos simples y `\1`            |
| Grupos condicionales   | Todavía no implementados                       | Use `<mix>` o una sequence       |
| `\p{...}` / `\P{...}`  | Las propiedades Unicode aún no son portables   | `\a{name}` o una clase explícita |
| `\n` / `\r`            | La generación multilínea vive en otro lado     | Use `<line>`s separados          |

Por ejemplo, `+` se rechaza de inmediato:

```xml
<gen type="regex" value="[a-z]+"/>
```

`./run bad.tdc`

```
error: invalid regex generator pattern: unbounded "+" quantifier is not
allowed; use "{1,n}"
```

## Proporciones exactas

El `regex` simple no fija porcentajes dentro de la expresión — `(cat|dog)` es aleatorio,
no exactamente 70/30. Para porciones exactas use:

- [`<mix percent="…">`](../reference/tags.md#top) para elegir entre fragmentos del DSL;
- [`<gen type="text" percent="…">`](text.md#top) para un conjunto de valores;
- [`advanced_regex`](advanced-regex.md#top) para elección ponderada dentro del propio patrón.

## Vea también

- **[Advanced Regex](advanced-regex.md#top)** — el mismo motor más elección ponderada.
- **[Symbol](symbol.md#top)** — cuando solo se necesita un conjunto de caracteres, no
  estructura.
- [`regex_max_length`](../reference/attributes.md#top) y [`alphabet`](../reference/attributes.md#top).

---

← Anterior: [Symbol](./symbol.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Regex avanzado](./advanced-regex.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/generators/regex)**
