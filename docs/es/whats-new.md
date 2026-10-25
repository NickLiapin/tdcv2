<a name="top"></a>

[English](../whats-new.md#top) · [Русский](../ru/whats-new.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/whats-new)**

← Anterior: [Introducción](./intro.md#top) · **[Contenido](./README.md#top)** · Siguiente: [Instalación](./getting-started/installation.md#top) →

---

# Novedades

Lo que cambió en TDC y usted puede ver — un comando o una bandera nueva, una comprobación
nueva, algo que ahora funciona distinto —, lo más reciente primero, y cada punto con un enlace a
donde la documentación lo explica ahora. Los cambios dentro del motor que no alteran nada de lo
que usted escribe o lee quedan fuera; todos los cambios están en el
[registro de cambios](https://github.com/NickLiapin/tdcv2/blob/main/CHANGELOG.md).

## 25 de octubre de 2026 — versión 0.3.6

- **`<line each="Pool">` imprime un pool registro por registro.** Una línea por registro, cada
  campo leído como `${{Pool.field}}`, así que una tabla de consulta sale de la misma
  configuración que las filas que apuntan a ella. Las posiciones `Pool._first`, `Pool._last` y
  `Pool._item` cuentan las líneas impresas de verdad, que es lo que pone una coma entre objetos
  JSON y no después del último. →
  [Un pool entero, registro por registro](./constructs/relational-tables.md#un-pool-entero-registro-a-registro)
- **`<group>` mantiene juntas varias líneas.** `<group each="Depts">` imprime sus líneas una vez
  por departamento, y un grupo dentro de él imprime los médicos de ese departamento: un documento
  JSON anidado desde una sola configuración. Sin `each`, su `if=` conserva o quita todas sus
  líneas a la vez. →
  [Varias líneas por elemento](./constructs/relational-tables.md#varias-líneas-por-elemento-group)
- **El filtro `json`.** `${{Name | json}}` escribe una cadena JSON con el escape hecho, o `null`
  si el valor está vacío; `${{Tags | json:;}}` escribe una lista como un array JSON. Una lista
  impresa sin su separador recibe una advertencia, `TDC312`. →
  [`json`](./guides/masks-and-case.md#json--un-valor-json-completo)
- **`plus=` lee la distancia de una columna.** `<gen type="date" of="Start" plus="Length m">`
  termina cada cita su propia duración después de empezar. →
  [Una distancia leída de otra columna](./generators/date.md#una-distancia-leída-de-otra-columna)
- **El `if=` de una línea con `each` decide elemento por elemento.** `<line each="Orders"
  if="Orders > 5000">` imprime solo los pedidos grandes; antes conservaba o quitaba la línea
  entera. →
  [Lo que se ve dentro de una línea con `each`](./constructs/relational-tables.md#qué-se-ve-dentro-de-una-línea-con-each)
- **Las líneas de los fixtures se comprueban, y su `if=` se lee.** Un `${{Name}}` mal escrito en
  `<before>` es un error en `check` en lugar de llegar al archivo tal cual. →
  [Fixtures](./core-concepts/output-formatting.md#fixtures--texto-alrededor-de-los-registros)
- **Identificadores de salud con dígitos de control reales:** el NPI de EE. UU., el KVNR y el
  LANR de Alemania, el RPPS y el FINESS de Francia, el CNS de Brasil. →
  [Números fiscales y de documentos por país](./reference/identifiers.md#números-fiscales-y-de-documentos-por-país)
- **Los teléfonos de EE. UU. y Canadá usan cualquier código de área en servicio**, con los
  números 555-0100 a 555-0199, reservados para la ficción. Antes cada número de EE. UU. empezaba
  por `+1 202 555`. → [Números de teléfono](./reference/identifiers.md#números-de-teléfono)
- **El registro de paquetes tiene 294 conjuntos.** Ya se pueden descargar el chino
  tradicional, el uzbeko, el montenegrino, el bretón, el sindhi, cuatro idiomas más y 46 países,
  y `tdcv2 pack list` nombra los países como nombres: United States, no "Usa". →
  [`pack list`](./data-packs/installing-packs.md#pack-list--ver-el-catálogo)
- **Rust y C#:** un paquete cuya comprobación `<valid>` rechaza un valor ahora lo vuelve a sacar
  como lo hacen los otros tres. Once paquetes incluidos, entre ellos el código de contenedor ISO
  6346 y los códigos postales de Eslovenia, daban allí valores distintos. →
  [`<valid>`](./compute/conditionals.md#valid--rechazar-y-reintentar)
- **Agentes de IA.** Claude Code, Codex, Cursor, VS Code y Gemini CLI pueden escribir y ejecutar
  configuraciones de TDC por usted, mediante un skill y un servidor MCP. →
  [Agentes de IA](./ai-agents/overview.md#top)

## 17 de octubre de 2026 — versión 0.3.5

- **`check` dice qué motor ejecutará la configuración y por qué.** Una segunda línea después de
  «is valid», como `runs on engine 1 (in memory): uniq="true" on "Code"`: de eso depende cuánta
  memoria gasta. `--brief` la omite. → [`tdcv2 check`](./reference/cli.md#tdcv2-check)
- **`--engine 3` avisa cuando la configuración la ejecuta el motor 1.** Con un total acumulado,
  una estadística o una columna `uniq="true"` siempre pasaba la ejecución al motor en memoria;
  ahora imprime una nota, y una medición de memoria ya no es en silencio una del motor 1. →
  [Qué motor corre su configuración](./guides/large-outputs.md#qué-motor-corre-su-configuración)
- **Corregido: una búsqueda o una fórmula que leía un miembro de `<uniq>` veía el valor de antes
  de reordenar el grupo** — el día impreso y el día buscado no coincidían en casi ninguna fila. →
  [`<uniq>` — entre secuencias separadas](./constructs/unique-values.md#uniq--entre-secuencias-separadas)
- **Corregido: `<assert>` e `if=` leen un campo a dos o más pools de profundidad**, como
  `D.room.dept.dep_id`. → [Hasta qué profundidad llega](./pools/linking.md#hasta-qué-profundidad-llega)
- **Corregido: un filtro dentro de un pool lee los campos de al lado.** `filter="dept_no == want"`,
  con `want` campo del mismo pool, se rechazaba como un filtro que nunca coincide. →
  [Qué significa un nombre dentro de `filter`](./pools/filter.md#qué-significa-un-nombre-dentro-de-filter)
- **Corregido: cada elemento de un `repeat=` es una extracción propia.** Un e-mail repetido ya no
  repite un solo dominio, y una distribución cuyo parámetro nombra otra columna lee el valor de
  su propia fila. → [Varios valores en una celda](./constructs/multiple-values.md#top)
- **Corregido: el 29 de febrero sigue siendo 29 de febrero.** En el paquete npm una fecha acotada
  por 2024-02-29 o medida desde ella salía como 1 de marzo. →
  [Una fecha aleatoria dentro de un rango](./generators/date.md#una-fecha-aleatoria-dentro-de-un-rango)
- **Python, Rust, Java y C#:** un `<switch>` sobre un campo de un registro de pool, una fecha
  medida desde uno y `repeat=` dentro de una rama de `<switch>` o un caso de `<mix>` funcionan
  como en el paquete npm. → [Dos nombres y un punto](./pools/overview.md#dos-nombres-y-un-punto)

## 16 de octubre de 2026 — versión 0.3.4

- **`init` puede omitir los ejemplos.** `tdcv2 init --yes --no-examples` escribe la
  configuración y la carpeta de paquetes, y nada más: para un script o un agente de IA que
  prepara un proyecto en nombre de otra persona. →
  [`--no-examples`](./data-packs/installing-packs.md#--no-examples--solo-la-configuración)
- **`check` advierte de tres errores que antes pasaban en silencio.** Cada uno se ejecutaba sin
  decir nada y daba datos equivocados:
  - un `<env>` sin `seed=`: cada ejecución da un archivo distinto →
    [`seed`](./core-concepts/configuration.md#seed)
  - `mm` en un formato de fecha son minutos, así que `YYYY-mm-DD` imprimía el mes `00`; el mes es
    `MM` → [Formato de la salida](./generators/date.md#formato-de-la-salida)
  - `&quot;` u otra entidad XML en `<data>` se imprime tal como está escrita →
    [`<data>` — texto crudo](./core-concepts/output-formatting.md#data--texto-crudo)

  Son advertencias: `check` sigue terminando con 0. Una ejecución con `--seed` no tiene nada que
  advertir, y una sin ella imprime en su lugar la semilla que sacó. →
  [`tdcv2 check`](./reference/cli.md#tdcv2-check), códigos `TDC309`–`TDC311` en la
  [referencia de diagnósticos](./reference/errors.md#top)
- **Una fecha medida desde otra fecha ahora tiene su formato revisado.** `format="YYY"` en una
  fecha con `of=`/`plus=` imprimía `25Y` en cada fila; ahora `check` lo rechaza, como en cualquier
  otra fecha. →
  [Una fecha medida desde otra fecha](./generators/date.md#un-intervalo-una-fecha-medida-desde-otra-fecha)
- **Paquete npm: `init --locale` sin valor se rechaza.** Antes escribía en silencio una
  configuración con `en`; las otras cuatro implementaciones ya lo rechazaban. →
  [`--locale`](./data-packs/installing-packs.md#--locale-loc--elegir-el-locale-por-omisión)

---

← Anterior: [Introducción](./intro.md#top) · **[Contenido](./README.md#top)** · Siguiente: [Instalación](./getting-started/installation.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/whats-new)**
