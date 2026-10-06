# Plat Book

A private deal analyzer and Oklahoma City map for two partners. Same setup as opentime:
plain HTML/CSS/JS on GitHub Pages, with Supabase handling sign-in and shared storage.

- `index.html`: the page
- `styles.css`: colors, type and layout (colors are the variables at the top)
- `app.js`: the math, saving, sign-in and the map, each in a labeled section
- `config.js`: your settings (app name, Supabase keys)
- `supabase/setup.sql`: the database and its security rules

## 1. Try it right now (2 minutes)

Push this folder to a GitHub repo and turn on Pages (step 3), or just open it with any local
server. With `config.js` left blank, it runs in "this device only" mode: everything saves in
your browser. Good for playing with numbers before Will has an account.

## 2. Make it private and shared (15 minutes)

1. Create a new project at supabase.com. (The free plan allows two active projects, and opentime
   is already one of them. Free projects can pause after a stretch of no use; opening the
   dashboard wakes them.)
2. Open `supabase/setup.sql`, replace the two example emails at the bottom with yours and Will’s,
   then paste the whole file into **SQL Editor → New query → Run**.
3. **Authentication → Sign In / Providers → Email**: turn **off** “Allow new users to sign up.”
   Now nobody can create an account on your site.
4. **Authentication → Users → Add user → Create new user**: add yourself and Will with
   passwords, and tick “Auto confirm.”
5. **Authentication → URL Configuration**: set Site URL to your site’s address so password
   reset emails link back correctly.
6. **Project Settings → API**: copy the Project URL and the anon (or “publishable”) key into
   `config.js`. Both are safe to publish. The rules in `setup.sql` are what protect your data:
   only emails on the members list can read or change anything.

Three locks, in order: no one can sign up, only the accounts you created can sign in, and only
emails on the members list can see data even if they do.

## 3. Put it online

1. Make a new GitHub repo (public is fine; nothing secret lives in the code) and push this folder.
2. **Settings → Pages → Deploy from a branch → main / root.**
3. Optional: a custom domain or subdomain, the same way you set up opentime.work.

`robots.txt` and a `noindex` tag ask search engines not to list it.

## Where the map data comes from

- Zoning, overlays, lot lines, plats, planokc land use and city limits: City of Oklahoma City’s
  public map service (`gis.okc.gov`)
- Flood zones: FEMA’s National Flood Hazard Layer (`hazards.fema.gov`)
- Address search: OpenStreetMap’s Nominatim (fine for light use like this)
- Base maps: OpenStreetMap (Street) and Esri (Satellite, Quiet), no API keys needed

If the city changes or retires its service, the map still works; that layer goes blank. The
service addresses are at the top of the MAP section in `app.js`.

## Changing things

The deal’s default numbers are in `blankDeal()` in `app.js`. Input labels and hints are in
`SECTIONS`. Every result explanation lives in the `why` object inside `resultsHTML()`.
Deals are stored as JSON, so new fields don’t need database changes.

The analyzer is arithmetic on the numbers you enter. It isn’t financial advice.
