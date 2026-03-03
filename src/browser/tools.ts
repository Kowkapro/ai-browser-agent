import type { ToolDefinition } from '../llm/provider.js';

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'navigate',
    description:
      'Navigate the browser to a URL. Use this to open websites. ' +
      'You can use full URLs (https://google.com) or search by navigating to a search engine first.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to navigate to (must include https://)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'click',
    description:
      'Click on an interactive element identified by its ref number from the page snapshot. ' +
      'Use the [ref] numbers shown in the "Interactive elements" list.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'number', description: 'The ref number of the element to click (e.g. 3)' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'type_text',
    description:
      'Type text into an input field identified by its ref number. ' +
      'This will click the field first, clear existing text, then type the new text. ' +
      'Set press_enter=true to submit a form or search after typing.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'number', description: 'The ref number of the text input element' },
        text: { type: 'string', description: 'The text to type into the field' },
        press_enter: { type: 'boolean', description: 'Whether to press Enter after typing (default: false)' },
      },
      required: ['ref', 'text'],
    },
  },
  {
    name: 'select_option',
    description:
      'Select an option from a dropdown/select element by its ref number. ' +
      'Provide the visible text of the option you want to select.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'number', description: 'The ref number of the select/combobox element' },
        option: { type: 'string', description: 'The visible text of the option to select' },
      },
      required: ['ref', 'option'],
    },
  },
  {
    name: 'scroll',
    description:
      'Scroll the page up or down to reveal more content. ' +
      'Use this when you need to see elements below or above the current viewport, ' +
      'or when the element list says "truncated".',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', description: 'Scroll direction: "up" or "down"', enum: ['up', 'down'] },
      },
      required: ['direction'],
    },
  },
  {
    name: 'go_back',
    description:
      'Navigate back to the previous page (like pressing the browser Back button). ' +
      'Use this when you need to return to a previous page.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'screenshot',
    description:
      'Take a screenshot of the current page. Use this when: ' +
      '1) The element list is empty or confusing and you need visual context. ' +
      '2) You need to verify visual layout (images, charts, CAPTCHAs). ' +
      '3) After an error, to understand what happened.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'wait',
    description:
      'Wait for a specified number of seconds for dynamic content to load. ' +
      'Use this when a page is loading or when elements have not appeared yet. Max 10 seconds.',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'Seconds to wait (1-10)' },
      },
      required: ['seconds'],
    },
  },
  {
    name: 'wait_for_user',
    description:
      'Pause and ask the user to perform an action in the browser manually. ' +
      'Use this when you encounter: login pages, CAPTCHAs, two-factor authentication, ' +
      'payment forms, or anything that requires the user\'s personal credentials. ' +
      'The browser border will disappear and the user will see your message. ' +
      'The agent will resume after the user presses Enter.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'What the user needs to do, e.g. "Please log in to your account"' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'press_key',
    description:
      'Press a keyboard key or key combination. Use this for: ' +
      'Escape (close popups/modals), Tab (switch focus), Enter (submit), ' +
      'ArrowDown/ArrowUp (navigate lists), Backspace, Delete, ' +
      'or combinations like "Control+a" (select all), "Control+c" (copy).',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key to press, e.g. "Escape", "Tab", "Enter", "ArrowDown", "Control+a"' },
      },
      required: ['key'],
    },
  },
  {
    name: 'done',
    description:
      'Signal that the task is complete. Provide a summary of what was accomplished. ' +
      'Use this ONLY when the user\'s task has been fully completed.',
    parameters: {
      type: 'object',
      properties: {
        result: { type: 'string', description: 'Summary of what was accomplished' },
      },
      required: ['result'],
    },
  },
];
