<a name="top"></a>

[English](../../bindings/python.md#top) · [Русский](../../ru/bindings/python.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/bindings/python)**

← Anterior: [TypeScript](./typescript.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Java](./java.md#top) →

---

# Python

El paquete de Python lee **la misma configuración `.tdc`** y, con la misma semilla,
produce **la misma salida** que las implementaciones de TypeScript, Java, C# y Rust: esa
garantía entre lenguajes es una promesa central de TDC.

## Cómo obtenerlo

> [!TIP]
> **En PyPI — versión 0.3.0**
>
>
> ```bash
> pip install tdcv2
> ```
>
> Eso le da la biblioteca y el comando `tdcv2`, con un juego inicial de paquetes de datos
> dentro del wheel. El panorama completo está en
> [Instalación](../getting-started/installation.md#top).

## Cómo usarlo

```python
from tdcv2 import TDC

data = TDC(config_file="users.tdc")
print(data)

for row in data:
    print(row["Gender"])

data.write_file("users.csv")
```

La salida completa es `str(data)`, las filas son lo que se recorre, una fila es
`data[3]` y cuántas hay es `len(data)`: el objeto se comporta como el Python que ya
escribe.

Junto a eso, el paquete responde a los nombres que comparten todas las implementaciones
— `to_string`, `to_array`, `iterate`, `get_at`, `to_columns`, `write_file`, `seed_info`,
`preflight` — de modo que un ejemplo escrito en otro lenguaje se lee aquí sin traducir.
Véase [los mismos nombres en todas partes](same-names.md#top). Los propios `to_list`,
`rows`, `uses_http`, `diagnostics`, `count` y `engine` de Python no se ven afectados ni
quedan obsoletos.

Para leer los diagnósticos conviene el [CLI](../reference/cli.md#top): `tdcv2 check`
imprime los mismos errores señalando el lugar exacto en la configuración.

## Un valor sin configuración

El paquete exporta además `tdc`, que sortea un solo valor desde los mismos paquetes de
datos que lee una configuración: sin archivo, sin `<env>`, una llamada.

```python
from tdcv2 import tdc

tdc.person.lastName()                             # Jones
tdc.country.usa.docs.ssn()                        # 699209702, con sus dígitos de control reales
tdc.person.lastName.many(5)                       # cinco de ellos
tdc.seed("demo").locale("ru").person.lastName()   # fijado y en ruso
```

Aquí los segmentos siguen en camelCase, al contrario que los nombres de métodos de
arriba. Son direcciones que los paquetes ya traen, no identificadores que este paquete
eligiera, y `person.lastName` tiene que leerse igual en una configuración, en la
referencia y en las otras cuatro implementaciones. Toda la superficie está en [Un valor
a la vez](../getting-started/quick-api.md#top).

---

← Anterior: [TypeScript](./typescript.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Java](./java.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/bindings/python)**
