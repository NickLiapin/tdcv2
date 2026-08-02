<a name="top"></a>

[English](../../generators/template.md#top) · [Русский](../../ru/generators/template.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/generators/template)**

← Anterior: [number](./number.md#top) · **[Contenido](../README.md#top)** · Siguiente: [File](./file.md#top) →

---

# El generador `template`

**Úselo cuando** necesite datos realistas «del mundo real» —nombres, fechas de
nacimiento, países— o identificadores técnicos —UUID, correos, IBAN, números
fiscales— que no quiera inventar a mano. `type="template"` saca el valor de una
fuente integrada; el atributo [`value`](../reference/attributes.md#top) es una **ruta con
puntos** que selecciona cuál, y muchas plantillas respetan el
[locale](../core-concepts/configuration.md#top).

Una ruta desconocida es un error de render: `unknown template path "..."`.

> [!NOTE]
> **Las salidas son ilustrativas**
>
> Los valores que se muestran en esta página vienen de un `seed` fijo, así que son
> reproducibles, pero las cadenas exactas pueden diferir entre versiones del núcleo.
> Tómelos como ejemplos de la *forma*, no como garantías.

## Por qué no una lista simple

Con [`text`](text.md#top) tendría que **escribir** los nombres a mano — una lista corta
que se repite y que no está localizada. `template` en cambio mete la mano en un
enorme conjunto integrado, en el idioma correcto, sin una sola línea de datos en su
configuración:

```xml
<sequence name="Manual"><gen type="text" value="Juan,María,Ana"/></sequence>
<sequence name="Tpl"><gen type="template" value="person.male.firstName"/></sequence>
```

`./run demo.tdc (local=es)`

```
manual=Juan    template=Enrique
manual=Ana     template=Elpidio
manual=Ana     template=Jairo
manual=María   template=Edmundo
manual=María   template=Isidro
```

La lista manual da vueltas sobre los mismos tres valores; la plantilla toma de un
conjunto integrado grande.

## Una persona completa y coherente

Varias plantillas juntas construyen un registro consistente: primero se saca el
género, y el nombre se toma de manera que coincida con él a través de
[`parent`](../core-concepts/sequences.md#top). La línea final se arma en un bloque
[`<data>`](../core-concepts/output-formatting.md#top):

```xml
<env count="6" seed="demo" local="es">
  <sequence name="Gender"><gen type="template" value="person.gender"/></sequence>
  <sequence name="Man" parent="Gender.Hombre">
    <gen name="First" type="template" value="person.male.firstName"/>
    <gen name="Last"  type="template" value="person.lastName"/>
  </sequence>
  <sequence name="Woman" parent="Gender.Mujer">
    <gen name="First" type="template" value="person.female.firstName"/>
    <gen name="Last"  type="template" value="person.lastName"/>
  </sequence>
  <sequence name="Bday">
    <gen type="template" value="person.b_day" youngest="18" oldest="70" format="DD.MM.YYYY"/>
  </sequence>
</env>
```

`./run person.tdc`

```
Mujer: Teodora Hoyos, 27.02.1986
Hombre: Omar Roldán, 29.11.2001
Mujer: Luz Tinoco, 25.07.1984
Hombre: Enrique Marcos, 19.08.1998
Hombre: Arnaldo Colmenares, 27.11.1981
Mujer: Diana Madrigal, 19.07.1970
```

Las filas masculinas reciben nombres masculinos y las femeninas nombres femeninos — y
nada de eso se escribió a mano. El resto de esta página recorre cada familia de
plantillas con salida real.

## Datos de personas

| Ruta                      | Produce                                            | Depende del locale |
| :------------------------ | :------------------------------------------------- | :----------------: |
| `person.male.firstName`   | Un nombre de pila masculino                        | `en`, `es`, `ru`   |
| `person.female.firstName` | Un nombre de pila femenino                         | `en`, `es`, `ru`   |
| `person.lastName`         | Un apellido (masculinos + comunes del locale)      | `en`, `es`, `ru`   |
| `person.male.diagnosis`   | Un diagnóstico masculino + los comunes             | `en`, `es`, `ru`   |
| `person.female.diagnosis` | Un diagnóstico femenino + los comunes              | `en`, `es`, `ru`   |
| `person.gender`           | Un género al azar; la etiqueta viene del locale    | `en`, `es`, `ru`   |
| `person.b_day`            | Una fecha de nacimiento en el formato dado         |   solo el formato  |

> [!NOTE]
> **Por qué `lastName` mezcla dos conjuntos**
>
> `person.lastName` combina los apellidos masculinos con los apellidos **comunes** del
> locale (los que comparten ambos géneros). En algunos locales esa distinción importa
> —los apellidos que se declinan tienen formas masculina y femenina separadas, mientras
> que los indeclinables son comunes—, así que el conjunto se arma a propósito de esta
> manera en vez de ser estrictamente «solo masculino».

### Nombres de pila — masculinos y femeninos

El mismo generador, una ruta por género:

```xml
<sequence name="M"><gen type="template" value="person.male.firstName"/></sequence>
<sequence name="F"><gen type="template" value="person.female.firstName"/></sequence>
```

`./run names.tdc (local=es)`

```
male=Jesús      female=Elisa
male=Agustín    female=Araceli
male=Elías      female=Amanda
male=Hugo       female=Patricia
male=Santiago   female=Daniela
male=Cosme      female=Josefina
```

Use dos rutas separadas cuando el género de la fila ya está fijo (como en el ejemplo
del registro coherente de arriba). Eche mano de un solo sorteo de
[`person.gender`](#persongender--una-etiqueta-que-depende-del-locale) primero cuando
quiera que el género mismo se elija al azar.

### Apellidos y diagnósticos

`person.lastName` y las rutas con género `person.*.diagnosis` funcionan igual: elija
la ruta y obtenga un valor del conjunto:

```xml
<sequence name="L"><gen type="template" value="person.lastName"/></sequence>
<sequence name="D"><gen type="template" value="person.male.diagnosis"/></sequence>
```

`./run patient.tdc (local=es)`

```
last=Cáceres     diagnosis=Criptorquidia
last=Valverde    diagnosis=Pancreatitis crónica
last=Zepeda      diagnosis=Criptorquidia
last=Coronado    diagnosis=Hiperplasia prostática benigna
last=Rodas       diagnosis=Fimosis
last=Godoy       diagnosis=Varicocele
```

Los conjuntos de diagnósticos tienen género por realismo —`person.female.diagnosis`
saca de una lista específica de mujeres mezclada con padecimientos comunes—, y por eso
siguen la misma división `male` / `female` que los nombres de pila. Úselos para
fixtures médicos sintéticos donde la etiqueta nada más tiene que *parecer* plausible,
no ser clínicamente exacta.

### `person.gender` — una etiqueta que depende del locale

`person.gender` no es una cadena fija `Male` / `Female`: devuelve la etiqueta de la
lista del locale activo (más o menos un reparto 50/50). Esas cadenas exactas son las
que se pasan como clave en [`parent`](../core-concepts/sequences.md#top), así que cambiar
de locale cambia la clave contra la que se hace la coincidencia:

```xml
<sequence name="Gender"><gen type="template" value="person.gender"/></sequence>
```

`./run gender.tdc (localización: es vs en vs ru)`

```
local="es"     local="en"     local="ru"
Mujer          Female         женщина
Mujer          Female         женщина
Mujer          Female         женщина
Hombre         Male           мужчина
Mujer          Female         женщина
Hombre         Male           мужчина
```

El sorteo es el mismo en las tres columnas — lo único que cambia es la etiqueta que
sale del paquete del locale. Con `local="es"` las claves son `Hombre` / `Mujer`, con
`local="en"` son `Male` / `Female` y con `local="ru"` son `мужчина` / `женщина`. Use
`parent="Gender.Hombre"` en el primer caso, `parent="Gender.Male"` en el segundo y
`parent="Gender.мужчина"` en el tercero.

### Localización — una ruta, tres idiomas

La dirección no cambia — lo único que cambia es
[`local`](../core-concepts/configuration.md#top) en `<env>`. Aquí está
`person.male.firstName` + `person.lastName` renderizado en español, en inglés y en
ruso, para mostrar la **misma configuración** produciendo salida localizada:

`./run names.tdc (localización: es vs en vs ru)`

```
local="es"           local="en"           local="ru"
Cirilo Cáceres       Michael Brown        Лев Гончар
Serafín Valverde     Robert Smith         Иван Дурново
Rogelio Zepeda       John Jones           Егор Дурново
Eduardo Coronado     David Williams       Антон Черных
Iván Rodas           William Garcia       Богдан Живаго
Ernesto Godoy        James Johnson        Валентин Кравчук
```

Las columnas en inglés y en ruso son una demostración de localización — el punto es
que una misma dirección se mapea al paquete de datos que el locale seleccione. `en`
es el predeterminado si no pone `local`.

## Ubicación

| Ruta               | Produce                | Depende del locale |
| :----------------- | :--------------------- | :----------------: |
| `location.country` | Un nombre de país      | las 9 locales      |

```xml
<sequence name="C"><gen type="template" value="location.country"/></sequence>
```

`./run country.tdc (local=es)`

```
Kirguistán
Islas Malvinas
Wallis y Futuna
Venezuela
Chipre
Kazajistán
```

El nombre sale en el idioma del locale activo — `Kirguistán` bajo `es`, `Kyrgyzstan`
bajo `en`, `Киргизия` bajo `ru`. Ojo: las tres listas **no** tienen el mismo largo (241
países en `en`, 237 en `es`, 115 en `ru`), así que un mismo seed no cae en el mismo país
en los tres locales; lo que se conserva es la reproducibilidad dentro de cada uno.

> [!NOTE]
> **Todavía faltan ciudades y regiones**
>
> Hoy la lista localizada llega hasta el **país**. Ciudades y regiones por locale están
> planeadas; mientras tanto, los paquetes de país las traen por su cuenta — por ejemplo
> [`mexico.geo.city`](../data-packs/overview.md#top) y `mexico.geo.state`.

## Fechas

Ambas plantillas de fecha comparten los tokens de formato (y los `L` / `LL` que
dependen del locale) del [generador `date`](date.md#formato-de-la-salida).

### `person.b_day` — una fecha de nacimiento

| Atributo   | Por omisión  | Descripción                                     |
| :--------- | :----------- | :---------------------------------------------- |
| `oldest`   | `80`         | Edad máxima, en años                            |
| `youngest` | `10`         | Edad mínima, en años                            |
| `format`   | `L`          | Formato de salida (formato de fecha de TDC)     |
| `local`    | del `<env>`  | Locale para los formatos localizados (`L`, `LL`) |

Úsela cada vez que un registro necesite una fecha de nacimiento acotada por edad — la
ventana `youngest` / `oldest` mantiene a todos dentro de una franja de edad creíble.

```xml
<gen type="template" value="person.b_day" youngest="18" oldest="65" format="YYYY-MM-DD"/>
```

`./run bday.tdc`

```
1999-11-18
1973-02-22
1999-04-15
1971-04-30
1986-06-17
1988-09-17
```

#### Nombres de mes localizados con `LL`

El formato `LL` escribe el mes como palabra en el idioma del locale — la fecha de
fondo es idéntica, lo único que cambia es cómo se escribe:

`./run bday.tdc (format=LL, localization: en vs ru)`

```
local="en"            local="ru"
November 18, 1999     18 ноября 1999 г.
February 22, 1973     22 февраля 1973 г.
April 15, 1999        15 апреля 1999 г.
April 30, 1971        30 апреля 1971 г.
June 17, 1986         17 июня 1986 г.
September 17, 1988    17 сентября 1988 г.
```

### `date.range` — una fecha de un rango

| Atributo  | Por omisión  | Descripción                                 |
| :-------- | :----------- | :------------------------------------------ |
| `range`   | —            | **Obligatorio.** `"YYYY.MM.DD - YYYY.MM.DD"` |
| `format`  | `L`          | Formato de salida                           |
| `local`   | del `<env>`  | Locale para los formatos localizados        |

Úsela para cualquier fecha que no sea de nacimiento —la fecha de un pedido, un
registro de alta, un evento—, donde quiera un sorteo uniforme entre dos límites
explícitos.

```xml
<gen type="template" value="date.range" range="2020.01.01 - 2025.12.31" format="DD.MM.YYYY"/>
```

`./run event.tdc`

```
08.12.2023
05.11.2020
23.02.2023
30.10.2024
03.08.2024
16.05.2020
```

La misma localización con `LL` aplica también aquí — cambie a `format="LL"` y el mes
se imprime como palabra en el locale activo (`December 8, 2023` con `en`,
`8 декабря 2023 г.` con `ru`).

## Identificadores técnicos

El mismo `type="template"` también construye **identificadores algorítmicos** — UUID,
correos, IBAN, números de tarjeta, números fiscales y de documentos con dígito
verificador. Dos reglas de nomenclatura:

- Los identificadores **globales** llevan el prefijo `common.` — `common.id.uuid`,
  `common.finance.iban`, `common.payment.card.pan`, `common.phone.e164`.
- Los **específicos de un país** empiezan con el nombre del país — `usa.docs.ssn`,
  `usa.tax.ein`, `brazil.tax.cpf`, `poland.docs.pesel`.

### Por qué esto no son solo dígitos al azar

La mayoría de los identificadores «con pinta de número» llevan un **dígito
verificador** calculado a partir del resto del número (Luhn, mod-11, ISO 7064, …).
Diez dígitos al azar reprueban la primerísima validación de formato, así que las
pruebas construidas sobre ellos no sirven de nada. Estas plantillas emiten valores que
**pasan su checksum** y que a la vez son deliberadamente no reales —rangos reservados
para pruebas, prefijos ficticios—, de modo que se pueden meter sin riesgo en demos,
fixtures y CI.

### IDs e internet

```xml
<gen type="template" value="common.id.uuid"/>
<gen type="template" value="common.id.ulid"/>
<gen type="template" value="common.internet.email"/>
<gen type="template" value="common.internet.ipv4"/>
<gen type="template" value="common.system.semver"/>
```

`./run ids.tdc`

```
common.id.uuid          b04b0159-d6a6-441f-b3cb-8941d2742bd0
common.id.ulid          609Q13BKAVCMD292YSS7RQ1HK9
common.internet.email   uak1benwm6@fixture-odkd82.test
common.internet.ipv4    192.168.102.101
common.system.semver    7.0.7
```

Los correos y dominios usan TLD reservados por la IANA (`.test`, `.invalid`,
`.example`) y las IP usan rangos privados, así que nada de aquí puede chocar con una
dirección real. También están disponibles: `common.id.nanoid`,
`common.id.object_id`, `common.internet.url`, `common.internet.mac`,
`common.internet.slug`, `common.internet.username`.

### Finanzas y pagos

```xml
<gen type="template" value="common.finance.iban"/>
<gen type="template" value="common.finance.bic"/>
<gen type="template" value="common.payment.card.pan"/>
<gen type="template" value="usa.finance.aba_routing"/>
```

`./run finance.tdc`

```
common.finance.iban       DE68702701363846402097
common.finance.bic        SAHTDENW5OW
common.payment.card.pan   4242420270136385
usa.finance.aba_routing   650270138
```

El IBAN lleva una verificación ISO 7064 mod-97 válida, el PAN de la tarjeta una
verificación Luhn válida dentro del rango de pruebas de Visa (`4242…`), y el número de
ruteo ABA una verificación mod-10 `[3,7,1]` válida — cada uno pasa la validación de
formato sin dejar de ser no real.

### Productos y dispositivos

```xml
<gen type="template" value="common.book.isbn13"/>
<gen type="template" value="common.product.ean13"/>
<gen type="template" value="common.device.imei"/>
<gen type="template" value="common.vehicle.vin"/>
```

`./run products.tdc`

```
common.book.isbn13     9790270136387
common.product.ean13   7027013638467
common.device.imei     702701363846407
common.vehicle.vin     0AK1BDNX8L5640209
```

También están disponibles: `common.book.isbn10`, `common.product.gtin14`,
`common.product.upc_a`, `common.periodical.issn`, `common.device.iccid`.

### Seguridad y hashes

```xml
<gen type="template" value="common.security.api_key"/>
<gen type="template" value="common.security.otp"/>
<gen type="template" value="common.security.sha256"/>
<gen type="template" value="common.git.sha"/>
```

`./run security.tdc`

```
common.security.api_key   tdc_i1Hk26NbKrPdP5H5xnmFlk3XbH5rBSI9
common.security.otp       702701
common.security.sha256    b04b01595d6a6141fcc3cb08941d2742bd0800d71700...
common.git.sha            b04b01595d6a6141fcc3cb08941d2742bd0800d7
```

También están disponibles: `common.security.jwt`, `common.security.md5`,
`common.security.sha1`, `common.security.totp_secret`.

### Números telefónicos

`common.phone.e164` elige un país al azar; cada país tiene además su propia ruta.
Todos emiten en forma E.164 y usan los rangos ficticios reservados para ficción y
pruebas (el área 202 de Estados Unidos con la central `555`, el `07700 900xxx` de la
Ofcom británica, …):

```xml
<gen type="template" value="usa.phone"/>
<gen type="template" value="common.phone.e164"/>
```

`./run phones.tdc`

```
usa.phone           +12025557027
usa.phone           +12025556829
common.phone.e164   +447700900829
common.phone.e164   +33670270136
```

### Números fiscales y de documentos nacionales

Cada país tiene su propia familia de números con dígito verificador. El conjunto de
Estados Unidos por sí solo cubre la mayoría de las necesidades comunes:

```xml
<gen type="template" value="usa.docs.ssn"/>
<gen type="template" value="usa.tax.ein"/>
<gen type="template" value="usa.tax.itin"/>
<gen type="template" value="usa.geo.zip"/>
```

`./run us-ids.tdc`

```
usa.docs.ssn   690070001
usa.tax.ein    750270136
usa.tax.itin   970620136
usa.geo.zip    77093
```

Hay decenas de países más disponibles con el mismo patrón — `mexico.docs.curp`,
`mexico.tax.rfc`, `mexico.finance.clabe`, `spain.docs.dni`, `brazil.tax.cpf`,
`poland.docs.pesel`, `germany.tax.vat`, `france.tax.siren`, y muchos otros:

```xml
<gen type="template" value="mexico.docs.curp"/>
<gen type="template" value="mexico.tax.rfc"/>
<gen type="template" value="mexico.finance.clabe"/>
<gen type="template" value="mexico.docs.nss"/>
```

`./run mx-ids.tdc`

```
mexico.docs.curp       PANP600906HCSDBT38
mexico.tax.rfc         REVM030514AW1
mexico.finance.clabe   103942461994603599
mexico.docs.nss        20419418189
```

La CURP lleva su dígito verificador mod-10 (pesos 18..2), la CLABE su verificación
mod-10 `[3,7,1]`, y el RFC su carácter de control mod-11 — igual que el resto, pasan la
validación de formato sin corresponder a ninguna persona real. El catálogo completo,
país por país, está en la [Referencia](../reference/generators.md#top).

### Parámetros

Muchos identificadores aceptan **parámetros**: se pasan como atributos comunes y
corrientes en [`<gen>`](../reference/tags.md#top). Cualquier parámetro que omita se saca
al azar; el que fije queda clavado en todas las filas. Por ejemplo, fijando el dominio
del correo:

```xml
<gen type="template" value="common.internet.email" domain="example.test"/>
```

`./run email.tdc`

```
uak1benwm6@example.test
j3k8iya414@example.test
p7m2nqx8v0@example.test
z0k4hya3c1@example.test
r5t9bd6l2e@example.test
```

Los generadores de país toman sus propios parámetros —un código de oficina fiscal, un
`sex`, un prefijo— y el dígito verificador siempre se recalcula para seguir siendo
válido. Cuáles parámetros acepta una ruta dada lo define el
[paquete de datos](../data-packs/overview.md#top) que está detrás: cada
`<sequence name="…">` local del paquete es un parámetro. Un parámetro equivocado es
un error claro (`TDC072`), nunca silencioso — TDC le dice qué acepta realmente esa
ruta.

> [!NOTE]
> **Variantes simplificadas**
>
> Cuando estos generadores se mudaron a paquetes editables, algunos parámetros poco
> usados y algunas variantes «con formato» (con corchetes o guiones) se redujeron a la
> forma simple. Los checksums y el formato base se conservan; lo único que se quitó fue
> la envoltura cosmética.

### Cómo se construyen los dígitos verificadores

La lógica del checksum no está escondida en código compilado: cada paquete calcula su
dígito verificador de forma **declarativa** con la etiqueta
[`<compute>`](../reference/compute.md#top), justo al lado de los datos. Si un país cambia
sus reglas, se edita el archivo de texto del paquete, no el motor. Vea
[Paquetes de datos](../data-packs/overview.md#top) para saber cómo está estructurado un
paquete.

## Dónde viven los datos de las plantillas

Hoy los conjuntos de plantillas vienen empaquetados con la biblioteca y se exponen a
través de las rutas integradas que se listaron arriba. El plan es poder cargar
*cualquier* archivo de datos de forma «declarativa» —con metadatos que describan qué
es, cómo está delimitado y qué clase lo parsea—, para que usted pueda registrar sus
propios conjuntos igual que están registrados los integrados. Hasta entonces, las
plantillas disponibles son exactamente las integradas que se documentan aquí.

## Vea también

- **[Date](date.md#top)** — los tokens de formato que usan estas plantillas de fecha.
- **[`<compute>`](../reference/compute.md#top)** — cómo se definen los checksums.
- **[Referencia: generadores](../reference/generators.md#top)** — el catálogo completo de identificadores.
- **[Paquetes de datos](../data-packs/overview.md#top)** — de dónde vienen los datos de las plantillas y cómo agregar los suyos.

---

← Anterior: [number](./number.md#top) · **[Contenido](../README.md#top)** · Siguiente: [File](./file.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/generators/template)**
