<a name="top"></a>

[English](../../bindings/same-names.md#top) · [Русский](../../ru/bindings/same-names.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/bindings/same-names)**

← Anterior: [Rust](./rust.md#top) · **[Contenido](../README.md#top)**

---

# Los mismos nombres en todas partes

Los cinco paquetes son una sola biblioteca con cinco fachadas, y el objeto que devuelve
una ejecución terminada responde a los **mismos nombres en todos ellos** — escritos según
la costumbre de cada lenguaje y con exactamente el mismo significado.

Aquí eso importa más que la costumbre local. Nadie lee esta biblioteca por su cuenta: se
lee junto al generador, y el ejemplo que estás copiando tenía tantas probabilidades de
haberse escrito en otro lenguaje como en el tuyo. Quien pasa de uno a otro no debería
tener que traducir los nombres de los métodos por el camino.

| Qué devuelve                            | TypeScript    | Python         | Java          | C#            | Rust           |
| --------------------------------------- | ------------- | -------------- | ------------- | ------------- | -------------- |
| La ejecución entera como texto          | `toString()`  | `to_string()`  | `toString()`  | `ToString()`  | `to_string()`  |
| Todos los registros, materializados     | `toArray()`   | `to_array()`   | `toArray()`   | `ToArray()`   | `to_array()`   |
| Los registros de uno en uno             | `iterate()`   | `iterate()`    | `iterate()`   | `Iterate()`   | `iterate()`    |
| Un registro por posición                | `getAt(i)`    | `get_at(i)`    | `getAt(i)`    | `GetAt(i)`    | `get_at(i)`    |
| La ejecución por columnas, no por filas | `toColumns()` | `to_columns()` | `toColumns()` | `ToColumns()` | `to_columns()` |
| Escrita en un archivo                   | `writeFile()` | `write_file()` | `writeFile()` | `WriteFile()` | `write_file()` |
| La semilla realmente usada              | `seedInfo()`  | `seed_info()`  | `seedInfo()`  | `SeedInfo()`  | `seed_info()`  |
| Lo que costará la ejecución             | `preflight()` | `preflight()`  | `preflight()` | `Preflight()` | `preflight()`  |
| Cuántos registros produce               | `count()`     | `count()`      | `count()`     | `Count()`     | `count()`      |

## La grafía propia de tu lenguaje sigue valiendo

Cada paquete creó sus propios nombres antes de que existiera esta tabla, y todos ellos
siguen funcionando. Nada queda obsoleto y nada se ha renombrado: una biblioteca publicada
no puede romper el código de quien la usa para ordenar su propia ortografía.

| También válido   | Dónde      |
| ---------------- | ---------- |
| `str(tdc)`       | Python     |
| `len(tdc)`       | Python     |
| `tdc[3]`         | Python     |
| `for row in tdc` | Python     |
| `to_list`        | Python     |
| `toList`         | Java       |
| `Rows`           | C#         |
| `this[int]`      | C#         |
| `rows`           | Rust       |
| `row`            | Rust       |
| `seed`           | Rust       |
| `Display`        | Rust       |
| `effectiveCount` | TypeScript |

Así que `data.to_list()` y `data.to_array()` son la misma llamada en Python, y conviene
escribir la que se lea mejor donde estés. La tabla de arriba es con la que puedes contar
en **los cinco**.

> [!NOTE]
> **Esto se comprueba, no se promete**
>
> `fixtures/cross-language/api.json` guarda la tabla, y los cinco conjuntos de pruebas la
> leen. TypeScript, Python, Java y C# preguntan por reflexión si el miembro existe; Rust no
> tiene reflexión, así que su prueba nombra cada uno en código — las llamadas no compilan si
> un nombre desaparece — y compara su lista con ese mismo archivo.
>
> Se comprueba porque ya se había desviado. Antes de que existiera la guarda, Python no
> tenía `to_string`, Java no tenía `toArray`, C# no tenía ni `GetAt` ni `Iterate`, Rust no
> tenía ni `to_array` ni `get_at`, y las versiones anteriores de esta página afirmaban de
> todos modos que los nombres coincidían.

---

← Anterior: [Rust](./rust.md#top) · **[Contenido](../README.md#top)**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/bindings/same-names)**
