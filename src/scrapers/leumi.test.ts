import LeumiScraper from './leumi';
import { maybeTestCompanyAPI, extendAsyncTimeout, getTestsConfig, exportTransactions } from '../tests/tests-utils';
import { SCRAPERS } from '../definitions';
import { LoginResults } from './base-scraper-with-browser';

const COMPANY_ID = 'leumi'; // TODO this property should be hard-coded in the provider
const testsConfig = getTestsConfig();

describe('Leumi legacy scraper', () => {
  beforeAll(() => {
    extendAsyncTimeout(); // The default timeout is 5 seconds per async test, this function extends the timeout value
  });

  test('should expose login fields in scrapers constant', () => {
    expect(SCRAPERS.leumi).toBeDefined();
    expect(SCRAPERS.leumi.loginFields).toContain('username');
    expect(SCRAPERS.leumi.loginFields).toContain('password');
  });

  test('should close the cookie alert before reading the login link', async () => {
    let cookieAlertClosed = false;
    const page = {
      waitForSelector: jest.fn().mockResolvedValue(undefined),
      waitForFunction: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn().mockImplementation(() => {
        cookieAlertClosed = true;
        return Promise.resolve();
      }),
      $eval: jest.fn().mockImplementation(() => {
        if (!cookieAlertClosed) {
          throw new Error('cookie alert blocks the login link');
        }

        return Promise.resolve('https://hb2.bankleumi.co.il/login');
      }),
      goto: jest.fn().mockResolvedValue(undefined),
      waitForNavigation: jest.fn().mockResolvedValue(undefined),
    };
    const scraper = new LeumiScraper({
      ...testsConfig.options,
      companyId: COMPANY_ID,
    });

    (scraper as any).page = page;

    await scraper.getLoginOptions({ username: 'user', password: 'password' }).checkReadiness?.();

    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), '.cookie-alert .hide-alert');
    expect(page.goto).toHaveBeenCalledWith('https://hb2.bankleumi.co.il/login', { waitUntil: 'networkidle2' });
  });

  test('should not wait for another navigation after opening the login page', async () => {
    const page = {
      waitForSelector: jest.fn().mockResolvedValue(undefined),
      waitForFunction: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn().mockResolvedValue(undefined),
      $eval: jest.fn().mockResolvedValue('https://hb2.bankleumi.co.il/login'),
      goto: jest.fn().mockResolvedValue(undefined),
      waitForNavigation: jest.fn().mockRejectedValue(new Error('no second navigation')),
    };
    const scraper = new LeumiScraper({
      ...testsConfig.options,
      companyId: COMPANY_ID,
    });

    (scraper as any).page = page;

    await expect(scraper.getLoginOptions({ username: 'user', password: 'password' }).checkReadiness?.()).resolves.toBe(
      undefined,
    );

    expect(page.waitForNavigation).not.toHaveBeenCalled();
  });

  test('should wait longer for the invalid password message after login', async () => {
    const options = {
      companyId: COMPANY_ID,
      startDate: new Date('2026-05-25T00:00:00.000Z'),
    };
    const page = {
      waitForSelector: jest.fn().mockResolvedValue(undefined),
      waitForFunction: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn().mockResolvedValue(undefined),
      $eval: jest.fn().mockResolvedValue('https://hb2.bankleumi.co.il/login'),
      goto: jest.fn().mockResolvedValue(undefined),
      waitForNavigation: jest.fn().mockResolvedValue(undefined),
    };
    const scraper = new LeumiScraper(options as any);

    (scraper as any).page = page;

    await scraper.getLoginOptions({ username: 'user', password: 'password' }).postAction?.();

    expect(page.waitForSelector).toHaveBeenCalledWith(
      `xpath//div[contains(string(),"אחד או יותר מפרטי ההזדהות שמסרת שגויים. ניתן לנסות שוב")]`,
      { timeout: 60000 },
    );
  });

  maybeTestCompanyAPI(COMPANY_ID, config => config.companyAPI.invalidPassword)(
    'should fail on invalid user/password"',
    async () => {
      const options = {
        ...testsConfig.options,
        companyId: COMPANY_ID,
      };

      const scraper = new LeumiScraper(options);

      const result = await scraper.scrape({ username: 'e10s12', password: '3f3ss3d' });

      expect(result).toBeDefined();
      expect(result.success).toBeFalsy();
      expect(result.errorType).toBe(LoginResults.InvalidPassword);
    },
  );

  maybeTestCompanyAPI(COMPANY_ID)('should scrape transactions', async () => {
    const options = {
      ...testsConfig.options,
      companyId: COMPANY_ID,
    };

    const scraper = new LeumiScraper(options);
    const result = await scraper.scrape(testsConfig.credentials.leumi);
    expect(result).toBeDefined();
    const error = `${result.errorType || ''} ${result.errorMessage || ''}`.trim();
    expect(error).toBe('');
    expect(result.success).toBeTruthy();

    exportTransactions(COMPANY_ID, result.accounts || []);
  });
});
