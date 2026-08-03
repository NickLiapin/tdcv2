<a name="top"></a>

[English](../../constructs/overview.md#top) · [Русский](../../ru/constructs/overview.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/constructs/overview)**

← Anterior: [Enlazar pools entre sí](../pools/linking.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Elegir entre valores (mix)](./mix.md#top) →

---

# Construcciones

Un [generador](../generators/overview.md#top) produce un valor. Una **construcción** decide
qué pasa alrededor de ese valor: _cuál_ se usa, _si_ aparece siquiera, _cuántos_ van en
una celda, si puede repetirse, y en cuántas filas se convierte un registro.

Esa es la lista completa. Seis construcciones; todo lo demás en TDC es o un generador, o
un lugar donde poner texto, o una forma de calcular algo a partir de valores que ya
tiene.

| Construcción          | La pregunta que responde                         |                                                    |
| :-------------------- | :----------------------------------------------- | :------------------------------------------------- |
| `<mix>`               | ¿Cuál de varias ramas — en proporciones exactas? | [Elegir entre valores](mix.md#top)                    |
| `<switch>`            | ¿Qué valor se deduce de otro campo?              | [Tablas de consulta](switch.md#top)                   |
| `if`                  | ¿Debe aparecer esta pieza?                       | [Condiciones](conditional-output.md#top)              |
| `repeat`              | ¿Cuántos valores van en una celda?               | [Varios valores en una celda](multiple-values.md#top) |
| `each`                | ¿Cuántas filas produce un registro?              | [Una fila por elemento](relational-tables.md#top)     |
| `uniq` · `<distinct>` | ¿Puede repetirse un valor — en la fila, o nunca? | [Unicidad](unique-values.md#top)                      |

Otras tres cosas se comportan como construcciones y están documentadas en otro lugar,
porque pertenecen a un tema mayor:

- **`<pool>`** — una fila que se refiere a un registro entero en vez de a un valor:
  treinta médicos, y una fila de paciente que recibe a uno de ellos completo. Creció
  hasta ser un tema propio, con [su propia sección](../pools/overview.md#top).

- **`parent`** — un valor tomado del subconjunto que eligió su padre. Es parte de cómo
  se relacionan las secuencias, así que vive con las
  [Secuencias](../core-concepts/sequences.md#top), y la versión aplicada está en
  [Dependencias jerárquicas](../guides/hierarchical-dependencies.md#top).
- **`<compute>`** — obtener un valor calculándolo en vez de sorteándolo. Es un pequeño
  lenguaje propio y tiene [su propia sección](../compute/overview.md#top).

## Cuatro de ellas en un solo config

Nada de esto es artificial: así se ve un config cuando las construcciones hacen el
trabajo. Un plan sorteado en proporciones fijas, un precio que se deduce del plan, un
número variable de etiquetas en una celda, y una palabra que solo aparece en las filas
de pago:

```xml
<env count="6" seed="tour">
  <mix name="Plan" percent="50,30,20">
    <case><gen type="text" value="free"/></case>
    <case><gen type="text" value="pro"/></case>
    <case><gen type="text" value="team"/></case>
  </mix>

  <switch name="Price" on="Plan">
    <map>free:0, pro:12, team:40</map>
  </switch>

  <sequence name="Tags">
    <gen type="text" value="api,web,cli,db" repeat="1..3" separator=";"/>
  </sequence>

  <sequence name="Id"><gen type="increment" value="1"/></sequence>
</env>

<block>
  <line>
    <data>${{Id}} ${{Plan}} $${{Price}} [${{Tags}}]</data>
    <data if="Price > 0"> paid</data>
  </line>
</block>
```

`./run tour.tdc`

```
1 free $0 [web;api]
2 free $0 [api;db;cli]
3 pro $12 [web] paid
4 free $0 [cli]
5 pro $12 [cli;api;db] paid
6 team $40 [db;web] paid
```

Compare la salida con el config y cada construcción se ve: tres `free` de seis son ese
`50` de `percent`; `$12` nunca aparece junto a `free`, porque `Price` no se sortea solo
sino que se deduce de `Plan`; la cantidad de etiquetas cambia por fila; y `paid` falta
exactamente donde el precio es cero.

## Adónde ir después

Las páginas de esta sección explican una construcción cada una, completa. Si está
aprendiendo el lenguaje, léalas en orden: se apoyan una en otra y los ejemplos dejan de
ser triviales poco a poco.

Cuando una construcción ya le resulte familiar, las
[Guías](../guides/hierarchical-dependencies.md#top) muestran qué construir con ellas:
registros coherentes, salida en CSV y SQL, formas estadísticas, valores atípicos,
huecos y conjuntos que no caben en memoria.

---

← Anterior: [Enlazar pools entre sí](../pools/linking.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Elegir entre valores (mix)](./mix.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/constructs/overview)**
