# AI Browser Agent - Implementation Plan (v2)

## Context

**Задача**: Разработать автономного AI-агента, управляющего веб-браузером для выполнения сложных многошаговых задач (поиск вакансий, удаление спама, заказ еды и т.д.).

**Ключевые требования из ТЗ**:
- Браузер открывается, пользователь пишет задачу в терминале
- Агент работает полностью автономно
- Никаких хардкод-селекторов, заготовок действий или подсказок по ссылкам
- Обязательно: автоматизация браузера, автономный AI-агент, управление контекстом, продвинутый паттерн

---

## Tech Stack

| Компонент | Технология | Почему |
|-----------|-----------|--------|
| Язык | TypeScript + Node.js | Первоклассная поддержка Playwright, строгая типизация |
| Браузер | **Playwright** | Нативный accessibility tree (ARIA snapshots), auto-wait, CDP |
| AI SDK | **Anthropic SDK** (primary) + **OpenAI SDK** (fallback) | Лучший tool-use, configurable через .env |
| CLI | readline + chalk | Минимальный, красивый терминальный интерфейс |
| Build | tsx (ts-node ESM) | Быстрый запуск без компиляции |

---

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   CLI (TTY)  │────▶│   Agent Loop     │────▶│   LLM Provider  │
│  user input  │◀────│  (orchestrator)  │◀────│  (Claude/GPT)   │
└─────────────┘     └────────┬─────────┘     └─────────────────┘
                             │
                    ┌────────▼─────────┐
                    │  Browser Tools   │
                    │  (Playwright)    │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │  Chromium        │
                    │  (persistent     │
                    │   user profile)  │
                    └──────────────────┘
```

### Core Agent Loop (Orchestrator pattern)

```
1. Получить задачу от пользователя
2. LOOP (max_iterations = 50):
   a. Получить состояние браузера:
      - URL + title
      - ARIA snapshot с пронумерованными refs [1], [2], [3]...
   b. Сформировать messages: system prompt + history + current state
   c. Отправить LLM запрос с tool definitions
   d. LLM возвращает:
      - tool_use → выполнить инструмент, добавить результат в историю
      - text без tool_use → задача завершена, показать результат пользователю
   e. Вывести в терминал текущее действие (chalk)
   f. Каждые 5 шагов: self-reflection (прогресс, ошибки, план)
   g. Повторить
