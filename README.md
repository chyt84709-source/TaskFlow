# TaskFlow

A headless Node.js platform for freelancing, micro-tasking, and e-commerce.

## Run locally

1. Install Node.js 20+.
2. Copy `.env.example` to `.env` and configure PostgreSQL and provider credentials.
3. Run `npm install`.
4. Run `npm start` or `start.bat`.

## Included flows

- Dashboard with earnings, task, store, and trust metrics.
- Video task browser with a watch-time verification timer and reward credit.
- Marketplace for browsing product listings and opening a seller listing flow.
- Wallet with balance, activity history, and payout request state.
- Profile with identity verification, two-factor status, and seller reputation.

The `login.html` file remains the browser client, while `server.js` provides the deployment-shaped API, session boundary, PostgreSQL persistence, Google OAuth, Resend email delivery, uploads, WebSocket chat, task verification, wallet ledger, disputes, notifications, and admin controls. See [DEPLOYMENT.md](DEPLOYMENT.md) for setup and production requirements.

## Notes

- The application has no graphical desktop entry point and is safe to run on a headless server.
- Never credit real users from client-side timing alone; production task verification must be server-side and backed by provider/webhook evidence.
