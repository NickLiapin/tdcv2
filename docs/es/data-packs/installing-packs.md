<a name="top"></a>

[English](../../data-packs/installing-packs.md#top) · [Русский](../../ru/data-packs/installing-packs.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/data-packs/installing-packs)**

← Anterior: [Descripción general](./overview.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Catálogo](./catalogue.md#top) →

---

# Instalar paquetes: `init` y `pack`

Los nombres, las ciudades, los estados, las empresas y demás listas son
[**paquetes de datos**](overview.md#top). Se distribuyen **aparte del motor**, así que
actualizar la biblioteca nunca sobrescribe sus datos y los conjuntos pesados no inflan
cada instalación. Un conjunto razonable por omisión viene incluido en la caja (por
ejemplo, los 1000 nombres de pila más frecuentes); los conjuntos completos y los
adicionales se descargan cuando hacen falta, con `tdcv2 pack`.

Todo el flujo son dos comandos:

1. `tdcv2 init` una sola vez: define **dónde** van los datos y cuál es el locale por
   omisión.
2. `tdcv2 pack add …`: descarga los conjuntos que realmente necesita.

`init` va primero porque responde una pregunta que `pack` no puede resolver: cuál carpeta
es _suya_. Los packs a propósito no viven dentro de la biblioteca instalada: si vivieran
ahí, cada `npm update`, cada `pip install -U` o cada actualización de dependencias
borraría un gigabyte de datos que usted eligió. `init` anota una carpeta que pertenece a
su proyecto, y todas las implementaciones leen ese mismo archivo, así que un pack
descargado una vez lo encuentran todas.

Si se salta `init`, `pack` no tiene dónde poner nada, y lo dice en vez de adivinar:

`tdcv2 pack list (todavía sin config)`

```
tdcv2: no pack store configured — run `tdcv2 init` first
```

> [!TIP]
> **Los mismos comandos en cualquier lenguaje**
>
> `init` y `pack` existen en todas las implementaciones, no solo en la de Node. Los
> comandos, su salida y el archivo de configuración que escriben son idénticos — lo
> sostiene una fixture de pruebas compartida contra la que las cinco se comparan byte a
> byte. Lo único que cambia es cómo se consigue el comando y cómo se escribe:
>
> | Su lenguaje | Cómo conseguir el comando                          | Cómo invocarlo                    |
> | :---------- | :------------------------------------------------- | :-------------------------------- |
> | Node.js     | nada — `npx` lo descarga solo                      | `npx tdcv2 pack add ru`           |
> | Python      | `pip install tdcv2`                                | `tdcv2 pack add ru`               |
> | Rust        | `cargo install tdcv2`                              | `tdcv2 pack add ru`               |
> | C#          | `dotnet tool install --global Tdcv2.Cli`           | `tdcv2 pack add ru`               |
> | Java        | descargar `tdcv2-0.2.2-cli.jar` de Maven Central   | `java -jar tdcv2-0.2.2-cli.jar pack add ru` |
>
> Tres de ellos dejan un comando `tdcv2` en su PATH y a partir de ahí se leen igual. Node no
> necesita instalación alguna: `npx` descarga y ejecuta en un solo paso. Java es la
> excepción porque Maven no tiene equivalente del `bin` de npm —añadir una biblioteca a un
> proyecto no puede poner un comando en el PATH—, así que la línea de comandos es un jar que
> usted ejecuta:
>
> ```bash
> curl -LO https://repo1.maven.org/maven2/io/github/nickliapin/tdcv2/0.2.2/tdcv2-0.2.2-cli.jar
> java -jar tdcv2-0.2.2-cli.jar pack add ru
> ```
>
> Vale la pena un alias —`alias tdcv2='java -jar /ruta/a/tdcv2-0.2.2-cli.jar'`— y a partir de
> ahí todos los comandos de esta página se leen igual que en cualquier otro sitio.
>
> Un proyecto configurado por una de ellas está listo para las otras cuatro — mismo config,
> mismo almacén, mismo registro. Instalar `ru` desde Python y generar con él en Rust no es un
> caso especial: es el caso normal.

> Las salidas de ejemplo de abajo son ilustrativas: la cantidad exacta de archivos, los
> tamaños y las rutas dependen de su máquina y de la versión del núcleo, pero la forma se
> mantiene.

## `tdcv2 init` — preparar un proyecto

`init` escribe un archivo de configuración para que nunca tenga que editar JSON a mano.
En una terminal interactiva corre un asistente breve (dónde guardar la configuración,
dónde descargar los paquetes, cuál es el locale por omisión). En un script o en CI, pase
banderas para que nada se quede esperando una respuesta.

Un `init` de **proyecto** además escribe tres ejemplos ejecutables en una carpeta nueva
`tdcv2-examples/` — conviene saberlo antes de correrlo dentro de un repositorio existente.
[`--global`](#--global---g--una-sola-configuración-para-todos-los-proyectos) no escribe
ninguno.

```bash
tdcv2 init            # pregunta y luego escribe
```

`tdcv2 init`

```
Wrote project config: /path/to/project/tdcv2.config.json
  data packs → /path/to/project/tdcv2-packs
  locale     → en
  examples   → tdcv2-examples/01-starter.tdc, tdcv2-examples/02-any-format.tdc, tdcv2-examples/03-coherent-records.tdc

Next: run it.
    tdcv2 tdcv2-examples/01-starter.tdc

The common, en and USA packs are already inside this install, so the
examples run with nothing downloaded. `tdcv2 pack` adds more locales.
```

Úselo una vez por proyecto, antes de su primer `tdcv2 pack add`. Cada bandera de abajo
cubre un caso donde el asistente le estorbaría.

### `--yes` / `-y` — sin preguntas

Se salta todas las preguntas y acepta los valores por omisión (configuración local al
proyecto, `./tdcv2-packs`, `en`). Es la bandera para CI y para scripts, donde no hay
nadie que le conteste al asistente.

```bash
tdcv2 init --yes
```

`tdcv2 init --yes`

```
Wrote project config: /path/to/project/tdcv2.config.json
  data packs → /path/to/project/tdcv2-packs
  locale     → en
  examples   → tdcv2-examples/01-starter.tdc, tdcv2-examples/02-any-format.tdc, tdcv2-examples/03-coherent-records.tdc

Next: run it.
    tdcv2 tdcv2-examples/01-starter.tdc

The common, en and USA packs are already inside this install, so the
examples run with nothing downloaded. `tdcv2 pack` adds more locales.
```

### `--global` / `-g` — una sola configuración para todos los proyectos

Escribe la configuración en su carpeta de configuración de usuario en vez de la actual:

| Plataforma                     | Adónde va                                              |
| :----------------------------- | :------------------------------------------------------ |
| Windows                        | `%APPDATA%\tdcv2\config.json` (o `~/AppData/Roaming/…` si `%APPDATA%` no está definido) |
| POSIX, con `XDG_CONFIG_HOME`   | `$XDG_CONFIG_HOME/tdcv2/config.json`                    |
| POSIX, por omisión             | `~/.config/tdcv2/config.json`                           |
 Úselo cuando quiera un único almacén de datos compartido, del que lea cada
proyecto de la máquina, en lugar de una carpeta `tdcv2-packs` por repositorio.

```bash
tdcv2 init --global
```

`tdcv2 init --global`

```
Wrote global config: /Users/you/.config/tdcv2/config.json
  data packs → /Users/you/.config/tdcv2/packs
  locale     → en
```

### `--force` / `-f` — sobrescribir una configuración existente

Por omisión, `init` se niega a pisar una configuración que ya está ahí. Pase `--force`
cuando quiera reiniciarla a propósito: por ejemplo, para cambiar la carpeta de paquetes o
para empezar de cero.

`tdcv2 init (la configuración ya existe)`

```
Config already exists: /path/to/project/tdcv2.config.json
Nothing written. Re-run with --force to overwrite.
```

### `--locale <loc>` — elegir el locale por omisión

Fija el valor `locale` en la configuración, para que no tenga que nombrar un locale en
cada generación. `en` es el valor integrado por omisión; pase otro código para volverlo
el valor por omisión del proyecto.

```bash
tdcv2 init --yes --locale en
```

### `--data-path <dir>` — elegir la carpeta de paquetes

Fija adónde descarga `pack add` (el `packStore`, más abajo). Apúntelo a una unidad
compartida o a una ruta fuera del repositorio cuando no quiera que los paquetes vivan
junto a su código fuente.

```bash
tdcv2 init --yes --data-path ../shared-tdc-packs
```

## El archivo `tdcv2.config.json`

`init` escribe un archivo pequeño como este:

```json
{
  "packStore": "./tdcv2-packs",
  "locale": "en"
}
```

- **`packStore`** — adónde descarga `pack`. Cada conjunto aterriza en esa única carpeta, y
  el primer `pack add` registra la carpeta misma en `dataPaths`. Vea
  [dentro del almacén de paquetes](#dentro-del-almacén-de-paquetes) para saber cómo queda.
- **`locale`** — el locale por omisión (lo fija la bandera `--locale`, arriba).
- **`dataPaths`** — las carpetas que el motor sí escanea en busca de paquetes. `pack add`
  pone ahí el almacén por usted, y usted puede agregar aquí sus propias carpetas para
  apuntar el motor a [paquetes que escribió usted mismo](writing-your-own.md#top).

Una corrida busca su configuración subiendo **desde la carpeta del propio archivo `.tdc`**
(igual que las herramientas localizan `tsconfig.json`) — así que `tdcv2 sub/users.tdc` toma
la configuración de proyecto de `sub/`, no la de la shell. `tdcv2 pack` y `tdcv2 init` no
tienen un `.tdc` del que partir, así que esas dos suben desde la carpeta actual. Cuando varias fuentes definen lo mismo, la
prioridad va de menor a mayor:

```
paquetes integrados  <  configuración global (~/.config/tdcv2)  <  tdcv2.config.json del proyecto  <  bandera --data-path
```

Las rutas dentro del archivo se resuelven **relativas al archivo mismo**, no a su carpeta
de trabajo actual, así que una configuración puede mudarse junto con su proyecto.

## `tdcv2 pack` — descargar y quitar conjuntos

Sin argumentos y en una terminal, `pack` abre un **selector** en vez de volcarle el
catálogo encima. 260 conjuntos no caben en una pantalla, así que se recorren con la forma
que tienen:

- **Todo**, o **elegir lo que necesito**: la primera pregunta, antes que ninguna otra.
- Los idiomas en una sola lista; a los países se llega **por continente**, desde un mapa.
- `/` busca desde cualquier punto: escriba `braz` y ahí está Brasil, con su continente al
  lado.
- <kbd>space</kbd> marca, y sobre un continente se lleva **el continente entero** de una vez.
- <kbd>backspace</kbd>, <kbd>esc</kbd> o <kbd>←</kbd> retroceden desde cualquier pantalla.
- **Revisar** enumera la canasta con su tamaño total; <kbd>space</kbd> descarta lo que ya
  no quiera, <kbd>enter</kbd> aplica. Antes de eso no se descarga nada.

El mapa muestra lo que lleva tomado: el continente bajo el cursor se enciende, y cada país
elegido prende una chispa donde de verdad está. <kbd>m</kbd> alterna entre las costas a
secas y la tierra rellena.

Todas las implementaciones abren el mismo selector, y la terminal decide cómo se dibuja:
medios bloques y color donde los hay, ASCII y un trazo simple donde no (la consola vieja
de Windows, una tubería, `NO_COLOR`). Los selectores de Java y de Rust necesitan `stty` y
por eso solo corren en Unix; en Windows imprimen la lista en su lugar, algo que Node,
Python y C# no tienen que hacer porque sus entornos leen una pulsación por su cuenta.

En un script —o en cualquier sitio sin terminal— manéjelo con subcomandos:

```bash
tdcv2 pack list              # qué hay en el registro
tdcv2 pack add en usa        # descarga y conecta
tdcv2 pack remove usa        # quita
```

Cualquier subcomando acepta además **`--registry <url-base>`**, que apunta `pack` a un
catálogo distinto del público. Por omisión se usa el registro propio del proyecto:

```bash
tdcv2 pack list --registry https://packs.example.internal/tdc
tdcv2 pack add en --registry=https://packs.example.internal/tdc
```

Sirve para un espejo interno de la empresa o una copia en un entorno aislado. La URL es
una base — `pack` añade por su cuenta las rutas del índice y de los archivos — y una
barra final se ignora. La verificación `sha256` sigue en pie: un espejo que sirva bytes
alterados falla al instalar igual que fallaría el público.

### `pack list` — ver el catálogo

Imprime el registro y marca lo que ya tiene instalado, con el tamaño de descarga de cada
conjunto.

`tdcv2 pack list`

```
Available data packs:

common ✓ installed Common (locale-agnostic) (0.0 MB)
Generators bound to neither a language nor a country: uuid,
hashes, ISBN/ISSN, GTIN/UPC/EAN, card PANs, MRZ, IPv4/IPv6/MAC,
semver, and more.

en ✓ installed English (language) (0.1 MB)
Content bound to the English language, not to any one country:
given names and surnames (US-frequency-weighted), gender words,
country names. Shared by every English-speaking locale (USA, UK,
Canada, Australia, …).

…

yemen Yemen (country) (0.0 MB)
Data specific to Yemen: docs, education, finance, geo, holiday,
phone, sport.

Install with: tdcv2 pack add <id>
```

Las descripciones se pliegan al ancho de su ventana, así que la lista sigue siendo una
lista por angosta que esté la terminal. En una tubería o con la salida redirigida no hay
ventana que medir, y las cinco implementaciones asumen 80 columnas — de modo que un
listado guardado es el mismo archivo lo haya escrito cualquiera de ellas.

El catálogo tiene hoy **260 conjuntos**: `common`, 86 idiomas y 173 países. Un idioma o
un país que no aparezca en la lista todavía no está terminado: una entrada es la promesa
de que toda dirección bajo ella resuelve, así que una carpeta con un solo archivo no
recibe una.

Úselo para revisar qué necesita una dirección antes de generar, y para confirmar que un
conjunto aterrizó después de `pack add`.

### `pack add <id…>` — descargar y registrar

`pack add` descarga el zip del conjunto, verifica su `sha256` (una descarga alterada o
corrupta no se instala), lo desempaqueta dentro del almacén de paquetes y **registra** ese
almacén en su configuración, de modo que los datos quedan vivos en sus direcciones con
puntos de inmediato, sin ningún paso extra de conexión.

```bash
tdcv2 pack add en
```

`tdcv2 pack add en`

```
Installed en: 324 files → /path/to/project/tdcv2-packs/en
  registered ./tdcv2-packs in /path/to/project/tdcv2.config.json
```

El almacén se registra una sola vez, en la primera instalación. Los conjuntos siguientes
aterrizan en la misma carpeta y dicen `already registered`.

Puede instalar varios conjuntos en una sola llamada —`tdcv2 pack add common en usa`—, que
es la manera normal de armar un locale (vea
[paquetes puros por eje](#los-paquetes-son-puros-por-eje), abajo).

### `pack remove <id…>` — borrar y quitar del registro

`pack remove` borra exactamente las rutas que trajo ese conjunto, y nada que esté al lado.
Una carpeta que quede vacía tras el borrado se va también.

```bash
tdcv2 pack remove usa
```

`tdcv2 pack remove usa`

```
Removed usa (/path/to/project/tdcv2-packs/countries/usa)
```

El almacén sigue en `dataPaths` mientras contenga algo, porque esa única entrada sirve a
todos los conjuntos que hay dentro. Quite el último conjunto y la entrada se va con él:

`tdcv2 pack remove common en`

```
Removed common (/path/to/project/tdcv2-packs/common)
Removed en (/path/to/project/tdcv2-packs/en)
  store now empty — unregistered /path/to/project/tdcv2-packs from /path/to/project/tdcv2.config.json
```

Quitar un conjunto es seguro: el
[conjunto integrado por omisión](#el-conjunto-integrado-frente-al-descargado) vuelve solo
en esas direcciones.

## Dentro del almacén de paquetes

Cada conjunto se desempaqueta en la **única** carpeta que nombra `packStore`. Un idioma va
bajo su código, un país bajo `countries/`, y `common` bajo su propio nombre:

```text
tdcv2-packs/
├── .tdcv2-installed.json
├── common/…
├── en/…
└── countries/usa/…
```

Esa carpeta es una sola raíz de escaneo, así que la configuración lleva una entrada de
`dataPaths` por muchos conjuntos que instale:

```json
{
  "packStore": "./tdcv2-packs",
  "locale": "en",
  "dataPaths": ["./tdcv2-packs"]
}
```

`.tdcv2-installed.json` es la contabilidad del propio almacén, y no un archivo que usted
edite. De cada conjunto anota las rutas que le pertenecen, cuántos archivos trajo, el
`sha256` contra el que se verificó la descarga, y la versión si el registro publica una.
De ahí lee `pack remove` qué borrar, y de ahí lee `pack list` la marca `✓ installed`.

### Un almacén de una versión anterior

Las versiones anteriores desempaquetaban cada conjunto en `<store>/<id>/packs/…` y le
daban una entrada propia en `dataPaths`. Eso dejaba tres niveles casi idénticos en disco, y
una entrada por conjunto en la configuración: cien paquetes de país eran cien entradas.

El primer `tdcv2 pack` que ejecute, sea cual sea, mueve ese almacén a la disposición de
arriba, en su sitio. No hay que descargar nada de nuevo. El aviso sale por stderr:

`tdcv2 pack list (almacén en la disposición antigua)`

```
tdcv2: pack store "/path/to/project/tdcv2-packs" used the old per-bundle layout; moved it to the flat one.
  en: en/packs → en (324 files)
  usa: usa/packs → countries/usa (22 files)
  dropped 2 per-bundle dataPaths entries
  registered ./tdcv2-packs instead
```

Todo movimiento se planifica antes de que nada se mueva. Si una ruta de la disposición
nueva ya está ocupada, el traslado se rechaza entero y se nombran las colisiones, en vez de
dejar el almacén mitad en una forma y mitad en la otra.

## Los paquetes son puros por eje

Los paquetes están organizados por un **solo eje** —un idioma, un país, o el conjunto
`common`, independiente del locale— y se **combinan**. Los datos del inglés de Estados
Unidos no son un paquete monolítico; son tres capas apiladas:

```bash
tdcv2 pack add common en usa
```

`tdcv2 pack add common en usa`

```
Installed common: 145 files → /path/to/project/tdcv2-packs/common
  registered ./tdcv2-packs in /path/to/project/tdcv2.config.json
Installed en: 324 files → /path/to/project/tdcv2-packs/en
  already registered in /path/to/project/tdcv2.config.json
Installed usa: 22 files → /path/to/project/tdcv2-packs/countries/usa
  already registered in /path/to/project/tdcv2.config.json
```

Quedan tres carpetas en el almacén, bajo la única entrada de `dataPaths` que las cubre a
todas — vea [dentro del almacén de paquetes](#dentro-del-almacén-de-paquetes).

Esto no es una rareza del formato de archivo: refleja que el idioma y el país son
genuinamente independientes. El inglés lo comparten Estados Unidos, el Reino Unido y
Canadá, así que se descarga una sola vez como `en`; los datos específicos del país (los
estados de EE. UU., los códigos de área de EE. UU.) viven en `usa`. Combínelos como
quiera para armar el locale que necesite.

## El conjunto integrado frente al descargado

El conjunto integrado por omisión (el que viene dentro del paquete) es la **capa más
baja** y siempre está presente. Un conjunto descargado se coloca **encima** y **oculta**
esas mismas direcciones sin borrar nada de lo que hay debajo. De ahí se siguen dos
consecuencias:

- instale un conjunto completo → **anula** al de por omisión en esas direcciones;
- `pack remove` → el de por omisión **reaparece** solo. Ningún hueco en sus datos.

Así que tanto descargar como quitar son operaciones seguras: el conjunto base nunca se
borra de verdad, solo queda oculto temporalmente mientras un conjunto más rico se apoya
encima.

## De dónde sale la capa base

Esa capa base se busca haciendo tres preguntas en orden: las mismas tres, en el mismo
orden, en las cinco implementaciones.

| Orden | Dónde                                      | Cuándo responde                                            |
| :---- | :----------------------------------------- | :--------------------------------------------------------- |
| 1     | `TDCV2_PACKS`, si nombra una carpeta       | Usted la fijó, así que gana sobre todo lo demás             |
| 2     | Una copia del código fuente de TDC         | Solo cuando el propio TDC se compiló desde el código        |
| 3     | El conjunto dentro del paquete instalado   | Lo normal: es lo que usa un paquete instalado               |

El paso 2 existe para quien trabaja sobre TDC mismo: dentro de una copia del repositorio
las cinco implementaciones leen su `data/packs`, así que ven una sola copia de los datos y
no cinco que podrían separarse. No puede activarse en un paquete instalado, y a propósito
no se conforma con cualquier carpeta llamada `data/packs`: la carpeta tiene que ser
reconociblemente el repositorio de TDC, para que una carpeta suya que comparta el nombre
nunca se tome por error.

`TDCV2_PACKS` es la vía de escape cuando quiere apuntar las cinco implementaciones a una
sola carpeta sin tocar ninguna configuración:

```bash
TDCV2_PACKS=/srv/shared-packs tdcv2 users.tdc
```

Todo lo que nombren `tdcv2.config.json` y `--data-path` se coloca **encima** de esa
respuesta, nunca en su lugar.

Otras dos variables afectan al comando `pack`, no a la búsqueda:

- **`TDCV2_NO_PICKER`** — definida con cualquier valor, `tdcv2 pack` sin subcomando imprime
  la lista en vez de abrir el selector de pantalla completa. Es la manera de obtener la
  lista impresa en una terminal; en un script o una tubería sale así de todos modos.
- **`TDCV2_ASCII`** — definida con cualquier valor, el selector dibuja con glifos ASCII y
  una fila de mapa por línea. Es la anulación manual para cuando la detección automática de
  Unicode se equivoca; `NO_COLOR` es aparte y solo apaga el color.

## Vea también

- **[Descripción general de los paquetes de datos](overview.md#top)** — qué es un paquete y
  cómo funcionan las direcciones con puntos.
- **[Cree su propio paquete](writing-your-own.md#top)** — el formato del archivo de paquete
  y las reglas de las direcciones.
- **[Referencia del CLI](../reference/cli.md#top)** — la referencia completa de la línea de
  comandos.

---

← Anterior: [Descripción general](./overview.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Catálogo](./catalogue.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/data-packs/installing-packs)**
