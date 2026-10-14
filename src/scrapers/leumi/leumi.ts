import moment, { type Moment } from 'moment';
import { type Page, type PuppeteerLifeCycleEvent } from 'puppeteer';
import { SHEKEL_CURRENCY } from '../../constants';
import { getDebug } from '../../helpers/debug';
import { clickButton, fillInput, pageEvalAll, waitUntilElementFound } from '../../helpers/elements-interactions';
import { fetchGetWithinPage } from '../../helpers/fetch';
import { getRawTransaction } from '../../helpers/transactions';
import { TransactionStatuses, TransactionTypes, type Transaction, type TransactionsAccount } from '../../transactions';
import { BaseScraperWithBrowser, LoginResults, type LoginOptions } from '../base-scraper-with-browser';
import { type ScraperOptions, type ScraperScrapingResult } from '../interface';
import { fetchForeignCurrencyAccounts } from './leumi-forex';

const debug = getDebug('leumi');
const BASE_URL = 'https://hb2.bankleumi.co.il';
// Login starts on the home page and clicks "כניסה לחשבון", the way a person arrives at the login
// page. Its "load" event can take longer than the navigation timeout (trackers, rate widgets), so
// only the HTML is awaited. Going straight to LOGIN_URL worked until Leumi's firewall started
// rejecting the login (2026-10-14).
const HOME_URL = 'https://www.leumi.co.il/he';
const LOGIN_URL = `${BASE_URL}/H/Login.html`;
const ENTER_ACCOUNT_SELECTOR = '.enter_account';
const LOGIN_APP_READY_PATH = '/api/v2/auth/key_exchange';
const LOGIN_APP_READY_TIMEOUT = 30000;
const TRANSACTIONS_URL = `${BASE_URL}/eBanking/SO/SPA.aspx#/ts/BusinessAccountTrx?WidgetPar=1`;
const FILTERED_TRANSACTIONS_URL = `${BASE_URL}/ChannelWCF/Broker.svc/ProcessRequest?moduleName=UC_SO_27_GetBusinessAccountTrx`;
const SAVINGS_URL = `${BASE_URL}/uiapiproxy/v1/digital-retails/mobile/accounts/1/Deposits?operationList=true`;

const DATE_FORMAT = 'DD.MM.YY';
const ACCOUNT_BLOCKED_MSG = 'המנוי חסום';
const INVALID_PASSWORD_MSG = 'אחד או יותר מפרטי ההזדהות שמסרת שגויים. ניתן לנסות שוב';
const CHANGE_PASSWORD_MODAL_SELECTOR = 'form input[name="newPwd"]';
const COOKIE_ALERT_CLOSE_SELECTOR = '.cookie-alert .hide-alert';

interface SavingsDepositItem {
  index: string;
  depositId: string;
  depositIndex: number;
  depositSourceId: string;
  type: number;
  displayName: string;
  productName: string;
  friendlyAccountName: string;
  deepLink: string;
  isForeclosed: boolean;
  asOfDate: string;
  createDate: string;
  exitPointDate: string;
  currentBalance: number;
  initialAmount: number | null;
  installmentsSavingFlag: boolean;
  marginRate: string;
  productInterestType: string | null;
  productLinkageType: string | null;
  sourceSystem: string;
  depositNumber: string;
  relatedAccountNumber: string;
  withdrawalRequestText: string | null;
  WithdrawalAvailableFrequency: string | null;
  depositOperationsItems: any[];
}

interface SavingsAccountData {
  totalDepositsAndSavingsBalance: number;
  previousBusinessDayDate: string;
  depositsAndSavingsItems: SavingsDepositItem[];
  operationsItemsTotal: string;
  operationsListItems: any[];
}

