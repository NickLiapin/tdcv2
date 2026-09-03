<a name="top"></a>

[English](../../bindings/csharp.md#top) · [Русский](../../ru/bindings/csharp.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/bindings/csharp)**

← Anterior: [Java](./java.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Rust](./rust.md#top) →

---

# C#

El paquete de .NET lee **la misma configuración `.tdc`** y, con la misma semilla, produce
**la misma salida** que las implementaciones de TypeScript, Python, Java y Rust: byte a byte,
en los tres motores y en Parquet.

Dos paquetes: la biblioteca y la línea de comandos como `dotnet tool`.

## Cómo obtenerlo

> [!TIP]
> **En NuGet — versión 0.3.0**
>
>
> ```bash
> dotnet add package Tdcv2
> ```
>
> Los paquetes de datos iniciales van incrustados en el ensamblado, así que funciona sin
> instalar nada más. La línea de comandos es su propio paquete de herramienta: instálela de
> forma global y `tdcv2` queda en su PATH:
>
> ```bash
> dotnet tool install --global Tdcv2.Cli
> ```
>

## Cómo usarlo

```csharp
using Tdcv2;

var data = new Tdc("users.tdc");
Console.WriteLine(data);

foreach (Tdc.Row row in data.Rows())
{
    Console.WriteLine(row["Gender"]);
}

data.WriteFile("users.csv");
```

## Filas, no texto

La fila es la razón para usar la biblioteca en vez de la línea de comandos. Una prueba
que afirma sobre `row["Gender"]` dice lo que quiere decir; la misma prueba analizando el
CSV de vuelta desde un texto gasta la mayor parte de sus líneas en el análisis.

La salida de texto y la de filas leen los mismos valores generados, así que nunca pueden
discrepar. La vista por filas ignora `<block>` y los envoltorios de texto por completo: eso describe
un formato de archivo, y una fila no tiene formato.

```csharp
var data = new Tdc(new Tdc.Options
{
    ConfigFile = "users.tdc",
    Count = 100,        // sustituye lo declarado en <env>
    SeedValue = "test", // fija la ejecución
});

Tdc.Row first = data[0];
Console.WriteLine(first["Address.city"]);          // un campo de la secuencia compuesta
Console.WriteLine(first.Nested()["Address"]);      // o la dirección entera de una vez
```

Una secuencia que no aplica a la fila devuelve `null`, nunca `""`. Una columna declarada
`parent="Gender.Male"` no tiene valor en una fila femenina, y una cadena vacía afirmaría
que sí lo tiene y que da la casualidad de que está vacío.

## Opciones

|                                |                                                                           |
| ------------------------------ | ------------------------------------------------------------------------- |
| `ConfigFile` / `ConfigString`  | Exactamente uno de los dos                                                |
| `Count`, `SeedValue`, `Locale` | Sustituyen lo declarado en `<env>`                                        |
| `NowMillis`                    | Fija el reloj, para que una prueba con fechas no caduque de un día a otro |
| `PacksDir`, `DataPaths`        | Dónde se buscan los packs y las fuentes `@data/…`                         |
| `BaseDir`                      | Respecto a qué se resuelve un `src=` relativo                             |

`Diagnostics` lleva todo aquello de lo que se advirtió a la configuración sin rechazarla;
los errores se lanzan desde el constructor, así que lo que quede ahí vale la pena decirlo
y no vale la pena detenerse por ello. `SeedInfo` indica si la semilla se generó: una
ejecución sin semilla no es reproducible, que casi nunca es lo que se quería.

## Un valor sin configuración

`Quick.Tdc` sortea un solo valor desde los mismos paquetes de datos que lee una
configuración: sin archivo, sin `<env>`, una llamada.

```csharp
using Tdcv2.Quick;

dynamic tdc = Quick.Tdc;

tdc.person.lastName();                              // Jones
tdc.country.usa.docs.ssn();                         // 699209702, con sus dígitos de control reales
tdc.person.lastName.many(5);                        // cinco de ellos
Quick.Seed("demo").locale("ru").person.lastName();  // fijado y en ruso
```

Esta es la única parte de la librería que es `dynamic`, y a propósito: una dirección es
un camino por los datos y no un conjunto fijo de miembros, y una clase por carpeta de
paquete metería cien mil líneas de nada en el ensamblado. El precio es que una dirección
mal escrita se detecta al ejecutar, así que el mensaje que lanza nombra la dirección real
más cercana. Toda la superficie está en [Un valor a la
vez](../getting-started/quick-api.md#top).

## Los mismos nombres en todos los lenguajes

El objeto que devuelve una ejecución terminada responde a los mismos nombres en los
cinco paquetes, escritos según la costumbre de cada lenguaje. [La tabla está aquí](same-names.md#top),
y los conjuntos de pruebas la comprueban en vez de darla por buena.

## Requisitos

.NET **6.0** o posterior. En el [README de C#](https://github.com/NickLiapin/tdcv2/tree/main/csharp)
están los lugares donde .NET exigió cuidado y la JVM no —desbordamiento, desplazamientos,
orden de bytes, mayúsculas y datos de locale—, cada uno de los cuales habría cambiado los
bytes.

---

← Anterior: [Java](./java.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Rust](./rust.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/bindings/csharp)**
