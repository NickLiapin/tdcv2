<a name="top"></a>

[English](../../pools/filter.md#top) · [Русский](../../ru/pools/filter.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/pools/filter)**

← Anterior: [Resumen](./overview.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Enlazar pools entre sí](./linking.md#top) →

---

# Acotar con `filter`

Sin `filter`, una fila sortea de todo el pool. Con él, sortea solo de los miembros que la
expresión acepta.

El caso evidente: un paciente de la clínica norte tiene que ver a un médico que trabaje
allí.

```xml
<tdc>
  <env count="10" seed="clinic" local="en">
    <pool name="Doctors" count="6">
      <sequence name="clinic"><gen type="text" value="North,South"/></sequence>
      <sequence name="name"><gen type="template" value="person.lastName"/></sequence>
    </pool>

    <sequence name="Clinic"><gen type="text" value="North,South" percent="50,50"/></sequence>
    <sequence name="Patient"><gen type="template" value="person.female.firstName"/></sequence>
    <sequence name="Seen"><gen type="pool" value="Doctors" filter="clinic == Clinic"/></sequence>
  </env>
  <block>
    <line><data>${{Clinic}} | ${{Patient}} -> Dr. ${{Seen.name}} (${{Seen.clinic}})</data></line>
  </block>
</tdc>
```

`./run clinic.tdc`

```
South | Barbara -> Dr. Smith (South)
North | Mary -> Dr. Jones (North)
South | Dorothy -> Dr. Garcia (South)
South | Jennifer -> Dr. Johnson (South)
North | Elizabeth -> Dr. Jones (North)
North | Patricia -> Dr. Jones (North)
North | Susan -> Dr. Williams (North)
South | Sarah -> Dr. Smith (South)
South | Margaret -> Dr. Garcia (South)
North | Linda -> Dr. Jones (North)
```

La columna de la clínica y la clínica del médico coinciden en todas las filas.

## El sorteo sigue siendo uniforme

`filter` decide **qué miembros están disponibles**, no cuál se toma. Entre los que pasan,
la elección es uniforme: a un paciente del norte puede tocarle cualquiera de los médicos
del norte.

Vale la pena decirlo, porque la alternativa obvia — «usar el primer miembro que encaje» —
le daría a todos los pacientes del norte el mismo médico y destruiría en silencio la
dispersión para la que se construyó el pool.

## Qué significa un nombre dentro de `filter`

La expresión se evalúa en **dos ámbitos a la vez**: los campos del miembro candidato y las
columnas de la fila actual.

| El nombre        | Qué lee                                                                 |
| :--------------- | :---------------------------------------------------------------------- |
| `clinic`         | un **campo** del miembro candidato, si el pool tiene uno con ese nombre |
| `Clinic`         | una **columna** de la fila actual                                       |
| `Doctors.clinic` | siempre el campo del candidato — la forma cualificada                   |
| `North`          | una palabra suelta, leída como cadena literal                           |

El orden importa: un nombre suelto se busca **primero** como campo del miembro y solo
después como columna de la fila. Un nombre que es las dos cosas se rechaza en lugar de
adivinarse:

`./run clinic.tdc`

```
error[TDC232]: "clinic" in filter= is both a field of pool "Doctors" and a sequence — which one is meant is not decidable
 --> clinic.tdc:8:27
  |
8 |     <sequence name="Seen"><gen type="pool" value="Doctors" filter="clinic == clinic"/></sequence>
  |                           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  |
note: Rename one of them. Qualifying one side ("Doctors.clinic") does not help: the other "clinic" still reads as the member's field, so the test would compare a value with itself.
```

Un nombre cualificado que el pool no tiene también se detecta:

`./run clinic.tdc`

```
error[TDC226]: filter= reads "Doctors.branch", but pool "Doctors" has no field "branch"
 --> clinic.tdc:7:27
  |
7 |     <sequence name="Seen"><gen type="pool" value="Doctors" filter="Doctors.branch == Site"/></sequence>
  |                           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  |
note: Fields of "Doctors": clinic.
```

Un nombre desconocido **sin cualificar** se deja pasar, a propósito: el lenguaje de
expresiones lee una palabra suelta como cadena literal, y así es como
`filter="clinic == North"` dice «solo los médicos del norte» sin declarar nada.

## Es una expresión completa

`campo == Columna` es la forma habitual, pero `filter` admite todo lo que entiende el
[lenguaje de expresiones](../constructs/conditional-output.md#operadores-de-comparación):
`!=`, `<`, `>`, `<=`, `>=`, `&&`, `||`, `!` y aritmética.

La comparación dentro de un filtro sigue las mismas reglas que en todas partes, así que un
miembro que contiene `01` lo encuentra una fila que produce `1` — vea
[Comparación y verdad](../reference/comparison.md#top).

Eso abre los casos que valen más que el de la clínica — un cliente que compra lo que puede
pagar:

```xml
<tdc>
  <env count="8" seed="shop" local="en">
    <pool name="Catalog" count="6">
      <sequence name="item" uniq="true"><gen type="text" value="Kettle,Lamp,Chair,Desk,Rug,Clock"/></sequence>
      <sequence name="price"><gen type="number" value="10..300"/></sequence>
    </pool>

    <sequence name="Budget"><gen type="number" value="50..250"/></sequence>
    <sequence name="Buys"><gen type="pool" value="Catalog" filter="price <= Budget"/></sequence>
  </env>
  <block>
    <line><data>budget ${{Budget}} -> ${{Buys.item}} at ${{Buys.price}}</data></line>
  </block>
</tdc>
```

`./run shop.tdc`

```
budget 232 -> Clock at 11
budget 124 -> Desk at 92
budget 61 -> Clock at 11
budget 148 -> Clock at 11
budget 208 -> Rug at 198
budget 54 -> Clock at 11
budget 102 -> Desk at 92
budget 60 -> Clock at 11
```

Nadie compra por encima de su presupuesto, y no hubo que enumerar nada a mano.

> [!WARNING]
> **Escriba `<=` y `&&` tal cual**
>
> TDC no expande entidades XML. `filter="price &lt;= Budget"` llega al analizador como esos
> nueve caracteres y falla. Escriba el operador que quiere decir.

### Lo que cuesta

Hay dos caminos, y cuál se recorre lo decide cómo está escrito el filtro:

| El filtro                               | Cómo se responde una fila                                                 |
| :-------------------------------------- | :------------------------------------------------------------------------ |
| `campo == Columna` (en cualquier orden) | el pool se agrupa por ese campo **una vez**; una fila cuesta una búsqueda |
| cualquier otra cosa                     | los candidatos se recorren, por fila — lineal en el tamaño del pool       |

Los dos son correctos. La diferencia es la razón de que un pool tenga un
[techo de tamaño](overview.md#tamaño): recorrer un millón de miembros, dos mil veces, es
un coste real, y el techo es donde la herramienta lo dice.

## `filter` no es `if`, y `if` no está disponible aquí

En otros sitios `if` acota preguntando por la **fila**, una vez por fila. `filter` pregunta
por cada **candidato**, una vez por miembro: treinta preguntas por fila para un pool de
treinta.

En una referencia a un pool solo existe `filter`. `if` se
[rechaza](../reference/errors.md#top), porque una referencia publica un REGISTRO entero y no
un valor: una condicional no registraría ninguna columna `Ref.field`, y `${{Doctor.name}}`
llegaría a la salida como su propio texto literal.

Para dejar algunas filas sin miembro, use `parent`. Enmascara la referencia igual que
enmascara cualquier otra secuencia, y en las filas que excluye los campos salen vacíos:

```xml
<sequence name="Adult"><gen type="text" value="yes" if="Age >= 18"/></sequence>
<sequence name="Seen" parent="Adult"><gen type="pool" value="Doctors" filter="clinic == Clinic"/></sequence>
```

## Cuando no encaja nadie

Como `filter` nunca produce una celda vacía, «no encajó nadie» es un error y no un hueco.
El mensaje nombra la fila y el valor que la acotó hasta cero:

`./run clinic.tdc`

```
tdcv2: pool "Doctors": no member satisfies filter="clinic == Clinic" for row 3 (Clinic="South"). A filter narrows the members a row may draw from; when it narrows them to none there is nothing to substitute. Add a member that matches, or widen the filter.
```

Este en concreto es un rechazo **en tiempo de ejecución**, porque el validador no puede
saber que ningún miembro saldrá `South` hasta que el pool se haya sorteado. Cuando la
contradicción SÍ se puede probar desde el config — ambos lados salen de listas escritas que
no se cruzan — `check` lo rechaza antes de correr y sin adivinar, como
[`TDC225`](../reference/errors.md#top). La línea la marca lo que se puede probar, no cuándo
aparece el fallo. Las dos soluciones están en el mensaje — añadir un miembro que encaje o
ampliar el filtro — y hay una tercera que conviene conocer: darle al campo del pool la
misma lista finita de la que sortea la columna de la fila, para que todos los valores estén
representados.

## Relacionado

- [Resumen](overview.md#top) — qué es un pool, y el techo de tamaño al que se refiere esta
  página
- [Enlazar pools entre sí](linking.md#top) — `filter` leyendo un campo de _otra_ referencia a
  un pool, que es como se construye una cadena
- [Condiciones](../constructs/conditional-output.md#top) — `if` completo, incluidos los
  operadores que comparte con `filter`

---

← Anterior: [Resumen](./overview.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Enlazar pools entre sí](./linking.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/pools/filter)**
