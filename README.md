# Golf Search

Golf Search checks tee-time availability at 13 courses around Des Moines and shows the results in one browser page. It uses Playwright to visit each course's booking site, then displays available times, player counts, and prices when the course provides them. Booking happens on the course's own site.

## Requirements

- Node.js 20 or newer
- A desktop environment for courses whose booking flow opens a visible browser
- A DriverPOS account that can sign in to the four city courses

## Download and install

```bash
git clone https://github.com/jacobwalter1/tee-time-tracker.git
cd tee-time-tracker
npm ci
npx playwright install chromium
```

If you download the ZIP from GitHub instead of using Git, extract it, open a terminal in the `tee-time-tracker` folder, and run the last two commands there.

**Windows PowerShell:** Use `npm.cmd ci` and `npx.cmd playwright install chromium` if PowerShell blocks `npm.ps1` or `npx.ps1` because of its script execution policy.

## Configure the courses

Create a file named `.env` in the project folder, next to `backend.js`. Add your own credentials and the booking page URL for each course:

```dotenv
email=your-driverpos-email@example.com
cityPassword=your-driverpos-password

jesterParkUrl=https://www.driverpos.io/your-jester-park-path/sign-in
wavelandUrl=https://www.driverpos.io/your-waveland-path/sign-in
brightGrandviewUrl=https://www.driverpos.io/your-bright-grandview-path/sign-in
blankUrl=https://www.driverpos.io/your-blank-path/sign-in
otterCreekUrl=https://your-otter-creek-booking-page
theLegacyUrl=https://your-legacy-booking-page
terraceHillsUrl=https://your-terrace-hills-booking-page

# Optional: defaults to 3000
PORT=3000

# Optional: show browser windows for normally headless courses
# SHOW_BROWSER=1
```

Use the actual booking URLs for your courses; the values above are examples. The first four courses share `email` and `cityPassword`. The `.env` file is ignored by Git so your credentials are not committed. All seven URL keys are needed to search the original seven courses; a missing URL produces an error for that course. The six additional live courses use booking URLs configured in `courses-steps.json` and do not need `.env` entries.

## Run and use

From the `tee-time-tracker` folder:

```bash
npm start
```

In Windows PowerShell, run `npm.cmd start` if `npm start` is blocked. Open [http://localhost:3000](http://localhost:3000), select one or more courses, choose a date, and select **Search tee times**. Only the selected courses are checked. Use **Select all** to search every configured course. The page shows results from those courses and reports any course it could not check. Select a result's booking link to continue on that course's site. Press `Ctrl+C` in the terminal to stop the server.

The first search may take a while because the app opens booking pages in Chromium. The Legacy and Terrace Hills are configured to launch a visible browser, even when `SHOW_BROWSER` is unset.

## More public courses

The page also lists ten additional public courses with course or booking links. Six are included in the live search: Copper Creek, Toad Valley, Woodland Hills, Beaver Creek, Deer Run, and Colfax Country Club. Their provider scrapers are in `booking-providers.js` and their URLs are in `courses-steps.json`. Sugar Creek Municipal and Tournament Club of Iowa use ForeUp booking pages that returned HTTP 403 during verification; River Valley's TeeSnap page also returned HTTP 403. Willow Creek's CGS booking page requires a Player ID and password, so those four remain directory links only. They are shown in `public/additional-courses.json` with their current status. Tournament Club of Iowa, River Valley, Deer Run, and Colfax are near the edge of a roughly 30-minute drive from downtown Des Moines; check travel time from your location.

## Troubleshooting

- **Port 3000 is already in use:** Stop the other server, or set `PORT` to another number in `.env` and open that port in your browser.
- **Chromium executable is missing:** Run `npx playwright install chromium` (`npx.cmd playwright install chromium` in PowerShell).
- **A course reports a login or selector error:** Check its URL and credentials in `.env`. Booking sites can change their pages; city course steps are in `courses-steps.json`, and the additional provider scrapers are in `booking-providers.js`.
- **One course has no results:** It may have no availability for that date. The page also lists course errors separately so you can tell an empty day from a failed scrape.
