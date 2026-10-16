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
