# NFC Music (Claim-on-first-tap) — Streaming Only

This version is built for your goal: **sell an NFC tag** that can be **claimed by one person**, then only that owner (on up to 2 devices) can stream the music.

## What it does
- Each NFC tag holds a unique **claim URL** like: `/claim/DEMO1234`
- First person to open it signs in with a **one-time email code** and **claims** the tag
- From then on, only the owner can access the player page
- Streaming uses **short‑lived tokens** bound to the **user + device**
- Device binding allows **up to 2 devices** per owner (configurable)

## Quick start
```bash
npm install
cp .env.example .env  # set JWT_SECRET and APP_BASE_URL
npm start
# open http://localhost:3001/demo
```
In the demo, login codes print to the server console. In production, send emails via a mail service.

## Testing the flow
1. Visit `/demo` and click the claim URL (uses tag code `DEMO1234`).
2. Enter your email → check server console for the 6‑digit code → verify.
3. The tag is now bound to your account.
4. You’ll be redirected to `/play/olivia-alexandra-ep` and can stream.

## Add your real music
1. Replace `music/sample.mp3` with your track file.
2. Update the album row in the database (or add a new NFC tag row). For a quick insert from code, modify the seed area in `server.js`.

## Make new NFC tags
- Add a row to `nfc_tags (code, album_slug)` where `code` is the short code you’ll program into the tag URL.
- Program the NFC tag with the URL: `https://your-domain.com/claim/YOURCODE`

## Why this is hard to pirate
- Claim-on-first-tap binds the NFC to **one account**.
- Streaming URLs are **short-lived**, **signed**, and **device-bound**.
- No raw file download route.
> No consumer system can make copying 100% impossible (a microphone can always re-record), but this strongly prevents casual sharing.

## Next steps (optional upgrades)
- Move to **HLS + AES-128** segments with per-user keys (stronger than progressive streaming).
- Add **forensic audio watermarking** per user (invisible, traceable leak deterrent).
- Add **email delivery** for OTP via a service (Postmark, SES, Mailgun).
- Add **admin UI** to mint tag codes and manage albums.
