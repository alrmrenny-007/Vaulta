# Vaulta (demo bank)

A US-style demo bank: sign up with a custom account number, log in, send money between
accounts, pay bills, and request debit cards. **No real money is ever held.**

The site is plain HTML/CSS/JS plus **one serverless function** (`api/index.js`) that stores
everything in a **Neon Postgres** database.

---

## Setup on Vercel (about 10 minutes, no coding)

### 1. Upload the files
Unzip `vaulta-site.zip`. Put **everything inside the folder** (including the `api` folder and
`package.json`) into your GitHub repo, replacing the old files. Vercel redeploys automatically.

> If you upload files by hand on github.com: use **Add file > Upload files** and drag the
> *contents* of the unzipped folder in, so `api/` and `package.json` sit at the top level of the repo.

### 2. Add the database
In Vercel, open your project, then **Storage > Create Database > Neon (Postgres)** and connect it
to this project (all environments). Vercel adds the connection setting (`DATABASE_URL`) for you.
The tables are created automatically the first time the site is used.

### 3. Add one secret
**Settings > Environment Variables > Add**
- Name: `APP_SECRET`
- Value: a long random password, **at least 32 characters** (use your phone's or browser's
  "suggest strong password"). Tick Production, Preview and Development.

Save it somewhere safe. **Do not change it later**: it protects PINs and stored card numbers, and
changing it locks every user's PIN.

### 4. Redeploy
**Deployments > the latest one > the three dots > Redeploy.** (Needed so the new settings apply.)

### 5. Check it works
Open `https://YOUR-SITE.vercel.app/api/health`. You should see:

    {"ok":true,"database":true,"secret":true}

Then open the site and sign up. Accounts from the old browser-only version do **not** carry over.

### If something looks wrong
| You see | Fix |
|---|---|
| `/api/health` says `"database":false` | Step 2 not finished: connect the Neon database to this project, then redeploy. |
| `/api/health` says `"secret":false` | Step 3: add `APP_SECRET` (32+ characters), then redeploy. |
| Page says "API not found" | The `api` folder or `package.json` was not uploaded at the top level of the repo. |
| Sign up says "The server is not set up yet" | Same as the first two rows; open `/api/health` for the exact reason. |
| Errors after a deploy | Vercel > your project > **Logs** shows the server error message. |

---

## What the server enforces (the browser can't bypass it)
- Passwords and PINs are hashed with scrypt. Sessions are random tokens in HttpOnly cookies, stored hashed.
- Transfers lock both accounts, so two simultaneous requests can never spend the same money twice. Balances can't go below zero (also enforced by the database).
- Wrong PIN guesses lock the PIN: 5 tries, then 5 min, 10 min, 20 min... up to 24 hours. Logins are rate limited.
- A $5,000 rolling 24-hour limit applies to transfers plus bill pay. Card numbers are stored encrypted; the CVV is never stored.
- Cross-site requests are blocked, spreadsheet-formula injection in CSV exports is neutralised.

## Demo-only parts
- "Add money" creates fake funds (max $5,000 per deposit, $25,000 per day). Set the environment variable `DEMO_MODE=off` to remove it, along with the "next delivery stage" card button.
- Card numbers (start with 9999) and the routing number (999000014) are fictional.

## Before real users or money
This is a demo, not a bank. Holding real money needs a chartered, FDIC-insured partner bank, a card issuer, identity verification (KYC/AML), email/SMS verification and password reset, audit logging, monitoring, backups, and a security review. Do not collect Social Security numbers or real card numbers here.

## Files
`index.html signup.html login.html dashboard.html` pages · `styles.css bank.css` styling · `app.js bank.js` browser code ·
`api/index.js api/_lib/*.js` server · `package.json vercel.json` config
