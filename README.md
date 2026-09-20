# TaskFlow

A Windows desktop prototype for a freelancing, micro-tasking, and e-commerce platform.

## Run from Visual Studio or a terminal

1. Install Python 3.10+ and make sure `py` is available.
2. Run `install.bat` once.
3. Run `start.bat` to launch the app.

## Included flows

- Dashboard with earnings, task, store, and trust metrics.
- Video task browser with a watch-time verification timer and reward credit.
- Marketplace for browsing product listings and opening a seller listing flow.
- Wallet with balance, activity history, and payout request state.
- Profile with identity verification, two-factor status, and seller reputation.

The `login.html` file remains a visual preview, while `server.js` provides the deployment-shaped API, session boundary, PostgreSQL persistence, Google OAuth, Resend email, uploads, WebSocket chat, task verification, wallet ledger, disputes, notifications, and admin controls. See [DEPLOYMENT.md](DEPLOYMENT.md) for setup and production requirements.

## Build the EXE

Run `build_exe.bat`. The finished executable is `dist\\FrameSpeakStudio.exe`.

## Notes

- The original desktop utility remains available through `main.py`; the web platform runs with Node.js 20+.
- Never credit real users from client-side timing alone; production task verification must be server-side and backed by provider/webhook evidence.
