import { chromium, type Page, type BrowserContext } from 'playwright';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

let context: BrowserContext | null = null;
let activePage: Page | null = null;

export function getActivePage(): Page {
  if (!activePage) throw new Error('Browser not launched. Call launchBrowser() first.');
  return activePage;
}

export function setActivePage(page: Page): void {
  activePage = page;
}

export async function launchBrowser(): Promise<Page> {
  logger.info('Запуск браузера (Chromium)...');

  context = await chromium.launchPersistentContext(config.browserDataDir, {
    headless: false,
    viewport: { width: 1280, height: 720 },
    args: [
      '--disable-blink-features=AutomationControlled',
    ],
  });

  // Handle new tabs/popups — auto-switch focus
  context.on('page', (newPage) => {
    logger.info(`Новая вкладка: ${newPage.url()}`);
    activePage = newPage;
    setupPageListeners(newPage);
  });

  // Get or create the first page
  const pages = context.pages();
  activePage = pages.length > 0 ? pages[0] : await context.newPage();
  setupPageListeners(activePage);

  logger.info('Браузер запущен.');
  return activePage;
}

export async function closeBrowser(): Promise<void> {
  if (context) {
    await context.close();
    context = null;
    activePage = null;
    logger.info('Браузер закрыт.');
  }
}

export async function takeScreenshot(): Promise<Buffer> {
  const page = getActivePage();
  return await page.screenshot({ type: 'png' });
}

function setupPageListeners(page: Page): void {
  // Auto-accept dialogs (alert, confirm, prompt)
  page.on('dialog', async (dialog) => {
    logger.info(`Диалог [${dialog.type()}]: "${dialog.message()}"`);
    await dialog.accept();
  });

  // Log navigation
  page.on('load', () => {
    logger.info(`Страница загружена: ${page.url()}`);
  });

  // Handle page close — switch to another open tab
  page.on('close', () => {
    if (activePage === page && context) {
      const pages = context.pages();
      activePage = pages.length > 0 ? pages[pages.length - 1] : null;
      if (activePage) {
        logger.info(`Вкладка закрыта. Переключение на: ${activePage.url()}`);
      }
    }
  });
}
