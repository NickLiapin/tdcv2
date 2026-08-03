<a name="top"></a>

[English](../../reference/cli.md#top) · [Русский](../../ru/reference/cli.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/reference/cli)**

← Anterior: [Cree su propio paquete](../data-packs/writing-your-own.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Etiquetas](./tags.md#top) →

---

# Referencia de la CLI

Toma un config `.tdc`, genera y escribe el resultado en un archivo o en stdout — sin escribir código.

```bash
tdcv2 <input.tdc> [options]
```

> [!NOTE]
> **De dónde sale `tdcv2`**
>
> `npm install -D tdcv2`, `pip install tdcv2` y `cargo install tdcv2` dejan el comando
> `tdcv2` en su PATH desde el mismo paquete que lleva la biblioteca. Maven y NuGet no tienen
> equivalente del `bin` de npm, así que en Java y C# la línea de comandos es un segundo
> artefacto; [Instalación](../getting-started/installation.md#top) tiene la pestaña de cada
> uno. Un alias hace que todos los comandos de esta página se lean igual. Todo lo de abajo
> funciona igual en cualquier implementación.

Además de generar, la CLI tiene `tdcv2 init` y `tdcv2 pack` para la configuración inicial
y los datos — vea [Instalar packs](../data-packs/installing-packs.md#top) — más `tdcv2 check`
([abajo](#tdcv2-check)) y `tdcv2 format` ([abajo](#tdcv2-format)).

## Opciones

| Opción                  | Qué hace                                                 |
| :---------------------- | :------------------------------------------------------- |
| `-o, --output <path>`   | Escribe en un archivo. Sin ella, imprime en stdout       |
| `--seed <seed>`         | Sobrescribe el `seed` de `<env>`                          |
| `--count <n>`           | Sobrescribe el `count` de `<env>`                         |
| `--locale <loc>`        | Sobrescribe el locale (por omisión `en`)                 |
| `--data-path <dir>`     | Agrega una carpeta de datos para `@data/…` (repetible)   |
| `--jobs <n>`            | Cantidad de hilos de trabajo (por omisión lo decide TDC) |
| `--mode <memory\|disk>` | Motor: `disk` (por omisión) o `memory`                   |
| `--engine <1\|2\|3>`    | Forzar un motor específico (avanzado)                    |
| `--disk`                | Atajo de `--mode disk` — ya es el valor por omisión     |
| `--stream`              | Alias heredado de `--engine 2`                           |
| `-h, --help`            | Muestra la ayuda                                         |
| `-v, --version`         | Muestra la versión                                       |

Las opciones largas también aceptan `=`: `tdcv2 demo.tdc --output=out.csv --count=100`.

En los ejemplos de abajo se usa este `demo.tdc`:

```xml
<tdc>
  <env count="10" seed="demo" local="en">
    <sequence name="Id"><gen type="increment" value="1"/></sequence>
    <sequence name="City"><gen type="text" value="Moscow,Berlin,Paris" order="sequential"/></sequence>
    <sequence name="Status"><gen type="text" value="new,active,closed"/></sequence>
    <before><line><data>Id,City,Status</data></line></before>
  </env>
  <block><line><data>${{Id}},${{City}},${{Status}}</data></line></block>
</tdc>
```

`./run demo.tdc`

```
Id,City,Status
1,Moscow,closed
2,Berlin,new
3,Paris,closed
4,Moscow,new
5,Berlin,closed
6,Paris,new
7,Moscow,new
8,Berlin,active
9,Paris,active
10,Moscow,active
```

## `--seed` — cambiar la aleatoriedad

El config trae un seed fijo, pero usted quiere otro conjunto de valores sin tocar el
archivo. `--seed` lo sobrescribe: las columnas de contador (`Id`) y de recorrido cíclico
(`City`) no dependen del seed, así que solo cambia `Status`.

## `--count` — cuántas filas

`--count 4` renderiza cuatro filas. Las columnas posicionales (contador, texto cíclico)
son un prefijo; las columnas de proporción exacta (`percent`, `<mix>`) y las de `uniq`
se recalculan a partir del nuevo total.
Vea [Determinismo y proporciones](../core-concepts/determinism.md#top).

## `--output` — escribir en un archivo

`-o` (o `--output`) escribe en un archivo; a stdout no sale nada:

```bash
tdcv2 demo.tdc -o out.csv
```

## `--locale` — el idioma de los datos de plantilla

Los generadores de plantilla (nombres, ciudades) usan inglés por omisión; `--locale ru`
cambia todo el archivo al ruso, posición por posición.

## `--data-path` — datos externos

Cuando un config lee `src="@data/…"`, la CLI necesita saber dónde está la carpeta
`data/`. Se le indica con `--data-path` (es repetible — las carpetas se recorren en orden):

```bash
tdcv2 demo.tdc --data-path ./data --data-path ./private-data -o out.csv
```

Una ruta relativa simple como `src="names.txt"` se busca primero junto al archivo `.tdc`
y después en las carpetas de `--data-path`.

## Velocidad y motores — `--jobs`, `--mode`, `--engine`

Normalmente no necesita ninguno de estos: TDC elige el motor a partir del config y decide
por su cuenta si paralelizar. En resumen:

- **`--jobs N`** — fija a mano la cantidad de hilos de trabajo. Esto es **solo cuestión
  de velocidad**: la salida es byte por byte idéntica a la de una corrida de un solo hilo.
- **`--mode memory`** — el motor pequeño en RAM (una salida de emergencia para datos
  chicos y para la API de objetos). Da **su propia** secuencia de valores: es otro motor,
  no el mismo resultado.
- **`--engine 1|2|3`** — fuerza un motor específico; `--stream` es un alias heredado de
  `--engine 2`.

TDC calcula cuántos hilos caben en la RAM de esta máquina y toma esa cantidad — en una
máquina débil la corrida simplemente va más lenta, no se cae a la mitad. Todo el detalle
está en [Volúmenes grandes](../guides/large-outputs.md#top).

## `tdcv2 check`

Lee una configuración, la valida y no genera nada. Es lo que quiere en un hook de
pre-commit o en un paso de CI: responde «¿esto correría?» sin gastar el tiempo de
correrlo.

```bash
tdcv2 check demo.tdc
```

Todo sale por stderr — una configuración válida recibe una línea, y una inválida los
mismos diagnósticos que imprimiría `tdcv2 demo.tdc`. **Por stdout no sale nada**, a
propósito: el stdout de un hook es ruido, y quien quiera los datos ejecuta el generador.

`tdcv2 check demo.tdc`

```
tdcv2: demo.tdc is valid
```

Las advertencias no hacen fallar la comprobación — se imprimen y el código de salida sigue
siendo `0`, porque una advertencia describe algo que funciona pero probablemente no es lo
que usted quería. Solo un error sale con `1`.

## `tdcv2 format`

Deja ordenado un `.tdc` — sangría, espaciado de los atributos, tablas `<map>` alineadas —
con el mismo formateador del editor.

```bash
tdcv2 format demo.tdc        # imprime el config formateado en stdout
tdcv2 format -w demo.tdc     # reescribe el archivo en su lugar (-w / --write)
```

Formatear **nunca cambia** lo que genera un config. Un error de sintaxis se muestra y el
archivo queda intacto (código de salida 1).

## Códigos de salida

| Código | Significado                                    |
| -----: | :--------------------------------------------- |
| `0`  | Generación exitosa, `--help` o `--version`       |
| `1`  | Error de lectura, parseo, validación o ejecución |
| `2`  | Argumentos de CLI incorrectos                    |

## Vea también

- **[Instalar packs](../data-packs/installing-packs.md#top)** — `tdcv2 init`, `tdcv2 pack`.
- **[Volúmenes grandes](../guides/large-outputs.md#top)** — `--jobs`, `--mode`, `--engine` a fondo.

---

← Anterior: [Cree su propio paquete](../data-packs/writing-your-own.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Etiquetas](./tags.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/reference/cli)**
