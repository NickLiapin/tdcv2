<a name="top"></a>

# Documentación de TDC

[English](../README.md#top) · [Русский](../ru/README.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/intro)**

---

- [Introducción](./intro.md#top)

## Primeros pasos

- [Instalación](./getting-started/installation.md#top)
- [Su primer conjunto de datos](./getting-started/first-data.md#top)
- [Soporte del editor](./getting-started/editor-support.md#top)

## Conceptos básicos

- [Estructura de la configuración](./core-concepts/configuration.md#top)
- [Secuencias](./core-concepts/sequences.md#top)
- [Salida y formato](./core-concepts/output-formatting.md#top)
- [Determinismo y proporciones](./core-concepts/determinism.md#top)
- [Un valor a la vez](./core-concepts/quick-api.md#top)

## Generadores

- [Descripción general](./generators/overview.md#top)
- [text](./generators/text.md#top)
- [number](./generators/number.md#top)
- [template](./generators/template.md#top)
- [File](./generators/file.md#top)
- [Date](./generators/date.md#top)
- [Symbol](./generators/symbol.md#top)
- [Regex](./generators/regex.md#top)
- [Regex avanzado](./generators/advanced-regex.md#top)
- [Contadores (increment / decrement)](./generators/counters.md#top)
- [Series de tiempo](./generators/timeseries.md#top)
- [Pattern (dibujo)](./generators/pattern.md#top)
- [Servicio HTTP](./generators/http.md#top)
- [Total acumulado](./generators/running.md#top)
- [Estadística](./generators/stat.md#top)
- [Formula (fórmula)](./generators/formula.md#top)

## Pools

- [Resumen](./pools/overview.md#top)
- [Acotar con filter](./pools/filter.md#top)
- [Enlazar pools entre sí](./pools/linking.md#top)

## Construcciones

- [Visión general](./constructs/overview.md#top)
- [Elegir entre valores (mix)](./constructs/mix.md#top)
- [Tablas de consulta (switch)](./constructs/switch.md#top)
- [Salida condicional (if)](./constructs/conditional-output.md#top)
- [Varios valores en una celda (repeat)](./constructs/multiple-values.md#top)
- [Una fila por elemento (each)](./constructs/relational-tables.md#top)
- [Unicidad (uniq, distinct)](./constructs/unique-values.md#top)
- [Configuraciones que se comprueban solas (assert)](./constructs/self-checking.md#top)

## Lenguaje de cálculo

- [Descripción general](./compute/overview.md#top)
- [Aritmética](./compute/arithmetic.md#top)
- [Listas e iteración](./compute/lists.md#top)
- [Strings y formato](./compute/strings.md#top)
- [Condicionales](./compute/conditionals.md#top)
- [Un pack leído línea por línea](./compute/walkthrough.md#top)

## Guías

- [Dependencias jerárquicas](./guides/hierarchical-dependencies.md#top)
- [Datos coherentes y relacionales](./guides/coherent-data.md#top)
- [Sin repeticiones dentro de una fila](./guides/distinct.md#top)
- [Leer archivos y CSV](./guides/files-and-csv.md#top)
- [Formatos de salida (CSV, JSON, SQL…)](./guides/output-formats.md#top)
- [Máscaras y mayúsculas](./guides/masks-and-case.md#top)
- [Distribuciones estadísticas](./guides/statistical-distributions.md#top)
- [Anomalías y valores atípicos](./guides/anomalies.md#top)
- [Datos faltantes](./guides/missing-data.md#top)
- [Salida tipada y Parquet](./guides/typed-output-parquet.md#top)
- [Salidas grandes y streaming](./guides/large-outputs.md#top)
- [Escribir un generador de servicio](./guides/writing-a-service.md#top)
- [Rendimiento](./guides/performance.md#top)
- [Señales a partir de fórmulas](./guides/signals-from-formulas.md#top)

## Paquetes de datos

- [Descripción general](./data-packs/overview.md#top)
- [Instalar paquetes de datos](./data-packs/installing-packs.md#top)
- [Catálogo](./data-packs/catalogue.md#top)
- [Cree su propio paquete](./data-packs/writing-your-own.md#top)

## Referencia

- [CLI](./reference/cli.md#top)
- [Etiquetas](./reference/tags.md#top)
- [Atributos](./reference/attributes.md#top)
- [Generadores](./reference/generators.md#top)
- [Funciones de cálculo](./reference/compute.md#top)
- [Valores integrados](./reference/builtins.md#top)
- [Catálogo de identificadores](./reference/identifiers.md#top)
- [Códigos de error](./reference/errors.md#top)
- [Expresiones](./reference/expressions.md#top)
- [Comparación y verdad](./reference/comparison.md#top)

## Bibliotecas por lenguaje

- [TypeScript](./bindings/typescript.md#top)
- [Python](./bindings/python.md#top)
- [Java](./bindings/java.md#top)
- [C#](./bindings/csharp.md#top)
- [Rust](./bindings/rust.md#top)
- [Los mismos nombres en todas partes](./bindings/same-names.md#top)
