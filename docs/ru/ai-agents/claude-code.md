<a name="top"></a>

[English](../../ai-agents/claude-code.md#top) · **Русский** · [Español](../../es/ai-agents/claude-code.md#top)

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/ai-agents/claude-code)**

← Назад: [TDC для ИИ-агентов](./overview.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Другие агенты](./other-agents.md#top) →

---

# Claude Code

Плагин ставит обе части сразу: скилл и MCP-сервер, который Claude Code сам запускает, когда
он нужен в сессии.

## Установка плагина

```bash
claude plugin marketplace add NickLiapin/tdcv2-agents
claude plugin install tdcv2@tdcv2
```

Первая команда добавляет маркетплейс плагина — это его репозиторий на GitHub. Вторая
устанавливает плагин для вас, во всех проектах. После этого начните новую сессию.

Чтобы убедиться, что всё встало, выполните `claude plugin list`: там будет `tdcv2@tdcv2` со
статусом `Status: ✔ enabled`. Затем `claude mcp list` покажет сервер плагина,
`plugin:tdcv2:tdcv2`, и за ним `✔ Connected`. Первая проверка сервера может занять несколько
секунд: при первом запуске он скачивается из npm.

## Попросите данные

Просите обычными словами, в любом проекте:

```text
200 клиентов из 10 стран в CSV, имена — под страну.
```

Claude Code читает скилл, пишет конфиг `.tdc`, проверяет его, генерирует файл в вашем проекте
и отдаёт вам и то, и другое. На странице [Работа с агентом](./working-with-the-agent.md#top)
показано, что происходит на каждом шаге и как проверить результат.

## Обновление и удаление

```bash
claude plugin update tdcv2@tdcv2
claude plugin uninstall tdcv2@tdcv2
```

`update` ставит самый новый выпуск, а если он уже установлен, так и говорит. Обновление
подхватит новая сессия.

## Только скилл или только сервер

Плагин — самый простой путь. Если нужна только одна часть:

```bash
npx -y tdcv2-mcp@0.1.5 install-skill            # скилл для вас: ~/.claude/skills/tdcv2
npx -y tdcv2-mcp@0.1.5 install-skill --project  # скилл для проекта: ./.claude/skills/tdcv2
claude mcp add tdcv2 -- npx -y tdcv2-mcp@0.1.5  # сервер для этого проекта
```

`install-skill` заменяет старую копию скилла в той же папке. `claude mcp add` подключает
сервер к проекту, в котором вы выполнили команду; добавьте `--scope user`, чтобы он был во
всех проектах.

---

← Назад: [TDC для ИИ-агентов](./overview.md#top) · **[Оглавление](../README.md#top)** · Вперёд: [Другие агенты](./other-agents.md#top) →

📖 **[Открыть на сайте документации →](https://nickliapin.github.io/tdcv2/ru/docs/ai-agents/claude-code)**
