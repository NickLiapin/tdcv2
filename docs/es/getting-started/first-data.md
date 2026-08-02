<a name="top"></a>

[English](../../getting-started/first-data.md#top) · [Русский](../../ru/getting-started/first-data.md#top) · **Español**

← Anterior: [Instalación](./installation.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Estructura de la configuración](../core-concepts/configuration.md#top) →

---

# Su primer conjunto de datos

Los datos de prueba hacen falta a cada rato: para poblar una base de datos antes de
una demo, para mover una prueba de carga, para revisar una exportación a CSV, para
mostrarle una tabla a un cliente. Escribirlos a mano es lento y el resultado sale
desbalanceado y previsible. Los generadores de datos falsos de siempre entregan
valores sueltos, pero lo difícil es coserlos en un registro **coherente**: un nombre
que corresponda al género, una ciudad que corresponda al país.

TDC le da vuelta al problema: se **describe** de qué se compone una fila y el motor
arma tantas filas **verosímiles** y **reproducibles** como se quieran. El mismo
`seed` siempre entrega la misma salida, que es justo lo que conviene tanto para las
pruebas como para los ejemplos de la documentación. La forma de la salida —texto
plano, CSV, JSON, SQL— la define usted con una plantilla de fila.

Esta página es un «Hola, TDC» de tres minutos. Va a escribir una configuración
pequeña, ejecutarla y ver una salida reproducible; después dará un paso más hacia la
función estrella de TDC, los campos dependientes.

## Paso 1 — Escribir la configuración más simple

Cree un archivo `demo.tdc`:

```xml
<tdc>
    <env count="3" seed="demo">
        <sequence name="Name">
            <gen type="text" value="Ana,Beatriz,Carlos,Diego,Elena"/>
        </sequence>
        <sequence name="Age">
            <gen type="number" value="18..65"/>
        </sequence>
    </env>

    <block>
        <line><data>${{Name}}, edad ${{Age}}</data></line>
    </block>
</tdc>
```

Qué hace cada parte:

- [`<env>`](../core-concepts/configuration.md#top) con `count="3"` — generar **3**
  filas; `seed` fija la aleatoriedad para que el resultado
  [se repita](../core-concepts/determinism.md#top) de una ejecución a otra.
- [`<sequence>`](../core-concepts/sequences.md#top) — una **columna** de datos; el
  [`<gen>`](../generators/overview.md#top) que lleva adentro dice de dónde salen sus
  valores (aquí, un nombre al azar de una lista).
- [`type="text"`](../generators/text.md#top) — elegir un valor de una lista separada
  por comas.
- [`type="number"`](../generators/number.md#top) con `value="18..65"` — un número al
  azar dentro de un rango.
- [`<block>`](../core-concepts/output-formatting.md#top) / `<line>` / `<data>` — la
  **plantilla de una fila de salida**; `${{Name}}` sustituye el valor de esa columna.

## Paso 2 — Ejecutarla

La forma más rápida, desde la raíz del repositorio:

```bash
./run demo.tdc        # ejecuta cualquier archivo propio
```

Por debajo, eso es el CLI del motor. La forma completa es:

```bash
node typescript/dist/cli/main.js demo.tdc
```

Una vez publicado el paquete, también se podrá ejecutar desde cualquier lugar:

```bash
npm install -D tdcv2
npx tdcv2 demo.tdc
```

Si el motor todavía no está compilado (no existe la carpeta `typescript/dist`),
compílelo una vez. Todo esto se explica en [Instalación](installation.md#top).

## Paso 3 — Mirar la salida

Como `seed="demo"` fija la aleatoriedad, la salida es la misma en cada ejecución:

`./run demo.tdc`

```
Elena, edad 59
Diego, edad 18
Carlos, edad 53
```

> [!IMPORTANT]
> Los nombres y números exactos son ilustrativos: pueden cambiar de una versión del
> núcleo a otra. Lo que cuenta es que el mismo seed siempre reproduce la misma salida
> para un núcleo dado.

### Sobrescribir count y seed desde la línea de comandos

La cantidad de filas y el seed se pueden cambiar sin tocar el archivo. Resulta
práctico cuando la configuración está fija (por ejemplo, versionada en un
repositorio) pero para una corrida puntual se necesita otro volumen u otro sorteo
aleatorio:

```bash
./run demo.tdc --count 5 --seed alt
```

`./run demo.tdc --count 5 --seed alt`

```
Ana, edad 20
Beatriz, edad 48
Carlos, edad 65
Elena, edad 22
Diego, edad 22
```

Un seed nuevo da un conjunto distinto, pero igual de reproducible: vuelva a
ejecutar con `--seed alt` y obtendrá otra vez exactamente estas cinco filas. La
lista completa de banderas está en la [referencia del CLI](../reference/cli.md#top).

## Un paso más — campos dependientes

La función estrella de TDC es que los campos pueden **depender** unos de otros. Aquí
el nombre se toma de una lista masculina o femenina según el género (el atributo
`parent`), y `${{_count}}` es el número de fila:

```xml
<tdc>
    <env count="5" seed="demo">
        <sequence name="Gender">
            <gen type="text" value="Hombre,Mujer" percent="50,50"/>
        </sequence>

        <sequence name="MaleName" parent="Gender.Hombre">
            <gen type="template" value="person.male.firstName"/>
        </sequence>

        <sequence name="FemaleName" parent="Gender.Mujer">
            <gen type="template" value="person.female.firstName"/>
        </sequence>

        <sequence name="Age">
            <gen type="number" value="18..80"/>
        </sequence>
    </env>

    <block>
        <line><data>${{_count}}. ${{Gender}} — ${{MaleName}}${{FemaleName}}, edad ${{Age}}</data></line>
    </block>
</tdc>
```

`./run people.tdc`

```
1. Hombre — John, edad 72
2. Hombre — James, edad 18
3. Mujer — Elizabeth, edad 64
4. Mujer — Mary, edad 26
5. Hombre — Robert, edad 32
```

Aquí hay dos cosas nuevas:

- [`percent="50,50"`](../generators/text.md#top) hace que el generador
  [`text`](../generators/text.md#top) reparta más o menos mitad y mitad entre `Hombre`
  y `Mujer`, en lugar de elegir de manera uniforme.
- [`type="template"`](../generators/template.md#top) con `value="person.male.firstName"`
  saca un nombre de pila real de los datos integrados `person.*`, resueltos según el
  locale activo, de modo que serán nombres en inglés con el `en` por
  omisión.

`MaleName` se llena solo para los hombres y `FemaleName` solo para las mujeres, así
que `${{MaleName}}${{FemaleName}}` siempre entrega exactamente un nombre acorde al
género: los dos campos nunca se desfasan. Esta es la idea central, tratada a fondo
en [Dependencias jerárquicas](../guides/hierarchical-dependencies.md#top).

## Usar TDC desde su código

La configuración es idéntica en todos los lenguajes; lo único que cambia es la
llamada desde el lenguaje anfitrión.

#### TypeScript

```typescript
import { TDC } from "tdcv2";

const data = new TDC({ configFile: "demo.tdc" });
console.log(data.toString());
```

#### Python

```python
from tdcv2 import TDC

data = TDC(config_file="demo.tdc")
print(data.to_string())
```

#### Java

```java
var data = new TDC("demo.tdc");
System.out.println(data.toString());
```

#### C#

```csharp
var data = new Tdc("demo.tdc");
Console.WriteLine(data);
```

#### Rust

```rust
let data = tdcv2::Tdc::from_file("demo.tdc")?;
println!("{data}");
```

> [!NOTE]
> Las cinco implementaciones están terminadas y producen los mismos bytes; la
> referencia con la que se comparan las demás es TypeScript. Cada una tiene su página:
> [TypeScript](../bindings/typescript.md#top), [Python](../bindings/python.md#top),
> [Java](../bindings/java.md#top), [C#](../bindings/csharp.md#top),
> [Rust](../bindings/rust.md#top).

## Qué sigue

- **[Estructura de la configuración](../core-concepts/configuration.md#top)** — `<tdc>`, `<env>` y cómo se organiza una configuración.
- **[Dependencias jerárquicas](../guides/hierarchical-dependencies.md#top)** — la función estrella.
- **[Valores de plantilla](../generators/template.md#top)** — `person.*`, `date.*`, `location.*` y el resto de los datos integrados.
- **[Referencia del CLI](../reference/cli.md#top)** — la línea de comandos completa, las etiquetas, los atributos y los generadores.

---

← Anterior: [Instalación](./installation.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Estructura de la configuración](../core-concepts/configuration.md#top) →
