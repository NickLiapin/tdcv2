<a name="top"></a>

[English](../../generators/stat.md#top) · [Русский](../../ru/generators/stat.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/generators/stat)**

← Anterior: [Total acumulado](./running.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Formula (fórmula)](./formula.md#top) →

---

# `stat` — un número para toda la ejecución

**Úsalo cuando** una fila necesita saber algo de _todas_ las filas, incluidas las que
vienen después: si este precio está por encima de la media, cuál es el pedido más grande
del fichero, cuántas filas llevan valor.

Este es el tercer y último eje de "un valor que no se sortea, sino que se deriva".
`accumulate=` suma una lista dentro de un registro. [`running`](running.md#top) suma una
columna sobre la marcha, así que la fila 40 sabe de las filas 1–39. Una estadística sabe de
todas.

```xml
<tdc>
  <env count="8" seed="basket" local="en">
    <sequence name="Price"><gen type="number" value="10..200" decimals="2"/></sequence>
    <sequence name="Average"><gen type="stat" of="Price" op="mean" decimals="2"/></sequence>
    <sequence name="Verdict">
      <gen if="Price > Average" type="text" value="above average"/>
      <gen type="text" value="below average"/>
    </sequence>
  </env>
  <block>
    <line><data>${{Price}}   ${{Average}}   ${{Verdict}}</data></line>
  </block>
</tdc>
```

`./run basket.tdc`

```
156.83   122.52   above average
176.51   122.52   above average
135.17   122.52   above average
157.94   122.52   above average
50.71   122.52   below average
92.28   122.52   below average
50.37   122.52   below average
160.35   122.52   above average
```

"¿Está esta fila por encima de la media?" no se puede preguntar de otra forma. La media no
se conoce hasta que existe la última fila, y un `<gen>` condicional se evalúa mientras la
fila se construye — así que la estadística tiene que ser una columna propia, calculada
antes.

> [!NOTE]
> **La salida es ilustrativa**
>
> Los valores vienen de un `seed` fijo, así que son reproducibles, pero las cadenas exactas
> pueden cambiar entre versiones del núcleo. Tómalos como ejemplos de _forma_, no como
> garantías.

## De un vistazo

| Atributo   | Obligatorio | Qué hace                                                              |
| :--------- | :---------- | :--------------------------------------------------------------------- |
| `of`       | sí          | La columna a resumir. Debe estar **declarada arriba** de esta secuencia |
| `op`       | sí          | `sum`, `mean`, `median`, `min`, `max`, `count` o `stddev`              |
| `decimals` | no          | Redondear la respuesta a N decimales, de 0 a 10                        |

Una estadística **no sortea nada**. Lee una columna que ya existe, no consume nada de
aleatoriedad y por tanto añadirla deja todas las demás columnas exactamente donde estaban.

## Las siete estadísticas

```xml
<env count="6" seed="lab" local="en">
    <sequence name="Reading"><gen type="number" value="1..100"/></sequence>
    <sequence name="Total"><gen type="stat" of="Reading" op="sum"/></sequence>
    <sequence name="Smallest"><gen type="stat" of="Reading" op="min"/></sequence>
    <sequence name="Largest"><gen type="stat" of="Reading" op="max"/></sequence>
    <sequence name="Middle"><gen type="stat" of="Reading" op="median"/></sequence>
    <sequence name="Spread"><gen type="stat" of="Reading" op="stddev" decimals="3"/></sequence>
    <sequence name="Rows"><gen type="stat" of="Reading" op="count"/></sequence>
</env>
```

`./run lab.tdc`

```
60  sum=297 min=7 max=81 median=63 sd=27.415 n=6
81  sum=297 min=7 max=81 median=63 sd=27.415 n=6
66  sum=297 min=7 max=81 median=63 sd=27.415 n=6
7  sum=297 min=7 max=81 median=63 sd=27.415 n=6
17  sum=297 min=7 max=81 median=63 sd=27.415 n=6
66  sum=297 min=7 max=81 median=63 sd=27.415 n=6
```

Dos de ellas conviene decirlas en voz alta, porque las alternativas son igual de comunes y
dan números distintos:

- **`stddev` es la desviación típica POBLACIONAL** — dividida por _n_, no por _n_−1. Una
  columna generada es todo lo que describe, no una muestra sacada de algo mayor, así que
  _n_ es el divisor honesto. La misma decisión que toma la función `stddev()` de las
  [expresiones](../reference/expressions.md#top).
- **`median` con un número par de valores es la media de los dos centrales**, así que una
  columna `2,4,4,4,5,5,7,9` tiene mediana `4.5`.

`count` es cuántas filas llevaban valor: las filas que un filtro
[`parent`](../guides/hierarchical-dependencies.md#top) vació no se cuentan, y tampoco
participan en ninguna de las demás. Es la misma regla que siguen `accumulate=` y `running`,
así que una columna filtrada significa una sola cosa en las tres y no tres distintas.

## Céntimos exactos y `decimals=`

`sum`, `min` y `max` son el último valor de la columna **acumulada** correspondiente. No es
un atajo: es lo que impide que las dos funciones se separen. La aritmética va sobre enteros
escalados por la fracción más larga de la columna, nunca sobre coma flotante, así que
`19.99 + 0.01 + 0.01` es `20.01` en las cinco implementaciones y no `20.009999999999998` en
una de ellas. `min` y `max` devuelven un elemento que ya existe, así que un valor que llegó
como `007` sigue siendo `007`.

`mean`, `median` y `stddev` son **razones** y no pueden ser exactas. Sin `decimals=` se
imprimen enteras, con todos sus dígitos, porque una media que perdió dígitos en silencio es
peor que una fea. Con `decimals=` se redondean — y un medio va **alejándose del cero**, la
misma regla que sigue `round()` en todo TDC, así que `117.045` a dos decimales es `117.05`.

## Orden de declaración

`of=` nombra una columna, y debe estar **declarada arriba** de la estadística (`TDC240`) —
la misma regla que siguen [`parent`](../guides/hierarchical-dependencies.md#top) y `running`,
por la misma razón: la estadística se construye a partir de una columna que ya existe.

Una estadística que no dice qué resumir, o qué estadística tomar, es `TDC262`.

`./run lab.tdc`

```
error[TDC262]: op="men" is not one of sum, mean, median, min, max, count, stddev
 --> lab.tdc:4:63
  |
4 |     <sequence name="Spread"><gen type="stat" of="Reading" op="men"/></sequence>
  |                                                               ^^^
  |
help: did you mean "mean"?
note: One of: sum, mean, median, min, max, count, stddev.
```

## Qué motor la ejecuta

El [motor de streaming](../guides/large-outputs.md#top) rechaza una estadística, por su
nombre, y el enrutador manda la configuración al motor en memoria:

`./run basket.tdc --engine 2`

```
tdcv2: a statistic ("Average") is computed over every row of the run, including the ones after this one, so it cannot be computed one row at a time; the in-memory engine handles it (run without a forced streaming engine)
```

Normalmente nunca ves ese mensaje — el enrutador elige el motor por su cuenta, y el rechazo
solo sale a la superficie cuando una configuración _nombra_ un motor de streaming y por
tanto ha pedido que se lo expliquen.

Lo que cuesta es el mismo límite que tiene [`running`](running.md#qué-motor-lo-ejecuta),
un paso más fuerte: un total acumulado al menos conoce su respuesta cuando llega a una
fila, y una estadística no la conoce hasta que la ejecución termina. La columna que lee se
mantiene durante toda la ejecución.

> [!TIP]
> **Si basta con la propia fila, usa una formula**
>
> Un estadístico es la herramienta correcta cuando una fila tiene que saber de TODAS las
> filas. Cuando solo tiene que saber de sí misma, [`<gen type="formula">`](formula.md#top)
> lo hace y **hace streaming**, así que el límite de ejecución entera de arriba no se
> aplica.

**Todo lo demás sigue fluyendo.** El límite es por configuración, no por proyecto: una
ejecución sin estadística no se ve afectada.

## Véase también

- [`running`](running.md#top) — la misma columna, acumulada sobre la marcha en lugar de
  resumida al final
- [`accumulate=` sobre una lista `repeat`](../constructs/multiple-values.md#accumulate--un-total-acumulado-a-lo-largo-de-la-lista) —
  la misma idea dentro de un registro, gratis en cualquier motor
- [Expresiones](../reference/expressions.md#top) — `sum`, `mean`, `median` y `stddev` también
  existen como funciones, sobre una lista dentro de una fila y no sobre una columna

---

← Anterior: [Total acumulado](./running.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Formula (fórmula)](./formula.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/generators/stat)**
