# TaskFlow deployment

Railway is the recommended first host for this project because it provides a managed PostgreSQL database, private environment variables, HTTPS, and simple Node deployment in one project. Render is a good alternative if you prefer separate web-service and database resources.

## Deploying to Vercel with S3-compatible storage

The Express app runs as a Vercel Node function through `api/index.js`. Set the Vercel environment variables for the production integrations, including `DATABASE_URL`, `SESSION_SECRET`, `SUPER_ADMIN_USERNAME`, and `SUPER_ADMIN_PASSWORD`. For S3 storage, set the bucket and region, plus the access-key ID and secret supplied by the Vercel Marketplace integration (`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`; also set `AWS_SESSION_TOKEN` if supplied). Bucket aliases include `AWS_S3_BUCKET`, `AWS_S3_BUCKET_NAME`, `S3_BUCKET_NAME`, `AWS_BUCKET_NAME`, and `S3_BUCKET`; region aliases include `AWS_REGION`, `AWS_DEFAULT_REGION`, and `S3_REGION`.

For Supabase on Vercel, use the project's **Connect → Transaction pooler** connection string for `DATABASE_URL`; the direct database hostname may be IPv6-only and fail DNS resolution from serverless runtimes. If database initialization fails, Vercel still serves the static app shell, while API requests return `503` until the database connection is corrected.

For S3-compatible providers, set `AWS_S3_ENDPOINT` to the provider's endpoint URL. `AWS_ENDPOINT_URL_S3`, `S3_ENDPOINT_URL`, and `S3_ENDPOINT` are also recognized. If the provider requires path-style bucket addressing, set `AWS_S3_FORCE_PATH_STYLE=true` (or `S3_FORCE_PATH_STYLE=true`). Uploads and copies use AES256 server-side encryption by default; set `S3_SERVER_SIDE_ENCRYPTION=none` only when the provider does not support that header and provides its own at-rest encryption.

Vercel builds run `npm run build`, which checks the server and function entry-point syntax before deployment. The Node runtime is pinned to 22.x so Vercel does not have to infer a version from a broad `>=20` range.

Keep the bucket private with S3 Block Public Access enabled and default bucket-owner encryption enabled. The app uses short-lived presigned uploads, checks file size/type on completion, and stores media under `media/` and book PDFs under `books/`. It requires `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, and `s3:ListBucket` access for the configured bucket. Do not grant public-read access or put AWS credentials in browser code.

Configure the bucket CORS policy to allow `PUT` from the exact production and Vercel preview origins you use. For example, replace the preview host below with the actual Vercel deployment domain:

```json
[
  {
    "AllowedOrigins": ["https://taskflow.monster", "https://your-project.vercel.app"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type", "x-amz-server-side-encryption"],
    "MaxAgeSeconds": 3000
  }
]
```

The upload signature requires `x-amz-server-side-encryption: AES256`. Add an S3 lifecycle rule to delete abandoned objects under `pending/` and `book-pending/` after one day; completed uploads are moved out of those prefixes.

The Vercel function handles API requests and serves the HTML/JS from the app. Grant only `s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject` on the configured bucket and its objects. Vercel Functions do not provide the app's in-process WebSocket server, so real-time chat requires a separate WebSocket host/service. Set `APP_BASE_URL`, `CORS_ORIGIN`, and the Google callback URL to the actual Vercel production domain before enabling sign-in.

## 1. Configure secrets

Copy `.env.example` to `.env` for local development and replace every placeholder. Set `DATABASE_URL` to the PostgreSQL connection string supplied by your host. In production, put all values in the host's secret manager; do not commit `.env` or paste secrets into source control.

Set `APP_BASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, and `STRIPE_WEBHOOK_SECRET` for Premium Checkout and hosted card verification. Register `POST /api/payments/stripe/webhook` in Stripe and enable the `checkout.session.completed` event. Set a separate random `UPLOAD_ENCRYPTION_KEY`; changing it later makes existing encrypted media unreadable.

Railway production stores every encrypted upload under `/app/upload`; mount the persistent volume at exactly that path and share it with every app instance. The production code pins this path so a stale `UPLOAD_DIR` value cannot route new uploads to the container filesystem. Local development uses `UPLOAD_DIR=./data/uploads`.

Book, article, and newspaper PDFs are encrypted in the persistent upload volume on Railway. On Vercel, browser uploads go directly to the private S3 bucket using presigned URLs, avoiding the serverless request-body limit; book files are limited to S3's 5 GB single-upload limit. The Books library resumes incomplete publications as drafts and protects downloads with the existing purchase checks. Existing product-attached PDF files are migrated to the Books library at startup when their stored media records are present; product listings and encrypted media are not deleted. Normal product listings continue to use image and video media.

## Custom domain: taskflow.monster

In Railway, add `taskflow.monster` to the TaskFlow web service's custom domains and copy the DNS target Railway displays. Add the requested DNS record at your domain provider and wait for Railway to issue HTTPS. Then set these TaskFlow service variables:

```text
APP_BASE_URL=https://taskflow.monster
CORS_ORIGIN=https://taskflow.monster
GOOGLE_CALLBACK_URL=https://taskflow.monster/api/auth/google/callback
```

Add that exact callback URL to Google OAuth's authorized redirect URIs, and update Stripe's webhook endpoint to `https://taskflow.monster/api/payments/stripe/webhook`. Use the custom domain for the public site; Railway's generated `*.up.railway.app` URL can remain as a service fallback.

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
