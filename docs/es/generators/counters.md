<a name="top"></a>

[English](../../generators/counters.md#top) · [Русский](../../ru/generators/counters.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/generators/counters)**

← Anterior: [Regex avanzado](./advanced-regex.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Series de tiempo](./timeseries.md#top) →

---

# Increment y decrement — contadores

**Se usan cuando** hace falta un contador corrido en lugar de un valor aleatorio: un
id secuencial o número de fila (1, 2, 3…), una serie de SKU que sube con un paso fijo,
o una cuenta regresiva que baja hasta cero.

Los dos viven dentro de una [`<sequence>`](../core-concepts/sequences.md#top): la
secuencia se calcula una sola vez como arreglo, y cada fila de salida toma el
siguiente valor mediante la
[interpolación](../core-concepts/output-formatting.md#top) `${{Nombre}}`.

## De un vistazo

| Atributo | Se aplica a              | Por defecto | Qué hace                           |
| :------- | :----------------------- | :---------- | :--------------------------------- |
| `value`  | `increment`, `decrement` | `0`         | Valor inicial                      |
| `step`   | `increment`, `decrement` | `1`         | Cuánto sumar o restar en cada fila |

Ambos contadores son **posicionales y deterministas**: cada fila simplemente toma el
siguiente valor de la corrida. Ignoran por completo el
[`seed`](../core-concepts/determinism.md#top) (a diferencia de los generadores
aleatorios), así que la secuencia es idéntica en cada ejecución — las salidas de esta
página son exactas, no solo ilustrativas.

> [!NOTE]
> **Bajo `parent=` los números siguen siendo 1..N, en un orden que elige la semilla**
>
> Un contador en una [secuencia hija](../guides/hierarchical-dependencies.md#top) numera solo las
> filas que el padre conservó. Esas filas llevan exactamente `1..N` sin huecos ni repeticiones,
> pero CUÁL de ellas recibe qué número lo decide la semilla, así que al leer el archivo de
> arriba abajo puede ver 6, 4, 5, 1, 2, 3 en lugar de 1, 2, 3, 4, 5, 6.
>
> Ese es el precio de un valor que cualquier motor calcula solo a partir de la fila. Numerar
> las filas conservadas en orden de archivo exigiría contar las conservadas ANTES de cada una,
> y el motor de streaming no lleva esa suma acumulada — responde por la fila 900.000 sin que
> existan las 899.999 anteriores. Donde también necesite el orden del archivo, dé al padre
> `order="sequential"` para que las filas conservadas queden contiguas.

## `increment` — un contador que sube

Cada fila es el valor anterior más [`step`](#step--el-paso). Con los valores por
defecto (`value="0"`, `step="1"`) cuenta de uno en uno, pero el caso común es una
columna de id que arranca en 1.

```xml
<sequence name="Id"><gen type="increment" value="1"/></sequence>
```

`./run demo.tdc (count=5)`

```
1
2
3
4
5
```

Conviene usarlo siempre que se necesite un id o número de fila estable y sin huecos:
cada registro recibe un valor secuencial distinto, y es reproducible entre corridas.

## `decrement` — un contador que baja

Cada fila es el valor anterior menos [`step`](#step--el-paso). Los mismos dos
atributos; solo se invierte la dirección.

```xml
<sequence name="Countdown"><gen type="decrement" value="100"/></sequence>
```

`./run demo.tdc (count=5)`

```
100
99
98
97
96
```

Eche mano de `decrement` cuando necesite una cuenta regresiva, una columna de
cantidad restante o cualquier numeración inversa que empiece alto y vaya bajando.

## `step` — el paso

[`step`](../reference/attributes.md#top) define cuánto se mueve el contador entre filas.
Por defecto vale `1`. Apunte el mismo arranque (`value="1"`) a dos pasos distintos y
lo único que cambia es la zancada: a la izquierda cuenta de uno en uno, a la derecha
de cinco en cinco:

```xml
<sequence name="ByOne"><gen type="increment" value="1"/></sequence>
<sequence name="ByFive"><gen type="increment" value="1" step="5"/></sequence>
...
<data>${{ByOne}}   ${{ByFive}}</data>
```

`./run demo.tdc (count=6)`

```
step=1   step=5
1        1
2        6
3        11
4        16
5        21
6        26
```

`step` funciona igual con `decrement`: controla qué tan grande es cada bajada:

```xml
<sequence name="Full"><gen type="decrement" value="1000"/></sequence>
<sequence name="ByHundred"><gen type="decrement" value="1000" step="100"/></sequence>
```

`./run demo.tdc (count=5)`

```
step=1   step=100
1000     1000
999      900
998      800
997      700
996      600
```

Use un `step` propio para series que no avanzan de uno en uno: SKU espaciados de 5 en
5, un precio que cae una cantidad fija, un medidor que marca de diez en diez.

### Pasos fraccionarios

`step` (y también `value`) acepta un número real, no solo entero — muy útil para
precios, porcentajes o cualquier magnitud medida que se mueve en fracciones:

```xml
<sequence name="Price"><gen type="decrement" value="9.99" step="0.50"/></sequence>
```

`./run demo.tdc (count=5)`

```
9.99
9.49
8.99
8.49
7.99
```

## Determinista por diseño

Los contadores nunca tocan el motor aleatorio, así que la misma configuración produce
la misma corrida sin importar el [`seed`](../core-concepts/determinism.md#top). Dos
ejecuciones con semillas distintas dan columnas de contador idénticas byte por byte:

```xml
<gen type="increment" value="1" step="10"/>
```

`./run demo.tdc — seed=alpha vs seed=omega (count=5)`

```
seed=alpha   seed=omega
1            1
11           11
21           21
31           31
41           41
```

Eso convierte a los contadores en la columna vertebral confiable de un conjunto de
datos: las columnas de id y los números de fila se quedan en su lugar aunque se
revuelva todo lo aleatorio a su alrededor.

## ¿Solo necesita el número de fila?

Si lo único que quiere es el número de fila actual dentro de la plantilla de salida,
existe el valor integrado [`${{_count}}`](../reference/builtins.md#top) — no hace falta
ninguna secuencia. Arranca en 1 y sube de uno en uno con cada registro.

Eche mano de una secuencia `increment` cuando necesite el contador como **valor con
nombre**: algo que reutilizar en varios lugares, dar formato con una
[máscara](../guides/masks-and-case.md#top), empezar en algo distinto de 1 o avanzar con
un paso distinto de 1.

## Vea también

- [Secuencias](../core-concepts/sequences.md#top) — el contenedor donde viven ambos contadores.
- [Valores integrados](../reference/builtins.md#top) — `_count`, `_first`, `_last`, `_total`.
- [Determinismo](../core-concepts/determinism.md#top) — por qué la misma semilla reproduce
  los mismos datos (y por qué los contadores lo ignoran).

---

← Anterior: [Regex avanzado](./advanced-regex.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Series de tiempo](./timeseries.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/generators/counters)**
