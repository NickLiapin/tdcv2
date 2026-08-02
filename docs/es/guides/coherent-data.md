<a name="top"></a>

[English](../../guides/coherent-data.md#top) · [Русский](../../ru/guides/coherent-data.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/guides/coherent-data)**

← Anterior: [Dependencias jerárquicas](./hierarchical-dependencies.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Sin repeticiones dentro de una fila](./distinct.md#top) →

---

# Datos coherentes y relacionales

Los generadores de datos falsos comunes llenan los campos de forma independiente, y así
salen pares imposibles: un `Fiat` con el modelo `Altima` (que es un Nissan), una ciudad
de un estado con un código postal de otro. TDC lo hace distinto.

El truco es simple: **la dirección de una plantilla puede interpolar el valor de otro
campo**. El padre nombra el archivo del que se saca el hijo:

```text
value="common.vehicle.model.${{Brand}}"
```

Si la marca sale `Fiat`, la dirección se vuelve `common.vehicle.model.Fiat`, y el modelo
se toma **del archivo de Fiat** — nunca un «Fiat Altima».

> [!NOTE]
> **Las salidas son ilustrativas**
>
> Los valores de abajo vienen de un `seed` fijo, así que son reproducibles, pero las
> cadenas y proporciones exactas pueden diferir entre versiones del core. Tómelos como
> ejemplos de la *forma*, no como garantías.

## Cómo se ve

Dos [secuencias](../core-concepts/sequences.md#top): una marca y un modelo. El modelo
declara [`parent="Brand"`](../core-concepts/sequences.md#top) (para que vea la marca
elegida) y la interpola en la dirección de la
[`template`](../generators/template.md#top) con `${{Brand}}`:

```xml
<tdc>
  <env count="5" seed="showroom" local="en">
    <sequence name="Brand"><gen type="template" value="common.vehicle.brand"/></sequence>
    <sequence name="Model" parent="Brand"><gen type="template" value="common.vehicle.model.${{Brand}}"/></sequence>
  </env>
  <block><line><data>${{Brand}} ${{Model}}</data></line></block>
</tdc>
```

`./run showroom.tdc`

```
Honda Passport
Nissan Ariya
Chevrolet Blazer
Toyota RAV4
Ford Maverick
```

Cada modelo pertenece a su marca. Y `common.vehicle.brand` es un pack **ponderado**
(Toyota es común, Maybach es raro), así que las marcas mismas aparecen también en
proporciones realistas — se obtienen pares coherentes *y* una mezcla de mercado creíble
en una sola configuración.

## Un hijo por padre — una cocina y su platillo

La misma forma sirve para cualquier par padre/hijo. Una cocina saca su propio platillo
(`food.cuisine` → `food.dishByCuisine.<cocina>`). **Conviene usarlo cuando** los dos
campos se verían absurdos si se sacaran de forma independiente: un «falafel coreano» no
convence a nadie:

```xml
<sequence name="Cuisine"><gen type="template" value="food.cuisine"/></sequence>
<sequence name="Dish" parent="Cuisine"><gen type="template" value="food.dishByCuisine.${{Cuisine}}"/></sequence>
```

`./run menu.tdc`

```
Lebanese: Falafel
Korean: Bulgogi
Indian: Rogan Josh
Chinese: Peking Duck
Greek: Souvlaki
```

## Un padre, varios hijos enlazados

Un mismo padre puede alimentar a **más de un** hijo. Cada hijo interpola el mismo valor
del padre en su propia dirección, así que todos los campos de la fila quedan
consistentes entre sí. Aquí un país (ponderado por población) saca tanto una capital
como una moneda:

```xml
<sequence name="Country"><gen type="template" value="geo.country"/></sequence>
<sequence name="Capital" parent="Country"><gen type="template" value="geo.capitalByCountry.${{Country}}"/></sequence>
<sequence name="Currency" parent="Country"><gen type="template" value="geo.currencyByCountry.${{Country}}"/></sequence>
```

`./run atlas.tdc`

```
China — Beijing — Renminbi
United States — Washington — US Dollar
India — New Delhi — Indian Rupee
Indonesia — Jakarta — Rupiah
China — Beijing — Renminbi
```

**Conviene usarlo cuando** varios campos dependen de la misma clave: partes de una
dirección que cuelgan de un estado, detalles de producto que cuelgan de una categoría,
datos organizacionales que cuelgan de un departamento. Declare cada hijo con el mismo
`parent` y todos leerán el único valor elegido.

## Cómo están acomodados los datos

El padre es una lista común y corriente; cada uno de sus valores tiene su **propio
archivo hijo**, nombrado exactamente con ese valor:

```text
data/packs/common/vehicle/
  brand.txt                 # las marcas (el padre)
  model/
    Toyota.txt              # modelos Toyota
    Fiat.txt                # modelos Fiat
    Mercedes-Benz.txt       # los nombres con guion o espacio también funcionan
```

La dirección del archivo es la ruta separada por puntos: `model/Fiat.txt` →
`common.vehicle.model.Fiat`. En la plantilla, `${{Brand}}` completa el nombre del
archivo y TDC encuentra la lista correcta. Para agregar una marca, coloque
`model/NewBrand.txt` y añada una línea a `brand.txt`. Ya vienen listos conjuntos
coherentes para marcas de autos, `food.cuisine`, `medical.specialtyCoherent`,
`work.industryCoherent`, `common.dev.languageCoherent`, `sport.sportCoherent` y
`geo.country`.

## Cosas que conviene recordar

- **El padre se declara antes que el hijo** — TDC materializa las
  [secuencias](../core-concepts/sequences.md#top) de arriba hacia abajo, así que
  `${{Brand}}` lee un valor ya calculado. Un hijo que interpola un campo definido *más
  abajo* no tiene nada que leer.
- **`parent="Brand"`** enlaza el hijo con el padre y fija el orden. Para una búsqueda
  simple eso basta; el filtrado más estricto sobre un valor *específico*
  (`parent="Brand.Fiat"`) se cubre en
  [Dependencias jerárquicas](hierarchical-dependencies.md#top).
- **Cada valor del padre necesita un archivo hijo que le corresponda**, o la dirección
  no se resolverá y saldrá un error. Por eso la lista del padre suele contener
  exactamente los valores que tienen archivo (como `common.vehicle.brand`).
- **Motor.** Una configuración así siempre corre en el motor en memoria (el único que
  resuelve una dirección por fila). Se trata de coherencia realista, no de generar
  gigabytes en streaming — vea [Salidas grandes](large-outputs.md#top) para la vía de
  streaming.

## El pariente CSV — `row` + `weight`

Cuando los campos relacionados viven en un solo **CSV** en vez de en archivos por valor,
enlácelos con [`row`](../generators/file.md#top): varios generadores
[`file`](../generators/file.md#top) con el mismo `row` leen la **misma línea** por
registro, así que los campos se mantienen en una sola fila de datos reales. Agregue
`weight` a uno de ellos para sacar esa línea según su frecuencia real:

```xml
<sequence name="Place">
  <gen name="City"  type="file" src="cities.csv" column="city"  row="loc" weight="population"/>
  <gen name="State" type="file" src="cities.csv" column="state" row="loc"/>
</sequence>
```

`./run cities.tdc`

```
Seattle, WA
Austin, TX
Chicago, IL
Seattle, WA
Denver, CO
```

Como ambos generadores comparten `row="loc"`, la ciudad y su estado nunca se separan en
registros distintos; `weight="population"` en la ciudad hace que los lugares más grandes
aparezcan con más frecuencia. Todos los detalles están en el
[generador File](../generators/file.md#top).

## Véase también

- **[Dependencias jerárquicas](hierarchical-dependencies.md#top)** — filtrar un hijo por un valor específico del padre.
- **[Secuencias](../core-concepts/sequences.md#top)** — declarar campos y el enlace `parent`.
- Los generadores **[Template](../generators/template.md#top)** y **[File](../generators/file.md#top)**.

---

← Anterior: [Dependencias jerárquicas](./hierarchical-dependencies.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Sin repeticiones dentro de una fila](./distinct.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/guides/coherent-data)**
