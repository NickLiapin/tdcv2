<a name="top"></a>

[English](../../getting-started/installation.md#top) · [Русский](../../ru/getting-started/installation.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/getting-started/installation)**

← Anterior: [Introducción](../intro.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Quick API — un valor a la vez](./quick-api.md#top) →

---

# Instalación

TDC está pensado para cinco ecosistemas — **npm** (Node.js / TypeScript), **pip**
(Python), **Maven** (Java), **NuGet** (.NET) y **Cargo** (Rust) —, y todos producen
exactamente la misma salida, byte por byte, a partir de la misma configuración, semilla,
versión y modo de salida (vea
[Determinismo y proporciones](../core-concepts/determinism.md#top)).

**Las cinco implementaciones están terminadas.** Comparten una gramática, un juego
de códigos de diagnóstico y una batería de fixtures que las obliga a producir los
mismos bytes: un gigabyte de salida desde la misma configuración sale idéntico en
cada una. Cada una lleva además la misma línea de comandos, así que ninguna
configuración necesita las herramientas de otro lenguaje para ejecutarse.

Elija abajo su ecosistema. Si solo quiere probar TDC sin comprometerse con un
lenguaje, use la pestaña de npm: incluye un wrapper de un solo comando que no
necesita nada de código.

#### Node.js — npm

**Requisitos:** Node.js **20.0.0** o más reciente.

```bash
npm install -D tdcv2
npx tdcv2 init
```

Esa es toda la instalación. `init` escribe un config y una carpeta `tdcv2-examples/`
con tres ejemplos trabajados, y al final imprime el comando que ejecuta el primero. Los
paquetes de datos `common`, `en` y el de EE. UU. vienen con el paquete, así que
funcionan sin descargar nada.

`npx` no es adorno: `npm install -D` deja el comando en `node_modules/.bin`, no en su
PATH. Los otros cuatro ecosistemas de abajo lo instalan como un comando de verdad, y
por eso allí los ejemplos dicen `tdcv2` a secas.

Si en cambio quiere trabajar sobre el motor mismo, ejecútelo desde una copia local
del repositorio. Compílelo una vez:

```bash
npm --workspace typescript run build
```

Después, cualquier configuración se ejecuta apuntando Node al CLI ya compilado:

```bash
node typescript/dist/cli/main.js tdcv2-examples/01-starter.tdc
```

En la raíz del repositorio también hay un wrapper de un solo comando, para no tener
que recordar esa ruta:

```bash
./run demo.tdc        # ejecuta cualquier archivo que se le indique
```

`./run` es la forma más rápida de ver la salida: indíquele un archivo y lea el
resultado en la terminal. Por debajo llama al mismo CLI. La lista completa de opciones — `--seed`, `--count`,
`--output`, `--locale` y las demás — está en la
[referencia del CLI](../reference/cli.md#top).

#### Python — pip

**Requisitos:** Python **3.10** o más reciente.

Un solo comando le da la biblioteca y el comando `tdcv2`:

```bash
pip install tdcv2
tdcv2 init
```

Eso es toda la configuración. Un juego inicial de paquetes de datos viaja dentro del
wheel, así que el ejemplo de arriba funciona sin instalar nada más.

El DSL y el comportamiento son idénticos a los de la versión de npm: la misma
configuración `.tdc`, ejecutada con el mismo `seed`, produce los mismos bytes. La API
está en [Bibliotecas por lenguaje — Python](../bindings/python.md#top).

#### Java — Maven

**Requisitos:** Java **17** o más reciente.

La biblioteca es una sola dependencia:

```xml
<dependency>
  <groupId>io.github.nickliapin</groupId>
  <artifactId>tdcv2</artifactId>
  <version>0.3.0</version>
</dependency>
```

Con Gradle, en `build.gradle.kts`:

```kotlin
implementation("io.github.nickliapin:tdcv2:0.3.0")
```

Un juego inicial de paquetes de datos viaja dentro del jar, así que el ejemplo de
arriba funciona sin instalar nada más.

**La línea de comandos es un artefacto aparte.** Maven no tiene equivalente del `bin`
de npm —añadir una biblioteca a un proyecto no pone ningún comando en su PATH—, así que
el CLI se distribuye como un único jar autónomo que no necesita más que un JDK. Vive en
las mismas coordenadas que la biblioteca y se distingue por el clasificador `cli`:

```bash
curl -LO https://repo1.maven.org/maven2/io/github/nickliapin/tdcv2/0.3.0/tdcv2-0.3.0-cli.jar
java -jar tdcv2-0.3.0-cli.jar init
```

Vale la pena un alias: `alias tdcv2='java -jar /ruta/a/tdcv2-cli.jar'`, y a partir de
ahí todos los comandos de estas páginas se leen igual que en cualquier otro sitio.

El DSL y el comportamiento son idénticos a los de la versión de npm. La API está en
[Bibliotecas por lenguaje — Java](../bindings/java.md#top).

#### .NET — NuGet

**Requisitos:** .NET **6.0** o más reciente.

La biblioteca es un paquete:

```bash
dotnet add package Tdcv2
```

El juego inicial de paquetes de datos va incrustado en el ensamblado, así que
funciona sin instalar nada más.

**La línea de comandos es su propio paquete.** NuGet no tiene equivalente del `bin` de
npm, así que el CLI es un paquete de herramienta de .NET: instálelo de forma global y el
comando queda en su PATH:

```bash
dotnet tool install --global Tdcv2.Cli
tdcv2 init
```

El DSL y el comportamiento son idénticos a los de la versión de npm.

#### Rust — Cargo

**Requisitos:** Rust **1.74** o superior.

Un solo crate trae la biblioteca y la línea de comandos:

```bash
cargo add tdcv2      # como dependencia
cargo install tdcv2  # como comando
tdcv2 init
```

Los paquetes de datos iniciales van compilados dentro del binario, así que un crate
instalado no necesita nada más en disco.

O bien, desde una copia del repositorio:

```bash
cd rust && cargo build --release
./target/release/tdcv2 init
```

El crate **no tiene dependencias**, así que para compilarlo no hace falta más que
Rust. La única excepción es HTTPS: `tdcv2 pack` ejecuta `curl` y, si no está,
explica cómo instalarlo.

El DSL y el comportamiento son idénticos a la versión de npm.

## Compruebe que funciona

`init` ya le dejó algo que ejecutar: `tdcv2-examples/01-starter.tdc` y dos más a su
lado. **Esos archivos aparecen solo después de ejecutar `init`**; nada los crea al
instalar, y luego son suyos para editarlos.

Ejecutar el primero es la comprobación de que la instalación funciona:

```bash
tdcv2 tdcv2-examples/01-starter.tdc
```

El resto de esta sección construye lo mismo a mano, para que se vea de dónde sale cada
línea. Cree un archivo `demo.tdc`. Tiene dos columnas —un
nombre elegido de una lista con [`type="text"`](../generators/text.md#top) y una edad
tomada de un rango con [`type="number"`](../generators/number.md#top)— y una plantilla
de salida de una sola línea:

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
        <line>
            <data>${{Name}}, edad ${{Age}}</data>
        </line>
    </block>
</tdc>
```

Ejecútelo con el comando que le dejó su instalación. Tres ecosistemas ponen `tdcv2` en
su PATH desde el mismo paquete que trae la biblioteca; Maven y NuGet no tienen
equivalente del `bin` de npm, así que para esos dos la línea de comandos es un segundo
artefacto:

| Lenguaje | Comando                                                                                                                   |
| :------- | :------------------------------------------------------------------------------------------------------------------------ |
| Node.js  | `npx tdcv2 tdcv2-examples/01-starter.tdc`                                                                                                      |
| Python   | `tdcv2 tdcv2-examples/01-starter.tdc`                                                                                                          |
| Rust     | `tdcv2 tdcv2-examples/01-starter.tdc`, tras `cargo install tdcv2`                                                                              |
| C#       | `tdcv2 tdcv2-examples/01-starter.tdc`, tras `dotnet tool install --global Tdcv2.Cli`                                                           |
| Java     | `java -jar tdcv2-0.3.0-cli.jar tdcv2-examples/01-starter.tdc` — el clasificador `cli` de las coordenadas de la propia biblioteca               |

Desde la raíz del repositorio, `./run demo.tdc` es el más corto de todos.

`tdcv2 demo.tdc`

```
Elena, edad 59
Diego, edad 18
Carlos, edad 53
```

> [!IMPORTANT]
> Los nombres y números exactos son ilustrativos: pueden variar entre versiones del
> núcleo. Lo importante es que `seed="demo"` vuelve reproducible la ejecución: la
> misma configuración con la misma semilla reproduce la misma salida siempre.

Si obtiene tres líneas con la forma `nombre, edad N`, la instalación funciona.
Confirme la reproducibilidad ejecutándola una segunda vez: las tres filas son
idénticas. Después cambie la cantidad de filas y la semilla desde la línea de
comandos, sin tocar el archivo:

```bash
tdcv2 demo.tdc --count 20 --seed alt
```

## O sáltese la configuración

Una configuración es la forma de describir un conjunto entero. Pero la misma instalación
también responde a un solo valor, como hace un faker: sin archivo, sin `<env>`, con una
llamada:

#### TypeScript

```typescript
import { tdc } from 'tdcv2';

tdc.person.lastName(); // Jones
tdc.person.male.firstName(); // Robert
tdc.common.finance.iban(); // DE62299399441396459682
tdc.country.usa.docs.ssn(); // 699209702 — con sus dígitos de control reales
tdc.lang.ru.person.lastName(); // tras `tdcv2 pack add ru`
```

#### Python

```python
from tdcv2 import tdc

tdc.person.lastName()           # Jones
tdc.person.male.firstName()     # Robert
tdc.common.finance.iban()       # DE62299399441396459682
tdc.country.usa.docs.ssn()      # 699209702 — con sus dígitos de control reales
tdc.lang.ru.person.lastName()   # tras `tdcv2 pack add ru`
```

#### Java

```java
import io.github.nickliapin.tdc.quick.Quick;

Quick tdc = Quick.tdc();

tdc.get("person.lastName");        // Jones
tdc.get("person.male.firstName");  // Robert
tdc.get("common.finance.iban");    // DE62299399441396459682
tdc.get("usa.docs.ssn");           // 699209702 — con sus dígitos de control reales
tdc.get("ru.person.lastName");     // tras `java -jar tdcv2-cli.jar pack add ru`
```

#### C#

```csharp
using Tdcv2.Quick;

dynamic tdc = Quick.Tdc;

tdc.person.lastName();          // Jones
tdc.person.male.firstName();    // Robert
tdc.common.finance.iban();      // DE62299399441396459682
tdc.country.usa.docs.ssn();     // 699209702 — con sus dígitos de control reales
tdc.lang.ru.person.lastName();  // tras `tdcv2 pack add ru`
```

#### Rust

```rust
use tdcv2::quick::Quick;

let mut tdc = Quick::new();

tdc.get("person.lastName")?;        // Jones
tdc.get("person.male.firstName")?;  // Robert
tdc.get("common.finance.iban")?;    // DE62299399441396459682
tdc.get("usa.docs.ssn")?;           // 699209702 — con sus dígitos de control reales
tdc.get("ru.person.lastName")?;     // tras `tdcv2 pack add ru`
```

Ambas rutas leen los mismos paquetes de datos, así que el apellido de una llamada de una
línea y el de una configuración de un millón de filas salen de la misma lista. Cuál quiere
depende de si los valores tienen que concordar entre sí: una configuración es lo que ata
una ciudad a su país y mantiene una proporción en exactamente el 30%, y una llamada suelta
no ata nada con nada.

[Quick API](quick-api.md#top) —la página siguiente— tiene toda la superficie: `.many(n)`,
`seed()`, `locale()` y cómo alcanzar un paquete concreto en cada lenguaje.

> [!NOTE]
> **Los valores de aquí vienen de una semilla**
>
> Cada una de las cinco es aleatoria por proceso por sí sola, como lo es un faker. Los
> valores de los comentarios son los que sortea la semilla `demo`, así que
> `tdc.seed('demo')` —`Quick.seeded("demo")` en Java y Rust— los reproduce exactamente.

## Instalar paquetes de datos (opcional)

Los nombres, ciudades, estados, empresas y demás listas de valores se distribuyen
como **paquetes de datos**, aparte del motor, para que actualizar la biblioteca
nunca sobrescriba sus datos. Viene incluido un conjunto razonable por omisión (por
ejemplo, los 1000 nombres de pila más frecuentes), así que el ejemplo de
comprobación de arriba funciona sin descargar nada más. Los conjuntos completos y
los adicionales se descargan cuando hacen falta.

Dos comandos dejan todo listo, una sola vez cada uno:

```bash
tdcv2 init            # elige dónde viven los paquetes y el locale por omisión
tdcv2 pack list       # muestra lo que ofrece el registro
tdcv2 pack add en usa # descarga y conecta los paquetes que quiera
```

> [!NOTE]
> En una instalación por npm cada uno de esos es `npx tdcv2 …`: el comando vive en
> `node_modules/.bin`. pip, cargo y `dotnet tool install -g` ponen `tdcv2` en su PATH, así
> que allí las líneas de arriba son exactamente lo que se teclea.

`tdcv2 pack list` imprime el catálogo y marca lo que ya está instalado:

`tdcv2 pack list`

```
Available data packs:

common ✓ installed Common (locale-agnostic) (46.5 KB)
Generators bound to neither a language nor a country: uuid,
hashes, ISBN/ISSN, GTIN/UPC/EAN, card PANs, MRZ, IPv4/IPv6/MAC,
semver, and more.

…

usa ✓ installed Usa (country) (18.8 KB)
Data specific to the USA regardless of the language it is
written in: SSN/ITIN/EIN, ZIP codes, states, street names, ABA
routing numbers, phone format, license plates.
```

Los paquetes son **combinables** a lo largo de ejes independientes —idioma, país y
un `common` independiente del locale—, de modo que los datos de
Estados Unidos en inglés son `common` + `en` + `usa`. El flujo completo (el archivo
de configuración, el ocultamiento entre paquetes, cómo quitarlos) está en
[Instalar paquetes de datos](../data-packs/installing-packs.md#top).

## Qué sigue

- **[Su primer conjunto de datos](first-data.md#top)** — escribir, ejecutar y ampliar una configuración en tres minutos.
- **[Referencia del CLI](../reference/cli.md#top)** — todas las banderas: `--seed`, `--count`, `--output`, `--locale`, `--data-path`, y los códigos de salida.
- **[Instalar paquetes de datos](../data-packs/installing-packs.md#top)** — el flujo completo de `init` / `pack`.

---

← Anterior: [Introducción](../intro.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Quick API — un valor a la vez](./quick-api.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/getting-started/installation)**
