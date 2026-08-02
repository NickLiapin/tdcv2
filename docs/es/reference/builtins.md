<a name="top"></a>

[English](../../reference/builtins.md#top) · [Русский](../../ru/reference/builtins.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/reference/builtins)**

← Anterior: [Funciones de cálculo](./compute.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Catálogo de identificadores](./identifiers.md#top) →

---

# Secuencias integradas

TDC crea unas cuantas secuencias de forma automática — están disponibles sin declararlas
en `<env>`. Por convención sus nombres empiezan con un guion bajo. Se usan en la
[interpolación](../core-concepts/output-formatting.md#top) (`${{_count}}`) y en las
expresiones `if` (`if="_first"`).

Muchas veces no se necesitan los datos del registro sino su **lugar dentro del conjunto**:
qué número le toca, si es el primero o el último, cuántos hay en total. TDC calcula todo
eso y lo deja en cuatro nombres listos para usar.

## La lista

| Nombre   | Valor                                                                |
| :------- | :------------------------------------------------------------------- |
| `_count` | El número del registro actual, **empezando en 1**                    |
| `_first` | `"true"` en el primer registro, `"false"` en los demás               |
| `_last`  | `"true"` en el último registro, `"false"` en los demás               |
| `_total` | La cantidad total de registros (lo mismo que `count`), en cada fila   |

> [!NOTE]
> **Cadenas, no booleanos**
>
> `_first` y `_last` son las cadenas `"true"` / `"false"`, no booleanos — y es a propósito,
> para que `${{_last}}` se imprima como la palabra legible `"false"` (cómodo para
> `"isLast": ${{_last}}` en JSON) mientras que `if="!_last"` la sigue leyendo bien como falso.

## Los cuatro a la vez

```xml
<block>
    <line><data>_count=${{_count}}  _first=${{_first}}  _last=${{_last}}  _total=${{_total}}  ${{Name}}</data></line>
</block>
```

`./run demo.tdc`

```
_count=1  _first=true  _last=false  _total=5  Raimundo
_count=2  _first=false  _last=false  _total=5  Marcial
_count=3  _first=false  _last=false  _total=5  Aurelio
_count=4  _first=false  _last=false  _total=5  Basilio
_count=5  _first=false  _last=true  _total=5  Anselmo
```

`_count` va de `1..5`, `_total` vale `5` en cada fila, `_first` es verdadero solo en el
primer registro y `_last` solo en el último.

## Usos comunes

**Numeración** — `${{_count}} de ${{_total}}: ${{Name}}`.

**JSON sin coma colgante** — un segundo `<data if="!_last">,` pone una coma en todos los
registros menos el último:

```xml
<line><data>{"id": ${{_count}}, "name": "${{Name}}"}</data><data if="!_last">,</data></line>
```

`./run demo.tdc`

```
{"id": 1, "name": "Raimundo"},
{"id": 2, "name": "Marcial"},
{"id": 3, "name": "Aurelio"},
{"id": 4, "name": "Basilio"}
```

**Un encabezado solo en el primer registro** — `<line if="_first"><data>=== START ===</data></line>`.

**Resaltar la segunda mitad** — los valores integrados funcionan dentro de la aritmética
de expresiones, así que `if="_count * 2 > _total"` se vuelve verdadero en cuanto el número
pasa la mitad.

## Dentro de una línea con `each=`: `_item` y `_item_id`

Una línea [`<line each="List">`](../reference/attributes.md#top) se repite una vez por cada
elemento de una lista, y allí hay dos valores integrados más — **solo allí**; el patrón
completo está en [Tablas relacionales](../constructs/relational-tables.md#top):

| Nombre       | Valor                                                                          |
| :----------- | :----------------------------------------------------------------------------- |
| `_item`      | La posición **dentro de esta tarjeta** — `1`, `2`, `3`, reiniciando cada una    |
| `_item_id`   | Un número **único en todo el run** — una clave primaria lista para usar          |

Existen solo en una línea con `each=`; en una línea común no nombran nada.

## Nombres reservados

No les ponga el prefijo `_` a sus propias secuencias — está reservado. No se puede tapar
un valor integrado; TDC se niega a arrancar y le dice qué nombres están tomados:

`./run bad.tdc`

```
error[TDC033]: sequence name "_count" collides with a builtin
note: Builtins: _count, _first, _last, _total. Pick a different name.
```

## Vea también

- **[Salida y formato](../core-concepts/output-formatting.md#top)** — interpolación e `if`.

---

← Anterior: [Funciones de cálculo](./compute.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Catálogo de identificadores](./identifiers.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/reference/builtins)**