3. При превышении лимита — спросить пользователя, продолжить ли
```

---

## File Structure

```
ai-browser-agent/
├── package.json
├── tsconfig.json
├── .env.example              # API keys template
├── .gitignore
├── src/
│   ├── index.ts              # Entry: CLI + agent bootstrap
│   ├── agent/
│   │   ├── agent.ts          # Core agent loop (orchestrator)
│   │   ├── prompt.ts         # System prompt + message formatting
│   │   └── history.ts        # Conversation history + context management
│   ├── llm/
│   │   ├── provider.ts       # Abstract LLM interface
│   │   ├── anthropic.ts      # Anthropic Claude adapter
│   │   └── openai.ts         # OpenAI GPT adapter
│   ├── browser/
│   │   ├── browser.ts        # Playwright browser manager (launch, close, profile)
│   │   ├── tools.ts          # Tool definitions (JSON schemas for LLM)
│   │   ├── actions.ts        # Tool implementations (execute browser actions)
│   │   └── extraction.ts     # Page state extraction (ARIA tree → numbered refs)
│   └── utils/
│       ├── config.ts         # .env loading, configuration
│       └── logger.ts         # Colored terminal output
```

---

## Critical Design: Element Resolution via Numbered Refs

**Проблема v1**: `click("кнопка Submit")` — ненадёжный natural language → locator перевод.

**Решение v2**: Пронумерованный ARIA snapshot.

### Как это работает:

**1. `extraction.ts` парсит accessibility tree и нумерует интерактивные элементы:**

```
Current page: https://hh.ru (Вакансии)
---
[1] link "Поиск вакансий"
[2] textbox "Профессия, должность" value=""
[3] button "Найти"
[4] link "Москва" (location filter)
[5] link "AI-инженер — от 200 000 ₽"
[6] link "ML Engineer — от 300 000 ₽"
[7] link "Следующая страница"
... (ещё 15 элементов)
Текст на странице: "Найдено 1,247 вакансий по запросу..."
```

**2. Агент видит этот snapshot и решает:**
```json
{ "tool": "click", "ref": 2 }   // кликнуть на textbox
{ "tool": "type_text", "ref": 2, "text": "AI инженер" }
{ "tool": "click", "ref": 3 }   // нажать "Найти"
```

**3. `actions.ts` по ref находит реальный Playwright locator:**
- Хранит Map<ref_number, {role, name, selector}>
- Использует `page.getByRole(role, { name })` — надёжный, не хардкод

### Преимущества:
- Детерминистично (ref=5 всегда один элемент)
- Компактно (20 элементов ≈ 400 токенов vs 50K+ для HTML)
- Нет хардкод-селекторов (ref пересоздаются при каждом snapshot)
- LLM не нужно угадывать CSS/XPath

---

## Browser Tools (9 tools)

| Tool | Parameters | Description |
|------|-----------|-------------|
| `navigate` | `url: string` | Перейти по URL |
| `click` | `ref: number` | Кликнуть элемент по ref из ARIA snapshot |
| `type_text` | `ref: number, text: string, press_enter?: bool` | Ввести текст в поле |
| `select_option` | `ref: number, option: string` | Выбрать опцию в dropdown |
| `scroll` | `direction: "up" \| "down"` | Прокрутить страницу |
| `go_back` | — | Вернуться назад |
| `screenshot` | — | Скриншот (fallback при ошибках или визуально-сложных страницах) |
| `wait` | `seconds: number` | Подождать загрузки (max 10 сек) |
| `done` | `result: string` | Завершить задачу с результатом |

**Убран `ask_user`** — вместо этого агент возвращает текст (без tool_use), CLI показывает его пользователю, пользователь отвечает, и цикл продолжается.

**Убран `get_page_content`** — ARIA snapshot автоматически прикрепляется к каждому шагу в agent loop. Агент всегда видит текущее состояние страницы.

### Tool Error Responses (actionable)

Каждый tool возвращает структурированный результат:
```typescript
type ToolResult = {
  success: boolean;
  data?: string;        // результат действия
  error?: string;       // что пошло не так
  suggestion?: string;  // что делать дальше
}
```

Пример ошибки:
```json
{
  "success": false,
  "error": "Element ref=15 not found — the page may have changed since last snapshot",
  "suggestion": "The page content was refreshed. Review the new element list above and retry with the correct ref."
}
```

---

## Context Management (3 уровня)

### Level 1: ARIA Snapshot (вместо DOM)
- Accessibility tree в 50-100x компактнее raw HTML
- Только интерактивные элементы + ключевой текст
- Автоматически прикрепляется к каждому шагу

### Level 2: Скользящее окно истории
```
messages = [
  { role: "system", content: systemPrompt },
  { role: "user", content: "Задача: ..." },
  // --- старые шаги: сжатый summary ---
  { role: "assistant", content: "Summary steps 1-10: Открыл hh.ru, нашёл вакансии..." },
  // --- последние 5 шагов: полные ---
  { role: "assistant", tool_use: { click, ref: 5 } },
  { role: "tool", result: "Clicked 'AI-инженер'. Page loaded." },
  ...
  // --- текущее состояние ---
  { role: "user", content: "Current page state:\n[ARIA SNAPSHOT]" }
]
```

### Level 3: Truncation больших страниц
- Если ARIA snapshot > 4000 токенов → обрезаем, добавляем hint:
  `"... (truncated, 47 more elements). Use scroll('down') to see more."`
- Текстовый контент страницы → первые 2000 символов + "..."

### Summarization: без отдельного LLM-вызова
- Простая стратегия: храним `stepSummaries: string[]`
- После каждого tool_use сохраняем однострочный summary: `"Step 5: Clicked 'Найти' on hh.ru search page"`
- При > 10 шагов: старые шаги заменяются на массив summaries
- Не требует дополнительных API-вызовов

---

## Advanced Pattern: Self-Reflection

После каждых 5 шагов в system prompt добавляется:

```
REFLECTION REQUIRED: You have completed 5 steps. Before your next action:
1. What is your current progress toward the goal?
2. Are you stuck or going in circles?
3. What should you do next and why?

