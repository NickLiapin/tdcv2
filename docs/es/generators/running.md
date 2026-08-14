<a name="top"></a>

[English](../../generators/running.md#top) · [Русский](../../ru/generators/running.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/generators/running)**

← Anterior: [Servicio HTTP](./http.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Estadística](./stat.md#top) →

---

# `running` — un total que se arrastra por la columna

**Sirve cuando** un valor no se sortea sino que se _acumula_: el saldo de una cuenta
después de cada movimiento, un medidor que solo sube, la carga más alta vista hasta ahora.
El valor de la fila 40 depende de las filas 1 a 39.

Todos los demás generadores contestan una fila a partir de su propio índice. Este no puede,
y no es una limitación que haya que esquivar: es lo que «acumulado» significa.

```xml
<tdc>
  <env count="8" seed="ledger" local="en">
    <sequence name="Op"><gen type="number" value="-400..500"/></sequence>
    <sequence name="Balance"><gen type="running" of="Op" accumulate="sum" base="1000"/></sequence>
  </env>
  <block>
    <line><data>${{Op}}   ${{Balance}}</data></line>
  </block>
</tdc>
```

`./run ledger.tdc`

```
399   1399
-246   1153
-270   883
159   1042
24   1066
-400   666
419   1085
80   1165
```

> [!NOTE]
> **La salida es ilustrativa**
>
> Los valores salen de un `seed` fijo, así que son reproducibles, pero las cadenas exactas
> pueden cambiar entre versiones del núcleo. Tómelas como ejemplo de _forma_, no como
> garantía.

## De un vistazo

| Atributo     | Obligatorio | Qué hace                                                                               |
| :----------- | :---------- | :------------------------------------------------------------------------------------- |
| `of`         | sí          | La columna que se acumula. Tiene que estar **declarada más arriba** que esta secuencia |
| `accumulate` | sí          | `sum`, `min` o `max`                                                                   |
| `base`       | no          | El valor de apertura — un saldo inicial, un odómetro de partida                        |
| `reset`      | no          | Una columna cuyo cambio reinicia el total                                              |

Un total acumulado **no sortea nada**. Lee una columna que ya existe, no consume azar, y
por eso agregar uno deja todas las demás columnas exactamente donde estaban.

## `reset=` — un total por grupo

Sin `reset=` hay un total para todo el archivo. Con él, la columna se parte en tramos y
cada uno se acumula por su cuenta — un saldo por cuenta y no un saldo por corrida.

```xml
<env count="9" seed="acct" local="en">
    <sequence name="Account"><gen type="text" value="A,A,A,B,B,C,C,C,C" order="sequential"/></sequence>
    <sequence name="Op"><gen type="number" value="10..99" decimals="2"/></sequence>
    <sequence name="Balance"><gen type="running" of="Op" accumulate="sum" reset="Account"/></sequence>
</env>
```

`./run accounts.tdc`

```
A  49.86  49.86
A  21.54  71.40
A  35.12  106.52
B  80.60  80.60
B  98.09  178.69
C  33.58  33.58
C  23.09  56.67
C  72.74  129.41
C  94.78  224.19
```

`base=` es el valor inicial de **cada tramo**, no de la corrida: con `reset=`, cada grupo
vuelve a arrancar desde él — que es justo lo que quiere un saldo inicial por cuenta.

Un tramo termina donde el valor de `reset=` **cambia respecto de la fila anterior**, así
que los grupos tienen que venir juntos. `order="sequential"` arriba es una manera de
lograrlo; ordenar es otra, aunque [de ordenar suele encargarse la base de
datos](../constructs/overview.md#top), así que lo habitual es que la columna ya venga
agrupada.

## Centavos exactos

La aritmética corre sobre enteros escalados por la fracción más ancha de la columna, nunca
sobre punto flotante. `49.86 + 21.54` es `71.40` — y es el mismo `71.40` en las cinco
implementaciones, cosa que un flotante no garantizaría.

`base=` entra en esa misma escala. Una apertura de `1000.00` ensancha toda la columna a
dos decimales, que es lo que espera quien lee un extracto.

## Orden de declaración

`of=` y `reset=` nombran una columna, y las dos tienen que estar **declaradas más arriba**
que el total acumulado (`TDC240`). La razón es la misma que tiene
[`parent`](../guides/hierarchical-dependencies.md#top): el total se arma con una columna que
ya existe.

`./run ledger.tdc`

```
error[TDC240]: of="Op" is not a sequence declared above this one
 --> ledger.tdc:3:54
  |
3 |     <sequence name="Balance"><gen type="running" of="Op" accumulate="sum"/></sequence>
  |                                                      ^^
  |
note: A running total is built from a column that already exists, so the column it reads has to come first.
```

Un total acumulado que no dice qué ni cómo acumular es `TDC239`.

## Qué motor lo ejecuta

Los [motores de streaming](../guides/large-outputs.md#top) rechazan un total acumulado, y lo
nombran al hacerlo; el enrutador manda la configuración al motor en memoria:

`./run ledger.tdc --engine 2`

```
tdcv2: a running total ("Balance") is the accumulation of every row before it, so it cannot be computed one row at a time; the in-memory engine handles it (run without a forced streaming engine)
```

Normalmente nunca ve ese mensaje: el enrutador elige el motor solo, y el rechazo aparece
únicamente cuando la configuración _nombra_ un motor de streaming y por lo tanto pidió que
se lo dijeran.

Lo que cuesta: un total acumulado vive en memoria durante toda la corrida, como cualquier
columna del motor en memoria. Ese es el límite honesto de este generador. Un libro mayor
de unos millones de filas está bien; uno de mil millones no es algo que TDC haga, porque
todo el sentido de los motores de streaming es que una fila se calcula desde su índice, y
acá no se puede.

> [!TIP]
> **Si basta con la propia fila, usa una formula**
>
> Un total acumulado es la herramienta correcta cuando una fila tiene que saber de las
> filas ANTERIORES. Cuando solo tiene que saber de sí misma — el total de una línea a
> partir de precio y cantidad, un margen de dos columnas —
> [`<gen type="formula">`](formula.md#top) lo hace y **hace streaming**, así que el límite
> de columna entera de arriba no se aplica.

**Todo lo demás sigue en streaming.** El límite es por configuración, no por proyecto: una
corrida sin total acumulado queda intacta, y el [total acumulado dentro de un
registro](../constructs/multiple-values.md#accumulate--un-total-acumulado-a-lo-largo-de-la-lista)
—`accumulate=` sobre una lista `repeat`— no cuesta nada y funciona en todos los motores.

## Véase también

- [`accumulate=` sobre una lista `repeat`](../constructs/multiple-values.md#accumulate--un-total-acumulado-a-lo-largo-de-la-lista) —
  la misma idea dentro de un registro, gratis en todos los motores
- [Contadores](counters.md#top) — `increment` y `decrement`, que se mueven a paso fijo y sí se
  calculan desde el índice de la fila
- [Series de tiempo](timeseries.md#top) — una curva que sube con tendencia y ruido, también
  desde el índice solo, y normalmente lo que «un valor que crece» realmente necesita

---

← Anterior: [Servicio HTTP](./http.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Estadística](./stat.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/generators/running)**
