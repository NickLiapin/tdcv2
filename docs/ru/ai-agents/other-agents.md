<a name="top"></a>

[English](../../ai-agents/other-agents.md#top) · **Русский** · [Español](../../es/ai-agents/other-agents.md#top)

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/ai-agents/other-agents)**

← Назад: [Claude Code](./claude-code.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Работа с агентом](./working-with-the-agent.md#top) →

---

# Codex, Cursor, VS Code, Gemini CLI и другие агенты

Все эти агенты читают скиллы, поэтому одна команда подключает TDC сразу ко всем. MCP-сервер
можно добавить поверх, по желанию.

## Скилл

```bash
npx -y tdcv2-mcp@0.1.5 install-skill --agents
```

Команда кладёт скилл в `~/.agents/skills/tdcv2` — общую папку, которую читают Codex, Cursor,
VS Code с Copilot и Gemini CLI. Начните новую сессию и просите данные обычными словами:
агент сам подхватит скилл.

Чтобы скилл жил в одном репозитории и был у всех, кто его клонирует, запишите его в папку
`.agents/skills` самого репозитория и закоммитьте:

```bash
npx -y tdcv2-mcp@0.1.5 install-skill --dir .agents/skills
```

Где каждый агент ищет скиллы — по его собственной документации:

| Агент               | Для вас                                                      | В репозитории                                         |
| :------------------ | :----------------------------------------------------------- | :---------------------------------------------------- |
| Codex               | `~/.agents/skills`                                           | `.agents/skills`                                      |
| Cursor              | `~/.agents/skills`, `~/.cursor/skills`, `~/.claude/skills`   | `.agents/skills`, `.cursor/skills`, `.claude/skills`  |
| VS Code (Copilot)   | `~/.agents/skills`, `~/.copilot/skills`, `~/.claude/skills`  | `.agents/skills`, `.github/skills`, `.claude/skills`  |
| Gemini CLI          | `~/.agents/skills`, `~/.gemini/skills`                       | `.agents/skills`, `.gemini/skills`                    |
| Claude Code         | `~/.claude/skills`                                           | `.claude/skills`                                      |

Повторный запуск команды заменяет скилл выпуском, который вы указали, — так он и
обновляется.

## MCP-сервер

Сервер — тот же пакет, только запускает его агент, а не вы. Все клиенты берут одну и ту же
команду — `npx -y tdcv2-mcp@0.1.5` — и различаются только тем, куда писать
настройку и как выглядит файл.

#### Codex

Выполните один раз:

```bash
codex mcp add tdcv2 -- npx -y tdcv2-mcp@0.1.5
```

Или добавьте сервер в `~/.codex/config.toml` сами:

```toml
[mcp_servers.tdcv2]
command = "npx"
args = ["-y", "tdcv2-mcp@0.1.5"]
```

Codex даёт серверу 10 секунд на запуск. При первом запуске пакет скачивается, поэтому один
раз выполните команду из раздела [Перед первым запуском](#перед-первым-запуском) или
увеличьте лимит строкой `startup_timeout_sec = 30` в той же таблице.

#### Cursor

Добавьте сервер в `~/.cursor/mcp.json`, чтобы он был во всех проектах, или в
`.cursor/mcp.json` одного проекта:

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

GitHub Copilot в VS Code читает `.vscode/mcp.json` в рабочей папке. Ключ верхнего уровня здесь
`servers`, а не `mcpServers`, как у остальных клиентов:

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

Чтобы добавить его в профиль пользователя, для всех рабочих папок:

```bash
code --add-mcp '{"name":"tdcv2","type":"stdio","command":"npx","args":["-y","tdcv2-mcp@0.1.5"]}'
```

#### Gemini CLI

Добавьте сервер в `~/.gemini/settings.json`, чтобы он был во всех проектах, или в
`.gemini/settings.json` одного проекта:

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

## MCP-сервер в других клиентах

Большинство MCP-клиентов принимают ту же запись `mcpServers`; где она лежит у вашего клиента —
смотрите в его документации:

```json
{ "mcpServers": { "tdcv2": { "command": "npx", "args": ["-y", "tdcv2-mcp@0.1.5"] } } }
```

В Windows напишите `"command": "npx.cmd"`, если клиент не может запустить `npx`.

## Где работает сервер

Сервер считает проектом папку, в которой его запустили: читает файлы `.tdc` и пишет
сгенерированные файлы только там. Пакеты данных, которые он ставит, ложатся туда, куда
указывает `tdcv2.config.json` проекта, — по умолчанию в `tdcv2-packs/` внутри проекта. Если
сгенерированные файлы оказываются не в вашем проекте, укажите клиенту, в какой папке
запускать сервер: Codex, VS Code и Gemini CLI принимают поле `cwd` рядом с `command`.

## Перед первым запуском

При первом запуске сервер и движок скачиваются из npm, и это может занять дольше, чем
клиент готов ждать. Выполните команду один раз в терминале, чтобы всё было готово заранее:

```bash
npx -y tdcv2-mcp@0.1.5 --help
```

---

← Назад: [Claude Code](./claude-code.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Работа с агентом](./working-with-the-agent.md#top) →

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/ai-agents/other-agents)**