function getPossibleLoginResults() {
  const urls: LoginOptions['possibleResults'] = {
    [LoginResults.Success]: [/ebanking\/SO\/SPA.aspx/i],
    [LoginResults.InvalidPassword]: [
      async options => {
        if (!options || !options.page) {
          throw new Error('missing page options argument');
        }
        const errorMessage = await pageEvalAll(options.page, 'svg#Capa_1', '', element => {
          return (element[0]?.parentElement?.children[1] as HTMLDivElement)?.innerText;
        });

        return errorMessage?.startsWith(INVALID_PASSWORD_MSG);
      },
    ],
    [LoginResults.AccountBlocked]: [
      // NOTICE - might not be relevant starting the Leumi re-design during 2022 Sep
      async options => {
        if (!options || !options.page) {
          throw new Error('missing page options argument');
        }
        const errorMessage = await pageEvalAll(options.page, '.errHeader', '', label => {
          return (label[0] as HTMLElement)?.innerText;
        });

        return errorMessage?.startsWith(ACCOUNT_BLOCKED_MSG);
      },
    ],
    [LoginResults.ChangePassword]: [
      async options => {
        if (!options || !options.page) {
          throw new Error('missing page options argument');
        }
        return !!(await options.page.$(CHANGE_PASSWORD_MODAL_SELECTOR));
      },
    ],
  };
  return urls;
}

function createLoginFields(credentials: ScraperSpecificCredentials) {
  return [
    { selector: 'input[placeholder="שם משתמש"]', value: credentials.username },
    { selector: 'input[placeholder="סיסמה"]', value: credentials.password },
  ];
}

function extractTransactionsFromPage(
  transactions: any[],
  status: TransactionStatuses,
  options?: ScraperOptions,
): Transaction[] {
  if (transactions === null || transactions.length === 0) {
    return [];
  }

  const result: Transaction[] = transactions.map(rawTransaction => {
    const date = moment(rawTransaction.DateUTC).milliseconds(0).toISOString(true);
    const newTransaction: Transaction = {
      status,
      type: TransactionTypes.Normal,
      date,
      processedDate: date,
      description: rawTransaction.Description || '',
      identifier: rawTransaction.ReferenceNumberLong,
      memo: rawTransaction.AdditionalData || '',
      originalCurrency: SHEKEL_CURRENCY,
      chargedAmount: rawTransaction.Amount,
      originalAmount: rawTransaction.Amount,
    };

    if (options?.includeRawTransaction) {
      newTransaction.rawTransaction = getRawTransaction(rawTransaction);
    }

    return newTransaction;
  });

  return result;
}

function hangProcess(timeout: number) {
  return new Promise<void>(resolve => {
    setTimeout(() => {
      resolve();
    }, timeout);
  });
}

async function clickByXPath(page: Page, xpath: string): Promise<void> {
  await page.waitForSelector(xpath, { timeout: 30000, visible: true });
  const elm = await page.$$(xpath);
  await elm[0].click();
}

function removeSpecialCharacters(str: string): string {
  return str.replace(/[^0-9/-]/g, '');
}

const ACCOUNT_NUMBER_SELECTOR = 'app-masked-number-combo span.display-number-li';
const ACCOUNT_TEXT_RE = /[^0-9/-]/g;

function normalizeAccountText(text: string): string {
  return text.replace(ACCOUNT_TEXT_RE, '');
}

async function clickAccountById(page: Page, accountId: string): Promise<void> {
  // Account labels may contain invisible bidi/whitespace chars; normalize before matching.
  const expected = normalizeAccountText(accountId);
  await page.waitForFunction(
    (selector, expected, reSource) => {
      const re = new RegExp(reSource, 'g');
      const normalize = (text = '') => text.replace(re, '');
      const elements = Array.from(document.querySelectorAll(selector));
      return elements.some(el => normalize(el.textContent || '') === expected);
    },
    {},
    ACCOUNT_NUMBER_SELECTOR,
    expected,
    ACCOUNT_TEXT_RE.source,
  );

  const clicked = await page.evaluate(
    (selector, expected, reSource) => {
      const re = new RegExp(reSource, 'g');
      const normalize = (text = '') => text.replace(re, '');
      const elements = Array.from(document.querySelectorAll(selector));
      const match = elements.find(el => normalize(el.textContent || '') === expected);
      if (!match) {
        return false;
      }
      (match as HTMLElement).click();
      return true;
    },
    ACCOUNT_NUMBER_SELECTOR,
    expected,
    ACCOUNT_TEXT_RE.source,
  );

  if (!clicked) {
    throw new Error(`Failed to click account option for "${expected}"`);
  }
}

async function closeCookieAlert(page: Page): Promise<void> {
  await page.evaluate(selector => {
    document.querySelector<HTMLElement>(selector)?.click();
  }, COOKIE_ALERT_CLOSE_SELECTOR);
}

