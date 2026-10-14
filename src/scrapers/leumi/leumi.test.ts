import { LoginResults } from '../base-scraper-with-browser';
import LeumiScraper from './leumi';
import { SHEKEL_CURRENCY } from '../../constants';
import { SCRAPERS } from '../../definitions';
import { getDebug } from '../../helpers/debug';
import { exportTransactions, extendAsyncTimeout, getTestsConfig, maybeTestCompanyAPI } from '../../tests/tests-utils';

const COMPANY_ID = 'leumi'; // TODO this property should be hard-coded in the provider
const testsConfig = getTestsConfig();
const debug = getDebug('leumi-test');

/** A fake page with everything the login flow and its tracing call. */
function fakePage(overrides: Record<string, unknown> = {}) {
  return {
    waitForSelector: jest.fn().mockResolvedValue(undefined),
    waitForFunction: jest.fn().mockResolvedValue(undefined),
    waitForResponse: jest.fn().mockResolvedValue(undefined),
    evaluate: jest.fn().mockResolvedValue({ title: '', text: '' }),
    $eval: jest.fn().mockResolvedValue('https://hb2.bankleumi.co.il/H/Login.html'),
    click: jest.fn().mockResolvedValue(undefined),
    goto: jest.fn().mockResolvedValue(undefined),
    waitForNavigation: jest.fn().mockResolvedValue(undefined),
    url: jest.fn().mockReturnValue('https://hb2.bankleumi.co.il/staticcontent/gate-keeper/he/'),
    on: jest.fn(),
    mainFrame: jest.fn(),
    ...overrides,
  };
}

