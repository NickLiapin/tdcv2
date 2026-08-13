<a name="top"></a>

[English](../../generators/formula.md#top) · [Русский](../../ru/generators/formula.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/generators/formula)**

← Anterior: [Estadística](./stat.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Resumen](../pools/overview.md#top) →

---

# El generador `formula`

**Úselo cuando** una columna no se sortea sino que se **calcula**, a partir de las otras
columnas de la misma fila. Un peso que sigue a una estatura. El IMC de ambos. Un precio por
una cantidad. Un resto que quiere imprimir en vez de comprobar.

```xml
<gen type="formula" expr="0.75 * Height - 58 + 6 * Z" decimals="1"/>
```

`expr=` es el mismo lenguaje pequeño que [`if=`](../reference/expressions.md#top): los mismos
operadores, las mismas funciones, los mismos nombres para las mismas columnas. La única
diferencia es adónde va la respuesta: `if=` la consume como un sí/no, y una fórmula la
conserva como el valor de su columna.

| Atributo   | Qué define                                                                     |
| :--------- | :------------------------------------------------------------------------------ |
| `expr`     | **Obligatorio.** La aritmética que ES esta columna                             |
| `decimals` | Dígitos tras el punto, 0 a 10. Sin él el valor se imprime completo              |

## Una columna que sigue a otra

Los datos reales no son un conjunto de columnas independientes: el peso sigue a la
estatura, los ingresos a la educación, la superficie al precio. Una fórmula es cómo se dice
eso:

```xml
<sequence name="Height"><gen type="number" distribution="normal" mean="170" sd="10" decimals="1"/></sequence>
<sequence name="Z">     <gen type="number" distribution="normal" mean="0" sd="1" decimals="4"/></sequence>

<sequence name="Weight"><gen type="formula" expr="0.75 * Height - 58 + 6 * Z" decimals="1"/></sequence>
<sequence name="BMI">   <gen type="formula" expr="Weight / pow(Height / 100, 2)" decimals="1"/></sequence>
<sequence name="Label"> <gen type="formula" expr="BMI > 25 ? over : normal"/></sequence>
```

`./run clinic.tdc`

```
152.3,62.1,26.8,over
187.3,73.4,20.9,normal
172.9,69.6,23.3,normal
164.9,59.8,22.0,normal
159.3,60.9,24.0,normal
157.4,63.9,25.8,over
```

`Height` se sortea, `Z` es el ruido que impide que la relación sea una línea recta, y las
otras tres se calculan. **`Z` no tiene que imprimirse**: deje una columna fuera de
`<block>` y se queda en el cálculo sin llegar al archivo. Un config de ciencia de datos
suele tener varias así.

La última línea merece atención aparte: un ternario hace que una fórmula produzca una
**etiqueta**, no solo un número, que es como un conjunto de entrenamiento consigue su
columna objetivo.

## La división, y el resto que sí puede imprimir

Aquí la división es real, y siempre lo fue — es el único operador que no puede quedarse
entero, porque los enteros no son cerrados bajo él:

```xml
<sequence name="N">   <gen type="number" value="1..20"/></sequence>
<sequence name="Half"><gen type="formula" expr="N / 2"/></sequence>
<sequence name="Rem"> <gen type="formula" expr="N % 3"/></sequence>
<sequence name="Row"> <gen type="formula" expr="_count"/></sequence>
```

`./run numbers.tdc`

```
n=15 half=7.5 rem=0 row=1
n=9  half=4.5 rem=0 row=2
n=9  half=4.5 rem=0 row=3
n=5  half=2.5 rem=2 row=4
```

`_count` y cualquier otro [valor incorporado](../reference/builtins.md#top) se puede leer, así
que una tendencia a mano es `expr="100 + 0.05 * _count"`.

> [!NOTE]
> **Una comparación imprime `true` / `false`, no 1 / 0**
>
> `expr="BMI > 25"` da la palabra `true`, igual que `_last`, `_first` y cualquier columna
> `anomaly_flag`: una sola escritura para una bandera en todo el motor.
>
> Un conjunto de entrenamiento suele querer la otra forma, y el ternario está ahí mismo:
>
> ```xml
> <gen type="formula" expr="BMI > 25 ? 1 : 0"/>
> ```

## Los enteros siguen siendo enteros

Un operando que ES un número entero se lleva como tal y solo se vuelve doble cuando algo se
lo pide. Así que una fórmula es exacta donde sus entradas lo son —`1000000 * 1000000` da la
respuesta correcta, no una redondeada— y solo se vuelve aproximada cuando el config pidió
algo inexacto. Las reglas son las mismas que en todo el lenguaje de expresiones y están
escritas en [Expresiones](../reference/expressions.md#números-enteros).

> [!CAUTION]
> **Dos fracciones rara vez son iguales**
>
> `0.1 + 0.2 == 0.3` es **falso**, aquí y en cualquier otro lenguaje, porque 0.1 no tiene
> forma binaria exacta. Es aritmética IEEE honesta, no una rareza de este motor —pero
> significa que una rama escrita como `if="A + B == 0.3"` puede no dispararse nunca. Compare
> con `<` y `>`, o redondee ambos lados primero.

## Una fuente vacía da una respuesta vacía

Una celda que [`parent=`](../core-concepts/sequences.md#top) o
[`missing=`](../guides/missing-data.md#top) dejó vacía no es un cero, y una fórmula
que la lee produce nada en vez de inventar un número:

```xml
<sequence name="H" parent="G.M"><gen type="number" value="170..190"/></sequence>
<sequence name="W"><gen type="formula" expr="H * 2"/></sequence>
```

`./run people.tdc`

```
F,,
F,,
M,170,340
M,172,344
```

Las filas donde `H` no tiene valor dejan `W` vacía también. Es la misma regla que
siguen [acumulado](running.md#top) y [estadística](stat.md#top) al saltarse una celda
vaciada, vista desde el otro lado — y es lo que hace segura una fórmula sobre una
columna con `missing=`: los vacíos siguen vacíos en vez de volverse aritmética.

## Los envoltorios que una fórmula no toma

`mask=`, `case=`, `missing=`, `missing_as=`, `repeat=`, `anomaly=` y
`anomaly_factor=` se rechazan con [`TDC015`](../reference/errors.md#top) en lugar de
aceptarse y ser ignorados. Una fórmula se resuelve antes de que corra la capa de
formato — la misma posición que ocupan `running` y `stat`.

La respuesta existe un paso más adelante y es mejor, porque funciona donde el valor se
IMPRIME:

```xml
<data>${{Weight|mask:x}}</data>
```

## Qué capa: formula o `<compute>`

Ambas calculan un valor, y la separación no es cuestión de gusto:

| | |
| :--- | :--- |
| **`formula`** | matemáticas — fracciones, división, funciones, cualquier valor derivado |
| **[`<compute>`](../compute/overview.md#top)** | dígitos de control y forma del texto — módulo 11, Luhn, relleno, recorte |

`<compute>` trabaja solo con enteros a propósito, porque eso es lo que un dígito de control
necesita. Escribir una fórmula en su árbol de etiquetas se puede, y es un suplicio:
`(x - lo) / (hi - lo)` allí es media pantalla de anidamiento y aquí trece caracteres.

## Qué rechaza `check`

Todo lo que una fórmula necesita se sabe desde el config, así que nada espera a la corrida:

- **sin `expr=`** — [`TDC294`](../reference/errors.md#top). Una fórmula ES su expresión.
- **un `expr=` que no se analiza** — `TDC294`, señalando el punto exacto.
- **un nombre que no es una columna declarada arriba** —
  [`TDC240`](../reference/errors.md#top), el mismo código que usan `running` y `stat` para la
  misma regla, con un `did you mean` cuando el nombre se parece a uno real. Este es el que
  más importa: una errata en un `if=` es una palabra suelta y la rama deja de dispararse en
  silencio, pero una errata en una fórmula llega a la aritmética.

La corrida rechaza dos más, porque dependen de los valores y no del config: aritmética
sobre una columna de **texto** (de donde saldría el `NaN`, y un archivo lleno de `NaN` sin
aviso es peor que una corrida detenida) y una **división por cero**.

## Detalles

- **Lee su propia fila.** La fila *i* se calcula de la fila *i* y de nada más, así que una
  fórmula no consume aleatoriedad: añadir una deja todas las demás columnas donde estaban.
- **Orden de declaración.** Una fórmula se construye con columnas que ya existen, así que
  cada nombre en `expr=` debe pertenecer a una secuencia declarada arriba.
- **Hace streaming.** Leer solo su propia fila es exactamente aquello sobre lo que está
  construido el [motor de streaming](../guides/large-outputs.md#top), así que una fórmula corre
  allí como cualquier columna sorteada y la memoria no crece con el número de filas. Medido
  sobre un config: 1 M de filas 2,1 s, 5 M 3,9 s, 20 M 9,5 s y un archivo de 291 MB, con la
  memoria pico subiendo 1,3× mientras las filas subían 20×. El motor en memoria, con los
  mismos 5 M, tardó 12,5 s y usó más memoria, y a 20 M no llega.

  Esto es lo que separa una fórmula de [acumulado](running.md#top) y [estadística](stat.md#top):
  esos dos necesitan filas distintas de esta —todas las anteriores, y todas sin más—, así
  que se quedan en memoria por definición, no por omisión.

## Vea también

- **[Expresiones](../reference/expressions.md#top)** — los operadores, las funciones y las
  reglas de los enteros.
- **[Acumulado](running.md#top)** — cuando la respuesta necesita las filas *anteriores*.
- **[Estadística](stat.md#top)** — cuando necesita toda la corrida.
- **[Number](number.md#top)** — las columnas sorteadas que una fórmula lee.

---

← Anterior: [Estadística](./stat.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Resumen](../pools/overview.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/generators/formula)**