Output your reflection as text, then proceed with the next tool call.
```

При обнаружении зацикливания (одинаковые действия 3 раза подряд):
```
WARNING: You appear to be repeating the same action.
Stop and try a completely different approach.
```

---

## Browser Profile (авторизация)

Для задач типа "удали спам из почты" пользователь должен быть залогинен.

**Решение**: Persistent browser profile.
```typescript
// browser.ts
const context = await browser.launchPersistentContext(
  './browser-data',  // сохраняет cookies, localStorage, sessions
  { headless: false, viewport: { width: 1280, height: 720 } }
);
```

- Первый запуск: пустой профиль, пользователь логинится вручную
- Последующие запуски: сессии сохранены, авторизация помнится
- Аналогично тому, как работает обычный браузер

---

## Multi-tab / Popup Handling

```typescript
// browser.ts — слушаем новые страницы
context.on('page', (newPage) => {
  // Автоматически переключаем фокус на новую вкладку
  activePage = newPage;
  logger.info(`New tab opened: ${newPage.url()}`);
});

// Обработка диалогов (alert, confirm, prompt)
page.on('dialog', async (dialog) => {
  logger.info(`Dialog: ${dialog.type()} — "${dialog.message()}"`);
  await dialog.accept(); // по умолчанию принимаем
});
```

---

## Screenshot Strategy

**Не на каждом шаге** (дорого). Используем в 3 случаях:

1. **При ошибке** — если tool вернул error, автоматически делаем скриншот и прикладываем к следующему LLM-вызову
2. **По запросу агента** — tool `screenshot` доступен, агент может вызвать когда нужно визуальное понимание
3. **На сложных страницах** — если ARIA snapshot пустой или очень маленький (canvas, WebGL)

---

## Implementation Steps (порядок разработки)

### Step 1: Project Scaffold (~5 min)
- `package.json` с зависимостями, `tsconfig.json`, `.env.example`, `.gitignore`
- Создать структуру директорий

### Step 2: Config + Logger (~5 min)
- `config.ts` — загрузка .env, определение провайдера
- `logger.ts` — chalk-based цветной вывод (action, result, error, info)

### Step 3: Browser Layer (~30 min)
- `browser.ts` — launch persistent context, page management, new tab handling, dialog handling
- `extraction.ts` — **ключевой файл**: ARIA tree → numbered refs + page text extraction
- `tools.ts` — JSON schemas для 9 инструментов
- `actions.ts` — реализация каждого инструмента через Playwright

### Step 4: LLM Provider Layer (~20 min)
- `provider.ts` — интерфейс `LLMProvider { chat(messages, tools): LLMResponse }`
- `anthropic.ts` — Anthropic Messages API с tool_use
- `openai.ts` — OpenAI Chat Completions с function calling

### Step 5: Agent Core (~30 min)
- `prompt.ts` — system prompt (роль, правила, tool docs) + message builder
- `history.ts` — sliding window, step summaries, truncation
- `agent.ts` — main loop: state → LLM → tool → result → repeat

### Step 6: CLI + Entry Point (~15 min)
- `index.ts` — readline loop, запуск браузера, запуск агента, graceful shutdown

### Step 7: Self-Reflection + Polish (~15 min)
- Reflection prompt каждые 5 шагов
- Loop detection (одинаковые действия подряд)
- Ctrl+C handling

---

## Verification

1. **Smoke**: "Открой google.com и найди погоду в Москве" (3-5 шагов)
2. **Navigation**: "Зайди на hh.ru и найди 3 вакансии AI-инженера" (10-15 шагов)
3. **Forms**: "Зайди на google.com и поищи 'best restaurants in Moscow'" (5 шагов, type + enter)
4. **Long task**: 20+ шагов — проверка context management
5. **Error recovery**: дать невалидный URL — агент должен восстановиться
6. **Video**: Playwright `recordVideo` для демо-записи

---

## Launch

```bash
npm install && npx playwright install chromium

# С Anthropic
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
npx tsx src/index.ts

# С OpenAI
echo "OPENAI_API_KEY=sk-..." > .env
npx tsx src/index.ts
```
