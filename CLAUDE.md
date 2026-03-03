# AI Browser Agent

Автономный AI-агент, управляющий веб-браузером через Playwright. Пользователь пишет задачу в терминале — агент выполняет её в реальном браузере (Chromium).

## Development Workflow

Разработку ведём пошагово: добавили новую фичу или механику → протестировали что она работает → сделали коммит и push на GitHub. Никаких больших непроверенных изменений.

## Tech Stack

- **TypeScript** + Node.js (>=18)
- **Playwright** — автоматизация браузера, ARIA accessibility tree
- **OpenAI SDK** (primary) / **Anthropic SDK** (fallback) — LLM провайдер (настраивается через `.env`)
- **chalk** — цветной вывод в терминале
- **tsx** — запуск TypeScript без компиляции

## Project Structure

```
src/
├── index.ts              # Entry point: CLI + bootstrap
│                          calls: agent.ts, browser.ts, config.ts
├── agent/
│   ├── agent.ts          # Core agent loop (orchestrator)
│   │                      calls: provider.ts, actions.ts, history.ts, extraction.ts
│   ├── prompt.ts         # System prompt + message formatting
│   │                      used by: agent.ts
│   └── history.ts        # Conversation history + context management
│                          used by: agent.ts
├── llm/
│   ├── provider.ts       # Abstract LLM interface + factory
│   │                      used by: agent.ts
│   └── openai.ts         # OpenAI GPT adapter (implements LLMProvider)
│                          used by: provider.ts factory
├── browser/
│   ├── browser.ts        # Playwright browser manager (persistent profile)
│   │                      calls: Playwright API. used by: index.ts, actions.ts
│   ├── tools.ts          # Tool definitions (JSON schemas for LLM)
│   │                      used by: agent.ts (sent to LLM)
│   ├── actions.ts        # Tool implementations (Playwright actions)
│   │                      calls: browser.ts, extraction.ts. used by: agent.ts
│   └── extraction.ts     # ARIA tree -> numbered refs extraction
│                          calls: Playwright accessibility API. used by: agent.ts, actions.ts
└── utils/
    ├── config.ts         # .env loading, configuration
    │                      used by: everywhere
    └── logger.ts         # Colored terminal output
                           used by: everywhere
```

### Call Flow

```
index.ts → browser.ts (launch Chromium)
         → agent.ts (start loop)
              → extraction.ts (get ARIA snapshot)
              → prompt.ts (build messages)
              → provider.ts → openai.ts (LLM call with tools)
              → actions.ts → browser.ts (execute tool in browser)
              → history.ts (save step, manage context window)
              → repeat until done/max_iterations
```

## How to Run

```bash
# 1. Install dependencies
npm install
npx playwright install chromium

# 2. Create .env from template
cp .env.example .env

# 3. Add your API key to .env
#    Open .env and set OPENAI_API_KEY=sk-...

# 4. Run
npx tsx src/index.ts
```

## Configuration (.env)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | yes* | — | OpenAI API key |
| `ANTHROPIC_API_KEY` | yes* | — | Anthropic API key (alternative) |
| `LLM_MODEL` | no | `gpt-4o` | Model ID (`gpt-4o`, `gpt-4o-mini`, `claude-sonnet-4-20250514`) |
| `MAX_ITERATIONS` | no | `50` | Max agent steps per task |

*At least one API key required.

## Key Architecture Decisions

- **Element resolution via numbered refs**: ARIA snapshot возвращает `[1] button "Submit"`, агент говорит `click(ref: 1)`. Никаких хардкод-селекторов. Refs пересоздаются при каждом snapshot.
- **Persistent browser profile**: `./browser-data/` сохраняет cookies/sessions между запусками. **SECURITY: эта папка в .gitignore, содержит пароли и сессии.**
- **Context management**: ARIA snapshots (50-100x компактнее DOM) + sliding window истории (последние 5 шагов полные, старые — однострочные summaries) + truncation при >4000 токенов.
- **Self-reflection**: каждые 5 шагов агент оценивает прогресс. Loop detection при 3+ одинаковых действиях подряд.

## Conventions

- Tool results: `{ success: boolean, data?: string, error?: string, suggestion?: string }`. Ошибки всегда содержат `suggestion` с конкретным следующим шагом.
- System prompt и tool schemas — на английском (LLM работает точнее). UI/логи — на русском.
- Конфигурация только через `.env`. Шаблон — `.env.example`.
- Новый tool: добавить schema в `tools.ts`, реализацию в `actions.ts`, обработку в `agent.ts`.

## Error Handling

| Ситуация | Поведение |
|----------|-----------|
| `.env` отсутствует или ключ пустой | Crash при старте с понятным сообщением |
| LLM API 429 (rate limit) | Retry с exponential backoff (3 попытки) |
| LLM API 500 / network error | Retry 2 раза, затем сообщение пользователю |
| Playwright timeout (элемент не найден) | Tool возвращает error + suggestion, агент пробует другой подход |
| ARIA snapshot пустой (SPA loading) | Автоматический `wait(2s)` + retry extraction, если всё ещё пусто — screenshot fallback |
| ref не найден (страница изменилась) | Tool возвращает error, агент получает свежий snapshot |
| Агент зациклился (3+ одинаковых действия) | WARNING injection в prompt, агент меняет стратегию |
| Превышен max_iterations | Спрашиваем пользователя: продолжить или остановить |

## Known Issues

<!-- Документируй баги и решения здесь по мере разработки -->

| Проблема | Причина | Решение | Статус |
|----------|---------|---------|--------|
| | | | |
