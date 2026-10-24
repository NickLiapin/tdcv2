<a name="top"></a>

[English](../../ai-agents/overview.md#top) · [Русский](../../ru/ai-agents/overview.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/ai-agents/overview)**

← Anterior: [Soporte del editor](../getting-started/editor-support.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Claude Code](./claude-code.md#top) →

---

# TDC para agentes de IA

Un agente de programación puede escribir las configuraciones de TDC por usted. Usted pide en
palabras sencillas —"500 clientes de 20 países en CSV", "una prueba de pytest para
`validate_user` con 50 usuarios distintos"— y el agente escribe la configuración `.tdc`, la
comprueba con el motor, genera el archivo en su equipo y le entrega los datos junto con la
configuración que los reproduce.

Para eso el agente necesita dos cosas, y el proyecto
[`tdcv2-agents`](https://github.com/NickLiapin/tdcv2-agents) aporta las dos:

- **Un skill**: instrucciones que el agente lee antes de empezar. Le enseña el lenguaje de
  TDC, el flujo de trabajo y las trampas que el `check` del motor no detecta. Después el
  agente ejecuta el motor en su propia terminal.
- **Un servidor MCP**, `tdcv2-mcp`: el mismo conocimiento en forma de herramientas que el
  agente llama: comprobar una configuración, generar, buscar e instalar paquetes de datos,
  resumir un archivo, leer esta documentación. MCP (Model Context Protocol) es la forma
  estándar en que un agente llama a las herramientas de otro programa.

Las dos partes se publican juntas, con una sola versión: 0.1.5.

## Cuál usar

| Su agente                                       | Qué instalar                                  | Página                                                                   |
| :---------------------------------------------- | :-------------------------------------------- | :----------------------------------------------------------------------- |
| Claude Code                                     | el plugin, que instala las dos partes         | [Claude Code](./claude-code.md#top)                                         |
| Codex, Cursor, VS Code con Copilot, Gemini CLI  | el skill; añada el servidor si quiere ambos   | [Otros agentes](./other-agents.md#top)                                      |
| cualquier otro cliente MCP                      | el servidor                                   | [Otros agentes](./other-agents.md#el-servidor-mcp-en-otros-clientes)    |

A un agente con terminal le basta el skill. El servidor conviene a un cliente sin terminal o
a un agente que trabaja mejor con herramientas que con instrucciones. Instalar las dos partes
no causa ningún problema: enseñan lo mismo.

## Dónde se publica

| Dónde                          | Nombre                                                                    |
| :----------------------------- | :------------------------------------------------------------------------ |
| Código fuente (MIT)            | [NickLiapin/tdcv2-agents](https://github.com/NickLiapin/tdcv2-agents)     |
| Marketplace de Claude Code     | `NickLiapin/tdcv2-agents`, plugin `tdcv2@tdcv2`                           |
| Registro oficial de MCP        | `io.github.NickLiapin/tdcv2`                                              |
| npm                            | [`tdcv2-mcp`](https://www.npmjs.com/package/tdcv2-mcp): el servidor y el skill |

Todo requiere Node.js 20 o posterior.

## Versiones

La versión 0.1.5 está comprobada con TDC 0.3.5. La
referencia del skill se construye a partir de la documentación de ese motor, y el agente
ejecuta ese mismo motor: `npx -y tdcv2@0.3.5`. El servidor usa el `tdcv2`
propio de su proyecto cuando el proyecto lo tiene y, si no, el motor que trae consigo. Con
otra versión del motor, el agente lee las páginas de esa versión, y la última palabra la
tiene el `check` del motor.

## Privacidad

El motor se ejecuta en su equipo. Ni el skill ni el servidor envían sus datos ni sus
configuraciones a ninguna parte. El servidor lee archivos `.tdc` y escribe los archivos
generados solo dentro de la carpeta en la que se inicia.

La red se usa solo para cuatro cosas:

- el primer inicio descarga `tdcv2-mcp` y el motor desde npm;
- con una versión del motor distinta de 0.3.5, el agente puede leer la página
  de documentación de esa versión en GitHub;
- los paquetes de datos se descargan cuando usted o el agente ejecutan `tdcv2 pack add`; a
  través del servidor es `tdc_pack_add`, y su cliente le pide permiso primero;
- una configuración con `<gen type="http" src="…">` envía los valores indicados a esa
  dirección, y solo si alguien escribe una configuración así.

La política completa está en [PRIVACY.md](https://github.com/NickLiapin/tdcv2-agents/blob/main/PRIVACY.md).

---

← Anterior: [Soporte del editor](../getting-started/editor-support.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Claude Code](./claude-code.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/ai-agents/overview)**
