# Comment System for kushaagra-artist-profile

A moderated comment section for your GitHub Pages site, with a name+contact
requirement, an approval queue, and an admin panel to delete comments.

## What's in this folder

- `server.js` — the backend API (Express + Postgres)
- `package.json` — dependencies
- `admin.html` — your moderation panel (served at `/admin`)
- `frontend-comments-snippet.html` — paste this into your site's `index.html`

## How it works

1. A visitor fills the comment form on your site → it POSTs to your Render
   backend → saved in the database as **pending** (not visible yet).
2. You open `https://your-app.onrender.com/admin`, log in with your admin
   password, and see every pending comment.
3. You click **Approve** → it becomes visible on your public site.
4. You click **Delete** any time → it's gone permanently, approved or not.

---

## Step 1 — Push this backend to its own GitHub repo

Render deploys from a GitHub repo, so this needs to live somewhere Render can
see it. Easiest: create a **new** repo (e.g. `kushaagra-comments-api`) and
push these files there — keep it separate from your site's repo, since one
is a static site and the other is a live server.

```bash
cd comments-backend
git init
git add .
git commit -m "Initial comment backend"
git branch -M main
git remote add origin https://github.com/KushaagraGiriwar/kushaagra-comments-api.git
git push -u origin main
```

(Create the empty repo on GitHub first, then run the commands above.)

## Step 2 — Create a free database on Neon (not Render Postgres)

Render's own free Postgres expires after 30 days and gets deleted — not
suitable for real comments people leave over time. **Neon** is a free
Postgres host with no 30-day kill switch, so use that instead:

1. Go to [neon.tech](https://neon.tech) → sign up (GitHub login is fastest)
2. Create a new project (any name, e.g. `kushaagra-comments`)
3. On the project dashboard, find the **Connection string** — it looks like
   `postgresql://user:password@ep-xxxx.neon.tech/dbname?sslmode=require`
4. Copy that full string — you'll paste it into Render as `DATABASE_URL` in
   Step 3

(Supabase is a fine alternative if you prefer it — same idea, just copy its
connection string instead. `server.js` doesn't care which one you use.)

## Step 3 — Deploy the backend as a Web Service

1. **New** → **Web Service** → connect your `kushaagra-comments-api` repo
2. Runtime: **Node**
3. Build command: `npm install`
4. Start command: `npm start`
5. Add these **Environment Variables**:
   | Key | Value |
   |---|---|
   | `DATABASE_URL` | the Neon connection string from Step 2 |
   | `JWT_SECRET` | any long random string (e.g. generate one at [randomkeygen.com](https://randomkeygen.com)) |
   | `ADMIN_PASSWORD` | a password only you know — this logs you into `/admin` |
6. Deploy. Render gives you a URL like `https://kushaagra-comments-api.onrender.com`

## Step 4 — Wire up your site

1. Open `frontend-comments-snippet.html` in this folder
2. Follow the instructions in the comment at the top — copy the CSS, HTML,
   and JS into the matching places in your `index.html`
3. Replace `https://YOUR-APP-NAME.onrender.com` with your **actual** Render
   URL from Step 3
4. Commit and push to your site's repo (`kushaagra-artist-profile`) — GitHub
   Pages redeploys automatically

## Step 5 — Try it

1. Visit your live site, submit a test comment
2. Go to `https://your-app.onrender.com/admin`, log in with your
   `ADMIN_PASSWORD`
3. Approve or delete your test comment
4. Refresh your site — approved comments now show up

---

## Notes

- **Free tier sleep:** Render's free web services go to sleep after 15 minutes
  of no traffic and take ~30-60 seconds to wake up. The first comment load
  after idle time may feel slow — this is normal, not a bug. If it bothers
  you, Render's paid tier (~$7/month) keeps it always-on.
- **CORS:** `server.js` only allows requests from
  `https://kushaagragiriwar.github.io`. If you ever add a custom domain,
  add it to the `ALLOWED_ORIGINS` list near the top of `server.js`.
- **Spam protection:** there's a hidden honeypot field (bots fill it, humans
  never see it) plus a rate limit of 5 submissions per visitor per 15
  minutes. Combined with manual approval, this should keep things clean
  without needing CAPTCHAs.
- **Changing your admin password later:** just update the `ADMIN_PASSWORD`
  environment variable on Render and redeploy — no code change needed.
