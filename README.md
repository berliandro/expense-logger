# Cashflow Logger (expense-logger)

Snap a receipt (or type a note) → Gemini structures it → rows land in Google
Sheets. Frosted Liquid Glass UI, Standard + Table-batch tabs, PIN-first 12h
sessions, recent-logs history.

## How it works

- Frontend: `Index.html` (single page, dark default + light mode)
- Backend: `Code.js` (Apps Script: serves the page, calls Gemini, writes sheets)
- `appsscript.json`: timezone `Asia/Jakarta`, web app `USER_DEPLOYING` /
  `ANYONE_ANONYMOUS` (family members open the `/exec` URL without editor
  access; the app's own PIN/session check still gates sensitive calls)
- `.clasp.json`: generated locally per user by the installer from your Script
  ID — never committed, covered by `.gitignore`
- `.cashlogger-deployment-id`: per-installation Web App deployment ID, saved
  locally by the installer — never committed, covered by `.gitignore`

## Prerequisites

- Git, Node.js + [`@google/clasp`](https://github.com/google/clasp)
  (`npm install -g @google/clasp`). The Windows installer below installs any
  missing prerequisites automatically.
- A Google account with access to Google Sheets + AI Studio
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/)
- A Google Sheet (bound automatically when the script comes from a Sheet, or
  set via Settings menu → Set Sheet). If no `Template` sheet exists, one is
  created automatically on first log with headers:
  `Date | Description | Amount | Category | Spending Type | Type | Merchant | Notes`
  (widths 100, 173, 100, 157, 127, 103, 207, 392), frozen header row, then
  hidden. Monthly sheets (`MMMM yyyy`) are copied from that `Template`.

## Family install (Windows)

1. Run `Install and Tutorial Berliandro Cash Log.bat` once.
2. It downloads the latest project from
   `https://github.com/berliandro/expense-logger.git` (`main` branch),
   installs missing Git / Node.js / clasp, and asks for your Google Apps
   Script ID.
3. Log in with Google when `clasp login` opens the browser.
4. The installer runs `clasp push -f`, then creates the initial Web App
   deployment with `clasp create-deployment --description "Cash Logger" --json`
   and extracts the deployment ID from the JSON output (no fragile text
   parsing). If the ID cannot be extracted, installation fails clearly.
5. The deployment ID is validated and saved to `.cashlogger-deployment-id`.
6. The installer shows `https://script.google.com/macros/s/{DEPLOYMENT_ID}/exec`
   and opens it automatically.
7. The installer does not delete itself and does not report success when
   something failed.

## Updates (same URL)

Run `Update.bat` for later updates. It keeps the same Web App URL:

```text
Update.bat
→ temporary copy in %TEMP% (so Git can safely replace Update.bat itself)
→ git fetch origin main
→ git reset --hard origin/main (tracked files match GitHub exactly)
→ run the newly downloaded Update.bat
→ clasp push -f
→ clasp update-deployment {saved deployment ID}
→ show the same https://script.google.com/macros/s/{DEPLOYMENT_ID}/exec URL
```

- The updater reuses the deployment ID stored in
  `.cashlogger-deployment-id` and updates that existing deployment. It does
  not create a new deployment on every run, so the `/exec` URL stays the
  same.
- Family installs are treated as deployment clients: `reset --hard` makes
  tracked files match GitHub exactly. Commit any local source changes before
  updating, or they will be overwritten. Ignored per-user files
  (`.clasp.json`, `.cashlogger-deployment-id`) are untouched.
- The updater checks for Git, clasp, `.git`, `.clasp.json`, and
  `.cashlogger-deployment-id`, and fails with a useful message when anything
  is missing.

## Manual clone & setup (developers)

```sh
git clone https://github.com/berliandro/expense-logger.git
cd expense-logger
clasp login          # opens Google OAuth in your browser (auth stays local)
clasp push           # uploads Code.js + Index.html + appsscript.json
```

Then in the Apps Script editor (**Project Settings → Script Properties**), add:

| Key              | Value                              |
|------------------|------------------------------------|
| `GEMINI_API_KEY` | your Gemini key (AI Studio)        |
| `SPREADSHEET_ID` | the ID from your sheet's URL       |

No keys ever live in this repo — they stay in Script Properties (and the
browser only ever holds a random 12h session token, never the PIN or keys).

## Manual deploy (developers)

```sh
# first time (creates a deployment and prints its deploymentId as JSON):
clasp create-deployment --description "Cashflow logger" --json
# afterwards (keep the same web-app URL / deployment ID):
clasp update-deployment <DEPLOYMENT_ID> -d "Describe the change"
```

Open the web-app `/exec` URL, set a 6-digit PIN on first run, then add the
Gemini API key when prompted (Settings menu → Set API key) and the Google
Sheet when prompted (Settings menu → Set Sheet). If the script was copied
from an existing Sheet (container-bound), the bound sheet is used
automatically; standalone scripts ask for the Sheet ID/URL in-app (same
style as the API-key prompt). `SPREADSHEET_ID` in Script Properties remains
supported as a manual fallback.

## Troubleshooting

- `Google Sheet is not set` (or `Spreadsheet is not configured` /
  `Could not open the Google Sheet` / legacy `Invalid argument: id`) on Log
  entry means no usable sheet was found. If bound to a Sheet it is used
  automatically; otherwise set it via Settings menu → Set Sheet (Sheet ID or
  full URL), or manually via `SPREADSHEET_ID` in Script Properties. Then
  reload the `/exec` URL and try again. A missing `Template` sheet is created
  automatically with the header row from Prerequisites.
- `Gemini API key is not set` means `GEMINI_API_KEY` is missing in Script
  Properties, or it was never saved via Settings menu → Set API key. Add it,
  then retry.

## Security notes

- The raw PIN is never stored on the device and never accepted by sensitive
  backend calls — login exchanges it (rate-limited: 5 fails / 10 min) for a
  random 256-bit session token valid 12h, stored hashed server-side.
- `PIN_HASH` / `PIN_SALT` / hashed sessions live in Script Properties.
- `.clasp.json` (your Script ID binding, generated by the installer),
  `.clasprc.json` (your personal clasp OAuth tokens),
  `.cashlogger-deployment-id` (your Web App deployment ID), and `.opencode/`
  (agent session state) are git-ignored — never commit them.
