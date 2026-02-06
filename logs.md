## 2026-02-06 - Leumi Account Selector Timeout

- **Bug**: Leumi scraping intermittently failed while selecting an account, timing out waiting for an XPath selector for the account number.
- **Root Cause**: The account label text can include invisible directionality characters, so direct text matching is unreliable.
- **Fix**: Normalize account labels to digits and separators only, then click the matching option by cleaned text.
- **Verification**: Not run locally (repo was restored; watch build expected to regenerate `lib`).
