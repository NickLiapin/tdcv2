<a name="top"></a>

[English](../../bindings/java.md#top) · [Русский](../../ru/bindings/java.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/bindings/java)**

← Anterior: [Python](./python.md#top) · **[Contenido](../README.md#top)** · Siguiente: [C#](./csharp.md#top) →

---

# Java

El paquete de Java lee **la misma configuración `.tdc`** y, con la misma semilla, produce
**la misma salida** que las implementaciones de TypeScript, Python, C# y Rust: la misma
garantía entre lenguajes.

## Cómo obtenerlo

Una sola dependencia, desde Maven Central:

```xml
<dependency>
  <groupId>io.github.nickliapin</groupId>
  <artifactId>tdcv2</artifactId>
  <version>0.2.2</version>
</dependency>
```

Con Gradle, en `build.gradle.kts`:

```kotlin
implementation("io.github.nickliapin:tdcv2:0.2.2")
```

> [!NOTE]
> **Maven Central puede ir una versión por detrás**
>
> Maven Central limita cuántas publicaciones acepta de un proyecto al mes. Cuando se
> alcanza ese límite, la coordenada de arriba todavía no resuelve y el jar más reciente
> de allí es la versión anterior; los otros cuatro registros ya están al día. Se pone al
> corriente cuando el límite se renueva.

Los paquetes de datos iniciales viajan dentro del jar, así que esto funciona sin
instalar nada más.

El panorama completo, incluido el jar aparte para la línea de comandos, está en
[Instalación](../getting-started/installation.md#top): Maven no tiene equivalente del
`bin` de npm, así que la línea de comandos se distribuye como su propio artefacto.

## Cómo usarlo

```java
var data = new TDC("users.tdc");
System.out.println(data.toString());

for (var row : data.iterate()) {
    System.out.println(row.get("Gender"));
}
```

Los nombres de los métodos son un espejo de la [API de TypeScript](typescript.md#top).

## Un valor sin configuración

`Quick` sortea un solo valor desde los mismos paquetes de datos que lee una
configuración: sin archivo, sin `<env>`, una llamada.

```java
import io.github.nickliapin.tdc.quick.Quick;

Quick tdc = Quick.tdc();

tdc.get("person.lastName");              // Jones
tdc.get("usa.docs.ssn");                 // 699209702, con sus dígitos de control reales
tdc.many("person.lastName", 5);          // cinco de ellos
Quick.seeded("demo").locale("ru").get("person.lastName");  // fijado y en ruso
```

Aquí la dirección es una cadena, mientras que TypeScript, Python y C# la recorren como
miembros. La forma con miembros necesita un método generado por dirección, y una
superficie generada solo cubriría los paquetes que van dentro del jar, cuando la mayoría
llega en tiempo de ejecución y `get("ru.person.lastName")` funciona en cuanto termina la
descarga. Toda la superficie está en [Un valor a la
vez](../core-concepts/quick-api.md#top).

---

← Anterior: [Python](./python.md#top) · **[Contenido](../README.md#top)** · Siguiente: [C#](./csharp.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/bindings/java)**
