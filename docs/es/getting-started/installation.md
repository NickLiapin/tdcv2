<a name="top"></a>

[English](../../getting-started/installation.md#top) · [Русский](../../ru/getting-started/installation.md#top) · **Español**

← Anterior: [Introducción](../intro.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Su primer conjunto de datos](./first-data.md#top) →

---

# Instalación

TDC está pensado para cinco ecosistemas — **npm** (Node.js / TypeScript), **pip**
(Python), **Maven** (Java), **NuGet** (.NET) y **Cargo** (Rust) —, y todos producen
exactamente la misma salida, byte por byte, a partir de la misma configuración, seed,
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

> [!NOTE]
> **Versión previa al lanzamiento**
>
> TDC todavía no está publicado en npm. En cuanto lo esté, instalarlo y ejecutarlo
> serán dos líneas:

```bash
npm install -D tdcv2
npx tdcv2 demo.tdc
```

Mientras el paquete siga sin publicarse, el motor se ejecuta directamente desde una
copia local del repositorio. Compílelo una vez:

```bash
npm --workspace typescript run build
```

Después, cualquier configuración se ejecuta apuntando Node al CLI ya compilado:

```bash
node typescript/dist/cli/main.js demo.tdc
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

> [!NOTE]
> **Antes del lanzamiento**
>
> Todavía no está en PyPI. Cuando lo esté, un solo comando le dará la biblioteca y el
> comando `tdcv2`:

```bash
pip install tdcv2
tdcv2 demo.tdc
```

Hasta entonces, instálela desde una copia del repositorio:

```bash
pip install -e python
tdcv2 demo.tdc
```

Eso es toda la configuración: una instalación editable pone `tdcv2` en su PATH igual
que lo hará el paquete publicado, así que nada cambia cuando salga la versión.

El DSL y el comportamiento son idénticos a los de la versión de npm: la misma
configuración `.tdc`, ejecutada con el mismo `seed`, produce los mismos bytes. La API
está en [Bibliotecas por lenguaje — Python](../bindings/python.md#top).

#### Java — Maven

**Requisitos:** Java **17** o más reciente.

> [!NOTE]
> **Antes del lanzamiento**
>
> Todavía no está en Maven Central. Cuando lo esté, la biblioteca es una dependencia:

```xml
<dependency>
  <groupId>io.github.nickliapin</groupId>
  <artifactId>tdcv2</artifactId>
  <version>1.0.0</version>
</dependency>
```

Hasta entonces, compílela desde una copia del repositorio:

```bash
cd java && ./gradlew build
```

**La línea de comandos es un artefacto aparte, y lo seguirá siendo tras el
lanzamiento.** Maven no tiene equivalente del `bin` de npm —añadir una biblioteca a
un proyecto no pone ningún comando en su PATH—, así que el CLI se distribuye como un
único jar autónomo que no necesita más que un JDK:

```bash
cd java && ./gradlew cliJar
java -jar build/libs/tdcv2-*-cli.jar demo.tdc
```

Vale la pena un alias: `alias tdcv2='java -jar /ruta/a/tdcv2-cli.jar'`, y a partir de
ahí todos los comandos de estas páginas se leen igual que en los demás lenguajes.

El DSL y el comportamiento son idénticos a los de la versión de npm. La API está en
[Bibliotecas por lenguaje — Java](../bindings/java.md#top).

#### .NET — NuGet

**Requisitos:** .NET **6.0** o más reciente.

> [!NOTE]
> **Antes del lanzamiento**
>
> Todavía no está en NuGet. Cuando lo esté, la biblioteca es un paquete y la línea de
> comandos es una herramienta:

```bash
dotnet add package Tdcv2
dotnet tool install -g Tdcv2.Cli
tdcv2 demo.tdc
```

Hasta entonces, compílelo desde una copia del repositorio:

```bash
cd csharp && dotnet build
dotnet run --project Tdcv2.Cli.Tool -- demo.tdc
```

A diferencia de Maven, .NET sí tiene una respuesta al `bin` de npm —un paquete de
herramienta—, así que `tdcv2` llega a su PATH igual que con npm y con pip, y todos
los comandos de estas páginas se leen idénticos.

El DSL y el comportamiento son idénticos a los de la versión de npm.

#### Rust — Cargo

**Requisitos:** Rust **1.74** o superior.

> [!NOTE]
> **Versión previa**
>
> Todavía no está en crates.io. Cuando lo esté, un solo crate trae la biblioteca y
> la línea de comandos:

```bash
cargo add tdcv2
cargo install tdcv2
tdcv2 demo.tdc
```

Mientras tanto, se compila desde una copia del repositorio:

```bash
cd rust && cargo build --release
./target/release/tdcv2 demo.tdc
```

El crate **no tiene dependencias**, así que para compilarlo no hace falta más que
Rust. La única excepción es HTTPS: `tdcv2 pack` ejecuta `curl` y, si no está,
explica cómo instalarlo.

El DSL y el comportamiento son idénticos a la versión de npm.

## Compruebe que funciona

Con la versión de npm ya lista, cree un archivo `demo.tdc`. Tiene dos columnas —un
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

Ejecútelo:

```bash
./run demo.tdc
```

`./run demo.tdc`

```
Elena, edad 59
Diego, edad 18
Carlos, edad 53
```

> [!IMPORTANT]
> Los nombres y números exactos son ilustrativos: pueden variar entre versiones del
> núcleo. Lo importante es que `seed="demo"` vuelve reproducible la ejecución: la
> misma configuración con el mismo seed reproduce la misma salida siempre.

Si obtiene tres líneas con la forma `nombre, edad N`, la instalación funciona.
Confirme la reproducibilidad ejecutándola una segunda vez: las tres filas son
idénticas. Después cambie la cantidad de filas y el seed desde la línea de
comandos, sin tocar el archivo:

```bash
./run demo.tdc --count 20 --seed alt
```

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

`tdcv2 pack list` imprime el catálogo y marca lo que ya está instalado:

`tdcv2 pack list`

```
Available data packs:

  common   installed   Common (locale-agnostic)   0.0 MB
  en                   English (language)          0.1 MB
  usa                  United States (country)     0.0 MB
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

← Anterior: [Introducción](../intro.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Su primer conjunto de datos](./first-data.md#top) →
