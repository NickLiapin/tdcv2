<a name="top"></a>

[English](../../guides/distinct.md#top) · [Русский](../../ru/guides/distinct.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/guides/distinct)**

← Anterior: [Datos coherentes y relacionales](./coherent-data.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Leer archivos y CSV](./files-and-csv.md#top) →

---

# La etiqueta `<distinct>`

**Conviene usarla cuando** dos campos de la misma fila sacan del mismo conjunto y no
deben caer en el mismo valor: un primer nombre y un segundo nombre que no deberían salir
`José José`, un país de nacimiento y un país de residencia que no deberían ser
idénticos. `<distinct>` dice: _sus hijos directos, dentro de una fila, deben diferir
entre sí._

Esta es una regla **horizontal** — mira a lo ancho de los campos de una sola fila. Su
gemela vertical es [`uniq`](../constructs/unique-values.md#top), que evita que la **fila completa** se
repita en cualquier parte del dataset. Las dos son totalmente independientes: use
cualquiera, o ambas a la vez.

> [!NOTE]
> **Las salidas de ejemplo son ilustrativas**
>
> Las extracciones exactas de abajo son las que produce una corrida típica; pueden cambiar
> según la versión del core y el `seed`. Lo que nunca cambia es la **estructura** que
> garantiza `<distinct>`: dos hijos de un grupo jamás son iguales dentro de una fila.

![](../../img/guides/distinct-uniq.svg)

*Con qué frecuencia salió cada combinación de dos campos. En horizontal: el primer campo; en vertical: el segundo.*

- **A** — con distinct, sobre 60 filas: la diagonal queda vacía, porque una fila nunca puede repetir un valor entre sus campos
- **B** — con uniq, sobre 6 filas: ninguna celda pasa de 1, porque una combinación nunca puede repetirse entre filas — las celdas vacías son combinaciones a las que esta ejecución simplemente no llegó

## El problema: dos campos colisionan

Tome un primer nombre y un segundo nombre de la **misma** lista. Los dos campos
[`<gen>`](../generators/overview.md#top) corren de forma independiente, así que tarde o
temprano alguna fila saca la misma palabra dos veces. Aquí ambos campos usan una lista
corta de cuatro nombres, así que las colisiones salen a la luz de inmediato:

```xml
<sequence name="Person">
    <gen name="First"  type="text" value="José,Antonio,Juan,Manuel"/>
    <gen name="Middle" type="text" value="José,Antonio,Juan,Manuel"/>
</sequence>
...
<data>${{Person.First}} ${{Person.Middle}}</data>
```

`./run person.tdc (8 rows)`

```
José Manuel
Antonio José
Manuel Juan
Juan Juan
Manuel Antonio
José José
Juan Antonio
Antonio Manuel
```

Las filas 4 y 6 son `Juan Juan` y `José José` — una persona con el mismo primer y
segundo nombre no debería existir en los datos.

## La solución: envolver los campos

Envuelva ambos campos en `<distinct>`. Todo lo demás queda igual: los mismos
generadores, la misma lista, incluso el mismo `seed`:

```xml
<sequence name="Person">
    <distinct>
        <gen name="First"  type="text" value="José,Antonio,Juan,Manuel"/>
        <gen name="Middle" type="text" value="José,Antonio,Juan,Manuel"/>
    </distinct>
</sequence>
```

`./run person.tdc (8 rows)`

```
José Manuel
Antonio José
Manuel Juan
Juan José
Manuel Antonio
José Juan
Juan Antonio
Antonio Manuel
```

**La ganancia.** Las filas que no tenían colisión quedan **idénticas byte por byte** —
el motor no las tocó. Solo se repararon las dos colisiones: `Juan Juan` pasó a
`Juan José` y `José José` pasó a `José Juan`. Únicamente se volvió a extraer el
segundo campo, y solo donde hacía falta. El orden y el `seed` se conservan.

## Dos niveles

`<distinct>` funciona en dos lugares, con **la misma regla en ambos**: los hijos
directos de `<distinct>` producen valores distintos en cada fila. Lo que cambia es qué
cuenta como «hijo».

### 1. Dentro de una `<sequence>` — envuelve campos `<gen>`

Aquí `<distinct>` va dentro de una
[`<sequence>`](../core-concepts/sequences.md#top) y envuelve los campos `<gen name="…">`.
Se lee como «First ≠ Middle»: `José Manuel` se permite, `José José` no.

```xml
<env count="6" seed="es" local="es">
    <sequence name="Person">
        <distinct>
            <gen name="First"  type="template" value="person.male.firstName"/>
            <gen name="Middle" type="template" value="person.male.firstName"/>
        </distinct>
    </sequence>
</env>
```

`./run person.tdc (6 rows) — First Middle`

```
Gustavo Mateo
Esteban Máximo
Daniel Aurelio
Edgar Eleuterio
Elpidio Florencio
Jeremías José
```

**Por qué aquí:** ambos campos sacan del mismo conjunto de nombres de
[`template`](../generators/template.md#top) y, aun así, los dos valores de cada fila
siempre difieren. Este es el caso de todos los días — dos atributos de una misma entidad
que comparten fuente pero no deben coincidir.

### 2. Dentro de `<env>` — envuelve bloques `<sequence>` completos

En el nivel superior, `<distinct>` va dentro de
[`<env>`](../core-concepts/configuration.md#top) y envuelve bloques `<sequence>` enteros.
El ejemplo clásico es «país de nacimiento» contra «país de residencia»: dos extracciones
independientes de la misma lista de países coinciden de vez en cuando dentro de una
fila.

```xml
<env count="100" seed="s" local="es">
    <distinct>
        <sequence name="Birth"><gen type="template" value="location.country"/></sequence>
        <sequence name="Live"><gen type="template" value="location.country"/></sequence>
    </distinct>
</env>
```

`./run migration.tdc (6 rows) — Birth -> Live`

```
Portugal -> Polonia
Vietnam -> Sudán del Sur
San Cristóbal y Nieves -> Hungría
Vanuatu -> Egipto
Samoa -> Siria
Antigua y Barbuda -> Isla de Navidad
```

**Por qué aquí:** los dos valores viven ahora en secuencias separadas, así que ninguna
secuencia por sí sola puede compararlos — el grupo tiene que subir un nivel, hasta
`<env>`. El país de nacimiento y el país de residencia de una misma fila nunca coinciden.

## Cómo funciona

El motor genera los campos como siempre. Si dos valores dentro de un grupo colisionan en
una fila, **vuelve a extraer** uno de ellos con el siguiente valor del generador, y
repite hasta que difieran. El determinismo se conserva: las reextracciones corren en un
orden fijo, así que la salida para un `seed` dado no cambia. Funciona igual en el motor
en memoria que en streaming — vea [Salidas grandes](large-outputs.md#top).

## Detalles y trampas

Cada uno de estos puntos es una regla que conviene tener presente:

### Se comparan los valores, no las fuentes

`<distinct>` mira la **cadena** producida, no de dónde vino. Si dos campos leen de
archivos distintos pero resulta que emiten la misma palabra, sigue contando como
colisión y uno de ellos se vuelve a extraer.

### Los grupos son independientes

Puede tener varios bloques `<distinct>` y no se estorban entre sí. Un grupo para el
primer y segundo nombre y otro grupo aparte para, digamos, dos números de teléfono
imponen cada uno su propia regla, sin interferencias.

```xml
<sequence name="Person">
    <distinct>
        <gen name="First"  type="template" value="person.male.firstName"/>
        <gen name="Middle" type="template" value="person.male.firstName"/>
    </distinct>
    <distinct>
        <gen name="HomePhone" type="regex" value="\+52 \([0-9]{3}\) [0-9]{3}-[0-9]{4}"/>
        <gen name="CellPhone" type="regex" value="\+52 \([0-9]{3}\) [0-9]{3}-[0-9]{4}"/>
    </distinct>
</sequence>
```

**Por qué:** cada grupo delimita su propia restricción. El primer y el segundo nombre
nunca pueden ser iguales entre sí; el teléfono de casa y el celular tampoco; pero un
nombre queda libre de coincidir con una serie de dígitos que se renderice igual — los
dos grupos no se ven el uno al otro.

### Los campos fuera de `<distinct>` no conservan restricción

Solo los hijos directos de un grupo `<distinct>` quedan restringidos. Cualquier campo
que se deje afuera se genera con normalidad y puede repetir libremente un valor que haya
producido un campo del grupo.

### Con muy pocos valores falla de forma limpia

Si una lista tiene menos valores distintos que la cantidad de campos que deben diferir
—digamos, una sola palabra para dos campos—, la restricción es imposible de satisfacer.
En vez de quedarse en un ciclo infinito, TDC se rinde tras 1000 intentos en una fila y lo
dice. A diferencia de `uniq`, que comprueba la viabilidad antes de generar, este falla
durante la corrida — rápido, pero no antes de que empiece:

`./run person.tdc`

```
tdcv2: stream mode: <distinct> in sequence "Person": could not find a value
for field "B" different from the others after 1000 attempts — its source
likely has too few distinct values.
```

**Por qué:** una petición imposible debe fallar de forma ruidosa, no colgarse. Lo que
cambia frente a [`uniq`](../constructs/unique-values.md#top) es el momento: `uniq` prueba la
viabilidad de toda la columna antes de generar, mientras que `<distinct>` se entera en la
primera fila que no puede satisfacer.

### En el nivel `<env>`, los grupos aceptan solo secuencias de un valor

Un `<distinct>` dentro de `<env>` puede envolver únicamente secuencias de **un solo
valor** — un [`<gen>`](../generators/overview.md#top) simple, un `<mix>` o un `<switch>`. Una
secuencia compuesta (de varios campos) no tiene un valor único que comparar, así que
ponerla en el grupo se rechaza con el error `TDC129`:

`./run migration.tdc`

```
error[TDC129]: <sequence name="Person"> inside a config-level <distinct> must produce a single value
note: A <distinct> around sequences uses one value per sequence. Use a simple
<gen> or a <switch> sequence, not a compound (multi-field) one.
```

**Por qué:** la regla horizontal necesita un valor por hijo para poder comparar. Dentro
de una secuencia, envuelva directamente los campos `<gen>` (la forma de nivel 1 de
arriba); en el nivel `<env>`, mantenga cada secuencia agrupada en un solo valor.

## `<distinct>` frente a `uniq`, de un vistazo

| Mecanismo    | Eje        | Alcance         | Significado                                              |
| :----------- | :--------- | :-------------- | :------------------------------------------------------- |
| `<distinct>` | horizontal | una fila        | los campos **no son iguales entre sí** dentro de la fila |
| `uniq`       | vertical   | todas las filas | la **combinación de campos** nunca se repite             |

Resuelven problemas distintos y se combinan sin problema — una fila puede exigir que sus
dos campos de nombre difieran _y_ que el par completo `(first, last)` sea único en todo
el dataset. Para la regla vertical, vea [Valores únicos](../constructs/unique-values.md#top).

## Puede contener

| Etiqueta                                       | Dónde                  | Qué contiene                 |
| :--------------------------------------------- | :--------------------- | :--------------------------- |
| [`<gen/>`](../generators/overview.md#top)         | dentro de `<sequence>` | Campos que deben diferir     |
| [`<sequence>`](../core-concepts/sequences.md#top) | dentro de `<env>`      | Secuencias que deben diferir |

## Véase también

- **[Valores únicos](../constructs/unique-values.md#top)** — `uniq`, la gemela vertical: filas completas
  que nunca se repiten en el dataset.
- **[Secuencias](../core-concepts/sequences.md#top)** — las secuencias compuestas y los
  campos, las estructuras sobre las que opera `<distinct>`.
- **[Determinismo y proporciones](../core-concepts/determinism.md#top)** — por qué un
  `seed` fijo reproduce la misma salida, con reextracciones y todo.

---

← Anterior: [Datos coherentes y relacionales](./coherent-data.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Leer archivos y CSV](./files-and-csv.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/guides/distinct)**
