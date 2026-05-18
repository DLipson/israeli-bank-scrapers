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
