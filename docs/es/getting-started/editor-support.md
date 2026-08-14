<a name="top"></a>

[English](../../getting-started/editor-support.md#top) · [Русский](../../ru/getting-started/editor-support.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/getting-started/editor-support)**

← Anterior: [Su primer conjunto de datos](./first-data.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Estructura de la configuración](../core-concepts/configuration.md#top) →

---

# Soporte del editor

El paquete de npm instala **dos** ejecutables. `tdcv2` genera datos; `tdcv2-lsp` es un
servidor de lenguaje que le da a cualquier editor que hable LSP revisión de errores en
vivo, autocompletado, información al pasar el cursor, ir a la definición, buscar
referencias, renombrar y formatear, para archivos `.tdc`.

Por dentro es el mismo analizador y el mismo validador que usa la CLI. Un diagnóstico
subrayado en el editor es el que imprimiría [`tdcv2 check`](../reference/cli.md#top): no
existe una segunda implementación que pueda desviarse.

## Qué obtiene

| Función                  | Qué hace                                                                         |
| :----------------------- | :--------------------------------------------------------------------------------- |
| **Errores en vivo**      | Subrayados rojos mientras escribe, en la posición exacta, con los mismos códigos `TDC…` y sugerencias «¿quiso decir…?» que [`check`](../reference/cli.md#top) |
| **Autocompletado**       | Etiquetas, atributos y valores — tipos de generador, nombres de secuencia para `parent=`, etiquetas de compute dentro de un `<compute>`, y **direcciones de packs con su texto `description:`** |
| **Información al pasar el cursor** | Una descripción breve de una etiqueta o un atributo; sobre `${{Name}}`, qué secuencia es y si está declarada |
| **Ir a la definición**   | Ctrl/Cmd-clic en `${{Name}}` o `parent="Name"` y cae en `<sequence name="Name">`   |
| **Buscar referencias**   | Cada uso de una secuencia en el archivo                                             |
| **Renombrar**            | Renombre una secuencia y todas las referencias la siguen                            |
| **Formatear**            | El mismo impresor que [`tdcv2 format`](../reference/cli.md#top)                         |

El autocompletado se dispara con `<`, un espacio, `"` y el punto — así que escribir un
punto dentro de `value="person."` ofrece lo que está realmente instalado.

El resaltado de sintaxis es un artefacto **aparte** y no necesita servidor: una gramática
TextMate en la carpeta `editor/` del repositorio, que leen IntelliJ, VS Code y Sublime.

## Instalación

Las bibliotecas de LSP son **dependencias peer opcionales**. Un `npm i tdcv2` normal para
generar datos no las trae: no cuestan nada hasta que ejecute el servidor:

```bash
npm i -g tdcv2
npm i -g vscode-languageserver vscode-languageserver-textdocument
```

Ejecútelo sin ellas y el servidor lo dice, en vez de lanzar un stack de resolución de
módulos:

`tdcv2-lsp --stdio`

```
tdcv2-lsp: the TDC language server needs its optional packages, which are not
installed by default. Install them to use the LSP:
  npm i vscode-languageserver vscode-languageserver-textdocument
```

Todos los editores de abajo apuntan a la misma línea de arranque:

```bash
tdcv2-lsp --stdio
```

## Qué packs autocompleta

El servidor ofrece las direcciones que realmente ve: los packs incluidos en la
instalación, más `data/packs/` o `packs/` bajo cualquier carpeta de trabajo abierta.
Instale un locale con [`tdcv2 pack add`](../data-packs/installing-packs.md#top) y reinicie el
servidor para que sus direcciones aparezcan en el autocompletado, cada una con la línea
`description:` del encabezado de su archivo.

## IntelliJ IDEA y otros IDE de JetBrains

**Resaltado** — sin servidor:

1. Settings → Editor → **TextMate Bundles** → **+** → apúntelo a la carpeta `editor/` del
   repositorio.
2. Settings → Editor → File Types → verifique que `*.tdc` esté asociado.

**El servidor de lenguaje:**

1. Instale el plugin gratuito **LSP4IJ** (Red Hat) desde el Marketplace.
2. LSP4IJ → New Language Server:
   - Name: `TDC`
   - Command: `tdcv2-lsp --stdio`
   - File name patterns: `*.tdc`, language id `tdc`
3. Abra un archivo `.tdc` — los errores se subrayan mientras escribe.

## VS Code

Una extensión envoltorio en la carpeta `editor/vscode/` del repositorio conecta ambas
piezas y se instala **localmente, sin el marketplace**:

```bash
cd editor/vscode && npm install && npm run build
```

Después, o abre esa carpeta en VS Code y presiona **F5** para probarla en una segunda
ventana, o ejecuta `npx @vscode/vsce package` e instala el `.vsix` resultante con
**Install from VSIX…**.

## Neovim

Con `nvim-lspconfig`, como servidor propio:

```lua
local configs = require('lspconfig.configs')
local lspconfig = require('lspconfig')
if not configs.tdc then
  configs.tdc = {
    default_config = {
      cmd = { 'tdcv2-lsp', '--stdio' },
      filetypes = { 'tdc' },
      root_dir = lspconfig.util.root_pattern('.git', 'data'),
    },
  }
end
lspconfig.tdc.setup({})
```

El resaltado viene de un plugin compatible con TextMate, o de una gramática Tree-sitter si
alguna vez se agrega.

## Cualquier otro editor

Sirve cualquier cosa que hable LSP: apúntela a `tdcv2-lsp --stdio` para los archivos
`*.tdc`. El servidor no tiene código específico de ningún editor — `server.ts` es una capa
delgada sobre el protocolo, y las partes que piensan son funciones puras compartidas con
la biblioteca y la CLI.

## Vea también

- **[Referencia de la CLI](../reference/cli.md#top)** — `tdcv2 check` y `tdcv2 format`, los
  mismos dos motores detrás de los subrayados y del formateo.
- **[Códigos de error](../reference/errors.md#top)** — todo lo que el editor puede mostrarle.
- **[Instalar packs](../data-packs/installing-packs.md#top)** — lo que ofrecerá el
  autocompletado.

---

← Anterior: [Su primer conjunto de datos](./first-data.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Estructura de la configuración](../core-concepts/configuration.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/getting-started/editor-support)**