describe('Leumi legacy scraper', () => {
  beforeAll(() => {
    extendAsyncTimeout(); // The default timeout is 5 seconds per async test, this function extends the timeout value
  });

  test('should expose login fields in scrapers constant', () => {
    expect(SCRAPERS.leumi).toBeDefined();
    expect(SCRAPERS.leumi.loginFields).toContain('username');
    expect(SCRAPERS.leumi.loginFields).toContain('password');
  });

  test('should start on the home page and click through to the login form', async () => {
    const page = fakePage();
    const scraper = new LeumiScraper({
      ...testsConfig.options,
      companyId: COMPANY_ID,
    });

    (scraper as any).page = page;

    const loginOptions = scraper.getLoginOptions({ username: 'user', password: 'password' });
    await loginOptions.checkReadiness?.();

    expect(loginOptions.loginUrl).toBe('https://www.leumi.co.il/he');
    expect(loginOptions.waitUntil).toBe('domcontentloaded');
    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), '.cookie-alert .hide-alert');
    expect(page.click).toHaveBeenCalledWith('.enter_account');
    expect(page.waitForSelector).toHaveBeenCalledWith('input[placeholder="שם משתמש"]', expect.anything());
    expect(page.goto).not.toHaveBeenCalled();
    expect(page.waitForNavigation).not.toHaveBeenCalled();
    // The login app must have started before the form is filled; listening starts before the click.
    expect(page.waitForResponse).toHaveBeenCalledWith(expect.any(Function), { timeout: 30000 });
    expect(page.waitForResponse.mock.invocationCallOrder[0]).toBeLessThan(page.click.mock.invocationCallOrder[0]);
    const isAppReady = page.waitForResponse.mock.calls[0][0];
    expect(isAppReady({ url: () => 'https://sa.bankleumi.co.il/api/v2/auth/key_exchange' })).toBe(true);
    expect(isAppReady({ url: () => 'https://sa.bankleumi.co.il/api/v2/auth/assert' })).toBe(false);
  });

  test('should continue when the login navigation is aborted by a redirect, and only then', async () => {
    const scraper = new LeumiScraper({
      ...testsConfig.options,
      companyId: COMPANY_ID,
    });
    const aborted = new Error('net::ERR_ABORTED at https://hb2.bankleumi.co.il/H/Login.html');
    const goto = jest.fn().mockRejectedValue(aborted);
    (scraper as any).page = { goto };
    const loginPage = 'https://hb2.bankleumi.co.il/H/Login.html';

    await expect(scraper.navigateTo(loginPage, 'domcontentloaded')).resolves.toBeUndefined();
    await expect(scraper.navigateTo('https://hb2.bankleumi.co.il/other', 'domcontentloaded')).rejects.toThrow(aborted);

    goto.mockRejectedValue(new Error('Navigation timeout of 30000 ms exceeded'));
    await expect(scraper.navigateTo(loginPage, 'domcontentloaded')).rejects.toThrow('Navigation timeout');
  });

  test('should start loading the home page without waiting for it to finish', async () => {
    const scraper = new LeumiScraper({
      ...testsConfig.options,
      companyId: COMPANY_ID,
    });
    const goto = jest.fn().mockReturnValue(new Promise(() => {}));
    (scraper as any).page = fakePage({ goto });
    const homeUrl = scraper.getLoginOptions({ username: 'user', password: 'password' }).loginUrl;

    await expect(scraper.navigateTo(homeUrl, 'domcontentloaded')).resolves.toBeUndefined();
    expect(goto).toHaveBeenCalledWith('https://www.leumi.co.il/he');
  });

  test('should not wait for another navigation after opening the login page', async () => {
    const page = fakePage({ waitForNavigation: jest.fn().mockRejectedValue(new Error('no second navigation')) });
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
    const page = fakePage();
    const scraper = new LeumiScraper(options as any);

    (scraper as any).page = page;

    await scraper.getLoginOptions({ username: 'user', password: 'password' }).postAction?.();

    expect(page.waitForSelector).toHaveBeenCalledWith(
      'xpath//div[contains(string(),"אחד או יותר מפרטי ההזדהות שמסרת שגויים. ניתן לנסות שוב")]',
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

    // Validate savings accounts if they exist
    expect(result.accounts).toBeDefined();
    const savingsAccounts = result.accounts?.filter(account => account.savingsAccount === true);

    debug('Total accounts:', result.accounts?.length);
    debug('Savings accounts found:', savingsAccounts?.length);

    if (savingsAccounts && savingsAccounts.length > 0) {
      debug('Savings account details:');
      savingsAccounts.forEach(account => {
        debug(`  - Account: ${account.accountNumber}, Balance: ${account.balance}`);
      });

      // Verify savings account properties
      savingsAccounts.forEach(account => {
        expect(account.savingsAccount).toBe(true);
        expect(account.accountNumber).toMatch(/ID/);
        expect(account.balance).toBeDefined();
        expect(account.txns).toBeDefined();
      });
    } else {
      debug('No savings accounts found - this may be expected if the test account has no deposits');
    }

    // Validate foreign currency accounts if they exist
    const foreignCurrencyAccounts = result.accounts?.filter(
      account => !!account.currency && account.currency !== SHEKEL_CURRENCY,
    );

    debug('Foreign currency accounts found:', foreignCurrencyAccounts?.length);

    if (foreignCurrencyAccounts && foreignCurrencyAccounts.length > 0) {
      debug('Foreign currency account details:');
      foreignCurrencyAccounts.forEach(account => {
        debug(
          `  - Account: ${account.accountNumber}, Currency: ${account.currency}, Balance: ${account.balance}, Transactions: ${account.txns.length}`,
        );
      });

      foreignCurrencyAccounts.forEach(account => {
        expect(account.accountNumber).toMatch(new RegExp(`-${account.currency}$`));
        expect(account.balance).toBeDefined();
        expect(account.txns).toBeDefined();

        account.txns.forEach(txn => {
          expect(txn.originalCurrency).toBe(account.currency);
          expect(txn.chargedCurrency).toBe(account.currency);
          expect(txn.date).toBeDefined();
          expect(Number.isNaN(txn.originalAmount)).toBe(false);
        });
      });
    } else {
      debug('No foreign currency accounts found - this may be expected if the test account has none');
    }
  });
});
