# TaskFlow deployment

Railway is the recommended first host for this project because it provides a managed PostgreSQL database, private environment variables, HTTPS, and simple Node deployment in one project. Render is a good alternative if you prefer separate web-service and database resources.

## 1. Configure secrets

Copy `.env.example` to `.env` for local development and replace every placeholder. Set `DATABASE_URL` to the PostgreSQL connection string supplied by your host. In production, put all values in the host's secret manager; do not commit `.env` or paste secrets into source control.

Google Cloud Console must include the exact callback URL from `GOOGLE_CALLBACK_URL` as an authorized redirect URI. Configure Resend using `RESEND_API_KEY` and a verified sender such as `RESEND_FROM_EMAIL=onboarding@resend.dev` or your own verified custom domain. Store the API key in Railway or your host secret manager and rotate any credentials that were previously shared in chat before adding the replacements.

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
