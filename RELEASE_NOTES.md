## 3.0.0 - Field Attendance App (multi-company)
- New product built around the v2.5 attendance engine (camera + GPS in parallel, 800 px photo, idempotent check-in/out, duplicate pre-check before photo upload, photo upload outside the lock, recent-rows reads).
- Company self-registration with Google sign-in (scope drive.file + email only). Spreadsheet and private photo folders are created in the company admin's own Google account.
- Roles in one APK: Admin, Manager, Employee, plus Owner console (status, plan, expiry, employee limit).
- Employees/managers created inside the app (automatic IDs E001/M001, PINs stored hashed, reset PIN, suspend/deactivate, geofence per employee).
- Admin dashboard, Location & Photos (filters, photos shown only through an authorised call), monthly Excel (P/L/WO/MC, hours, location) built on the phone with Sundays in yellow, shared via the Android share sheet.
- Server-side company isolation, licence checks on every request, 5-failure PIN lock, audit log in the owner registry.
- Not yet: offline queue, holiday calendar, Excel import.

# Release notes

## 2.5.0 - faster check-in
- App: location is found WHILE the camera is open (was: after the photo), so the Submit button is ready at once.
- App: photo is captured at 800 px / 60% quality (smaller upload, no double resize). Location finishes sooner (<=25 m at once, <=50 m after 5 s, max 12 s). Any accuracy is still accepted and recorded.
- Server: photo upload to Drive now happens outside the lock, so 30 technicians can check in at the same time without queueing.
- Server: duplicate / already-checked-in requests are refused before the photo is uploaded; Drive folder id is cached; daily actions read only the newest 600 rows (reports still read everything).
- Version 2.5 - replace www/app.js on GitHub AND paste the new Code.gs in Apps Script (Deploy > Manage deployments > pencil > New version).

## 2.0.0 - Google Sheet edition
* Backend replaced by Google Apps Script + Google Sheet + Google Drive (no hosting cost).
* Sign-in with Employee ID + PIN; Status / Expiry in the Employees tab enforced on every request.
* Check-in: front-camera photo (information band burned in) + GPS; check-out: GPS only. Duplicate-safe.
* Monthly P/A and Location reports generated inside the Sheet (Sundays yellow), downloadable as Excel.
* Tests: 8 backend-logic tests against a mock of Google services (`npm test`).

## 2.1.0
* Fix: camera and GPS now use the native plugins (registerPlugin). Previously the app fell back to browser camera/GPS, which skipped the permission prompts.

## 2.2.0
* No GPS accuracy restriction: best reading within ~15 s is recorded with its accuracy (warning above 100 m). Location is collected while the photo is being reviewed.
* Reports: PA tab now has Total Hours Worked; new Hours tab; Location tab is one row per session with Open map + View photo links.

## 2.3.0
* Fix: "Camera component is missing". The app now calls the native Camera and Geolocation plugins through the Capacitor Android bridge (nativePromise / nativeCallback). window.Capacitor.registerPlugin and Capacitor.Plugins are not available in an un-bundled page, which broke v2.0-2.2.
* Tests: added bridge tests that run the real Capacitor Android bridge against a fake phone (14 tests in total).

## 2.4.0
* Fix: blank screen after install (v2.3 deleted the app's state variable, so the app crashed before drawing the login page). Any future startup error is now shown on screen.
* Fix: signing out after a suspension no longer throws an error from the old photo screen.
* Reports: days without attendance now show L (Leave) instead of A; totals column is Leave (L).
* Tests: added a full end-to-end test (real app.js + real Android bridge + real Code.gs on a mock sheet): login, photo, GPS, submit, logout.
