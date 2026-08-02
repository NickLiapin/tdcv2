<a name="top"></a>

[English](../../bindings/java.md#top) · [Русский](../../ru/bindings/java.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/bindings/java)**

← Anterior: [Python](./python.md#top) · **[Contenido](../README.md#top)** · Siguiente: [C#](./csharp.md#top) →

---

# Java

El paquete de Java lee **la misma configuración `.tdc`** y, con el mismo seed, produce
**la misma salida** que las implementaciones de TypeScript, Python, C# y Rust: la misma
garantía entre lenguajes.

## Cómo obtenerlo

Una sola dependencia, desde Maven Central:

```xml
<dependency>
  <groupId>io.github.nickliapin</groupId>
  <artifactId>tdcv2</artifactId>
  <version>0.1.3</version>
</dependency>
```

Con Gradle, en `build.gradle.kts`:

```kotlin
implementation("io.github.nickliapin:tdcv2:0.1.3")
```

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

---

← Anterior: [Python](./python.md#top) · **[Contenido](../README.md#top)** · Siguiente: [C#](./csharp.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/bindings/java)**
