# Tracker

A small interval tracker, fully editable. Vibe coded to hell and back. Love you, Claude. 

## Run it online

https://whocouldpossiblyguesswhy.github.io/tracker

All of your data is stored locally in the browser. I cannot access it, nor do I care to. Export a JSON periodically; if site data is cleared you will lose it.

Recommended on iOS: visit the link, tap Share, then choose "Add to Home Screen" for regular use

## Run it locally

Double-click **Start Tracker.bat**. It starts the local server in a minimized window and
opens the app in your default browser. Close that server window to stop it. Or from a
terminal:

```bash
node tools/serve.js
```

Then open http://localhost:8765/ in Firefox or any other browser that makes some attempt to respect your privacy.

The folder is self-contained: move or copy it anywhere and the launcher still works. Your
data is stored by the browser per site address, so it stays with `localhost:8765` on your
PC regardless of where the folder lives. On desktop, click the *Install app*
icon in the address bar to get a windowed app with its own taskbar icon.

To test on an iPhone over your home Wi-Fi:

```bash
node tools/serve.js 0.0.0.0
```

and open `http://<your PC's IP>:8765/` in Safari. Everything works this way except the
offline cache and the Add-to-Home-Screen install, which Safari only enables over HTTPS.

## Install on iPhone (recommended setup)

Host the folder anywhere that serves HTTPS. GitHub Pages is free and takes two minutes:
create a repository, push this folder, enable Pages in the repository settings. Then on the
phone open the page in Safari, tap Share, then *Add to Home Screen*. It launches full
screen, works offline, and keeps its data on the phone.

The iOS caveat: Safari pauses web apps when the screen locks, so the alarm sound only fires
while the app is open. The app keeps the screen awake during a timer, and the timer is
stored as a deadline, so if you do lock the phone the count is still credited correctly when
you come back.

## Using it

- **Calendar strip**: three days back, today, three days ahead. Past days show the counts
  that were done and a coloured dot for the rating (green easy, yellow medium, red hard).
  Future days show the projected split or "rest". Tap any day for details.
- **Ring**: tap it or the button to start. Orange is work, blue is rest. Cancel aborts the
  running timer without counting it.
- **After count 3** you rate the day. Hard means the same level must be done again today
  before it counts.
- **Discount last count** removes the most recent count if something went wrong mid-run.
  It also works right after the day completed, and rolls the level back.
- **Reset session** records today's attempt as abandoned without changing the level.
- **Corrections**: tap any day in the calendar or History. A recorded day can be moved to
  another date, have a session's rating changed, or be deleted. An empty past day can have a
  completed session recorded on it with a chosen split and rating. Corrections never change
  the current level; adjust that in Settings if a fix calls for it.
- **Chime**: a synthesized wind chime (no audio files). Volume is in Settings with a Play
  button to preview.
- **Settings**: counts per day, timer lengths, the item list, which count asks for a
  rating, rest days between sessions, freeze, and a manual level picker.
- **History**: every recorded day with its sessions, ratings and outcome. Export JSON for
  backup or to move to another device, and import it there. CSV export for spreadsheets.

## Data safety

All data lives in the browser's local storage for the site. Every save keeps the previous
good copy as a backup and verifies the write. If the primary copy is ever unreadable the
backup is restored automatically. Clearing the browser's site data does delete it, so
export a JSON backup now and then.
