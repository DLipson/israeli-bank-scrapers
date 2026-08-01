## 2026-02-06 - Leumi Account Selector Timeout

- **Bug**: Leumi scraping intermittently failed while selecting an account, timing out waiting for an XPath selector for the account number.
- **Root Cause**: The account label text can include invisible directionality characters, so direct text matching is unreliable.
- **Fix**: Normalize account labels to digits and separators only, then click the matching option by cleaned text.
- **Verification**: Not run locally (repo was restored; watch build expected to regenerate `lib`).

## 2026-05-18 - Leumi Cookie Alert Blocks Login

- **Bug**: Leumi scraping could fail on the initial public site because the cookie alert covered the login entry point.
- **Root Cause**: The Leumi readiness flow waited for `.enter_account` and then read its link without first dismissing the cookie alert overlay.
- **Fix**: Close `.cookie-alert .hide-alert` when present before resolving and navigating to the login link.
- **Verification**: Added a Leumi regression test for the blocked login link; ran the Leumi test and the full local Jest suite with live-company tests disabled.

## 2026-05-18 - Leumi Login Page Timeout Before Credentials

- **Bug**: Leumi scraping could time out on the login page before entering credentials.
- **Root Cause**: After `page.goto` opened the login URL, the readiness flow waited for another navigation that might never happen.
- **Fix**: Let `page.goto` wait for `networkidle2` directly and proceed to the login-field selectors without a second navigation wait.
- **Verification**: Added a regression test that fails if readiness waits for a second navigation after opening the login page; ran the full local Jest suite with live-company tests disabled and `npm run type-check`.

## 2026-05-25 - Leumi Invalid Password Message Timeout

- **Bug**: Leumi scraping could fail with a generic timeout while waiting for the invalid-password message after login.
- **Root Cause**: The post-login `waitForSelector` for the invalid-password XPath used Puppeteer's default timeout instead of the longer window already used for the other post-login checks.
- **Fix**: Increased the invalid-password selector wait to 60 seconds in `src/scrapers/leumi.ts`.
- **Verification**: Added a regression test in `src/scrapers/leumi.test.ts` that asserts the invalid-password selector is waited on with a `60000` ms timeout; confirmed it failed before the fix and passed afterward. Ran `npx jest --runInBand` with a temporary `TESTS_CONFIG` and got 18 passing suites, with 1 live-company suite skipped.
