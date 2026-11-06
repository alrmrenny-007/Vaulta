# Vaulta (fintech demo)

Static site: HTML, CSS and JS. Pages: `index`, `signup`, `login`, `dashboard`.

## Features
- Sign up with a custom account number (8-12 digits like real US accounts; routing numbers are 9 digits) (type, generate, use phone number, or pick a suggestion)
- Login with email or account number
- Dashboard: balance, send money to other Vaulta accounts, saved beneficiaries, bill pay, transaction history with search, CSV export and print
- 4-digit transaction PIN (5 wrong tries locks it for 5 minutes), password change
- Debit cards: request Virtual ($10, instant), Standard ($25) or Premier ($50, expedited) cards with a one-time issuance fee and delivery tracking, activate, freeze, spend limit, show details, cancel
- Add money (demo only, no real money): ACH bank transfer, debit card, mobile check deposit, or direct deposit details

## Files
`index.html signup.html login.html dashboard.html styles.css bank.css app.js bank.js vercel.json`

## Deploy to Vercel
1. Put all files in one folder and push it to a GitHub repo (or run `vercel` in the folder).
2. On vercel.com choose **Add New > Project**, import the repo, framework preset **Other**, no build command. Deploy.

## Important
- Everything is stored in the browser's localStorage. Users only exist on their own device, so a transfer only works between accounts created in the same browser.
- Card numbers and the routing number (999000014) are fictional and cannot be used for real payments.
- Before real users or money: move auth, balances, transfers and cards to a server-side backend and database (e.g. Vercel Functions plus Postgres), hash passwords/PINs server-side, and partner with a chartered, FDIC-insured bank and a card issuer (BaaS) with KYC/AML compliance. Do not collect SSNs or real card data in this demo.
