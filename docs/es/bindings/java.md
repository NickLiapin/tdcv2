<a name="top"></a>

[English](../../bindings/java.md#top) · [Русский](../../ru/bindings/java.md#top) · **Español**

← Anterior: [Python](./python.md#top) · **[Contenido](../README.md#top)** · Siguiente: [C#](./csharp.md#top) →

---

# Java

El paquete de Java lee **la misma configuración `.tdc`** y, con el mismo seed, produce
**la misma salida** que las implementaciones de TypeScript, Python, C# y Rust: la misma
garantía entre lenguajes.

## Cómo obtenerlo

> [!NOTE]
> **Antes del lanzamiento**
>
> La implementación en Java está terminada y pasa todos los fixtures entre lenguajes, pero
> **todavía no está en Maven Central**. Compílela desde el repositorio:
>
> ```bash
> cd java && ./gradlew build
> ```
>
> Tras el primer lanzamiento, la misma biblioteca será una sola dependencia — el panorama
> completo, incluido el jar aparte para la línea de comandos, está en
> [Instalación](../getting-started/installation.md#top).

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
