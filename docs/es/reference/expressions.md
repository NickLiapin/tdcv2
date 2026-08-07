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

## Números enteros

Un double guarda todos los enteros hasta 2⁵³ y a partir de ahí empieza a saltárselos, así que una
expresión construida solo sobre doubles responde así:

`lo que un double dice de dos números distintos`

```
9007199254740993 == 9007199254740992   true
9007199254740993 -  9007199254740992   0
```

Las dos cosas son falsas, y falsas en silencio — que para un generador de datos es la peor forma
de estar equivocado: la ejecución termina y el archivo parece correcto. Por eso un operando que
ES un número entero se lleva como tal:

| | |
| :--- | :--- |
| un literal sin punto ni exponente | sigue siendo entero |
| una columna cuyo valor se lee como dígitos | compara como entero contra otro entero |
| `+ - * %` sobre dos enteros | siguen siendo enteros |
| `abs` `round` `floor` `ceil` `trunc` sobre un entero | siguen siendo enteros: redondear un entero es ese mismo entero, del tamaño que sea |
| `min` `max` `sum` mientras todos los argumentos sean enteros | siguen siendo enteros |
| `/` | **siempre** en coma flotante — la división no es cerrada sobre los enteros |
| lo que se pasa a `sqrt`, `log`, `sin`… | pasa a double: esas no tienen respuesta exacta que dar |

