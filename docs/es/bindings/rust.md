<a name="top"></a>

[English](../../bindings/rust.md#top) · [Русский](../../ru/bindings/rust.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/bindings/rust)**

← Anterior: [C#](./csharp.md#top) · **[Contenido](../README.md#top)**

---

# Rust

El crate lee la **misma configuración `.tdc`** y, con el mismo seed, produce **la misma
salida** que las implementaciones de TypeScript, Python, Java y C#: byte a byte, en los
tres motores y en Parquet.

Un solo crate: biblioteca y línea de comandos a la vez.

## Cómo obtenerlo

> [!NOTE]
> **Antes del lanzamiento**
>
> Todavía no está en crates.io — `cargo add tdcv2` no lo encontrará. Compílelo desde el
> repositorio:
>
> ```bash
> cd rust && cargo build --release
> ./target/release/tdcv2 demo.tdc
> ```
>
> El crate **no tiene dependencias**, así que basta con el toolchain de Rust. Tras el
> lanzamiento será `cargo add tdcv2` / `cargo install tdcv2`; vea
> [Instalación](../getting-started/installation.md#top).

## Cómo usarlo

```rust
use tdcv2::Tdc;

let data = Tdc::from_file("users.tdc")?;
println!("{data}");

for row in data.rows() {
    println!("{:?}", row.get("Gender"));
}

data.write_file("users.csv")?;
```

## Registros, no cadenas

El registro es la razón para usar la biblioteca en lugar de la línea de comandos. Una
prueba que verifica `row.get("Gender")` dice lo que quiere decir; la misma prueba
analizando el CSV de vuelta desde una cadena gasta la mayoría de sus líneas en el análisis.

La salida de texto y la salida por registros leen los mismos valores generados, así que
nunca pueden discrepar. La vista por registros ignora `<block>` y las envolturas por
completo: describen un formato de archivo, y un registro no tiene formato.

```rust
use tdcv2::{Options, Tdc};

let data = Tdc::new(Options {
    config_file: Some("users.tdc".into()),
    count: Some(100),                 // sustituye lo declarado en <env>
    seed: Some("test".into()),        // fija la corrida
    ..Options::default()
})?;

let first = data.row(0).unwrap();
println!("{:?}", first.get("Address.city"));   // un campo de una secuencia compuesta
println!("{:?}", first.nested()["Address"]);   // o la dirección entera de una vez
```

Una secuencia que no aplica a un registro devuelve `None`, nunca `Some("")`. Una columna
declarada `parent="Gender.Male"` no tiene valor en un registro femenino, y un vacío
afirmaría que sí lo tiene y que resulta estar en blanco.

## Opciones

| | |
| --- | --- |
| `config_file` / `config_string` | Exactamente uno de los dos |
| `count`, `seed`, `locale` | Sustituyen lo declarado en `<env>` |
| `engine` | Fuerza el motor 1, 2 o 3 en vez de dejar que la configuración decida |
| `now_millis` | Fija el reloj, para que una prueba sobre fechas no caduque de un día para otro |
| `packs_dir`, `data_paths` | Dónde se buscan los packs y las fuentes `@data/…` |
| `base_dir` | Respecto a qué es relativo un `src=` relativo |

Una configuración rechazada vuelve como `TdcError::Refused`, que lleva los diagnósticos **y**
el fuente al que apuntan, de modo que quien llama puede mostrar la línea con el error en
lugar de solo citar el mensaje. `diagnostics()` en una corrida exitosa lleva aquello de lo
que se advirtió sin llegar a rechazar. `seed()` informa si el seed fue inventado: una
corrida sin seed no es reproducible, que casi nunca es lo que se quería.

## Sin dependencias

El crate no depende de nada. Su lexer y su parser están escritos a mano contra la gramática
compartida; también lo están el PRNG, el descompresor DEFLATE, SHA-256, los codificadores
Thrift y Snappy detrás del escritor de Parquet, y el decodificador PNG que lee un
[dibujo](../generators/pattern.md#top) y lo convierte en una curva.

No es minimalismo por gusto. Cada una de esas piezas tiene que producir los mismos bytes
que las otras cuatro implementaciones, y un crate que cambiara una regla de redondeo o un
hash en una versión menor rompería la garantía sobre la que se levanta este proyecto sin
tocar una línea de TDC.

La única excepción es HTTPS, que necesita una pila TLS que nadie debería escribir a mano.
`tdcv2 pack` y [`<gen type="http">`](../generators/http.md#top) ejecutan **curl** como proceso
hijo; si no está, el comando lo dice e imprime la línea de instalación para la plataforma
en la que corre. Todo lo demás — generar datos, leer packs locales, cualquier formato de
salida — funciona sin él.

## Requisitos

Rust **1.74** o superior.

---

← Anterior: [C#](./csharp.md#top) · **[Contenido](../README.md#top)**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/bindings/rust)**