async function fetchTransactionsForAccount(
  page: Page,
  startDate: Moment,
  accountId: string,
  options: ScraperOptions,
): Promise<TransactionsAccount> {
  // DEVELOPER NOTICE the account number received from the server is being altered at
  // runtime for some accounts after 1-2 seconds so we need to hang the process for a short while.
  await hangProcess(4000);

  await waitUntilElementFound(page, 'button[title="חיפוש מתקדם"]', true);
  await clickButton(page, 'button[title="חיפוש מתקדם"]');
  await waitUntilElementFound(page, 'bll-radio-button', true);
  await clickButton(page, 'bll-radio-button:not([checked])');

  await waitUntilElementFound(page, 'input[formcontrolname="txtInputFrom"]', true);

  await fillInput(page, 'input[formcontrolname="txtInputFrom"]', startDate.format(DATE_FORMAT));

  // we must blur the from control otherwise the search will use the previous value
  await page.focus("button[aria-label='סנן']");

  await clickButton(page, "button[aria-label='סנן']");
  const finalResponse = await page.waitForResponse(response => {
    return response.url() === FILTERED_TRANSACTIONS_URL && response.request().method() === 'POST';
  });

  const responseJson: any = await finalResponse.json();

  const accountNumber = accountId.replace('/', '_').replace(/[^\d-_]/g, '');

  const response = JSON.parse(responseJson.jsonResp);

  const pendingTransactions = response.TodayTransactionsItems;
  const transactions = response.HistoryTransactionsItems;
  const balance = response.BalanceDisplay ? parseFloat(response.BalanceDisplay) : undefined;

  const pendingTxns = extractTransactionsFromPage(pendingTransactions, TransactionStatuses.Pending, options);
  const completedTxns = extractTransactionsFromPage(transactions, TransactionStatuses.Completed, options);
  const txns = [...pendingTxns, ...completedTxns];

  return {
    accountNumber,
    balance,
    txns,
  };
}

async function fetchRegularAccounts(
  scraper: LeumiScraper,
  page: Page,
  startDate: Moment,
  options: ScraperOptions,
): Promise<TransactionsAccount[]> {
  await scraper.navigateTo(TRANSACTIONS_URL);
  return fetchTransactions(page, startDate, options);
}

async function getSavingsAccounts(page: Page, accountId: string): Promise<TransactionsAccount[]> {
  debug('========== FETCHING SAVINGS ACCOUNTS ==========');
  debug('Account: %s', accountId);

  const accounts: TransactionsAccount[] = [];

  try {
    debug('Trying savings URL: %s', SAVINGS_URL);

    const savingsData = await fetchGetWithinPage<SavingsAccountData>(page, SAVINGS_URL);
    if (!savingsData || !savingsData.depositsAndSavingsItems || savingsData.depositsAndSavingsItems.length === 0) {
      debug('No savings accounts found for account %s', accountId);
      return [];
    }
    debug('✓ Found %d savings deposits', savingsData.depositsAndSavingsItems.length);

    // Create a separate account for each individual deposit
    for (const deposit of savingsData.depositsAndSavingsItems) {
      const balance = deposit.currentBalance;
      const savingsAccountNumber = `${accountId}-${deposit.depositId}`;

      accounts.push({
        accountNumber: savingsAccountNumber,
        savingsAccount: true,
        balance,
        txns: [],
      });

      debug(
        'Added savings account %s with balance %s (product: %s)',
        savingsAccountNumber,
        balance,
        deposit.productName,
      );
    }
  } catch (error) {
    debug('  - Error fetching savings accounts: %s', error);
  }

  debug('Returning %d savings accounts', accounts.length);
  return accounts;
}

async function fetchTransactions(
  page: Page,
  startDate: Moment,
  options: ScraperOptions,
): Promise<TransactionsAccount[]> {
  const accounts: TransactionsAccount[] = [];

  // DEVELOPER NOTICE the account number received from the server is being altered at
  // runtime for some accounts after 1-2 seconds so we need to hang the process for a short while.
  await hangProcess(4000);

  const accountsIds = (await page.evaluate(() =>
    Array.from(document.querySelectorAll('app-masked-number-combo span.display-number-li'), e => e.textContent),
  )) as string[];

  // due to a bug, the altered value might include undesired signs like & that should be removed

  if (!accountsIds.length) {
    throw new Error('Failed to extract or parse the account number');
  }

  for (const accountId of accountsIds) {
    if (accountsIds.length > 1) {
      // get list of accounts and check accountId
      await clickByXPath(page, 'xpath///*[contains(@class, "number") and contains(@class, "combo-inner")]');
      await clickAccountById(page, accountId);
    }

    accounts.push(await fetchTransactionsForAccount(page, startDate, removeSpecialCharacters(accountId), options));
  }

  return accounts;
}

