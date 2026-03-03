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
│                          calls: coordinator.ts, browser.ts, config.ts
├── agent/
│   ├── coordinator.ts    # Coordinator agent: classify → decompose → dispatch workers
│   │                      calls: worker.ts, validator.ts, prompt.ts, extraction.ts
│   ├── worker.ts         # Worker agent: executes single subtask with fresh context
│   │                      calls: provider.ts, actions.ts, history.ts, extraction.ts
│   ├── validator.ts      # Validator agent: verifies subtask completion (1 LLM call)
│   │                      calls: provider.ts, extraction.ts
│   ├── types.ts          # Shared interfaces: Subtask, WorkerReport, ValidationResult, etc.
│   │                      used by: coordinator.ts, worker.ts, validator.ts
│   ├── prompt.ts         # System prompts for all agents + message formatting
│   │                      used by: coordinator.ts, worker.ts, validator.ts
│   └── history.ts        # Conversation history + context management
│                          used by: worker.ts (fresh instance per subtask)
├── llm/
│   ├── provider.ts       # Abstract LLM interface + factory
│   │                      used by: coordinator.ts, worker.ts, validator.ts
│   ├── openai.ts         # OpenAI GPT adapter (implements LLMProvider)
│   │                      used by: provider.ts factory
│   └── anthropic.ts      # Anthropic Claude adapter (implements LLMProvider)
│                          used by: provider.ts factory
├── browser/
│   ├── browser.ts        # Playwright browser manager (persistent profile)
│   │                      calls: Playwright API. used by: index.ts, actions.ts
│   ├── tools.ts          # Tool definitions (JSON schemas for LLM)
│   │                      used by: worker.ts (sent to LLM)
│   ├── actions.ts        # Tool implementations (Playwright actions)
│   │                      calls: browser.ts, extraction.ts. used by: worker.ts
│   └── extraction.ts     # DOM-based element extraction -> numbered refs
│                          calls: page.evaluate() for DOM walking. used by: coordinator.ts, worker.ts, validator.ts
└── utils/
    ├── config.ts         # .env loading, configuration
    │                      used by: everywhere
    └── logger.ts         # Colored terminal output
                           used by: everywhere
```

### Multi-Agent Architecture

```
Task → Coordinator → classify (simple/complex?)
                   ├─ simple → 1 Worker (fresh context) → Validator → done
                   └─ complex → decompose into subtasks
                                  → Worker₁ → Validator₁
                                  → Worker₂ → Validator₂ (sequential, same browser)
                                  → ...
                                  → Coordinator final report
```

### Call Flow

```
index.ts → browser.ts (launch Chromium)
         → coordinator.ts (classify task)
              ├─ simple: create 1 subtask
              └─ complex: decompose via LLM → [subtask₁, subtask₂, ...]
              for each subtask:
                → worker.ts (fresh ConversationHistory, max 15 steps)
                     → extraction.ts (get DOM snapshot)
                     → prompt.ts (build messages)
                     → provider.ts → openai.ts / anthropic.ts (LLM call with tools)
                     → actions.ts → browser.ts (execute tool in browser)
                     → history.ts (save step, manage context window)
                     → repeat until done/max_steps
                → validator.ts (1 LLM call: verify completion)
                     → if not completed: retry worker with feedback (max 2 retries)
              → final report
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
| `LLM_MODEL` | no | `gpt-4.1` / `claude-sonnet-4-20250514` | Model ID (auto-validated against provider) |
| `MAX_ITERATIONS` | no | `50` | Total step budget across all workers |
| `WORKER_MAX_STEPS` | no | `15` | Max steps per worker (per subtask) |

*At least one API key required.

## Key Architecture Decisions

