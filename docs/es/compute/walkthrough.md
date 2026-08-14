<a name="top"></a>

[English](../../compute/walkthrough.md#top) · [Русский](../../ru/compute/walkthrough.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/compute/walkthrough)**

← Anterior: [Condicionales](./conditionals.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Dependencias jerárquicas](../guides/hierarchical-dependencies.md#top) →

---

# Un pack leído línea por línea

Las demás páginas presentan una etiqueta a la vez. Esta va en sentido contrario: un
generador real, de principio a fin, con cada línea explicada. Aquí no aparece nada nuevo:
si ha leído [Listas](lists.md#top) y [Aritmética](arithmetic.md#top), ya conoce todas las
etiquetas de abajo.

El objeto es un routing number bancario estadounidense, los nueve dígitos impresos abajo
a la izquierda de un cheque. Ocho son arbitrarios. El noveno es un dígito de control:
multiplique los primeros ocho por los pesos 3, 7, 1, 3, 7, 1, 3, 7 por turno, sume los
productos y elija el último dígito para que el total caiga en un múltiplo de diez.

## El conjunto

```xml
<tdc>
    <env count="4" seed="aba-walk" local="en">
        <sequence name="Prefix"><gen type="text" value="01,02,03,04,05,06,07,08,09,10,11,12"/></sequence>
        <sequence name="Tail"><gen type="regex" value="[0-9]{6}"/></sequence>

        <sequence name="Routing">
            <compute>
                <let name="base"><concat><field name="Prefix"/><field name="Tail"/></concat></let>
                <let name="weighted">
                    <reduce>
                        <over><use name="base"/></over>
                        <init><int v="0"/></init>
                        <do>
                            <add>
                                <acc/>
                                <multiply>
                                    <current/>
                                    <at><in><list v="3,7,1,3,7,1,3,7"/></in><index><current_index/></index></at>
                                </multiply>
                            </add>
                        </do>
                    </reduce>
                </let>
                <let name="check">
                    <mod><subtract><int v="10"/><mod><use name="weighted"/><int v="10"/></mod></subtract><int v="10"/></mod>
                </let>
                <result><concat><use name="base"/><use name="check"/></concat></result>
            </compute>
        </sequence>
    </env>
    <block><line><data>${{Routing}}</data></line></block>
</tdc>
```

`./run routing.tdc`

```
107718758
096763296
073800334
052259744
```

Los cuatro pasan la comprobación real: pondere los primeros ocho dígitos con
3, 7, 1, 3, 7, 1, 3, 7, sume el noveno y el total se divide entre diez.

![](../../img/compute/studio-routing-config-light.png)

*El config como grafo: dos columnas sorteadas alimentan una calculada, y cada flecha dice quién usa a quién.*

## Quién sortea y quién computa

Dos secuencias sortean, una computa.

`Prefix` y `Tail` llevan `<gen>`, así que son los únicos lugares donde ocurre algo
aleatorio. `Routing` lleva un `<compute>`, de modo que no inventa nada: lee las dos
columnas sorteadas y deduce lo que se sigue de ellas. Cambie la semilla y las dos primeras
cambian; la tercera cambia solo porque cambiaron sus entradas.

Esa división es la forma completa de un pack de identificadores. El azar está en las
partes, las reglas están en el cómputo.

![](../../img/compute/studio-routing-tree-light.png)

*El mismo compute como árbol, en el canvas de Studio. Es más ancho que esta columna — haga clic para abrirlo a tamaño completo y recorrerlo.*

## Línea por línea

### La base: ocho dígitos de dos columnas

```xml
<let name="base"><concat><field name="Prefix"/><field name="Tail"/></concat></let>
```

`<field>` trae una columna que ya existe; `<concat>` pega las dos cadenas en una de ocho
caracteres; `<let>` le da a esa cadena el nombre `base`.

A partir de aquí `base` se lee como `<use name="base"/>` en el resto de este `<compute>`,
y solo después de esta línea. Un nombre se liga una vez, se lee hacia adelante y no se
vuelve a ligar.

### La suma ponderada: un plegado con una tabla dentro

```xml
<reduce>
    <over><use name="base"/></over>
    <init><int v="0"/></init>
    <do>
        <add>
            <acc/>
            <multiply>
                <current/>
                <at><in><list v="3,7,1,3,7,1,3,7"/></in><index><current_index/></index></at>
            </multiply>
        </add>
    </do>
</reduce>
```

Tres ranuras, cada una en su papel de siempre. `<over>` es el estante: `base` es una
cadena, así que se recorre carácter a carácter, ocho pasos. `<init>` pone `0` en el bote.
`<do>` se ejecuta una vez por paso.

Dentro de `<do>`, lea del centro hacia fuera:

1. `<current_index/>` es el número de paso, contando desde 0.
2. `<at>` lo usa para tomar el peso correspondiente de la lista de ocho elementos. Es una
   tabla de consulta en lugar de ocho ramas de un condicional.
3. `<multiply>` multiplica el dígito que tiene en la mano por ese peso.
4. `<add>` suma el producto a lo que ya hay en el bote, `<acc/>`.

Recorriendo los ocho primeros dígitos de `07718758` — `0 7 7 1 8 7 5 8` — contra los pesos
3, 7, 1, 3, 7, 1, 3, 7:

| Paso | `<current/>` | peso | producto | bote después |
| ---: | -----------: | ---: | -------: | -----------: |
|    1 |            0 |    3 |        0 |            0 |
|    2 |            7 |    7 |       49 |           49 |
|    3 |            7 |    1 |        7 |           56 |
|    4 |            1 |    3 |        3 |           59 |
|    5 |            8 |    7 |       56 |          115 |
|    6 |            7 |    1 |        7 |          122 |
|    7 |            5 |    3 |       15 |          137 |
|    8 |            8 |    7 |       56 |          193 |

Así que `weighted` vale 193 para ese registro.

### El dígito de control: lo que falta para un diez redondo

```xml
<mod><subtract><int v="10"/><mod><use name="weighted"/><int v="10"/></mod></subtract><int v="10"/></mod>
```

Léalo de dentro hacia fuera. `193 mod 10` es 3: cuánto ha pasado ya la suma de un múltiplo
de diez. `10 - 3` es 7: cuánto le falta. El `<mod>` exterior cubre el único caso en que esa
aritmética falla: si la suma ya termina en 0, `10 - 0` da 10, y un dígito de control tiene
que ser un solo dígito, así que `10 mod 10` lo devuelve a 0.

Ese `<mod>` exterior es de esas líneas que parecen sobrar hasta que llega el registro de
cada diez que las necesita.

### La respuesta

```xml
<result><concat><use name="base"/><use name="check"/></concat></result>
```

Ocho dígitos y el noveno, unidos. `<result>` es donde termina un `<compute>`, y su valor
es lo que imprime `${{Routing}}`. Un bloque termina una vez, así que nada puede quedar
al lado de `<result>`.

## Qué llevarse de aquí

La forma se traslada a cualquier esquema con dígito de control:

1. Sortee la parte arbitraria con `<gen>`, en una o varias secuencias.
2. Déle un nombre con `<let>` para que el resto del bloque pueda leerla.
3. Pliéguela con `<reduce>`, usando `<at>` para los pesos por posición en vez de ramas.
4. Convierta el total en un dígito con aritmética de `<mod>`.
5. Una las partes con `<concat>` y entréguelas a `<result>`.

Luhn, ISBN, el mod-97 del IBAN y los esquemas de identificación nacional de los packs
incluidos son todos esta misma forma de cinco pasos con otros pesos y otro paso final.

## Vea también

- **[Resumen](overview.md#top)** — la tubería, las ranuras y las etiquetas cuyo nombre engaña.
- **[Listas e iteración](lists.md#top)** — de dónde sale una lista y `<reduce>` paso a paso.
- **[Aritmética](arithmetic.md#top)** — división entera, `<mod>` y la frontera cadena-número.
- **[Escribir los suyos](../data-packs/writing-your-own.md#top)** — cómo publicar un generador como este.

---

← Anterior: [Condicionales](./conditionals.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Dependencias jerárquicas](../guides/hierarchical-dependencies.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/compute/walkthrough)**