async function fetchSavingsAccounts(
  page: Page,
  regularAccounts: TransactionsAccount[],
): Promise<TransactionsAccount[]> {
  const allSavingsAccounts: TransactionsAccount[] = [];
  const regularAccountCount = regularAccounts.length;

  for (let i = 0; i < regularAccountCount; i++) {
    try {
      const savingsAccounts = await getSavingsAccounts(page, regularAccounts[i].accountNumber);
      allSavingsAccounts.push(...savingsAccounts);
      debug('Added %d savings accounts to results', savingsAccounts.length);
    } catch (error) {
      debug('Error fetching savings accounts for %s: %s', regularAccounts[i].accountNumber, error);
    }
  }

  return allSavingsAccounts;
}

// --- Login tracing (debug namespace israeli-bank-scrapers:leumi). Never logs credentials,
// request bodies, or query strings. ---

const tracedPages = new WeakSet<Page>();
const TRACED_RESOURCE_TYPES = ['document', 'xhr', 'fetch'];

/** Origin and path only, so tracking codes and tokens in query strings never reach the log. */
function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.slice(0, 120);
  }
}

/** Logs page changes, Leumi page and API responses, failed requests, and page script errors. */
function traceLeumiPage(page: Page): void {
  if (tracedPages.has(page)) return;
  tracedPages.add(page);
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) debug(`page changed: ${shortUrl(frame.url())}`);
  });
  page.on('response', response => {
    const request = response.request();
    const type = request.resourceType();
    if (!TRACED_RESOURCE_TYPES.includes(type) || !/leumi/i.test(response.url())) return;
    const location = response.headers().location;
    const redirect = location ? ` -> ${shortUrl(location)}` : '';
    debug(`${type} ${request.method()} ${response.status()} ${shortUrl(response.url())}${redirect}`);
  });
  page.on('requestfailed', request => {
    if (!TRACED_RESOURCE_TYPES.includes(request.resourceType())) return;
    debug(`request failed (${request.failure()?.errorText}): ${request.method()} ${shortUrl(request.url())}`);
  });
  page.on('console', message => {
    if (message.type() === 'error') debug(`page script error: ${message.text().slice(0, 200)}`);
  });
}

/** Logs where the page is and what it shows. Input values are not part of innerText. */
async function logPageState(page: Page, label: string): Promise<void> {
  try {
    const state = await page.evaluate(() => ({
      title: document.title,
      text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 300),
    }));
    debug(`${label}: url ${shortUrl(page.url())}, title "${state.title}", text "${state.text}"`);
  } catch (error) {
    debug(`${label}: url ${shortUrl(page.url())}, page text unavailable (${String(error)})`);
  }
}

async function openLoginFromHomePage(page: Page): Promise<void> {
  debug('wait for the "enter account" link on the home page');
  await waitUntilElementFound(page, ENTER_ACCOUNT_SELECTOR, true);
  const href = await page.$eval(ENTER_ACCOUNT_SELECTOR, element => (element as HTMLAnchorElement).href).catch(() => '');
  debug(`"enter account" link found on ${shortUrl(page.url())}, points to ${shortUrl(href)}`);
  await closeCookieAlert(page);
  // The login page is a Next.js app: its HTML, form included, arrives before its scripts take over
  // the form. Submitting before that posts the whole form natively, which Leumi's firewall answers
  // with "Request Rejected" (2026-10-14). The app's first call once it runs is auth/key_exchange.
  // Start listening before the click, so an early response is not missed.
  const appStarted = page
    .waitForResponse(response => response.url().includes(LOGIN_APP_READY_PATH), { timeout: LOGIN_APP_READY_TIMEOUT })
    .then(() => true)
    .catch(() => false);
  debug('click the "enter account" link');
  await page.click(ENTER_ACCOUNT_SELECTOR);
  // The login page is still loading (and changes page once more), so do not run page scripts
  // such as closeCookieAlert here; the selector waits below survive page changes.
  await waitForLoginFields(page);
  if (await appStarted) {
    debug(`login app started (${LOGIN_APP_READY_PATH} answered)`);
  } else {
    debug(`no ${LOGIN_APP_READY_PATH} within ${LOGIN_APP_READY_TIMEOUT} ms; filling the form anyway`);
  }
  await logPageState(page, 'login form ready');
}

