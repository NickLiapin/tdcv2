<a name="top"></a>

[English](../../bindings/python.md#top) · [Русский](../../ru/bindings/python.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/bindings/python)**

← Anterior: [TypeScript](./typescript.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Java](./java.md#top) →

---

# Python

El paquete de Python lee **la misma configuración `.tdc`** y, con el mismo seed,
produce **la misma salida** que las implementaciones de TypeScript, Java, C# y Rust: esa
garantía entre lenguajes es una promesa central de TDC.

## Cómo obtenerlo

> [!NOTE]
> **Antes del lanzamiento**
>
> La implementación en Python está terminada y pasa todos los fixtures entre lenguajes,
> pero **todavía no está en PyPI** — `pip install tdcv2` no la encontrará. Instálela desde
> el repositorio:
>
> ```bash
> pip install -e python
> ```
>
> Eso le da la biblioteca y el comando `tdcv2`. El panorama completo está en
> [Instalación](../getting-started/installation.md#top).

## Cómo usarlo

```python
from tdcv2 import TDC

data = TDC(config_file="users.tdc")
print(data.to_string())

for row in data.iterate():
    print(row["Gender"])
```

Los nombres de los métodos son un espejo de la [API de TypeScript](typescript.md#top)
—`to_string`, `write_file`, `iterate`, `to_array`, `get_at`, `preflight`— en el
snake_case de Python.

Para leer los diagnósticos conviene el [CLI](../reference/cli.md#top): `tdcv2 check`
imprime los mismos errores señalando el lugar exacto en la configuración.

---

← Anterior: [TypeScript](./typescript.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Java](./java.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/bindings/python)**
