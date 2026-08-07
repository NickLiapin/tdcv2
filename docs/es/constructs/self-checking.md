<a name="top"></a>

[English](../../constructs/self-checking.md#top) · [Русский](../../ru/constructs/self-checking.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/constructs/self-checking)**

← Anterior: [Unicidad (uniq, distinct)](./unique-values.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Descripción general](../compute/overview.md#top) →

---

# `<assert>` — una configuración que comprueba su propia salida

**Úsalo cuando** la forma de los datos le importa a quien los recibe y prefieres que la
ejecución se detenga antes que entregar un fichero que se ha desviado en silencio.

Una aserción declara una propiedad que la ejecución terminada debe cumplir. Si se cumple,
no pasa nada. Si no, la ejecución se detiene con tu propia frase, antes de escribir una
sola línea.

```xml
<assert that="Tracked == 700" says="cada pedido enviado debe llevar número de seguimiento"/>
```

Vive en `<env>`, junto a [`<uniq>` y `<distinct>`](unique-values.md#top), porque como ellos
dice algo sobre la ejecución entera y no sobre una columna.

## Qué merece la pena afirmar

No lo que la configuración ya dice. Escribiste `percent="70"` y afirmas el 70 por ciento:
has comprobado que TDC sabe contar.

El valor está en lo que la configuración **no** dice. Aquí un filtro y una condición se
acumulan, y la proporción que llega al fichero no aparece en ningún sitio del texto:

```xml
<tdc>
  <env count="1000" seed="orders" local="en">
    <sequence name="Status"><gen type="text" value="shipped,pending" percent="70,30"/></sequence>
    <sequence name="Tracking" parent="Status.shipped">
      <gen type="regex" value="[A-Z]{2}[0-9]{9}" if="Status == 'shipped' && _count % 4 != 0"/>
    </sequence>
    <sequence name="Tracked"><gen type="stat" of="Tracking" op="count"/></sequence>

    <assert that="Tracked == 700" says="every shipped order should carry a tracking number"/>
  </env>
  <block>
    <line><data>${{Status}},${{Tracking}}</data></line>
  </block>
</tdc>
```

`./run orders.tdc`

```
tdcv2: assert failed: every shipped order should carry a tracking number
  Tracked == 700   with Tracked = 522
```

Nada más en TDC tiene una opinión sobre esta configuración. Se analiza, se valida, se
ejecuta, y 178 pedidos enviados salen con el número de seguimiento vacío. Ese es
exactamente el fallo para el que existe una aserción.

El código de salida es 1, así que CI se detiene ahí.

## De un vistazo

| Atributo | Obligatorio | Qué hace                                                        |
| :------- | :---------- | :--------------------------------------------------------------- |
| `that`   | sí          | La condición, en el mismo lenguaje que [`if=`](../reference/expressions.md#top) |
| `says`   | sí          | La frase que recibe quien lee cuando la condición no se cumple    |

Ambos son obligatorios. Una aserción que salta mostrando solo su expresión obliga a quien
la lee a reconstruir, meses después y en un log de CI, para qué estaba.

**No hay bandera.** Una aserción se ejecuta porque está escrita: una comprobación que hay
que recordar activar es una comprobación que nadie ejecutó, sobre una configuración que
parece verificada.

## De dónde salen los números

`that=` lee columnas, y las que suele merecer la pena leer son
[`<gen type="stat">`](../generators/stat.md#top): un número para toda la ejecución.

```xml
<env count="500" seed="clinic" local="en">
    <sequence name="Visit"><gen type="date" from="2026-01-01" to="2026-06-30" format="YYYY-MM-DD"/></sequence>
    <sequence name="Follow"><gen type="date" of="Visit" plus="7..30d" format="YYYY-MM-DD"/></sequence>
    <sequence name="Ward"><gen type="text" value="A,B,C" percent="50,30,20"/></sequence>

    <sequence name="Rows"><gen type="stat" of="Visit" op="count"/></sequence>
    <sequence name="Wards"><gen type="stat" of="Ward" op="count"/></sequence>

    <assert that="Rows == _total" says="cada fila tiene fecha de visita"/>
    <assert that="Wards == _total" says="cada fila tiene planta"/>
</env>
```

`_total` es el número de filas, y es el único valor interno que una aserción puede leer.

## La regla que la mantiene honesta

**Cada nombre en `that=` debe ser el mismo en todas las filas.** Una columna `stat` lo es
por construcción. Una columna `text` de un solo valor lo es de hecho. Una columna sorteada
no lo es, y se rechaza:

```xml
<sequence name="Amount"><gen type="number" value="1..500"/></sequence>
<assert that="Amount > 0" says="every amount is positive"/>
```

`./run amounts.tdc`

```
tdcv2: assert ("Amount > 0"): "Amount" is not the same on every row, so this would have checked the first row and called the run verified. An assertion reads whole-run values: give it a <gen type="stat" of="Amount" op="…"/> column, or _total.
```

Sin esta regla, `that="Amount > 0"` leería la fila 0 e informaría sobre una fila de
quinientas: una comprobación que pasó porque apenas miró, con una etiqueta que dice
«verificado». Esa es justo la enfermedad que esta función viene a curar.

Una columna que un filtro `parent=` deja **vacía** en parte de las filas se rechaza por lo
mismo: la ejecución no tiene un valor único para ella, y la condición compararía contra lo
que la fila 0 tuviera por casualidad. Resúmela con `op="count"`.

## Lo que todavía no hace

- **Aserciones por fila** («cada importe es positivo»). Es otra función: necesita un
  recorrido por filas y un informe que nombre las filas que fallan, no un solo número.
- **Afirmar un dígito de control.** Ahí está la trampa: lo calculó
  [`<compute>`](../compute/overview.md#top), y recalcularlo solo afirma que el mismo código
  está de acuerdo consigo mismo.

## Motores

Una aserción lee columnas `stat`, y `stat` ya envía la configuración al motor en memoria.
Así que las aserciones no añaden consecuencias de motor propias; véase
[salidas grandes](../guides/large-outputs.md#top).

## Véase también

- [`stat`](../generators/stat.md#top) — de dónde salen los números
- [Expresiones](../reference/expressions.md#top) — el lenguaje en el que se escribe `that=`
- [Unicidad](unique-values.md#top) — las otras declaraciones sobre la ejecución entera

---

← Anterior: [Unicidad (uniq, distinct)](./unique-values.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Descripción general](../compute/overview.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/constructs/self-checking)**