async function waitForLoginFields(page: Page): Promise<void> {
  debug('waiting for components of login to enter credentials');
  await Promise.all([
    waitUntilElementFound(page, 'input[placeholder="שם משתמש"]', true),
    waitUntilElementFound(page, 'input[placeholder="סיסמה"]', true),
    waitUntilElementFound(page, 'button[type="submit"]', true),
  ]);
}

async function waitForPostLogin(page: Page): Promise<void> {
  debug(`login form submitted on ${shortUrl(page.url())}; waiting up to 60 s for the account page`);
  try {
    await Promise.race([
      waitUntilElementFound(page, 'a[title="דלג לחשבון"]', true, 60000),
      waitUntilElementFound(page, 'div.main-content', false, 60000),
      page.waitForSelector(`xpath//div[contains(string(),"${INVALID_PASSWORD_MSG}")]`, {
        timeout: 60000,
      }),
      waitUntilElementFound(page, CHANGE_PASSWORD_MODAL_SELECTOR, true, 60000),
    ]);
    debug(`after login: ${shortUrl(page.url())}`);
  } catch (error) {
    await logPageState(page, 'no account page after login');
    throw error;
  }
}

type ScraperSpecificCredentials = { username: string; password: string };

class LeumiScraper extends BaseScraperWithBrowser<ScraperSpecificCredentials> {
  /**
   * The home page and /H/Login.html both move on by script (the login page to its gate-keeper
   * Hebrew page). When that move starts before the first page is ready, goto fails with
   * net::ERR_ABORTED although the page opens. checkReadiness then waits for the expected
   * elements, so continue.
   */
  async navigateTo(url: string, waitUntil?: PuppeteerLifeCycleEvent, retries?: number): Promise<void> {
    if (url === HOME_URL) {
      traceLeumiPage(this.page);
      debug(`open ${url} (not waiting for it to finish loading)`);
      // On some networks the home page takes more than 30 s to reach DOMContentLoaded, but its
      // "enter account" link renders early. Start loading and let checkReadiness wait for the link.
      this.page.goto(url).catch(error => debug(`home page did not finish loading: ${String(error)}`));
      return;
    }
    try {
      await super.navigateTo(url, waitUntil, retries);
    } catch (error) {
      const ownPage = url === HOME_URL || url === LOGIN_URL;
      if (!ownPage || !(error instanceof Error) || !error.message.includes('net::ERR_ABORTED')) {
        throw error;
      }
      debug(`login navigation was replaced by a redirect (${error.message}); waiting for the login form`);
    }
  }

  getLoginOptions(credentials: ScraperSpecificCredentials) {
    return {
      loginUrl: HOME_URL,
      fields: createLoginFields(credentials),
      submitButtonSelector: "button[type='submit']",
      // Only the page's HTML is needed; the login form is awaited in checkReadiness.
      waitUntil: 'domcontentloaded' as const,
      checkReadiness: async () => openLoginFromHomePage(this.page),
      preAction: async () => logPageState(this.page, 'about to fill the login form'),
      postAction: async () => waitForPostLogin(this.page),
      possibleResults: getPossibleLoginResults(),
    };
  }

  async fetchData(): Promise<ScraperScrapingResult> {
    const minimumStartMoment = moment().subtract(3, 'years').add(1, 'day');
    const defaultStartMoment = moment().subtract(1, 'years').add(1, 'day');
    const startDate = this.options.startDate || defaultStartMoment.toDate();
    const startMoment = moment.max(minimumStartMoment, moment(startDate));

    const accounts = await fetchRegularAccounts(this, this.page, startMoment, this.options);
    const savingsAccounts = await fetchSavingsAccounts(this.page, accounts);
    accounts.push(...savingsAccounts);

    const foreignCurrencyAccounts = await fetchForeignCurrencyAccounts(this.page, startMoment, this.options);
    accounts.push(...foreignCurrencyAccounts);

    return {
      success: true,
      accounts,
    };
  }
}

export default LeumiScraper;
