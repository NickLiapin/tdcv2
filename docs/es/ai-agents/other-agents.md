<a name="top"></a>

[English](../../ai-agents/other-agents.md#top) · [Русский](../../ru/ai-agents/other-agents.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/ai-agents/other-agents)**

← Anterior: [Claude Code](./claude-code.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Trabajar con el agente](./working-with-the-agent.md#top) →

---

# Codex, Cursor, VS Code, Gemini CLI y otros agentes

Todos estos agentes leen skills, así que un solo comando pone TDC a disposición de todos
ellos. El servidor MCP es opcional, encima de eso.

## El skill

```bash
npx -y tdcv2-mcp@0.1.5 install-skill --agents
```

El comando coloca el skill en `~/.agents/skills/tdcv2`, la carpeta compartida que leen Codex,
Cursor, VS Code con Copilot y Gemini CLI. Inicie una sesión nueva y pida los datos en
palabras sencillas; el agente toma el skill por su cuenta.

Para que el skill viva en un solo repositorio, y lo tenga cualquiera que lo clone, escríbalo
en la carpeta `.agents/skills` del propio repositorio y haga commit:

```bash
npx -y tdcv2-mcp@0.1.5 install-skill --dir .agents/skills
```

Dónde busca skills cada agente, según su propia documentación:

| Agente              | Para usted                                                   | En un repositorio                                     |
| :------------------ | :----------------------------------------------------------- | :---------------------------------------------------- |
| Codex               | `~/.agents/skills`                                           | `.agents/skills`                                      |
| Cursor              | `~/.agents/skills`, `~/.cursor/skills`, `~/.claude/skills`   | `.agents/skills`, `.cursor/skills`, `.claude/skills`  |
| VS Code (Copilot)   | `~/.agents/skills`, `~/.copilot/skills`, `~/.claude/skills`  | `.agents/skills`, `.github/skills`, `.claude/skills`  |
| Gemini CLI          | `~/.agents/skills`, `~/.gemini/skills`                       | `.agents/skills`, `.gemini/skills`                    |
| Claude Code         | `~/.claude/skills`                                           | `.claude/skills`                                      |

Ejecutar el comando de nuevo reemplaza el skill por la versión que indique; así se
actualiza.

## El servidor MCP

El servidor es el mismo paquete, pero lo inicia el agente y no usted. Todos los clientes usan
el mismo comando —`npx -y tdcv2-mcp@0.1.5`— y solo cambian el lugar donde va
la configuración y la forma del archivo.

#### Codex

Ejecute una vez:

```bash
codex mcp add tdcv2 -- npx -y tdcv2-mcp@0.1.5
```

O añada el servidor a `~/.codex/config.toml` usted mismo:

```toml
[mcp_servers.tdcv2]
command = "npx"
args = ["-y", "tdcv2-mcp@0.1.5"]
```

Codex da a un servidor 10 segundos para iniciarse. El primer inicio descarga el paquete, así
que ejecute una vez el comando de [Antes del primer inicio](#antes-del-primer-inicio) o suba
el límite con `startup_timeout_sec = 30` en la misma tabla.

#### Cursor

Añada el servidor a `~/.cursor/mcp.json` para tenerlo en todos sus proyectos, o a
`.cursor/mcp.json` en un proyecto:

```json
{
  "mcpServers": {
    "tdcv2": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "tdcv2-mcp@0.1.5"]
    }
  }
}
```

#### VS Code

GitHub Copilot en VS Code lee `.vscode/mcp.json` en el espacio de trabajo. Aquí la clave de
nivel superior es `servers`, no `mcpServers` como en los demás clientes:

```json
{
  "servers": {
    "tdcv2": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "tdcv2-mcp@0.1.5"]
    }
  }
}
```

Para añadirlo a su perfil de usuario, en todos los espacios de trabajo:

```bash
code --add-mcp '{"name":"tdcv2","type":"stdio","command":"npx","args":["-y","tdcv2-mcp@0.1.5"]}'
```

#### Gemini CLI

Añada el servidor a `~/.gemini/settings.json` para tenerlo en todos sus proyectos, o a
`.gemini/settings.json` en un proyecto:

```json
{
  "mcpServers": {
    "tdcv2": {
      "command": "npx",
      "args": ["-y", "tdcv2-mcp@0.1.5"]
    }
  }
}
```

## El servidor MCP en otros clientes

La mayoría de los clientes MCP aceptan la misma entrada `mcpServers`; consulte en la
documentación de su cliente dónde la guarda:

```json
{ "mcpServers": { "tdcv2": { "command": "npx", "args": ["-y", "tdcv2-mcp@0.1.5"] } } }
```

En Windows, escriba `"command": "npx.cmd"` si el cliente no puede iniciar `npx`.

## Dónde trabaja el servidor

El servidor toma como proyecto la carpeta en la que se inicia: lee los archivos `.tdc` y
escribe los archivos generados solo ahí. Los paquetes de datos que instala van adonde indica
el `tdcv2.config.json` del proyecto, que es `tdcv2-packs/` dentro del proyecto salvo que usted
haya elegido otra cosa. Si los archivos generados aparecen fuera de su proyecto, indique al
cliente en qué carpeta iniciar el servidor: Codex, VS Code y Gemini CLI aceptan un campo
`cwd` junto a `command`.

## Antes del primer inicio

El primer inicio descarga el servidor y el motor desde npm, y eso puede tardar más de lo que
un cliente espera. Ejecute el comando una vez en una terminal para tenerlo listo:

```bash
npx -y tdcv2-mcp@0.1.5 --help
```

---

← Anterior: [Claude Code](./claude-code.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Trabajar con el agente](./working-with-the-agent.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/ai-agents/other-agents)**
