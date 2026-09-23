# TaskFlow deployment

Railway is the recommended first host for this project because it provides a managed PostgreSQL database, private environment variables, HTTPS, and simple Node deployment in one project. Render is a good alternative if you prefer separate web-service and database resources.

## 1. Configure secrets

Copy `.env.example` to `.env` for local development and replace every placeholder. Set `DATABASE_URL` to the PostgreSQL connection string supplied by your host. In production, put all values in the host's secret manager; do not commit `.env` or paste secrets into source control.

Set `APP_BASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, and `STRIPE_WEBHOOK_SECRET` for Premium Checkout and hosted card verification. Register `POST /api/payments/stripe/webhook` in Stripe and enable the `checkout.session.completed` event. Set a separate random `UPLOAD_ENCRYPTION_KEY`; changing it later makes existing encrypted media unreadable.

Set `CLOUDFLARE_TURNSTILE_SITE_KEY` and `CLOUDFLARE_TURNSTILE_SECRET_KEY` for wallet payment-method verification. The server rejects card requests when Turnstile verification is missing or invalid.

Set `PLATFORM_COUNTRY` and `INTERNATIONAL_TAX_RATE` for tax policy. Taxes apply only when the user's normalized country differs from `PLATFORM_COUNTRY`. Set `STRIPE_PAYMENT_METHOD_TYPES` to the Stripe payment methods enabled in your account; regional options are filtered against that allowlist.

Google OAuth redirect URI checklist:

- The value in Google Cloud Console must match `GOOGLE_CALLBACK_URL` exactly.
- Local testing: `http://localhost:3000/api/auth/google/callback`
- Production: `https://your-domain.com/api/auth/google/callback`
- Do not use `127.0.0.1`, a different port, a trailing slash, or a different host/protocol.
- If you deploy behind a reverse proxy, set `GOOGLE_CALLBACK_URL` to the public HTTPS URL, not the internal app URL.

Configure Resend using `RESEND_API_KEY` and a verified sender such as `RESEND_FROM_EMAIL=onboarding@resend.dev` or your own verified custom domain. Store the API key in Railway or your host secret manager and rotate any credentials that were previously shared in chat before adding the replacements.

## 2. Install and run

```powershell
npm install
npm start
```

Open `http://localhost:3000`. The headless Node server serves `login.html` and the API from the same origin.

## 3. Production requirements

- Run behind HTTPS and a reverse proxy.
- Use a long random `SESSION_SECRET`; set secure cookies and restrict `CORS_ORIGIN` to the real origin.
- Use the managed PostgreSQL database configured by `DATABASE_URL`; the application initializes its schema at startup.
- Configure Google OAuth before enabling login. Never ship development OTP responses.
- Configure `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, and `RESEND_FROM_NAME` for transactional email and OTP delivery through Resend.
- Configure Stripe Checkout and verify webhook signatures before accepting Premium payments.
- Keep `UPLOAD_ENCRYPTION_KEY` in the secret manager and never expose encrypted media files through a static directory.
- Add a managed object store for uploads and malware scanning before making file sharing public.
- Use a broker-backed WebSocket layer for multiple instances.
- Add payment-provider webhooks and idempotency keys before moving real funds.
- Store audit logs outside the application database and back them up.
- Add database migrations, automated tests, monitoring, alerting, and a secret manager before launch.

## API surface

- `POST /api/auth/phone/request`, `POST /api/auth/phone/verify`, `GET /api/auth/google`
- `POST /api/auth/2fa/enable`, `POST /api/auth/logout`, `GET /api/me`
- `GET/POST /api/tasks`, `POST /api/tasks/:id/complete`
- `GET/POST /api/listings`, `POST /api/checkout/commission-split`
- `GET /api/wallet`, `GET /api/notifications`, `POST /api/disputes`
- `POST /api/chat/upload`, WebSocket `/ws?thread=<thread-id>`
- `POST /api/admin/login`, `GET /api/admin/overview`
- `POST /api/admin/disputes/:id/resolve`, `POST /api/admin/listings/:id/pause`

The browser page uses the same backend endpoints for Google OAuth, admin authentication, email authentication, PostgreSQL persistence, uploads, and Resend-powered transactional email.
