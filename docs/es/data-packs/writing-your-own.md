<a name="top"></a>

[English](../../data-packs/writing-your-own.md#top) · [Русский](../../ru/data-packs/writing-your-own.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/data-packs/writing-your-own)**

← Anterior: [Catálogo](./catalogue.md#top) · **[Contenido](../README.md#top)** · Siguiente: [CLI](../reference/cli.md#top) →

---

# Cómo crear su propio paquete

El paquete más simple es un archivo plano, un valor por línea, direccionado por su ruta
(vea [Descripción general](overview.md#cómo-se-forma-la-dirección)). A partir de ahí, un
**encabezado** desbloquea listas ponderadas, archivos externos y pequeños generadores,
todo sin tocar el código del motor y todo seguro de compartir, porque un paquete no es
más que datos o un DSL analizado y aislado.

Las salidas de ejemplo de abajo son **ilustrativas**: los valores exactos dependen de la
semilla y pueden cambiar entre versiones del núcleo. Lo que sí está garantizado —el
determinismo por semilla y las proporciones exactas— se señala donde importa.

## El encabezado

Ponga los campos entre dos líneas `---` al principio del archivo. Todos son opcionales:

| Campo         | Significado                                                                           |
| :------------ | :------------------------------------------------------------------------------------ |
| `description` | Una descripción para humanos: «qué es esto»                                           |
| `address`     | Una dirección explícita, que anula la calculada a partir de la ruta                   |
| `locale`      | El idioma (`en`, `es`, `ru`…) — y el segmento de locale que le falta a una ruta plana |
| `file`        | Apuntar a un archivo de datos externo en vez de un cuerpo integrado                   |
| `column`      | Con `file`: tomar una columna con nombre o número de un CSV ajeno                     |
| `delimiter`   | Con un CSV en `file`, o con un cuerpo ponderado: el separador (por omisión `,`)       |
| `weight`      | Con `file`: la columna de frecuencia que vuelve ponderado el paquete                  |
| `weighted`    | `true` — el cuerpo son líneas `valor,peso`                                            |
| `generator`   | `tdc` — el cuerpo es un [`<gen>`](../generators/overview.md#top), no una lista           |
| `inject`      | Un marcador de interpolación propio para el generador                                 |

Cada uno de estos se explica abajo, con una configuración y su salida.

## Paquetes ponderados — la frecuencia sale de los datos

Un paquete plano se elige de manera **uniforme**: `Smith` tan seguido como `Zabrowski`.
La vida real no es así: más de 2,4 millones de estadounidenses se apellidan `Smith`. Un
paquete ponderado arregla esto, y lo hace **con exactitud**, repartiendo las frecuencias
con el método de Hamilton (el del resto mayor), la misma garantía que
[`percent`](../generators/text.md#proporciones-exactas-con-percent). Hay dos maneras de
suministrar los pesos.

### Cuerpo integrado — `weighted: true`

Ponga `weighted: true` y escriba cada línea como `valor,peso`:

```text
---
description: Apellidos de EE. UU., ponderados (Censo de 2010)
weighted: true
---
Smith,2442977
Johnson,1932812
Williams,1625252
…
```

(El pack `en` real trae las 1000 primeras del censo; tres líneas bastan para mostrar la
forma.)

Se llama igual que cualquier paquete: nada cambia en la configuración.

```xml
<sequence name="Last">
    <gen type="template" value="person.lastName"/>
</sequence>
```

A lo largo de 100 000 filas, cada apellido aparece en proporción a su conteo: `Smith`
unas 2000 veces, el 2,02 % que su peso representa entre esas mil:

`./run surnames.tdc (100 000 filas)`

```
Smith      2022
Johnson    1599
Williams   1345
```

Use esta forma cuando la lista sea corta y quiera los pesos justo al lado de los valores.

### CSV externo — `file:` + `weight:`

Cuando la lista es grande y vive por su cuenta, apúntele con `file:` y nombre la columna
de frecuencia con `weight:` (y la columna de valores con `column:`):

```text
---
description: Apellidos de EE. UU., ponderados (Censo de 2010)
file: ../../../sources/us/person/lastName.csv
column: name
weight: count
---
```

La llamada desde la configuración es idéntica: el cambio en el encabezado es invisible
para la configuración.

```xml
<gen type="template" value="person.lastName"/>
```

Use esta forma para referirse a un CSV grande de censo o de catálogo sin copiarlo dentro
del paquete.

Las proporciones son exactas en **ambos** motores: tanto en el de streaming, que es el de
por omisión, como en `mode="memory"`. Un peso es un **entero no negativo** (un conteo
crudo, no un porcentaje); una celda de peso vacía (`Smith,`) es un error, no un cero
silencioso; un `0` deliberado excluye el valor.

### Valores que contienen comas — `delimiter:`

Si sus valores son frases que a su vez llevan comas (notificaciones, oraciones), un
separador de coma las despedazaría. Ponga `delimiter:` en cualquier carácter o en un
alias (`tab`, `semicolon`, `pipe`):

```text
---
weighted: true
delimiter: @
---
Su pedido, listo para recoger, ya fue enviado@100
Mensaje nuevo, marcado como urgente@50
```

El corte se hace en el **último** delimitador de la línea, así que las comas dentro de un
valor sobreviven:

`./run notices.tdc (30 filas)`

```
Su pedido, listo para recoger, ya fue enviado
Su pedido, listo para recoger, ya fue enviado
Su pedido, listo para recoger, ya fue enviado
Mensaje nuevo, marcado como urgente
```

Ese mismo `delimiter:` también fija el separador de columnas de un CSV externo en `file:`.

## Generadores dentro de un paquete — `generator: tdc`

Un paquete puede devolver un **generador** en vez de una lista; entonces la dirección
entrega un valor _calculado_. Está escrito en el DSL propio de TDC, así que no hay nada
nuevo que aprender. Ponga `generator: tdc` en el encabezado; el cuerpo es un
[`<gen>`](../generators/overview.md#top). Aquí, la placa de vehículo mexicana — el formato
nacional de auto particular `LLL-NN-NN`, más el formato antiguo `NNN-LLL` que sigue
circulando:

```text
---
address: mexico.vehicle.plate
description: Placa de vehículo de México
generator: tdc
locale: es
---
<gen type="regex" value="([A-Z]{3}-[0-9]{2}-[0-9]{2}|[0-9]{3}-[A-Z]{3})"/>
```

Se llama exactamente igual que una plantilla respaldada por una lista:

```xml
<gen type="template" value="mexico.vehicle.plate"/>
```

`./run plates.tdc`

```
993-ZLK
294-EVY
625-RBW
```

Corre sobre el mismo motor que su configuración, así que se mantienen todas las garantías
(determinismo, portabilidad a los futuros runtimes de Python y Java) y es **seguro**
incluso descargado: un DSL analizado y limitado, sin acceso al sistema. Nombre los
archivos de generador con `.tdc` (los de datos se quedan en `.txt`) para distinguirlos de
un vistazo; el nombre del archivo es el último segmento de la dirección
(`plate.tdc` → `…plate`).

### Armar a partir de los datos

Un generador puede traer listas de datos vecinas por su dirección y construir un valor a
partir de ellas. El cuerpo es una **secuencia compuesta** (las traídas de datos,
nombradas a través del punto) más un
[`<data>`](../core-concepts/output-formatting.md#top) que dice qué devolver.

Los nombres se resuelven en inglés bajo el locale `en` por omisión. Este ejemplo pone
`locale: es` a propósito para mostrar una convención de nombres que el inglés no tiene:
un nombre completo español de dos nombres de pila y dos apellidos:

```text
---
description: Nombre completo masculino en español
generator: tdc
locale: es
---
<sequence name="p">
  <distinct>
    <gen name="f1" type="template" value="es.person.male.firstName"/>
    <gen name="f2" type="template" value="es.person.male.firstName"/>
  </distinct>
  <distinct>
    <gen name="l1" type="template" value="es.person.lastName"/>
    <gen name="l2" type="template" value="es.person.lastName"/>
  </distinct>
</sequence>
<data>${{p.f1}} ${{p.f2}} ${{p.l1}} ${{p.l2}}</data>
```

`./run es-fullname.tdc`

```
Amancio Venancio Buendía Prado
Genaro Sergio Otero Medina
Germán Liborio Villalba Roa
```

Los datos (`firstName`, `lastName`) viven en sus propios archivos; el generador solo los
compone. La etiqueta [`<distinct>`](../constructs/unique-values.md#top) dice que las dos
extracciones de una misma lista deben **diferir** dentro de una fila; de lo contrario,
dos extracciones independientes podrían coincidir en `Juan Juan`.

Este no es un ejemplo inventado: es el paquete que trae TDC en
`data/packs/es/person/male/fullName.tdc`, y puede llamarlo hoy mismo con
`<gen type="template" value="es.person.male.fullName"/>`.

### Porcentajes exactos dentro de un generador — `<mix>` + `percent`

Un [`<mix>`](../reference/tags.md#distribuciones-y-selección) con `percent` funciona
dentro de un generador, y el reparto es **exacto** por conteo de filas. Por ejemplo, el
60 % de las personas recibe **dos** apellidos y el 40 % recibe **uno**:

```text
---
description: Apellido español — 60 % doble, 40 % simple
address: es.person.surname
generator: tdc
---
<mix name="s" percent="60,40">
  <case>
    <gen type="template" value="es.person.lastName"/>
    <data> </data>
    <gen type="template" value="es.person.lastName"/>
  </case>
  <case>
    <gen type="template" value="es.person.lastName"/>
  </case>
</mix>
<data>${{s}}</data>
```

`./run es-surname.tdc (100 filas)`

```
García Fernández
López
Martín Romero
Ruiz
```

A lo largo de 100 filas, exactamente 60 llevan dos apellidos y 40 llevan uno: la
proporción se reparte con Hamilton sobre todo el `count`, no al azar.

**Nota sobre el motor.** Esa proporción es una cuota sobre la columna entera, y ningún
motor de streaming puede repartirla de a una fila, así que una configuración que use este
paquete corre en el motor en memoria y su memoria crece con `count`. Un paquete sin
`percent=` no cuesta nada. Vea [Qué motor corre su
configuración](../guides/large-outputs.md#qué-motor-corre-su-configuración).

Dentro de un [`<case>`](../reference/tags.md#distribuciones-y-selección), arme el valor
con las etiquetas mismas ([`<gen>`](../generators/overview.md#top), y
[`<data>`](../core-concepts/output-formatting.md#top) para el texto literal entre ellas) en
vez de con `${{…}}`: interpolar otros campos dentro de un `case` todavía no está
soportado.

### Un marcador de interpolación propio — `inject:`

Si la **salida** de un generador tiene que contener un `${{ }}` literal (porque está
generando GitHub Actions, Handlebars o plantillas de Go), fije su propio marcador con
`inject:` (exactamente un `%` marca dónde va el nombre), para que la sustitución de TDC
no choque con su texto:

```text
---
address: common.ci.deploy_step
generator: tdc
inject: <<%>>
---
<sequence name="s"><gen name="env" type="text" value="prod,staging"/></sequence>
<data>  - run: deploy.sh --token ${{ secrets.TOKEN }} --env <<s.env>></data>
```

Aquí `<<s.env>>` es la sustitución de TDC, mientras que `${{ secrets.TOKEN }}` pasa
intacto. La línea producida (mostrada como bloque de código, ya que contiene
literalmente el marcador `${{ }}`):

```text
  - run: deploy.sh --token ${{ secrets.TOKEN }} --env prod
  - run: deploy.sh --token ${{ secrets.TOKEN }} --env staging
```

El marcador está **aislado**: no depende del `inject` de la configuración principal, así
que el mismo generador se comporta igual dondequiera que se conecte. Sin `inject:`, el
valor por omisión sigue siendo `${{%}}`.

### Un generador que llama a otro generador

Un generador puede referirse a **otro generador**, no solo a una lista: un «nombre
completo» puede apoyarse en un generador de «apellido» que a su vez decide si es simple o
doble. TDC verifica al cargar que **no haya ciclos** (A → B → A, o una autorreferencia) y
falla con `generator reference cycle: …` antes de generar, en lugar de recurrir sin fin.

> [!NOTE]
> **Qué se permite dentro de un generador**
>
> Ocho tipos de generador producen un valor por sí solos y se permiten en cualquier parte
> del cuerpo de un paquete: [`text`](../generators/text.md#top),
> [`number`](../generators/number.md#top), [`regex`](../generators/regex.md#top),
> [`advanced_regex`](../generators/advanced-regex.md#top),
> [`symbol`](../generators/symbol.md#top), [`date`](../generators/date.md#top),
> [`increment`](../generators/counters.md#top) y [`decrement`](../generators/counters.md#top).
> Dentro de un `<sequence>` también puede usar [`template`](../generators/template.md#top) para
> traer una lista de datos u otro generador por dirección, junto con la distribución
> [`<mix>`](../reference/tags.md#distribuciones-y-selección) / `percent`.
>
> Cualquier otra cosa se **rechaza por su nombre**: `file` resolvería una ruta relativa a
> nada en particular, y `http` pondría una llamada de red detrás de una dirección que parece
> una lista de palabras:
>
> ```text
> generator uses <gen type="http"> which is not allowed inside a pack generator
> ```
>
> `uniq=` y `order=` también se rechazan, aparezcan donde aparezcan en un paquete. Ambos
> describen **toda la columna** —qué valores pueden repetirse entre filas y en qué orden
> salen— y a un paquete se le pide un valor por fila, así que no tiene ni el recuento de
> filas ni las demás filas para responder. Decláre­los en la secuencia de la configuración
> que sortea del paquete. [`<distinct>`](#distinct--sin-repeticiones-dentro-de-una-fila) es
> otra cosa y sigue permitido: restringe campos entre sí *dentro* de una fila, algo que un
> paquete sí puede decidir por su cuenta.
>
> Las correlaciones complejas entre campos van en la configuración, no en el generador de un
> paquete.

## `<distinct>` — sin repeticiones dentro de una fila

Dos extracciones independientes de una misma lista a veces coinciden (`Saúl Saúl`).
Envuelva los campos (o las secuencias enteras) que deben **diferir dentro de una fila** en
[`<distinct>`](../constructs/unique-values.md#top):

```xml
<sequence name="pair">
    <distinct>
        <gen name="a" type="template" value="person.male.firstName"/>
        <gen name="b" type="template" value="person.male.firstName"/>
    </distinct>
</sequence>
```

`./run pair.tdc (local=es)`

```
Saúl y Esteban
Jonás y Eloy
Josué y Ladislao
```

`Saúl y Esteban` está bien; `Saúl y Saúl` nunca aparece. Ante una coincidencia, el
motor vuelve a extraer uno de los valores, y el determinismo por semilla se conserva.
Funciona tanto dentro de una [`<sequence>`](../core-concepts/sequences.md#top) (envolviendo
`<gen>`) como dentro de `<env>` (envolviendo secuencias enteras).

No lo confunda con [`uniq`](../constructs/unique-values.md#top): `uniq` impide que una fila
entera se repita a lo largo de **todo** el conjunto de datos (vertical); `<distinct>`
impide que los campos **de una misma fila** coincidan (horizontal). Ambos están
implementados y son independientes.

## Dónde van los paquetes propios

- El **conjunto integrado** viene en el repositorio, bajo `data/packs/`, y se escanea
  automáticamente al arrancar.
- **Sus propias carpetas** se agregan con la bandera de CLI `--data-path <carpeta>`
  (repetible) o con `dataPaths` de la biblioteca; vea
  [Instalar paquetes de datos](installing-packs.md#top).

## Errores y archivos ignorados

- **Dos archivos que reclaman una misma dirección** → `TDC170`, nombrando ambos
  archivos. Renombre o mueva uno.
- **Un archivo que no llega a ninguna dirección** — tiene cabecera, pero ni `address:`
  ni `locale:`, y el primer segmento de su ruta no es un locale, un país ni `common` →
  `TDC171`, una advertencia que nombra el archivo. Se omite, así que un `value=` que lo
  nombre luego falla con `TDC071`.
- **Un error de tecleo en una dirección** dentro de la configuración
  (`value="person.lastNam"`) → `TDC071` «unknown template path», lanzado antes de
  generar.
- Los archivos ocultos (los que empiezan con `.`), y `README` / `LICENSE` / `CHANGELOG`,
  son **ignorados** por el escáner.

## Todavía no

- **Autocompletado de direcciones** en el editor (a partir de las descripciones del
  encabezado) — es lo siguiente.
- Un **manifiesto de paquete** para una carpeta entera (licencia, autor, versión) —
  planeado.

## Vea también

- **[Descripción general](overview.md#top)** — direcciones y uso de los paquetes.
- **[Instalar paquetes de datos](installing-packs.md#top)** — `tdcv2 init` y `tdcv2 pack`.
- **[Datos coherentes y relacionales](../guides/coherent-data.md#top)** — padre → hijo por
  nombre.
- **[Valores únicos](../constructs/unique-values.md#top)** — `<distinct>` y `uniq` a fondo.

---

← Anterior: [Catálogo](./catalogue.md#top) · **[Contenido](../README.md#top)** · Siguiente: [CLI](../reference/cli.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/data-packs/writing-your-own)**
