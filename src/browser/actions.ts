import { getActivePage, takeScreenshot } from './browser.js';
import { getRefMap, type ElementRef } from './extraction.js';
import { logger } from '../utils/logger.js';

export interface ToolResult {
  success: boolean;
  data?: string;
  error?: string;
  suggestion?: string;
  screenshot?: Buffer; // attached on error or screenshot tool
}

export async function executeAction(
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    switch (toolName) {
      case 'navigate':    return await doNavigate(args);
      case 'click':       return await doClick(args);
      case 'type_text':   return await doTypeText(args);
      case 'select_option': return await doSelectOption(args);
      case 'scroll':      return await doScroll(args);
      case 'go_back':     return await doGoBack();
      case 'screenshot':  return await doScreenshot();
      case 'wait':        return await doWait(args);
      case 'done':        return doDone(args);
      default:
        return { success: false, error: `Unknown tool: ${toolName}`, suggestion: 'Use one of: navigate, click, type_text, select_option, scroll, go_back, screenshot, wait, done.' };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Tool "${toolName}" failed: ${message}`);

    // Auto-screenshot on error for visual debugging
    let screenshot: Buffer | undefined;
    try { screenshot = await takeScreenshot(); } catch { /* ignore */ }

    return {
      success: false,
      error: message,
      suggestion: 'An unexpected error occurred. Try a different approach or use screenshot to see the current page state.',
      screenshot,
    };
  }
}

// === Tool Implementations ===

async function doNavigate(args: Record<string, unknown>): Promise<ToolResult> {
  const url = args.url as string;
  if (!url) return { success: false, error: 'Missing "url" parameter.', suggestion: 'Provide a full URL like https://google.com' };

  const page = getActivePage();
  logger.action('navigate', url);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  // Extra wait for SPAs
  await page.waitForTimeout(1000);

  return { success: true, data: `Navigated to ${page.url()}` };
}

async function doClick(args: Record<string, unknown>): Promise<ToolResult> {
  const ref = args.ref as number;
  if (ref == null) return { success: false, error: 'Missing "ref" parameter.', suggestion: 'Provide the ref number from the interactive elements list.' };

  const element = resolveRef(ref);
  if (!element) return refNotFoundResult(ref);

  const page = getActivePage();
  logger.action('click', `[${ref}] ${element.role} "${element.name}"`);

  const locator = buildLocator(page, element);
  await locator.click({ timeout: 5000 });
  await page.waitForTimeout(800);

  return { success: true, data: `Clicked [${ref}] ${element.role} "${element.name}"` };
}

async function doTypeText(args: Record<string, unknown>): Promise<ToolResult> {
  const ref = args.ref as number;
  const text = args.text as string;
  const pressEnter = args.press_enter as boolean ?? false;

  if (ref == null) return { success: false, error: 'Missing "ref" parameter.', suggestion: 'Provide the ref number of the text input.' };
  if (!text) return { success: false, error: 'Missing "text" parameter.', suggestion: 'Provide the text to type.' };

  const element = resolveRef(ref);
  if (!element) return refNotFoundResult(ref);

  const page = getActivePage();
  logger.action('type_text', `[${ref}] "${text}"${pressEnter ? ' + Enter' : ''}`);

  const locator = buildLocator(page, element);
  await locator.click({ timeout: 5000 });
  await locator.fill(text);

  if (pressEnter) {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
  }

  return { success: true, data: `Typed "${text}" into [${ref}] ${element.role} "${element.name}"${pressEnter ? ' and pressed Enter' : ''}` };
}

async function doSelectOption(args: Record<string, unknown>): Promise<ToolResult> {
  const ref = args.ref as number;
  const option = args.option as string;

  if (ref == null) return { success: false, error: 'Missing "ref" parameter.', suggestion: 'Provide the ref number of the select element.' };
  if (!option) return { success: false, error: 'Missing "option" parameter.', suggestion: 'Provide the visible text of the option to select.' };

  const element = resolveRef(ref);
  if (!element) return refNotFoundResult(ref);

  const page = getActivePage();
  logger.action('select_option', `[${ref}] option="${option}"`);

  const locator = buildLocator(page, element);
  await locator.selectOption({ label: option }, { timeout: 5000 });

  return { success: true, data: `Selected "${option}" in [${ref}] ${element.role} "${element.name}"` };
}

async function doScroll(args: Record<string, unknown>): Promise<ToolResult> {
  const direction = args.direction as string;
  if (!direction || !['up', 'down'].includes(direction)) {
    return { success: false, error: 'Invalid direction.', suggestion: 'Use "up" or "down".' };
  }

  const page = getActivePage();
  const delta = direction === 'down' ? 600 : -600;
  logger.action('scroll', direction);

  await page.mouse.wheel(0, delta);
  await page.waitForTimeout(500);

  return { success: true, data: `Scrolled ${direction}` };
}

async function doGoBack(): Promise<ToolResult> {
  const page = getActivePage();
  logger.action('go_back', '');

  await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
  await page.waitForTimeout(800);

  return { success: true, data: `Navigated back to ${page.url()}` };
}

async function doScreenshot(): Promise<ToolResult> {
  logger.action('screenshot', '');
  const screenshot = await takeScreenshot();

  return {
    success: true,
    data: 'Screenshot taken. See the attached image.',
    screenshot,
  };
}

async function doWait(args: Record<string, unknown>): Promise<ToolResult> {
  let seconds = args.seconds as number;
  if (!seconds || seconds < 1) seconds = 1;
  if (seconds > 10) seconds = 10;

  logger.action('wait', `${seconds}s`);

  const page = getActivePage();
  await page.waitForTimeout(seconds * 1000);

  return { success: true, data: `Waited ${seconds} seconds` };
}

function doDone(args: Record<string, unknown>): ToolResult {
  const result = args.result as string || 'Task completed.';
  logger.result(`Задача завершена: ${result}`);

  return { success: true, data: result };
}

// === Helpers ===

function resolveRef(ref: number): ElementRef | undefined {
  return getRefMap().get(ref);
}

function refNotFoundResult(ref: number): ToolResult {
  return {
    success: false,
    error: `Element ref=${ref} not found. The page may have changed since the last snapshot.`,
    suggestion: 'Review the updated element list in the current page state and retry with the correct ref number.',
  };
}

function buildLocator(page: ReturnType<typeof getActivePage>, element: ElementRef) {
  // Primary strategy: getByRole with exact name
  // This is the most reliable, no hardcoded selectors
  return page.getByRole(element.role as any, { name: element.name, exact: false });
}
