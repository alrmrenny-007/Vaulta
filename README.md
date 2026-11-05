# Vaulta (fintech demo)

Static site: HTML, CSS and JS. Pages: `index`, `signup`, `login`, `dashboard`.

## Deploy to Vercel
1. Put all files in one folder and push it to a GitHub repo.
2. On vercel.com choose **Add New > Project**, import the repo.
3. Framework preset: **Other**. Leave build command and output directory empty. Deploy.

Or with the CLI: `npm i -g vercel`, then run `vercel` in the folder.

## Notes
- Accounts are stored in the browser's localStorage, so users are only visible on their own device. This is a demo.
- Before real users or money: add a backend (e.g. Vercel Functions plus a database such as Postgres), server-side password hashing (bcrypt/argon2), sessions or JWTs, and server-side account number uniqueness.
- Handling real money also requires regulatory licensing and a banking partner.
