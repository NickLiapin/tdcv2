<a name="top"></a>

[English](../../ai-agents/claude-code.md#top) · [Русский](../../ru/ai-agents/claude-code.md#top) · **Español**

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/ai-agents/claude-code)**

← Anterior: [TDC para agentes de IA](./overview.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Otros agentes](./other-agents.md#top) →

---

# Claude Code

El plugin instala las dos partes a la vez: el skill y el servidor MCP, que Claude Code inicia
por su cuenta cuando una sesión lo necesita.

## Instalar el plugin

```bash
claude plugin marketplace add NickLiapin/tdcv2-agents
claude plugin install tdcv2@tdcv2
```

El primer comando añade el marketplace del plugin, que es su repositorio de GitHub. El
segundo instala el plugin para usted, en todos sus proyectos. Después, inicie una sesión
nueva.

Para confirmar que funcionó, ejecute `claude plugin list`: muestra `tdcv2@tdcv2` con
`Status: ✔ enabled`. Después, `claude mcp list` muestra el servidor del plugin,
`plugin:tdcv2:tdcv2`, seguido de `✔ Connected`. La primera comprobación del servidor puede
tardar unos segundos, porque el primer inicio lo descarga desde npm.

## Pida los datos

Pida en palabras sencillas, en cualquier proyecto:

```text
200 clientes de 10 países en CSV, con nombres que correspondan al país.
```

Claude Code lee el skill, escribe una configuración `.tdc`, la comprueba, genera el archivo en
su proyecto y le entrega ambos. [Trabajar con el agente](./working-with-the-agent.md#top)
muestra lo que ocurre en cada paso y cómo revisar el resultado.

## Actualizar y quitar

```bash
claude plugin update tdcv2@tdcv2
claude plugin uninstall tdcv2@tdcv2
```

`update` instala la versión más reciente y, si ya la tiene, se lo indica. Una sesión nueva
toma la actualización.

## Solo el skill o solo el servidor

El plugin es el camino sencillo. Si quiere una sola parte:

```bash
npx -y tdcv2-mcp@0.1.5 install-skill            # el skill, para usted: ~/.claude/skills/tdcv2
npx -y tdcv2-mcp@0.1.5 install-skill --project  # el skill, este proyecto: ./.claude/skills/tdcv2
claude mcp add tdcv2 -- npx -y tdcv2-mcp@0.1.5  # el servidor, este proyecto
```

`install-skill` reemplaza una copia anterior del skill en la misma carpeta. `claude mcp add`
registra el servidor para el proyecto en el que lo ejecuta; añada `--scope user` para tenerlo
en todos sus proyectos.

---

← Anterior: [TDC para agentes de IA](./overview.md#top) · **[Contenido](../README.md#top)** · Siguiente: [Otros agentes](./other-agents.md#top) →

📖 **[Abrir en el sitio de documentación →](https://nickliapin.github.io/tdcv2/es/docs/ai-agents/claude-code)**
