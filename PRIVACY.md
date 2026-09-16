# Privacy

Short version: this extension has no backend, no analytics, no telemetry, and no account. Nothing
you do leaves your browser, except the requests it makes to fomo.family on your behalf — the same
ones the site already makes — and optional Telegram alerts you configure yourself.

## What it accesses

| Data | Why | Where it goes |
|---|---|---|
| Your fomo.family session (the token the site stores in your browser) | To quote your tokens, read your balances and trade in the page, exactly like you would | Only to `fomo.family` / `prod-api.fomo.family`, from your own tab. The token is never copied out of the page, never logged, never sent anywhere else. |
| Your orders, settings and event log | To watch thresholds and act on them | `chrome.storage.local`, on your machine only |
| Token prices and your balances | To decide when an order triggers and to confirm an execution | Kept in local storage, never uploaded |
| Telegram bot token and chat id (optional, off by default) | To push alerts to your phone | Stored locally; used only to call `api.telegram.org` with the message text |

## What it never does

- It never sees, stores or transmits a private key or a seed phrase. Signing happens inside
  fomo.family's own wallet, as usual.
- It never sends your data to the author or to any third-party server.
- It does not track you: no analytics, no identifiers, no remote logging.
- It runs only on `https://fomo.family/*`. It does nothing on any other site.

## Permissions, one by one

- `storage` — save your orders and settings locally.
- `alarms` — wake the background worker so a pending order keeps being watched.
- `tabs` — find or open a fomo.family tab to quote prices and to execute an order.
- `notifications` — tell you when an order triggers, fills or fails.
- `https://fomo.family/*` — the only site the extension works on.
- `https://api.telegram.org/*` — only used if you turn on Telegram alerts.

## Removing your data

Uninstalling the extension deletes everything it stored. You can also clear orders, settings and
the log from the extension's settings page at any time.