- **Element resolution via numbered refs**: DOM injection через `page.evaluate()` возвращает `[1] button "Submit"`, агент говорит `click(ref: 1)`. Элементы маркируются `data-agent-ref` атрибутами. Никаких хардкод-селекторов. Refs пересоздаются при каждом snapshot.
- **3-level fallback click**: normal click → force click → JS click. Каждый уровень проверяет результат.
- **Smart page load waits**: navigate/click/goBack определяют тип загрузки (навигация vs UI-обновление) и ждут соответственно (`waitForLoadState` вместо хардкод-таймаутов).
- **Persistent browser profile**: `./browser-data/` сохраняет cookies/sessions между запусками. **SECURITY: эта папка в .gitignore, содержит пароли и сессии.**
- **Context management**: DOM-based extraction (компактнее полного DOM) + sliding window истории (последние 8 шагов полные, старые — однострочные summaries) + truncation текста при >4000 символов.
- **Multi-agent architecture (Coordinator → Worker → Validator)**: Coordinator классифицирует задачу (simple/complex), декомпозирует сложные на подзадачи, Worker выполняет каждую подзадачу с ЧИСТЫМ контекстом (свежий ConversationHistory), Validator проверяет результат (1 LLM-вызов). При провале — retry с feedback (макс. 2), при полном провале — re-planning оставшихся подзадач.
- **Self-reflection**: каждые 5 шагов Worker оценивает прогресс. Loop detection ловит A-A-A и A-B-A-B паттерны.
- **Extraction retry**: если DOM extraction упал или вернул 0 элементов — автоматический retry через 2с.

## Conventions

- Tool results: `{ success: boolean, data?: string, error?: string, suggestion?: string }`. Ошибки всегда содержат `suggestion` с конкретным следующим шагом.
- System prompt и tool schemas — на английском (LLM работает точнее). UI/логи — на русском.
- Конфигурация только через `.env`. Шаблон — `.env.example`.
- Новый tool: добавить schema в `tools.ts`, реализацию в `actions.ts`, обработку в `worker.ts`.

## Error Handling

| Ситуация | Поведение |
|----------|-----------|
| `.env` отсутствует или ключ пустой | Crash при старте с понятным сообщением |
| LLM API 429 / 500 / 503 / network error | Retry с exponential backoff (3 попытки), затем сообщение пользователю |
| Playwright timeout (элемент не найден) | Tool возвращает error + suggestion, агент пробует другой подход |
| DOM snapshot пустой (SPA loading) | Агент может использовать `wait(2)` + `screenshot()` для повторной попытки |
| ref не найден (страница изменилась) | Tool возвращает error, агент получает свежий snapshot |
| Worker зациклился (3+ одинаковых действия) | WARNING injection в prompt, Worker меняет стратегию |
| Превышен worker_max_steps (15) | Worker останавливается, Coordinator пробует retry |
| Превышен max_iterations (50 total) | Coordinator останавливается и сообщает о неполном выполнении |
| LLM отвечает без tool calls 3+ раз подряд | Worker завершается с ошибкой (защита от бесконечного цикла) |
| Validator не подтвердил подзадачу | Worker retry с feedback (макс. 2 retry), затем re-planning |

## Known Issues

<!-- Документируй баги и решения здесь по мере разработки -->

| Проблема | Причина | Решение | Статус |
|----------|---------|---------|--------|
| `punycode` deprecation warning | Node.js 24 deprecated встроенный `punycode` модуль | Косметическая проблема, не влияет на работу. Запускать с `node --no-deprecation` | minor |
| `page.accessibility.snapshot()` removed | Playwright 1.58 удалил старый API | Заменено на DOM-based extraction через `page.evaluate()` | fixed |
| Readline ERR_USE_AFTER_CLOSE | stdin закрывается при pipe-вводе | Добавлен флаг `closed` + обработчик `rl.on('close')` | fixed |
| JS click fallback молча "успешен" | `querySelector` возвращает null, код не проверял | `page.evaluate` возвращает boolean, проверка `!clicked` → error | fixed |
| Бесконечный nudge loop | Нет счётчика text-only ответов LLM | `textOnlyRetries >= 3` → return error | fixed |
| `domcontentloaded` не ждёт SPA | SPA рендерит после DOMContentLoaded | `waitUntil: 'load'` + `networkidle(3s)` для navigate/goBack | fixed |
| Хардкод 800мс после клика | Не определяет произошла ли навигация | URL diff до/после → conditional waitForLoadState | fixed |
| Extraction error невидима агенту | Ошибка логируется но не передаётся в snapshot | Retry через 1.5с + explicit ERROR banner в snapshot | fixed |
| Осцилляция не ловится | isLooping проверял только A-A-A | Расширено на A-B-A-B паттерны (4 последних шага) | fixed |
| Дублирование скриншотов | Screenshot после click + в main loop | Убран screenshot из doClick, оставлен только в main loop | fixed |
| Malformed JSON в tool_calls | JSON parse → пустой args → cryptic error | `_parse_error` flag → skip execution, return error | fixed |
