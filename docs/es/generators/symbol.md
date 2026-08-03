<a name="top"></a>

[English](../../generators/symbol.md#top) · [Русский](../../ru/generators/symbol.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/generators/symbol)**

← Anterior: [Date](./date.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Regex](./regex.md#top) →

---

# El generador `symbol`

**Se usa cuando** se necesita un string de cierta longitud construido a partir de un
conjunto específico de **caracteres** — un token, un código de cupón, un sufijo
aleatorio o ruido en una escritura particular. `symbol` elige **un carácter a la vez**
de un conjunto que usted define. (Para una **palabra** completa tomada de una lista, use
[`text`](text.md#top) en su lugar.)

El conjunto de caracteres se define de **una de dos** maneras — nunca las dos a la vez:

- [`value`](#su-propio-conjunto-con-value) — escriba su propio conjunto, aquí mismo;
- [`alphabet`](#alfabetos-con-nombre-mediante-alphabet) — nombre un alfabeto Unicode
  incorporado.

Después, [`length`](#longitud) dice cuántos caracteres producir, y
[`include`](#ampliar-el-conjunto-con-include) / [`exclude`](#recortar-el-conjunto-con-exclude)
ajustan el conjunto sin reescribirlo.

Las salidas de ejemplo de esta página son ilustrativas — los caracteres exactos dependen
del seed y pueden cambiar entre versiones del core. Las **reglas** que muestran sí son
estables.

## De un vistazo

| Atributo   | Obligatorio    | Qué hace                                                      |
| :--------- | :------------- | :------------------------------------------------------------ |
| `value`    | uno de los dos | Su propio conjunto de caracteres (literales + rangos `[x-y]`) |
| `alphabet` | uno de los dos | Nombre de un alfabeto Unicode incorporado                     |
| `length`   | no             | Longitud del string; por omisión `1`, máximo `1024`           |
| `include`  | no             | Agrega caracteres al conjunto (misma gramática que `value`)   |
| `exclude`  | no             | Quita caracteres del conjunto                                 |

## Su propio conjunto con `value`

El camino más simple: liste en `value` los caracteres que quiere. No hacen falta
expresiones regulares — usted escribe el conjunto y `symbol` sortea de ahí.

```xml
<gen type="symbol" value="ABCDEF" length="4"/>        <!-- literales -->
<gen type="symbol" value="[a-z]" length="6"/>         <!-- un rango -->
<gen type="symbol" value="[A-Z0-9]" length="8"/>      <!-- dos rangos en un grupo -->
<gen type="symbol" value="[a-f]xY[0-9]" length="5"/>  <!-- rangos + literales mezclados -->
```

`./run demo.tdc`

```
value="ABCDEF" length="4"      → CDFA
value="[a-z]" length="6"       → tqmboa
value="[A-Z0-9]" length="8"    → K7QW2ZP4
value="[a-f]xY[0-9]" length="5" → x3bYa
```

### Las reglas de un conjunto

- **Literales** — simplemente escriba los caracteres: `value="ABCDEF"` → el conjunto
  `{A, B, C, D, E, F}`.
- **Rangos** — entre corchetes: `[a-z]`, `[A-Z]`, `[0-9]`. Se pueden poner varios rangos
  en un mismo grupo: `[a-z0-9_]`.
- **Las comas y los espacios fuera de los corchetes se ignoran** — están ahí solo por
  legibilidad: `value="[a-f], [0-5]"` es el mismo conjunto que `value="[a-f][0-5]"`. Para
  usar una coma o un espacio _como carácter_, póngalo entre corchetes: `[,]`, `[ ]`.
- **Los duplicados se eliminan; el orden se conserva.** `value="AABB"` es solo `{A, B}`.

Sirve cualquier carácter, de cualquier idioma — no hay límite a ASCII. Vea
[Alfabetos con nombre](#alfabetos-con-nombre-mediante-alphabet) más abajo para un atajo a
escrituras completas, y [Escrituras Unicode a mano](#escrituras-unicode-a-mano) para
teclearlas directamente.

> [!NOTE]
> **Un carácter, no una palabra**
>
> `symbol` elige un solo **carácter** a la vez. Para elegir una **palabra** completa de una
> lista, use [`text`](text.md#top): `<gen type="text" value="red,green,blue"/>`.

## Longitud

`length` fija cuántos caracteres producir. Por omisión es `1` y tiene un tope de `1024`.
Úselo siempre que necesite un token de ancho fijo — un código de 6 dígitos, una llave de
32 caracteres, y así.

```xml
<gen type="symbol" value="[A-Z0-9]"/>            <!-- length omitido → 1 -->
<gen type="symbol" value="[A-Z0-9]" length="6"/>
<gen type="symbol" value="[A-Z0-9]" length="16"/>
```

`./run demo.tdc`

```
length omitted → K
length="6"     → Q7ZW2P
length="16"    → K7QW2ZP4M9RXB3TA
```

Aquí solo se admite una longitud **exacta**. Si necesita un string de ancho variable,
[`number`](number.md#largo-variable) acepta rangos de longitud y grupos; `symbol` no.

## Ampliar el conjunto con `include`

En vez de reescribir un conjunto entero para agregarle unos cuantos caracteres, páselos a
`include`. Usa la misma gramática que `value` (literales y rangos `[x-y]`). Esto resulta
más útil con un **alfabeto con nombre**, que de otro modo es fijo — por ejemplo, letras
más dígitos para un string estilo login.

```xml
<!-- sus propias letras, más dos dígitos específicos -->
<gen type="symbol" value="[a-z]" include="2,4" length="8"/>

<!-- un alfabeto con nombre, ampliado con los dígitos que le faltan -->
<gen type="symbol" alphabet="latin.lower" include="[0-9]" length="8"/>
```

`./run demo.tdc`

```
value="[a-z]" include="2,4" length="8"   → t2qm4boa
alphabet="latin.lower" include="[0-9]"   → k7qw2zp4
```

## Recortar el conjunto con `exclude`

La imagen espejo: `exclude` quita caracteres del conjunto. Práctico para sacar caracteres
que se confunden entre sí de un código (nada de `O`/`0`, nada de `l`/`1`), o para recortar
un par de letras de un alfabeto con nombre.

```xml
<!-- letras y dígitos, menos los pares confusos -->
<gen type="symbol" value="[A-Z0-9]" exclude="O0Il1" length="8"/>

<!-- letras, menos una vocal -->
<gen type="symbol" value="[a-z]" exclude="y" length="8"/>
```

`./run demo.tdc`

```
value="[A-Z0-9]" exclude="O0Il1" length="8" → K7QW2ZP4
value="[a-z]" exclude="y" length="8"        → tqmboade
```

### Cómo se combinan `include` y `exclude`

El conjunto final es `(base ∪ include) − exclude`, así que **`exclude` tiene la última
palabra**: un carácter agregado por `include` y quitado por `exclude` **no** aparecerá.
Si el conjunto queda vacío después de los modificadores, eso es el error `TDC099`.

```xml
<!-- 4 se incluye y luego se excluye → pierde; 2 sobrevive -->
<gen type="symbol" value="[a-z]" include="2,4" exclude="4" length="8"/>
```

`./run demo.tdc`

```
value="[a-z]" include="2,4" exclude="4" → t2qmboad   (no 4 anywhere)
```

## Alfabetos con nombre mediante `alphabet`

**Se usa cuando** se necesita un string aleatorio de un sistema de escritura específico —
cirílico para logins al estilo ruso, kana para datos de prueba en japonés, letras árabes
o hebreas para ejercitar un layout de derecha a izquierda. Teclear el rango Unicode a
mano (`[а-я]`) es propenso a errores: se olvida la `ё`, o se falla el límite. Un alfabeto
con nombre se valida por su nombre y contiene exactamente los caracteres correctos.

`alphabet` reemplaza a `value` — se da un nombre del registro, más un `length`.

```xml
<gen type="symbol" alphabet="cyrillic.ru.letters" length="10"/>
<gen type="symbol" alphabet="kana.hiragana" length="8"/>
<gen type="symbol" alphabet="arabic.letters" length="6"/>
```

`./run demo.tdc`

```
cyrillic.ru.letters length="10" → рнБСпВЖЧжХ
kana.hiragana length="8"        → ゃまぃすめいおち
arabic.letters length="6"       → فؿآحـآ
```

Esta es una demostración deliberada de Unicode y localización: la salida es no latina a
propósito, para mostrar que el mismo generador produce la escritura que se le nombre.

### Ejemplos vivos de cada escritura

El mismo generador, una línea por alfabeto (`length="10"`), para comparar las escrituras
lado a lado:

| `alphabet`            | Salida de ejemplo      |
| :-------------------- | :--------------------- |
| `latin.lower`         | `usahtbcjpi`           |
| `latin.upper`         | `USAHTBCJPI`           |
| `digits.fullwidth`    | `７７０２７０１３６３` |
| `cyrillic.ru.letters` | `рнБСпВЖЧжХ`           |
| `greek.letters`       | `ξμΒΟνΓΖΤζΡ`           |
| `hebrew.letters`      | `פףאחפבגךני`           |
| `arabic.letters`      | `فؿآحـآإذغد`           |
| `kana.hiragana`       | `ゃまぃすめいおちふそ` |
| `kana.katakana`       | `ユメィズヤイオヂヘタ` |
| `cjk.unified.basic`   | `货袪倱料護冣囱沌耣楿` |
| `roman.upper`         | `DDIXDIIXCX`           |

### Todos los nombres soportados

| `alphabet`            | Contiene                                    |
| :-------------------- | :------------------------------------------ |
| `latin.lower`         | ASCII `a-z`                                 |
| `latin.upper`         | ASCII `A-Z`                                 |
| `latin.letters`       | ASCII `A-Z` y `a-z`                         |
| `digits.ascii`        | Dígitos ASCII `0-9`                         |
| `digits.fullwidth`    | Dígitos de ancho completo `０-９`           |
| `cyrillic.ru.lower`   | Ruso `а-я` más `ё`                          |
| `cyrillic.ru.upper`   | Ruso `А-Я` más `Ё`                          |
| `cyrillic.ru.letters` | Cirílico ruso, ambas cajas, incluida la `ё` |
| `greek.letters`       | Letras griegas básicas                      |
| `hebrew.letters`      | Hebreo `א-ת`                                |
| `arabic.letters`      | Letras árabes `ء-ي`                         |
| `kana.hiragana`       | Hiragana japonés `ぁ-ゖ`                    |
| `kana.katakana`       | Katakana japonés `ァ-ヺ`                    |
| `cjk.unified.basic`   | CJK Unified Ideographs `U+4E00..U+9FFF`     |
| `roman.upper`         | Letras de números romanos `I V X L C D M`   |
| `roman.lower`         | Letras de números romanos `i v x l c d m`   |

Los 16 nombres están validados: cada uno se resuelve y produce caracteres de su
escritura. Como el conjunto es fijo, use
[`include`](#ampliar-el-conjunto-con-include) /
[`exclude`](#recortar-el-conjunto-con-exclude) para ajustarlo — por ejemplo
`alphabet="cyrillic.ru.letters" exclude="ъь"`.

## Escrituras Unicode a mano

No _hay_ obligación de usar un alfabeto con nombre — como `value` acepta cualquier
carácter, también se puede teclear una escritura (o mezclar varias) directamente. Aun
así, los alfabetos con nombre siguen siendo preferibles donde existe uno: están
documentados, validados e incluyen caracteres incómodos que un rango simple dejaría
fuera (como la `ё` rusa).

```xml
<gen type="symbol" value="[А-Я]" length="4"/>            <!-- rango cirílico -->
<gen type="symbol" value="कखगघचछ" length="3"/>          <!-- literales devanagari -->
<gen type="symbol" value="あア[0-9][A-F]" length="6"/>   <!-- escrituras mezcladas + rangos -->
```

`./run demo.tdc`

```
value="[А-Я]" length="4"          → ШФПР
value="कखगघचछ" length="3"         → चचग
value="あア[0-9][A-F]" length="6" → アB4あ7ア
```

## Los mismos alfabetos en regex

El registro de alfabetos también está disponible dentro de [`regex`](regex.md#top) y
[`advanced_regex`](advanced-regex.md#top) mediante el escape `\a{name}`, así que se puede
insertar una escritura con nombre dentro de un patrón más grande:

```xml
<gen type="regex" value="\a{kana.hiragana}{5}"/>
<gen type="advanced_regex" value="(?%{70:\a{latin.upper}{2};30:\a{cyrillic.ru.upper}{2}})-[0-9]{4}"/>
```

`./run demo.tdc`

```
kana.hiragana{5}          → まぃすめい
weighted upper + -[0-9]4  → KM-8042
```

Los rangos BMP simples como `[а-я]{8}` también funcionan dentro de `regex`, pero los
alfabetos con nombre son preferibles por las mismas razones de arriba — están
documentados, validados por su nombre y cubren caracteres que un rango pelado dejaría
fuera.

## Vea también

- [`alphabet`](../reference/attributes.md#top) y [`length`](../reference/attributes.md#top)
  en la referencia de atributos.
- **[Regex](regex.md#top)** — cuando el string tiene estructura, no solo un conjunto de
  caracteres.
- **[Máscaras y mayúsculas](../guides/masks-and-case.md#top)** — cómo remodelar un string
  ya generado.

---

← Anterior: [Date](./date.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Regex](./regex.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/generators/symbol)**