El dominio son 64 bits con signo, el mismo que la [capa compute](compute.md#top). Más allá la
respuesta es un rechazo, con las mismas palabras que usa compute:

`tdcv2 ledger.tdc`

```
tdcv2: integer overflow: 10000000000000000000 is outside the signed 64-bit range
```

Un borde que conviene saber: −2⁶³ se alcanza con aritmética pero no se escribe como literal.

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
> Un DIVISOR negativo es donde Python también se separa: `7 % -3` es **1** aquí y −2 allí.
> El resultado nunca lleva signo — siempre está en `0 … |divisor| - 1`.
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
| `split(s, sep)`            | 2          | texto cortado en lista — ver [Listas dentro de una fila](#listas-dentro-de-una-fila) |
| `join(list, sep)`          | 2          | una lista de vuelta a texto                        |
| `count(list)`              | 1          | cuántos elementos                                  |
| `at(list, i)`              | 2          | el elemento i, contando **desde cero**             |
| `sum(list)`                | 1          | el total — sigue entero mientras todos lo sean     |
| `mean(list)` `median(list)`| 1          | media y valor central                              |
| `stddev(list)`             | 1          | desviación típica **poblacional**, dividida por n  |
| `sqrt(x)`                  | 1          | raíz cuadrada                                      |
| `pow(x, y)`                | 2          | x elevado a y                                      |
| `exp(x)`                   | 1          | e elevado a x                                      |
| `log(x)` `log10(x)`        | 1          | logaritmo natural / decimal                        |
| `sin(x)` `cos(x)` `tan(x)` | 1          | funciones circulares, en **radianes**              |
| `asin(x)` `acos(x)` `atan(x)` | 1       | sus inversas, en radianes                          |
| `atan2(y, x)`              | 2          | el ángulo del punto (x, y), sobre (−π, π]          |
| `sinh(x)` `cosh(x)` `tanh(x)` | 1       | funciones hiperbólicas                             |
| `cbrt(x)`                  | 1          | raíz cúbica — también de negativos, a diferencia de `pow` |
| `expm1(x)` `log1p(x)`      | 1          | eˣ−1 y log(1+x), exactas cerca de cero             |
| `log2(x)`                  | 1          | logaritmo binario — exacto en una potencia de dos  |
| `asinh(x)` `acosh(x)` `atanh(x)` | 1     | funciones hiperbólicas inversas                    |
| `hypot(x, y)`              | 2          | longitud del vector, sin desbordar por el camino   |
| `sign(x)`                  | 1          | −1, 0 o 1                                          |
| `erf(x)` `erfc(x)`         | 1          | la función de error y su complemento               |
| `gamma(x)` `lgamma(x)`     | 1          | Γ(x), y log \|Γ(x)\| para cuando Γ desborda        |
| `beta(a, b)`               | 2          | Γ(a)Γ(b)/Γ(a+b)                                    |
| `digamma(x)`               | 1          | ψ(x), la derivada de log Γ                         |
| `zeta(s)`                  | 1          | la función zeta de Riemann, para s real            |
| `degrees(x)` `radians(x)`  | 1          | entre las dos formas de escribir un ángulo         |

Todo lo que está por encima de la raya es exacto: construido con comparaciones y con la
aritmética que IEEE-754 fija sin ambigüedad, así que las cinco implementaciones no pueden
discrepar. Todo lo que está por debajo, TDC lo calcula por sí mismo.

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

## Listas dentro de una fila

Una secuencia con `repeat=` pone varios valores en un mismo campo, unidos por su
`separator=`. Una expresión ve el **texto unido**, porque eso es lo que el campo contiene:
`split` es el puente que convierte una lista en una lista.

```xml
<sequence name="Prices">
  <gen type="number" value="10..200" repeat="3" separator=","/>
</sequence>
<sequence name="Basket">
  <gen if="sum(split(Prices, ',')) > 300" type="text" value="large"/>
  <gen type="text" value="ordinary"/>
</sequence>
```

`min` y `max` leen una lista igual de bien que argumentos sueltos: funcionan tanto
`max(split(Prices, ','))` como `max(1, 9, 4)`. Un separador vacío corta en caracteres
sueltos, la misma unidad que cuenta `len`, así que `count(split(s, ''))` y `len(s)` nunca
discrepan.

> [!NOTE]
> **`at` cuenta desde cero y rechaza un índice que no lo es**
>
> `at(list, 0)` es el primer elemento. **Pasado el final el resultado es texto vacío**, y a
> propósito: `repeat="1..4"` hace filas de longitudes distintas, y preguntar por el tercer
> elemento de una fila de dos es una pregunta real con una respuesta vacía. Para preguntar
> antes está `count(list)`.
>
> Todo lo demás se rechaza en vez de responder con esa misma cadena vacía: un índice
> negativo, uno fraccionario, uno que no es un número, y un sujeto que nunca se cortó. Ese
> último es el error que todo el mundo comete primero —
>
> ```xml
> <gen if="at(Prices, 1) > 100" …/>   <!-- rechazado: TDC260 -->
> <gen if="at(split(Prices, ','), 1) > 100" …/>   <!-- lo que se quería decir -->
> ```
>
> `Prices` es el texto unido, así que la primera línea pedía el segundo elemento de una lista
> de uno y dejaba la columna en blanco mientras la ejecución informaba de éxito. Los errores
> escritos tal cual los detecta `tdcv2 check` antes de que exista una fila; un índice que se
> calcula sobre la marcha — `at(list, _count - 1)` — se comprueba al construir la fila.

## Por qué TDC calcula sus propias funciones trascendentes

IEEE-754 fija para `+ - * /` y `sqrt` exactamente una respuesta legal, así que sobre ellas
todos los lenguajes coinciden. No dice nada sobre `sin`, `cos`, `exp`, `log` ni `pow` — cada
libm elige su propio algoritmo — y la diferencia es medible, no teórica:

| | `tan(1)` |
| :--- | :--- |
| Node | `3ff8eb245cbee3a6` |
| Python | `3ff8eb245cbee3a5` |

De setenta y siete valores muestreados, dieciséis discrepan en al menos dos de las cinco
implementaciones. En un `timeseries` eso no se ve: cada número se redondea a una cadena
decimal antes de convertirse en salida, y el último bit muere de camino. Una comparación no
tiene paso de redondeo, así que ese bit se vuelve otra fila y otro archivo — en una
herramienta cuya promesa entera es que cinco implementaciones producen los mismos bytes.

Por eso TDC las calcula por sí mismo, igual que ya calcula sus propios números aleatorios en
vez de confiar en los de cada lenguaje. Cada una cae dentro de **4 ulp** del valor verdadero —
el mismo vecindario que ocupa una libm — y, mucho más importante, sobre el **mismo** double en
las cinco. Coincidir con una libm concreta no es el objetivo ni podría serlo: las libms no
coinciden entre sí.

Ese 4 se comprueba, no se afirma, sobre mallas que llegan a los extremos del rango de cada
función. Los extremos son lo que importa: una serie truncada dos términos antes de tiempo es
invisible en mitad de un intervalo y se desvía trece ulp en el borde — que es exactamente el
fallo tras el cual se escribió la comprobación.

`pow` es la única con una cota más ancha, por una razón que conviene conocer:

| exponente | cómo se calcula | desviación |
| :--- | :--- | :--- |
| entero, o un medio | elevación al cuadrado, `sqrt` para el medio | crece con el exponente: ~4 ulp en 3, ~22 en 20 |
| cualquier otro | `exp(y · log x)` | crece con \|y · log x\|: ~2 ulp en 1, ~457 en 400 |

Ambas son amplificación, no un defecto: elevar al cuadrado duplica el error recibido, y `exp`
convierte un error absoluto en su argumento en uno relativo en su respuesta. Doce cifras
significativas sobreviven en los dos casos.

```xml
<sequence name="Month"><gen type="increment" value="1"/></sequence>
<sequence name="Load">
  <gen if="cos(Month / 2) > 0.5"  type="text" value="peak"/>
  <gen if="cos(Month / 2) < -0.5" type="text" value="trough"/>
  <gen                            type="text" value="normal"/>
</sequence>
<sequence name="Tier">
  <gen if="pow(2, Month) > 100" type="text" value="large"/>
  <gen                          type="text" value="small"/>
</sequence>
```

`tdcv2 seasonal.tdc`

```
1 peak small
2 peak small
3 normal small
4 normal small
5 trough small
6 trough small
7 trough large
8 trough large
```

Ese archivo se pasó por las cinco implementaciones y todas produjeron esos mismos bytes.

De calcularlas en vez de tomarlas prestadas se siguen dos cosas. `pow` con un exponente
entero pasa por elevación al cuadrado, así que `pow(10, 3)` es exactamente 1000 y no
999.9999999999998 — una configuración que compare contra un número redondo lo habría notado.
Y las funciones circulares toman **radianes**, sin variante en grados: un convenio, dicho una
sola vez.

### El par que existe porque la resta pierde cosas

`expm1` y `log1p` no son atajos para `exp(x) - 1` ni `log(1 + x)`. Son esas expresiones
calculadas de modo que la respuesta sobreviva:

`cerca de cero, las definiciones no devuelven nada`

```
expm1(1e-20)   1e-20        exp(1e-20) - 1     0
log1p(1e-20)   1e-20        log(1 + 1e-20)     0
```

La segunda columna no es un error de redondeo: es la respuesta entera, desaparecida. `1 + 1e-20`
ES 1 como double, así que el logaritmo nunca llega a ver el argumento; y `exp(1e-20)` es 1,0000…,
de modo que la resta cancela todas las cifras que importaban. `asinh` y `atanh` están construidas
sobre `log1p` por la misma razón.

`hypot` evita el problema simétrico en el otro extremo: `sqrt(x² + y²)` desborda a infinito para
x = 10²⁰⁰, aunque la respuesta es perfectamente representable. Y `log2` separa el exponente antes
de tomar ningún logaritmo, así que `log2(8)` es 3 y no 2,9999999999999996.

### Donde la cota deja de medirse en ulp

Estas cuatro llevan una cota que no se resume en «dentro de 4 ulp», y decirlo es
parte de la referencia, no una nota al pie:

| Función | Lo que se garantiza |
| :--- | :--- |
| `erf` | dentro de 4 ulp |
| `erfc` | dentro de 8 ulp — pasa por e^(−x²), y esa exponencial arrastra el redondeo del cuadrado |
| `gamma` | **exacta** en los enteros hasta 23, dentro de 7 ulp en los 171 que caben en un double; doce cifras significativas en el resto |
| `lgamma` | dentro de 32 ulp lejos de sus ceros; en x = 1 y x = 2 la cota con sentido es absoluta, bajo 10⁻¹³ |

`lgamma` es el caso interesante. Vale cero en 1 y en 2, y ningún método que sume
términos de tamaño 1 puede ser *relativamente* exacto sobre que se cancelen a
nada — allí la afirmación tiene que ser absoluta, y lo es. Ambos ceros salen
exactamente cero.

`gamma` fuera de los enteros termina en una exponencial, así que su desvío crece
con log Γ(x): la misma amplificación que tiene `pow`. Por eso un entero toma el
camino del factorial.

## Lo que falta a propósito

**La matemática que un generador de datos no tiene por qué cargar.** `besselj`, `bessely`,
`airy`, `elliptic_k`, `elliptic_e` y `polygamma` se rechazan por nombre:

`tdcv2 check seasonal.tdc`

```
error[TDC257]: besselj() is not available yet in an if expression
```

Fíjese en lo que NO dice: «¿quiso decir `beta`?». La distancia de edición habría ofrecido justo
eso, y las dos nombran funciones completamente distintas. Un nombre de esta lista recibe la razón,
no una conjetura.

Cada una de ellas es un proyecto y no una función, y ninguna ha pertenecido nunca de verdad a
un predicado de fila. Se quedan en la lista para que quien alcance una reciba una respuesta y
no «función desconocida».

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
