<a name="top"></a>

[English](../../generators/text.md#top) · [Русский](../../ru/generators/text.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/generators/text)**

← Anterior: [Descripción general](./overview.md#top) · **[Contenido](../README.md#top)** · Siguiente: [number](./number.md#top) →

---

# El generador `text`

**Úselo cuando** tenga una lista corta y fija de opciones de dónde elegir: género,
estatus, categoría, tipo de pago, nivel. Y si necesita proporciones exactas de cada
una (digamos, 60 % de una y 40 % de la otra), eso es un solo atributo extra.

Las salidas de ejemplo de abajo son ilustrativas: los valores exactos que produce un
`seed` dado pueden cambiar entre versiones del núcleo, pero las **cantidades** que
garantiza una máscara `percent` nunca cambian.

## De un vistazo

| Atributo  | Obligatorio | Qué hace                                                                             |
| :-------- | :---------- | :----------------------------------------------------------------------------------- |
| `value`   | **sí**      | Las opciones, separadas por comas: `"a,b,c"`                                         |
| `percent` | no          | Proporción exacta de cada opción; vea [más abajo](#proporciones-exactas-con-percent) |

Además de estos, `text` acepta los atributos transversales de los generadores:
`case=` / `mask=` para el [formato de salida](../guides/masks-and-case.md#top) y
`order=` / `cycle=` para el [orden de los valores](overview.md#top).

## `value` — una lista de opciones

El parámetro principal. Para `text`, `value` es una **lista separada por comas** con
las opciones de dónde tomar valores; el generador elige una al azar para cada fila.

```xml
<sequence name="Color">
    <gen type="text" value="red,green,blue"/>
</sequence>
```

`./run color.tdc (count=6)`

```
blue
red
green
green
red
blue
```

Sin `percent`, la elección es **uniforme**: todas las opciones son igual de
probables, y el mismo `seed` siempre reproduce la misma secuencia. Los valores pueden
repetirse libremente de una fila a otra (`green` dos veces arriba); si necesita que
cada fila sea distinta, vea [Valores únicos](../constructs/unique-values.md#top).

¿Quiere las opciones en el orden estricto de la lista en vez de al azar? Agregue
`order="sequential"` — vea [Resumen de generadores](overview.md#top).

> [!NOTE]
> **`value` se lee distinto en cada generador**
>
> `value` es la entrada principal de todos los generadores, pero su **significado
> depende de `type`**. En `text` es una lista de palabras completas; en
> [`number`](number.md#top) es un rango numérico como `1..100`; en [`date`](date.md#top) es
> un rango de fechas o una palabra de modo como `today`; en [`regex`](regex.md#top) es un
> patrón. Mismo atributo, gramática distinta — esta página cubre solo la lectura de
> `text`.

## Proporciones exactas con `percent`

Esto es lo que distingue a `text` de un simple selector aleatorio. Agregue `percent`
y TDC acomoda los valores en cantidades **exactas** usando el método de Hamilton (del
resto mayor): el número de veces que aparece cada valor coincide, garantizado, con
los porcentajes. Lo aleatorio es solo el _orden_.

```xml
<sequence name="Gender">
    <gen type="text" value="Hombre,Mujer" percent="60,40"/>
</sequence>
```

Las filas salen revueltas:

`./run gender.tdc (first 6 rows)`

```
Mujer
Hombre
Mujer
Hombre
Hombre
Hombre
```

…pero cuente **todas** y el reparto es exacto. Sobre `count="100"`:

`./run gender.tdc (count=100, tallied)`

```
Hombre   60
Mujer    40
```

Exactamente 60 `Hombre` y 40 `Mujer` — no «como 60 %», sino 60. Ese es todo el punto
de Hamilton: los totales son exactos; solo el orden depende de la semilla.

### Proporciones que no dividen parejo

Tres proporciones iguales sobre 100 filas son 33.33 % cada una, lo cual no puede ser
entero. Hamilton le da la fila sobrante al resto más grande, así que el total sigue
siendo exactamente 100:

```xml
<sequence name="Grade">
    <gen type="text" value="A,B,C" percent=",,"/>
</sequence>
```

`./run grade.tdc (count=100, tallied)`

```
A   34
B   33
C   33
```

`34 + 33 + 33 = 100` — no se pierde ni se cuenta doble ninguna fila. Las proporciones
explícitas se comportan igual de literalmente:

```xml
<sequence name="Tier">
    <gen type="text" value="gold,silver,bronze" percent="50,30,20"/>
</sequence>
```

`./run tier.tdc (count=100, tallied)`

```
gold     50
silver   30
bronze   20
```

### Cantidades pequeñas

La garantía es «los totales suman `count`», lo cual solo cae en los porcentajes
exactos cuando `count` se puede repartir así. Con `count="100"` y `percent="50,50"`
obtiene exactamente 50 y 50. Con `count="3"` y la misma máscara no puede haber dos y
medio de cada uno, así que Hamilton redondea a `2 + 1` o a `1 + 2` —cuál valor se
lleva la fila sobrante depende de la semilla—, pero las dos cantidades **siempre suman 3**.
Nunca se descarta ni se duplica una fila.

`./run coin.tdc (value=Heads,Tails percent=50,50 count=3)`

```
Heads
Tails
Heads
```

El redondeo importa sobre todo cuando la proporción es **pequeña**.
`percent="10"` sobre 5 filas pide media fila, y media fila no se puede emitir —
así que el valor aparece una vez o no aparece, y lo decide el seed. Una opción
rara puede desaparecer por completo de una ejecución corta mientras la
configuración se ve correcta. Multiplique la proporción por la cantidad de filas
antes de confiar en ella; el ejemplo resuelto está en
[Una proporción menor que un registro](../constructs/mix.md#una-proporción-menor-que-un-registro).

### Máscaras `percent` cortas

No hace falta llenar todas las posiciones. La regla es:

- **Un número fija la proporción de ese valor.**
- **Cada posición vacía reparte por partes iguales lo que queda de 100** — y «vacía»
  significa tanto una coma pelona dentro de la máscara _como_ cualquier posición más
  allá del final de una máscara más corta que la lista de valores.

La columna `Valores` de abajo es el largo de la lista de valores a la que se aplica la
máscara (la misma máscara se expande distinto para un número distinto de valores):

| Máscara  | Valores | Se expande a                 | Por qué                                                       |
| :------- | :------ | :--------------------------- | :------------------------------------------------------------ |
| `60`     | 2       | `60,40`                      | valor 1 = 60; el valor 2 se lleva el resto                    |
| `,58`    | 2       | `42,58`                      | valor 2 = 58; el valor 1 se lleva el resto                    |
| `,10,10` | 4       | `40,40,10,10`                | valores 3–4 = 10; los valores 1–2 reparten los 80 restantes   |
| `46,`    | 5       | `46,13.5,13.5,13.5,13.5`     | valor 1 = 46; los valores 2–5 reparten los 54 restantes (÷4)  |
| `,,25,,` | 5       | `18.75,18.75,25,18.75,18.75` | valor 3 = 25; los otros cuatro reparten los 75 restantes (÷4) |

Tome `46,` sobre una lista de cinco valores: solo se fijó la primera proporción, así
que los otros cuatro valores dividen en partes iguales el sobrante
`100 − 46 = 54` — `13.5` cada uno. La coma final solita nada más señala «y los demás
quedan abiertos».

Así que el ejemplo exacto de 60/40 de arriba se puede escribir aún más corto: la
segunda proporción es simplemente «el resto»:

```xml
<gen type="text" value="Hombre,Mujer" percent="60"/>
```

Si la máscara está **completa**, sus números deben sumar 100. Si tiene posiciones
vacías, los números que sí están deben sumar **a lo más** 100.

## Proporciones dentro de un subconjunto

Cuando la secuencia tiene un [`parent`](../core-concepts/sequences.md#top), los
porcentajes se calculan contra el tamaño del **subconjunto filtrado**, no contra el
`count` completo. Esa es la clave de las dependencias jerárquicas — un reparto de
«70 % Soldado / 30 % Capitán» que aplica solo a los hombres, por ejemplo. Vea
**[Dependencias jerárquicas](../guides/hierarchical-dependencies.md#top)**.

## `percent` más allá de `text`

La misma gramática de máscara y el mismo acomodo de Hamilton mueven también las
proporciones de las ramas de un bloque `<mix>`: ahí el largo de la máscara se compara
contra el número de ramas `<case>` anidadas, y un `percent` omitido reparte los casos
de manera uniforme. Así que una vez que entendió `percent` aquí, lo entendió en todos
los lugares donde aparece.

## Formato

Como cualquier generador, `text` acepta `case=` / `mask=` y `order=` para transformar
su salida — por ejemplo, poner en mayúsculas la palabra elegida, o forzar el orden
secuencial. Vea **[Máscaras y mayúsculas](../guides/masks-and-case.md#top)**.

## Siguiente

- **[Number](number.md#top)** — enteros, rangos y cadenas de dígitos de ancho fijo.
- **[File](file.md#top)** — la misma idea de «elegir de una lista», pero la lista vive en un archivo o en una columna CSV.

---

← Anterior: [Descripción general](./overview.md#top) · **[Contenido](../README.md#top)** · Siguiente: [number](./number.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/generators/text)**
