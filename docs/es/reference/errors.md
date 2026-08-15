<a name="top"></a>

[English](../../reference/errors.md#top) · [Русский](../../ru/reference/errors.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/reference/errors)**

← Anterior: [Catálogo de identificadores](./identifiers.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Expresiones](./expressions.md#top) →

---

# Códigos de error

Todos los diagnósticos que TDC puede emitir, por código. Consúltelo cuando una
ejecución se detiene y el mensaje por sí solo no alcanza.

## Cómo leer un diagnóstico

Un diagnóstico lleva cuatro cosas, y el código es la parte que no cambia entre
versiones: la redacción puede mejorar, `TDC193` sigue siendo `TDC193`.

`./run demo.tdc`

```
error[TDC193]: "Naem" is not a declared sequence — it would be printed literally
 --> demo.tdc:8:11
  |
8 |     <line><data>${{Naem}}</data></line>
  |           ^^^^^^^^^^^^^^^^^^^^^^
  |
help: did you mean "Name"?
note: Declare it in <env>, or set a different inject= pattern if you really want the text ${{…}} in the output.
```

- el **código** — qué salió mal; estable entre versiones;
- el **lugar** — archivo, línea y columna, con el elemento culpable subrayado;
- **`help:`** — una conjetura de lo que quiso decir, cuando el nombre casi acierta;
- **`note:`** — qué hacer al respecto.

La validación corre antes de la generación, así que un config con errores no produce
dato alguno en vez de medio archivo. Casi cada diagnóstico aquí es un **error** y detiene
el run: si el config pidió algo que no va a obtener, TDC se niega en vez de devolver
datos que parecen correctos pero no lo son. Las excepciones son once **advertencias** que
dejan terminar el run: `TDC136` (una fila de `<map>` malformada, omitida mientras las
válidas siguen aplicando), `TDC171` (un archivo de data pack cuya cabecera lo deja sin
dirección), `TDC200` (una estimación de memoria grande pero que cabe), `TDC216` (una
expresión que siempre es verdadera o siempre falsa), `TDC221` (un grupo `<uniq>` o
`<distinct>` con un solo miembro, que no restringe nada), `TDC231` (un pool que nadie
lee), `TDC234` (un pool de más de
100.000 miembros), `TDC299` (una columna `uniq` más allá de 100.000 filas, que no puede
fluir — en su segundo sentido, un pool declarado fuera de orden, es un error), `TDC251`
(una proporción de `percent` que pide menos de una fila), `TDC272` (una locale que da
nombres muy bien y no trae nombres de meses, así que las fechas salen en inglés) y
`TDC284` (un `secret=` escrito como literal dentro del config — una clave viaja a donde
viaje él). Cada una lo indica en su fila
más abajo.

Los números se reparten más o menos en el orden en que se revisa un config — primero la
estructura, luego los generadores, luego todo lo construido encima — pero el número es un
identificador, no una clasificación. Guíese por los grupos de abajo.

## Estructura del documento

| Código   | Cuándo salta                                                 | Qué hacer                                                                                                                             |
| :------- | :----------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------ |
| `TDC001` | El archivo no tiene raíz `<tdc>`, **o** no se pudo analizar en absoluto — un error de sintaxis, incluida una etiqueta de cierre con otro nombre (`<sequence>…</gen>`) o elementos anidados a más de **64 niveles**, algo a lo que ninguna configuración real llega y una generada sí | Envuelva todo en un único `<tdc>…</tdc>`, o corrija la sintaxis que señala el mensaje. Nada más se comprueba hasta que el archivo se analice |
| `TDC002` | `<tdc>` no tiene hijo `<block>`                              | Agregue el `<block>` con la disposición de un registro                                                                                |
| `TDC003` | En `<tdc>` están `version` y `v` a la vez                    | Deje uno — son alias                                                                                                                  |
| `TDC004` | La versión declarada no parece una versión                   | Use una versión que el runtime admita, p. ej. `v="0.1"` (un valor más nuevo que el runtime lanza `TDC005`)                            |
| `TDC005` | El archivo pide una versión más nueva que este runtime       | Actualice TDC, o baje la versión declarada                                                                                            |
| `TDC010` | Bajo `<tdc>` hay una etiqueta que no es `<env>` ni `<block>` | Muévala dentro de una de las dos                                                                                                      |
| `TDC013` | Una etiqueta está anidada donde no se permite                | Ver [Etiquetas](tags.md#top): qué puede contener qué                                                                                     |
| `TDC014` | Una etiqueta que necesita hijos se escribió autocerrada      | Escriba `<env …></env>`, no `<env …/>` — sus hijos se perderían en silencio                                                           |
| `TDC015` | Una etiqueta lleva un atributo que el motor no lee           | La corrida se detiene: el config pidió algo que no iba a obtener. Revise la escritura — el mensaje sugiere el nombre real más cercano |
| `TDC020` | `count` no es un entero no negativo                          | `count="1000"`                                                                                                                        |
| `TDC021` | Un patrón `inject` sin hueco, o con más de uno               | Un `%` es el hueco sólo donde tiene texto a AMBOS lados, y un marcador tiene exactamente uno: `inject="[[%]]"`. Ninguno (`"%%"`, `"%x"`, sin `%`) y no se sustituye nada; varios (`"[%]-[%]"`) y sólo se lee el de la derecha, quedando los otros como un `%` literal que su texto no contiene. `inject="%{%}%"` es válido: sólo cumple su `%` central |

## Secuencias

| Código   | Cuándo salta                                                                                                                                                          | Qué hacer                                                                            |
| :------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------- |
| `TDC030` | Una etiqueta que necesita nombre no lo tiene                                                                                                                          | Agregue `name="…"`                                                                   |
| `TDC031` | Un nombre de secuencia empieza con `_`                                                                                                                                | Ese prefijo está reservado a los [integrados](builtins.md#top)                          |
| `TDC032` | Dos secuencias comparten nombre                                                                                                                                       | Renombre una — la referencia sería ambigua                                           |
| `TDC033` | Un nombre choca con un integrado                                                                                                                                      | Elija otro; el integrado siempre gana                                                |
| `TDC034` | Un valor de `parent` no es `Padre.Valor`                                                                                                                              | Use las dos partes, p. ej. `parent="Gender.Male"`                                    |
| `TDC035` | La secuencia padre se declara **después** de esta                                                                                                                     | Suba el padre — la resolución va de arriba abajo                                     |
| `TDC214` | `parent=` nombra una secuencia compuesta                                                                                                                              | El padre se filtra por el valor que produjo, y un grupo de campos no produce ninguno |
| `TDC036` | Un `<sequence>` no tiene `<gen>` dentro                                                                                                                               | Sin generador una secuencia no produce nada                                          |
| `TDC110` | _retirado_ — un `<gen>` sin nombre junto a uno con nombre ahora [compone el valor](../core-concepts/sequences.md#una-secuencia-compuesta-por-valor) en vez de fallar | —                                                                                    |
| `TDC111` | Dos campos de una misma compuesta comparten nombre                                                                                                                    | Renombre uno                                                                         |
| `TDC129` | Un `<sequence>` dentro de una etiqueta de nivel config no da nada útil allí                                                                                           | Ver [Secuencias](../core-concepts/sequences.md#top)                                     |

## Generadores

| Código   | Cuándo salta                                                                                     | Qué hacer                                                                                                                                                                           |
| :------- | :----------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TDC040` | `<gen>` no tiene `type`                                                                          | Agregue `type="…"` — ver [Generadores](generators.md#top)                                                                                                                              |
| `TDC041` | El tipo es desconocido, o no se admite en un `<gen>` en línea                                    | Revise la escritura; TDC sugiere el nombre más cercano                                                                                                                              |
| `TDC050` | `type="text"` sin `value`                                                                        | Dé la lista, p. ej. `value="a,b,c"`                                                                                                                                                 |
| `TDC051` | Un `percent` tiene más entradas que la lista `value`                                             | Un porcentaje por valor                                                                                                                                                             |
| `TDC052` | Una entrada de `percent` no es un número no negativo                                             | Las posiciones llenas son números; una vacía reparte el resto                                                                                                                       |
| `TDC053` | Los valores de `percent` no suman 100                                                            | Ajústelos a 100, o deje una posición vacía para el resto                                                                                                                            |
| `TDC060` | `type="file"` sin `src`                                                                          | Apunte `src` al archivo                                                                                                                                                             |
| `TDC061` | El archivo no se puede leer                                                                      | Revise la ruta — se cuenta desde el config, o use `--data-path`                                                                                                                     |
| `TDC062` | `column` no se resuelve                                                                          | Un nombre de cabecera (`column="email"`) o un índice desde 1 (`column="2"`)                                                                                                         |
| `TDC064` | `row` sin `column`                                                                               | El enlace por fila necesita saber de qué columna del CSV tomar                                                                                                                      |
| `TDC065` | `type="http"` sin `src`                                                                          | Apúntelo al servicio — `src="http://127.0.0.1:5566/gen"`                                                                                                                            |
| `TDC066` | `src` no es una URL http(s)                                                                      | Use `http://…` o `https://…`, con host y ruta                                                                                                                                       |
| `TDC067` | `in=` no nombra nada declarado antes                                                             | El valor enviado por fila viene de una `<sequence>` anterior                                                                                                                        |
| `TDC068` | `on_error` no es `fail` ni `empty`                                                               | `fail` (por omisión) detiene la corrida; `empty` deja la celda vacía                                                                                                                |
| `TDC069` | `timeout` no es un número positivo de segundos                                                   | `timeout="30"` espera treinta segundos por una respuesta; omítalo para el valor por omisión de 30                                                                                    |
| `TDC070` | `type="template"` sin `value`                                                                    | Dé la dirección con puntos, p. ej. `value="person.lastName"`                                                                                                                        |
| `TDC071` | La dirección de plantilla es desconocida                                                         | Revise la escritura, o instale el pack que la provee                                                                                                                                |
| `TDC072` | `value="date.range"` sin `range`, **o** un parámetro de `type="template"` que el pack no declara | Agregue `range="…"`; o revise el nombre del parámetro — el mensaje lista los válidos                                                                                                |
| `TDC073` | Un `range` heredado no son dos fechas válidas                                                    | Use `YYYY.MM.DD - YYYY.MM.DD`                                                                                                                                                       |
| `TDC081` | Un rango numérico está mal escrito                                                               | `value="10..99"`                                                                                                                                                                    |
| `TDC082` | `first_zero` no es `true` ni `false`                                                             | No hay otros valores                                                                                                                                                                |
| `TDC083` | `length` no es un número, un rango ni una lista con comas                                        | p. ej. `length="8"`, `length="6..9"`, `length="4,6,8"`                                                                                                                              |
| `TDC084` | Un `percent` sobre un `value` numérico tiene más entradas de las que el rango admite             | Un porcentaje por valor                                                                                                                                                             |
| `TDC085` | Una entrada de `percent` sobre un número no es un número no negativo                             | Las posiciones llenas son números                                                                                                                                                   |
| `TDC086` | `percent` sobre un número no suma 100                                                            | Ajuste los valores a 100                                                                                                                                                            |
| `TDC087` | `include`/`exclude` sin rango numérico en `value`                                                | Filtran un rango, así que el rango debe existir                                                                                                                                     |
| `TDC088` | `distribution` se combina con un atributo incompatible                                           | Una distribución con nombre define ella misma el sorteo                                                                                                                             |
| `TDC089` | Los parámetros de la distribución están mal                                                      | Ver [Distribuciones](../guides/statistical-distributions.md#top)                                                                                                                       |
| `TDC090` | Un atributo que debe ser número no lo es                                                         | Revise el valor                                                                                                                                                                     |
| `TDC095` | `type="regex"` sin `value`                                                                       | El patrón va en `value`                                                                                                                                                             |
| `TDC096` | `regex_max_length` no es un entero positivo                                                      | p. ej. `regex_max_length="64"`                                                                                                                                                      |
| `TDC097` | La expresión regular no parsea                                                                   | Corrija el patrón — sigue el mensaje del propio parser                                                                                                                              |
| `TDC098` | A `type="symbol"` se le dan `value` y `alphabet`, o **ninguno**                                  | Dé exactamente uno — un conjunto en `value` o un `alphabet` con nombre                                                                                                              |
| `TDC099` | El alfabeto con nombre es desconocido                                                            | Ver [Symbol](../generators/symbol.md#top)                                                                                                                                              |
| `TDC128` | `type="advanced_regex"` sin `value`                                                              | El patrón va en `value`                                                                                                                                                             |
| `TDC128` | _(segundo significado)_ `default=` o `if=` escritos en un `<case>`                               | Un `<mix>` elige su caso por porcentaje y un `<switch>` por la clave `is`: ninguno pregunta una condición. Para valores por condición use una `<sequence>` con ramas `<gen if="…">` |
| `TDC130` | El patrón avanzado no parsea                                                                     | Ver [Advanced regex](../generators/advanced-regex.md#top)                                                                                                                              |

## Expresiones en `if`

| Código   | Cuándo salta                                                                                              | Qué hacer                                                                                                                                                                                       |
| :------- | :-------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TDC100` | La expresión no parsea                                                                                    | Ver [Salida y formato](../core-concepts/output-formatting.md#top)                                                                                                                                  |
| `TDC101` | Un operador binario no está admitido                                                                      | Admitidos: `== != === !== < > <= >= && \|\| + - * /`                                                                                                                                            |
| `TDC102` | Un operador unario no está admitido                                                                       | Admitidos: `!`, `-`, `+`                                                                                                                                                                        |
| `TDC103` | Se usa acceso calculado a un miembro                                                                      | Solo se permiten nombres simples                                                                                                                                                                |
| `TDC215` | Un nombre en un `if=` que ninguna secuencia tiene                                                         | Se lee como su propio texto: solo, la rama siempre se activa; comparado, nunca                                                                                                                  |
| `TDC216` | _(advertencia)_ una rama que nunca puede dispararse: `if="Seq.Value"` o `if="Seq == Value"` con un valor que la secuencia nunca produce; `<case is="…">` o una clave de `<map>` fuera de la lista del sujeto; `parent="Seq.Value"` sobre un valor que no ocurre | La rama está muerta. Advertencia y no error: acotar la lista a propósito es algo que se hace                                                                                                    |
| `TDC217` | Una ruta de plantilla existe, pero no para la configuración regional de la corrida                        | El mensaje nombra la configuración regional; ponga `local=` en el `<gen>` o el `<env>`, o elija una ruta que su configuración regional traiga                                                   |
| `TDC218` | `uniq="true"` en una secuencia sin valores propios — `<compute>` lee otras, `if=` elige una rama por fila, y `running`/`stat`/`formula`/un desplazamiento de fecha se calculan en vez de sortearse | Ponga `uniq=` en las secuencias que lee, o envuélvalas en `<uniq>`                                                                                                                              |
| `TDC219` | Un `<compute>` y un `<gen>` en la misma `<sequence>` — uno de los dos se descartaría                      | Mueva el `<compute>` a su propia `<sequence>` y lea la sorteada con `<field>`                                                                                                                   |
| `TDC220` | `uniq="true"` sobre un valor compuesto que junta dos o más partes sorteadas                               | Las partes no tienen ancho fijo, así que un conjunto único de partes no da un string único: `9`+`15` y `91`+`5` son los mismos tres caracteres. Deje una sola parte sorteada, o fije los anchos |
| `TDC221` | _(advertencia)_ Un `<uniq>` o `<distinct>` alrededor de menos de dos `<sequence>`                         | Un grupo restringe a sus miembros entre sí, así que un solo miembro no restringe nada. Agregue un segundo, o escriba `uniq="true"` en la secuencia misma                                        |

## `<pool>`

Ver [Registros coherentes](../pools/overview.md#top).

| Código   | Cuándo salta                                                                | Cómo arreglarlo                                                                                                                                                                                                                                             |
| :------- | :-------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TDC222` | Un `<pool>` sin `name`, o sin `count`                                       | Un pool se lee por nombre y tiene un número fijo de miembros: `<pool name="Doctors" count="30">`                                                                                                                                                            |
| `TDC223` | Un `<pool count="…">` que no es un entero de al menos 1                     | Un pool vacío no tiene ningún miembro que entregar                                                                                                                                                                                                          |
| `TDC224` | `<gen type="pool" value="X">` sin ningún `<pool name="X">` declarado        | El mensaje enumera los pools declarados. Declárelo en el mismo `<env>`                                                                                                                                                                                      |
| `TDC225` | `filter="field == X"` donde los dos lados nunca pueden coincidir            | Ambas listas están escritas en la configuración y no se cruzan, así que cada fila se reduce a ningún miembro. El mensaje nombra las dos. Aquí solo se informa la contradicción segura; un valor que simplemente sale poco se rechaza en la fila que lo saca |
| `TDC226` | `filter=` lee `Pool.field` y el pool no tiene ese campo                     | El mensaje enumera los campos del pool. Un nombre desconocido **sin cualificar** se deja pasar: el lenguaje de expresiones lee una palabra suelta como literal                                                                                              |
| `TDC229` | `${{Ref}}` donde `Ref` sortea un miembro entero                             | Un miembro es un registro, no un valor. Lea un campo: `${{Ref.lastName}}`                                                                                                                                                                                   |
| `TDC230` | Un `<block>`, una etiqueta de formato u otro `<pool>` dentro de un `<pool>` | Un pool es una tabla que otras columnas leen, no algo que se escriba en un archivo, y los pools no se anidan                                                                                                                                                |
| `TDC231` | _(advertencia)_ Un `<pool>` que ningún `<gen type="pool">` lee              | Se construye entero antes de la primera fila y se mantiene en memoria todo el run, así que uno sin leer se paga y se tira. Léalo o quítelo                                                                                                                  |
| `TDC232` | Un nombre en `filter=` que es a la vez campo del pool y secuencia           | Renombre uno de los dos. Cualificar un lado no ayuda: el otro nombre sigue leyéndose como el campo del miembro, así que la comparación sería consigo misma                                                                                                  |
| `TDC234` | _(advertencia)_ Más de 100.000 miembros                                     | Un pool se mantiene en memoria toda la ejecución — unos 320 bytes por miembro con cuatro campos. Si quería decir el número de FILAS, eso es `count` en `<env>`                                                                                              |
| `TDC235` | Más de 1.000.000 de miembros                                                | La misma causa, pasado el punto en que vale la pena ejecutarlo. Reduzca el pool, o mueva el número a `<env count="…">`                                                                                                                                      |
| `TDC236` | Un pool lee un pool declarado más abajo, o a sí mismo                       | Los pools se construyen en orden de declaración, así que un pool solo puede leer los que están por encima. Suba el que lee. Ese mismo orden es la razón por la que un ciclo entre pools no se puede escribir                                                |
| `TDC241` | Dos pools declarados con el mismo nombre                                    | A un pool se llega por su nombre, así que dos no pueden compartirlo. El segundo reemplazaba al primero en silencio, y la única señal era un `TDC193` en el bloque sobre un campo que «no existe»                                                            |
| `TDC242` | `anomaly` o `missing` no es un número en `[0, 1]`                           | Ambos son una PROPORCIÓN de los valores: `anomaly="0.05"`, `missing="0.1"`                                                                                                                                                                                  |
| `TDC243` | `anomaly` sobre una lista `value` sin ningún número                         | Una anomalía multiplica un número, así que una lista de palabras vuelve sin cambios                                                                                                                                                                         |
| `TDC246` | `anomaly_flag` en un `<gen>` dentro de un `<case>`                          | El cuerpo de un caso son varias partes unidas, así que una marca en una parte no describe la fila: ponga `flag="NOMBRE"` en el `<mix>`                                                                                                                     |
| `TDC247` | `step` en un `<gen type="date">` no es un paso que pueda recorrer, o mezcla una unidad de calendario con una fija | Escriba `15m`, `1h30m`, `2d`, `3mo`, `1y` — unidades `s`, `m`, `h`, `d`, `w`, `mo`, `y`; un número solo significa días                                                                                                                                                     |
| `TDC248` | `step` sin `order="sequential"` en el mismo `<gen>`                        | Nadie recorre el rango: las fechas se siguen sorteando al azar. Añada `order="sequential"` o quite `step`                                                                                                   |
| `TDC249` | `weekdays` nombra un día de la semana que no existe                        | sun, mon, tue, wed, thu, fri, sat — un rango `mon..fri` o una lista `sun,wed`                                                                                                                                 |
| `TDC250` | `weekdays` con un paso de un número entero de semanas, o un paso de calendario | Dos razones bajo un mismo código. Un número entero de semanas fija el día de la semana, así que el filtro coincidiría con todas las filas o con ninguna. Un paso de calendario hace lo contrario — `1mo` recorre jueves, domingo, domingo, miércoles — así que qué filas sobreviven lo decidiría el calendario y no la configuración |
| `TDC252` | `peak_at` en un `<gen type="timeseries">` no es un número                     | `peak_at` es la fila en la que la onda estacional alcanza su máximo, contada como `period`: `peak_at="182"` con `period="365"` pone el pico el primero de julio |
| `TDC253` | `peak_at` sin `period` en el mismo `<gen>`                                    | Una onda necesita un largo antes de poder tener un punto más alto. Añada `period`, o quite `peak_at` |
| `TDC251` | _(advertencia)_ Una proporción de `percent` pide menos de una fila entera     | `percent` es una cuota exacta sobre las filas que llegan a ella, así que el 10 % de un subconjunto de cinco filas pide medio registro. Medio registro no se puede emitir: la rama dispara una vez o ninguna, y lo decide el seed. Suba la proporción, o suba `count` |
| `TDC254` | `repeat=` y `order="sequential"` en el mismo `<gen>`                          | Deje uno. Una columna que recorre toma un valor por fila de su fuente; una repetida toma varios valores sorteados. Juntos los motores discrepaban, así que la combinación se rechaza en vez de responderse de tres formas |
| `TDC255` | `decimals=` junto con `include=` o `exclude=`                                 | Deje uno. Un conjunto formado por `include`/`exclude` contiene números enteros y la elección es uniforme entre ellos, así que no hay nada fraccionario que redondear — el motor emitía enteros en silencio |
| `TDC256` | Una máscara sin patrón — `<mask>` sin `pattern=`, o `${{X\|mask}}` sin argumento | Déle un patrón. Sin él la máscara no conserva nada y devuelve la cadena vacía, así que la columna sale en blanco |
| `TDC257` | Una expresión `if=` llama a una función que no existe | O es una errata, y entonces se ofrece el nombre cercano, o es una de `sin`, `cos`, `exp`, `log` y afines, y entonces se da la razón: cada lenguaje anfitrión las calcula un poco distinto, y una comparación convierte el último bit en otra fila. Hoy están: `abs`, `ceil`, `floor`, `max`, `min`, `round`, `trunc` |
| `TDC258` | Una función de una expresión `if=` recibe un número de argumentos equivocado | `abs`, `ceil`, `floor`, `round` y `trunc` toman exactamente uno; `min` y `max` toman los que les dé |
| `TDC259` | Una `[lista]` está en un sitio que no es la derecha de `in` | Una lista es un conjunto de valores contra el que comparar, así que solo significa algo como `Country in [US, CA, MX]`. Por sí sola no le da ningún valor a la condición |
| `TDC260` | `at()` recibe algo que no es una lista | Una lista de `repeat` llega a la expresión como su texto unido, así que `at(Items, 1)` pide el segundo elemento de una lista de uno y responde con nada. Córtela primero: `at(split(Items, ","), 1)` |
| `TDC261` | `at()` recibe un índice que no lo es | Un índice es un número entero, cero o más. Pasado el final el resultado es texto vacío a propósito — las filas de `repeat="1..4"` tienen longitudes distintas — pero `-1`, `1.5` y `"one"` son errores, y cada uno producía esa misma columna en blanco |
| `TDC262` | `<gen type="stat">` no dice qué resumir (`of=`) ni qué estadística (`op=`), o nombra una que no existe | Una estadística lee otra columna y no genera nada propio, así que ambas son obligatorias. `op=` es una de `sum`, `mean`, `median`, `min`, `max`, `count`, `stddev`; `decimals=` va de 0 a 10 |
| `TDC263` | `${{Name}}` en un atributo que no lo expande | La interpolación llega al texto dentro de `<data>` y a `<gen type="template" value=>`, y a ningún otro sitio — en cualquier otro las llaves son caracteres literales. Para que una columna dependa de otra, léala en una condición `if=` o construya el valor en una secuencia `<compute>` |
| `TDC264` | `<gen type="date" of="…">` está mal escrito | Un desplazamiento necesita `plus=` (`7d`, `3..10d`, `1..3mo`, `-10..-3d`), con el límite menor primero y en una unidad que `step=` también usa. Los atributos que acotan el sorteo PROPIO del generador — `value`, `from`, `to`, `range`, `oldest`, `youngest`, `order`, `step` — no dicen nada una vez que `of=` ha situado la fecha respecto a otra columna, así que se rechazan en lugar de ignorarse. El caso simétrico también se rechaza: un `plus=` en una fecha sin `of=` no tiene de qué distanciarse |
| `TDC265` | `<assert>` no tiene condición | Una aserción es la única construcción cuyo valor entero está en que FALLE, y sin `that=` no puede hacerlo nunca. Escribe la propiedad que la ejecución debe cumplir, en el lenguaje de `if=`, sobre columnas iguales en toda la ejecución |
| `TDC266` | `<assert>` no tiene mensaje | `says=` es lo que lee una persona meses después, en un log de CI. Una expresión sola la deja reconstruyendo qué estaba defendiendo |
| `TDC267` | `uniq="true"` junto con `mask=`, `case=`, `missing=`, `repeat=`, `separator=` o `anomaly=` | Un sorteo sin reemplazo produce la columna directamente y nunca llega a la capa que reescribe los valores, así que el atributo solo podía perderse. Aplicarlo rompería la otra promesa: una máscara lleva dos sorteos distintos a los mismos caracteres |
| `TDC268` | `if=` en un `<gen type="pool">` | Una referencia publica un REGISTRO entero, y un `<gen>` con `if=` pasa a ser una rama condicional que el resolutor de pools no reconoce — no se registraba ninguna columna `Ref.field` y `${{Ref.name}}` llegaba a la salida como su propio texto literal. Para dejar filas sin miembro, use `parent=` |
| `TDC269` | `if=` en un `<gen>` dentro de un `<case>` | El cuerpo de una rama son varias partes unidas en un solo valor, así que una condición sobre una parte no tiene valor al que replegarse. Se aceptaba y se ignoraba, y la parte aparecía en todas las filas — incluidas las que la condición excluía. Ponga la condición en la rama: `<case if="…">` |
| `TDC270` | `<tdc>` tiene un segundo `<env>` o `<block>` | Ambos se leen tomando el PRIMERO de su clase, así que un segundo se descarta entero — con cada secuencia que declara y cada línea que dispone — mientras la corrida termina como si nada. Se informa sobre el segundo |
| `TDC271` | `percent=` junto a `order="sequential"` | Recorrer la lista en orden fija qué valor recibe cada fila, así que no queda cuota que repartir. El porcentaje se aceptaba y se descartaba: `percent="98,1,1"` sobre cien filas daba 34 / 33 / 33 |
| `TDC272` (aviso) | `<env local=…>` nombra un locale sin traducciones de fechas | El locale es una buena fuente de NOMBRES y no trae nombres de meses, así que las fechas salen en inglés. En `<gen type="date" local=…>` se rechaza (TDC153) y aquí callaba hasta ahora. Solo salta si el formato lee el locale: `format="YYYY-MM-DD"` es igual en todos los idiomas |
| `TDC273` | un argumento que el filtro no puede usar | `slice:5,2` termina antes de empezar y vacía la columna; `slice:abc`, `group:abc`, `group:0`, `compact:1` y `compact:99` dejan el valor intacto. `group` y `compact` SIN argumento conservan sus valores por defecto documentados (3, base 36) |
| `TDC274` | un argumento en un filtro que no lee ninguno | `trim`, `sql`, `upper`, `lower`, `capitalize` y `title` son transformaciones completas; `${{X\|trim:junk}}` ignoraba `junk` en silencio. Encadena en su lugar: `${{X\|trim\|upper}}` |
| `TDC275` | `replace` sin nada que buscar | `${{X\|replace}}` y `${{X\|replace:,to}}` no cambian nada. Escribe las dos partes: `${{X\|replace:from,to}}` |
| `TDC276` | un parámetro clavado con el ancho equivocado | Un identificador con dígito de control tiene un diseño fijo, así que una parte de otro ancho lo rompe en vez de desplazarlo. `usa.finance.aba_routing prefix="12345"` abortaba la ejecución; `tail="678"` escribía un número de seis dígitos que no lo es. Solo se informa donde el ancho se puede DEMOSTRAR a partir del cuerpo del propio paquete |
| `TDC277` | `decimals=` sin rango que redondear | Sin `value=` el generador produce una cadena de DÍGITOS — un identificador — y no hay nada que redondear. `<gen type="number" length="4" decimals="2"/>` emitía 4566, 5773, 5192 |
| `TDC278` | `decimals=` junto a `length=` | Un valor fraccionario no tiene ancho entero al que rellenar, así que el descartado era `length=`: `value="1..9" length="3" decimals="2"` emitía 3.78, 2.89 |
| `TDC279` | `first_zero="false"` que el rango no puede cumplir | Todo valor de `0..5` es de un dígito, así que una escritura de tres siempre rellena. El generador volvía a sortear cien veces por fila y emitía la forma prohibida igualmente: 005, 002, 003. Solo se informa donde el rango lo DEMUESTRA |
| `TDC280` | dos grafías del mismo rango de fechas | `value=`, el par `from`/`to` y `range=` dicen lo mismo, y el generador los lee en ese orden y se detiene. `value="2020-05-05" from="1990-01-01" to="1990-12-31"` producía 1990-05-11 y descartaba el resto sin decir nada. `value="today"`, `"now"` y `"birth"` también son grafías |
| `TDC281` | un rango de fechas que termina antes de empezar | El sorteo tomaba el mínimo y el máximo de los dos extremos, así que `from="2020-01-01" to="2010-01-01"` producía fechas plausibles de un rango que nadie escribió. `plus="10..3d"` se rechaza como errata en vez de intercambiarse desde que se escribió; esta es la misma errata |
| `TDC282` | `order="sequential"` solo en algunos miembros de un enlace `row=`                                 | Póngalo en todos los miembros del enlace, o quítelo — un enlace mixto deja de leer una sola línea por registro                                                                       |
| `TDC283` | `anomaly_flag` en un `<gen>` que es solo una parte de su `<sequence>` | La bandera registra QUÉ FILAS recibieron un valor atípico, y una secuencia construida con varias partes — un segundo `<gen>`, un literal `<data>` o un `name=` que convierte este `<gen>` en un campo — no tiene dónde poner esa columna. Mueva el `<gen>` a su propia `<sequence>`; así también obtiene el valor como columna propia. El mismo razonamiento que `TDC246`, un nivel más arriba |
| `TDC284` | `secret=` escrito dentro de la configuración, o vacío | Una clave dentro de la configuración viaja a donde viaje ella — al control de versiones incluido. `secret="env:TDC_HTTP_SECRET"` la lee del entorno, `secret="file:~/.tdc/service.key"` de un archivo que el repositorio no guarda. Un literal es una ADVERTENCIA, porque un servicio en 127.0.0.1 por una tarde es un uso real; `secret=""` es un error, porque firmar con nada produce una firma que cualquiera puede falsificar |
| `TDC285` | Un atributo del dibujo cuyo valor no es ninguna de sus palabras, ni un número | `mode=`, `interp=`, `spread=` y `decimals=` solo se leían en la corrida, así que `check` llamaba válido a `mode="banana"` y la corrida lo rechazaba — el único lugar donde `check` no respondía «¿esto correría?». Se admiten: `mode="signal|density"`, `interp="linear|smooth|step"`, un `spread=` no negativo y un `decimals=` entero no negativo |
| `TDC286` | `<is_digit>` o `<encode>` recibió `<field name="_count">` o `<field name="_total">` | Esos dos campos llegan como NÚMEROS; ambas etiquetas quieren un carácter de texto. `<is_digit>` respondía «no» en todas las filas — incluidas aquellas en las que el conteo sí es un solo dígito — y `check` no decía nada; `<encode>` detenía la corrida con «expected a single-character string», sin nombrar archivo ni línea, en un config que `check` también llamaba válido. Compare el número con `<equals>` o `<less_than>`, envuélvalo en `<concat>` para `<encode>`, o ponga el carácter que quiere decir en un `<str>` |
| `TDC287` | `<equals>`, `<greater_than>` o `<less_than>` recibió un literal `<str>` que no es un número | Las tres comparaciones trabajan con números. Un `<str>` con dígitos se lee como el número que deletrea — `<equals><str v="7"/><int v="7"/></equals>` es verdadero — así que solo se rechaza el literal que no es un número. Antes ese detenía la corrida con «expected an integer in `<equals>`, got the string …», sin nombrar archivo ni línea, en un config que `check` llamaba válido. Solo se revisan los literales: lo que tendrá un `<field>` no se sabe antes de la corrida |
| `TDC288` | `<var>` — la etiqueta se renombró a `<use>` | Nunca declaró nada: `<let>` liga un nombre y esta lo vuelve a leer, que es lo que dice el nombre nuevo. Sin un rechazo propio, la grafía antigua caía en «etiqueta de compute desconocida», que dice que está mal escrita pero no cuál es la correcta. El atributo `name=` no cambia |
| `TDC289` | `distinct=` recibió algo que no es `true` ni `false` | El atributo tiene dos formas y ningún tercer significado. Tratar una palabra desconocida como `false` dejaría una configuración que pide valores distintos y obtiene repeticiones en silencio |
| `TDC290` | `distinct=` sin `repeat=` | Un valor no puede repetirse a sí mismo, así que el atributo se leería y no haría nada. Añada `repeat="N"` o `repeat="A..B"`, o quite `distinct=` |
| `TDC291` | `percent=` y `distinct=` en el mismo `<gen>` | `percent=` promete proporciones exactas sobre toda la ejecución; `distinct=` cambia esa promesa por una garantía dentro de cada fila. Ambas no pueden sostenerse, así que ninguna se descarta en silencio. Para proporciones sobre las LONGITUDES de las listas, póngalas en un `<mix>` o `<switch>` por fuera, con `repeat=` en el `<gen>` de dentro |
| `TDC292` | `repeat=` bajo `distinct=` pide más valores de los que la lista puede ofrecer | Cinco valores no pueden dar seis distintos. Se informa antes de la ejecución cuando el conjunto está en la configuración (`type="text"`, un rango de enteros, un conjunto `symbol` de un carácter); en tiempo de ejecución cuando no lo está (un archivo de pack, una columna CSV, una regex), ya que solo se leen al generar |
| `TDC293` | `<gen type="pattern">` sin `y_range=` | Un dibujo no trae escala propia: la misma curva sale de una herramienta en coordenadas 0..100 y de otra en 0..10002345345. `y_range="min..max"` dice qué significan esas coordenadas: se convierte en el piso y el techo del lienzo del dibujo. Sin él toda respuesta sería una conjetura sobre los ajustes de exportación de alguien más, así que el atributo es obligatorio y no se supone |
| `TDC294` | `<gen type="formula">` sin `expr=`, con un `expr=` que no se analiza, o un `decimals=` fuera de 0..10 | Una fórmula ES su expresión, así que sin ella no hay nada que calcular. La expresión es el mismo lenguaje que `if=`, vea [Expresiones](expressions.md#top). Un nombre dentro de ella que no sea una columna declarada arriba da `TDC240`, el mismo código que usan `running` y `stat` para la misma regla |
| `TDC295` | `if=` en una columna `running`, `stat`, `formula` o un desplazamiento de fecha | Se construyen una vez, para toda la corrida, en orden de declaración — un `if=` pide un valor elegido fila por fila, y ambas cosas no pueden ser ciertas a la vez. Ponga la condición donde el valor se USA (`<data if="…">`), o calcule la columna sin condición y ramifique después |
| `TDC296` | Una columna `running`, `stat`, `formula`, una fecha medida desde otra o un `<compute>` dentro de `<uniq>` o `<distinct>` | Un grupo REORDENA columnas ya terminadas hasta que cada registro sea único. Un valor sorteado significa lo mismo dondequiera que caiga; uno calculado describe la fila para la que se calculó, así que moverlo deja mal la aritmética. Pon el grupo alrededor de las columnas que esta LEE y deja la calculada fuera: seguirá a lo que el grupo ordene |
| `TDC297` | Dos lecturas de un mismo archivo a la vez — `read="quantile"` junto a `weight=`, `row=` u `order="sequential"`; un `read=` mal escrito; `sample=` sin él | `weight=` guarda las proporciones en una segunda columna, `row=` enlaza varias columnas a una LÍNEA, `order="sequential"` recorre la lista en orden, y `read="quantile"` dice que los valores SON la distribución y que una fila cae en cualquier punto de la muestra ordenada. Quédese con una lectura: lo contable quiere `weight=` y su cuota exacta, lo medido quiere la lectura por cuantiles |
| `TDC298` | Una misma clave `row=` sobre dos archivos distintos | Un enlace es una LÍNEA de un archivo, así que no hay línea que pertenezca a ambos. Apunte a todos los miembros del enlace al mismo `src=`, o dele a este su propia clave `row=` |
| `TDC299` | _(aviso)_ `uniq="true"` sobre más de 100 000 filas                       | Sacar sin reemplazo obliga a recordar lo ya sacado, así que la columna entera se queda en memoria y la ejecución no puede transmitirse. Medido en unos 250 bytes por valor: 2 000 000 de filas cuestan unos 477 MB. Funciona; conviene hacerlo a conciencia                                                  |
| `TDC300` | Un `fit=` que no es una banda, que va de mayor a menor, o que acompaña a `points=`/`upper=`/`lower=` | `fit="bajo..alto"` dice en qué se convierten el punto más bajo y el más alto del propio dibujo sobre el eje de valores: así se coloca una curva leída de `src=`, ya que un archivo lleva una forma y ninguna unidad. Dos números, el menor primero; dar la vuelta al dibujo es otra petición. Junto a puntos escritos a mano se rechaza: allí `80` ya significa el 80% de `y_range`, así que no queda nada que colocar. Omítelo y el dibujo llenará todo el `y_range` |
| `TDC301` | _(aviso)_ Una lista de proporciones que deja un valor declarado en 0% | Un `percent` más corto que `value` está bien: lo que sobra va a las posiciones que no escribió, así que `value="a,b,c" percent="30,40"` le da a `c` los 30 restantes. Cuando las proporciones escritas ya suman 100 no sobra nada, y ese valor queda declarado y no puede salir nunca: `percent="50,50"` sobre 300 filas dio 150 `a`, 150 `b`, ningún `c`. Un cero que usted mismo escribe — `percent="50,0,50"` — se toma al pie de la letra y no dice nada |
| `TDC244` | `type="pattern"` sin `points`, `src` ni `upper`                             | Un dibujo necesita una forma de la que leer: `points="0,0 1,5 2,3"`, un archivo en `src`, o `upper`/`lower` para una banda                                                                                                                                  |

Tres números de este rango se reservaron mientras se diseñaban los pools y quedarán sin
usar, así que los huecos están declarados en vez de quedar en silencio:

- **`TDC227`** — un `filter=` que nombra una columna que no existe. Una palabra suelta en
  el lenguaje de expresiones siempre ha sido un literal de texto, y eso es lo que usa
  `filter="clinic == North"` para decir «solo los del norte». Un error de tipeo y un
  literal se escriben igual, así que la comprobación pondría un error sobre
  configuraciones que funcionan. Donde el literal es un error seguro — ningún miembro
  podría tener ese valor — lo dice `TDC225`, sin adivinar.
- **`TDC228`** — un `${{Pool.campo}}` que llega al pool sin pasar por una referencia.
  `TDC193` ya lo reporta como un nombre que no resuelve a nada, y un segundo código para
  la misma frase no vale el número.
- **`TDC233`** — ningún candidato pasó el `filter=` en la fila N, para expresiones más
  ricas que una igualdad simple. Ese rechazo ocurre y vale la pena tenerlo; solo que no
  es un código de diagnóstico. Compara contra un valor que solo existe cuando la fila ya
  se está construyendo, así que pertenece a la corrida, y el mensaje de la corrida nombra
  la fila y el valor con el que nadie coincidió.

## Totales acumulados

Véase [`accumulate=`](../constructs/multiple-values.md#accumulate--un-total-acumulado-a-lo-largo-de-la-lista)
y [`<gen type="running">`](../generators/running.md#top).

| Código   | Cuándo salta                                                                | Cómo se arregla                                                                                                                             |
| :------- | :-------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------ |
| `TDC237` | `accumulate=` en un generador sin `repeat=`                                 | No hay nada que acumular: no hay lista. Agregue `repeat="N"` o quite `accumulate=`. (`type="running"` es la excepción: acumula por columna) |
| `TDC238` | `accumulate=` nombra una operación que no existe                            | Una de `sum`, `min`, `max`                                                                                                                  |
| `TDC239` | `<gen type="running">` no dice qué (`of=`) ni cómo (`accumulate=`) acumular | Un total acumulado lee la columna de otro y no sortea nada por su cuenta, así que ambos son obligatorios                                    |
| `TDC240` | `of=` o `reset=` nombra una columna que no está declarada más arriba        | El total se arma con una columna que ya existe — la misma regla que tiene `parent=`                                                         |

## `<compute>`

| Código   | Cuándo salta                                                                                                     | Cómo arreglarlo                                                                                                                                          |
| :------- | :--------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TDC180` | Una etiqueta dentro de `<compute>` que el lenguaje de cálculo no tiene, o un predicado escrito fuera de `<test>` | El mensaje nombra la etiqueta. Contrástela con el [Lenguaje de cálculo](../compute/overview.md#top) — un predicado como `<eq>` solo vale dentro de `<test>` |
| `TDC181` | `<current>`, `<current_index>` o `<acc>` fuera de su cuerpo de iteración                                         | Solo existen dentro de un `<do>` (o el `<do>` de un `<reduce>`)                                                                                          |
| `TDC182` | `<use name="X">` no nombra ningún `<let>` que lo envuelva                                                        | Envuélvalo en `<let name="X">…</let>`, o corrija el nombre                                                                                               |
| `TDC183` | Una operación de compute que toma exactamente dos operandos recibió otro número | Solo `<divide>` y `<mod>` son binarias — un tercer operando no significa nada ahí. `<add>`, `<subtract>` y `<multiply>` son variádicas: `<add>` sobre tres operandos suma los tres, y sin operandos da `0` (`<multiply>` da `1`) |
| `TDC184` | `<choose>` no tiene rama `<otherwise>`                                                                           | Agregue `<otherwise>` — cada registro necesita una respuesta                                                                                             |
| `TDC185` | Un `<let name="X">` tapa una vinculación externa del mismo nombre                                                | Renombre una — la interna ocultaría la externa                                                                                                           |
| `TDC186` | `<encode>`: codificación desconocida                                                                             | Una de: `base36`, `ascii`, `unicode`, `hex`, `binary`, `octal`                                                                                           |
| `TDC187` | A un predicado le falta su hijo envoltorio                                                                       | `<when>` quiere `<test>`, `<choose>` quiere `<then>` — el mensaje nombra el par                                                                          |
| `TDC188` | `<int v="…">` no es un número entero                                                                             | Escriba un entero; para texto use `<str v="…"/>`                                                                                                         |
| `TDC189` | `<compute>` tiene más de un `<result>`                                                                           | Deje un solo `<result>` — los anteriores se descartarían                                                                                                 |

## `<mix>`, `<switch>`, fixtures

| Código   | Cuándo salta                                                                                                        | Qué hacer                                                            |
| :------- | :------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------- |
| `TDC120` | `<mix>` no tiene ningún `<case>`                                                                                    | Una mezcla necesita ramas entre las que elegir                       |
| `TDC121` | Un `percent` sobre un `<mix>`/`<switch>` tiene más entradas que casos                                               | Un porcentaje por caso                                               |
| `TDC122` | Una entrada de `percent` sobre un `<mix>`/`<switch>` no es un número no negativo                                    | Las posiciones llenas son números                                    |
| `TDC123` | `percent` sobre un `<mix>`/`<switch>` no suma 100                                                                   | Ajuste los valores a 100                                             |
| `TDC124` | `<mix>` tiene un hijo que no es `<case>`                                                                            | Allí solo puede ir `<case>`                                          |
| `TDC125` | `<case>` tiene un hijo desconocido | Se permiten `<data>`, `<gen>`, `<mix>`, `<switch>` — un `<switch>` anidado dentro de una rama es un constructo de pleno derecho (véase TDC245) |
| `TDC131` | Una fixture lleva una etiqueta que no acepta, o un `<data>` sin `<line>` alrededor                                  | El cuerpo de una fixture se compone de `<line>`. Un `<data>` suelto validaba y no renderizaba nada |
| `TDC132` | Dentro de `<line>` hay una etiqueta que no corresponde                                                              | El bloque de salida es disposición; los generadores viven en `<env>` |
| `TDC133` | `<switch>` no tiene `on`                                                                                            | Nombre la secuencia sobre la que se conmuta                          |
| `TDC134` | `on` nombra una secuencia, o un campo suyo, que no existe                                                           | Revise el nombre — el mensaje dice cuál de las dos mitades falla     |
| `TDC135` | `<switch>` no tiene entradas                                                                                        | Agregue `<map>`, `<case>` o `<default>`                              |
| `TDC136` | _(advertencia)_ Una fila de `<map>` no es `CLAVE:VALOR` — la fila mala se omite y el resto del mapa sigue aplicando | Un par por entrada, separado por dos puntos                          |
| `TDC137` | Un `<case>` dentro de `<switch>` no tiene `is`                                                                      | `is` es la clave de la rama                                          |
| `TDC245` | `name` en un `<switch>` escrito dentro de un `<case>` | La forma anidada aporta un valor a esa rama; solo un `<switch>` a nivel de `<env>` se convierte en columna |

## Fechas

| Código   | Cuándo salta                                | Qué hacer                                                             |
| :------- | :------------------------------------------ | :-------------------------------------------------------------------- |
| `TDC150` | Solo se dio uno de `from` / `to`            | Ambos extremos o ninguno                                              |
| `TDC151` | El valor de fecha no parsea                 | `value="2020-01-01..2025-12-31"`, `"birth"`, `"today"`, `"now"`       |
| `TDC152` | Un token de `format` es desconocido         | Ver la [tabla de tokens](../generators/date.md#formato-de-la-salida) |
| `TDC153` | `local` nombra un locale sin datos de fecha | Incluidas: `ar`, `de`, `el`, `en`, `es`, `fr`, `it`, `pl`, `pt`, `ru`, `zh-cn`, más alias de tres letras |
| `TDC154` | `precision` no es un paso admitido          | Ver [precision](../generators/date.md#top)                               |

## Durante la generación

Estos surgen al generar, no al validar: el config es correcto, pero la combinación no
se puede llevar a cabo.

| Código   | Cuándo salta                                                                                             | Qué hacer                                                                                   |
| :------- | :------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------ |
| `TDC160` | `row="…"` en un `<gen>` en línea                                                                         | El enlace por fila necesita un `<sequence>`                                                 |
| `TDC161` | Se usan opciones ponderadas de `advanced_regex` en línea                                                 | Los porcentajes exactos se calculan sobre toda la columna — muévalo a un `<sequence>`       |
| `TDC162` | En un contador en línea `value` o `step` no es numérico                                                  | `value="1" step="2"`                                                                        |
| `TDC170` | Un archivo de data pack no se puede cargar                                                               | El mensaje nombra el archivo — ver [Escribir los suyos](../data-packs/writing-your-own.md#top) |
| `TDC171` | _(advertencia)_ Un archivo de data pack no obtiene dirección, así que se omite                           | Añada `address:` o `locale:` a su cabecera, o muévalo bajo una carpeta de locale            |
| `TDC200` | _(advertencia)_ La estimación de memoria es una parte grande de la RAM de esta máquina — el run continúa | Para conjuntos muy grandes use `mode="disk"`, la memoria se mantiene plana                  |
| `TDC201` | La estimación de memoria supera la RAM de esta máquina                                                   | Baje `count`, divida el run, o use `mode="disk"`                                            |

> [!NOTE]
> **A tres de estos no se llega desde una configuración**
>
> `TDC160`, `TDC161` y `TDC162` describen un `<gen>` en línea — escrito directamente dentro
> de `<line>` en vez de en un `<sequence>`. La validación rechaza esa forma antes, con
> `TDC131` (`a <gen> is not allowed inside <line>`) o `TDC013`, así que una configuración
> real nunca llega tan lejos. Solo se alcanzan por el export de bajo nivel
> `render(parse(src).tree)`, que recorre un árbol sin validar a propósito. Por eso mismo no
> existen en los cuatro ports: compilan la configuración en un modelo donde ese `<gen>` no
> tiene dónde ir.

## Formato y modificadores

| Código   | Cuándo salta                                             | Qué hacer                                                                 |
| :------- | :------------------------------------------------------- | :------------------------------------------------------------------------ |
| `TDC190` | `case` no es una transformación conocida                 | `upper`, `lower`, `capitalize`, `title`                                   |
| `TDC191` | `order` no es `random` ni `sequential`                   | Esos son los dos                                                          |
| `TDC192` | Un filtro de interpolación es desconocido                | Ver [Máscaras y mayúsculas](../guides/masks-and-case.md#top)                 |
| `TDC193` | `${{Name}}` o `${{Name.field}}` nombra algo no declarado | Se imprimiría literal — se comprueba la referencia entera, campo incluido |
| `TDC194` | Un `<data>` tipado no tiene `name`                       | Solo un `<data>` con nombre se vuelve columna                             |
| `TDC195` | `repeat` no es un número ni un rango                     | `repeat="3"` o `repeat="1..5"` (de 0 a 64)                                |
| `TDC196` | `repeat` se usa en `<mix>`                               | Una mezcla elige una rama; no produce una lista                           |
| `TDC198` | `separator` sin `repeat`                                 | Une valores repetidos, así que tiene que haberlos                         |
| `TDC199` | Un índice de `mask` está mal formado                     | Los índices empiezan en 0 y los rangos usan `..` — `x[0..3]`, `w[-1]`     |
| `TDC202` | Hay `flag` pero ningún `<case>` marcado `anomaly="true"` | La columna saldría toda en negativo — marque la rama atípica              |
| `TDC203` | `flag` en un `<mix>` anidado                             | Solo una mezcla con nombre a nivel `<env>` lleva la columna-respuesta     |
| `TDC204` | `repeat` en un generador que no puede repetir            | El mensaje nombra el tipo                                                 |
| `TDC206` | `each=""` no nombra ninguna secuencia                    | Nombre la lista a recorrer                                                |
| `TDC207` | `each` nombra una secuencia de un solo valor             | Tiene que ser una lista — agregue `repeat` en el origen                   |
| `TDC209` | Un `<data>` con nombre dentro de una línea con `each=`   | Esa línea produce varias filas, y el nombre de columna queda ambiguo      |
| `TDC211` | `weight` en un generador que no es `file`                | Los pesos vienen de una columna del CSV                                   |
| `TDC212` | `weight` sin `column`                                    | Los pesos viven en una segunda columna, que hay que nombrar               |
| `TDC213` | `weight` junto con `order`                               | `order` recorre las filas por posición; ponderar las elige por frecuencia |

## Vea también

- [CLI](cli.md#top) — códigos de salida y banderas
- [Etiquetas](tags.md#top) y [Atributos](attributes.md#top) — qué se permite dónde

---

← Anterior: [Catálogo de identificadores](./identifiers.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Expresiones](./expressions.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/reference/errors)**
