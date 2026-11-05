# Field Attendance App (v3.0.0)

One Android app, one central backend, many companies. Roles: company **Admin**, **Manager**, **Employee**, and the app **Owner**.

* Each company registers in the app and signs in with Google. Its attendance sheet and private photo folder are created in that admin's own Google account.
* Employees sign in with Company ID + Employee ID + PIN. Check-in = front-camera photo + GPS (GPS starts while the camera is open). Check-out = GPS only.
* Admin: dashboard, employee/manager management inside the app, Location & Photos with filters, monthly Excel reports, company and subscription details.
* Manager: sees only assigned employees. Owner: companies, status, plan, expiry, employee limit.

## Folders
| Folder | What |
|---|---|
| `apps-script/Code.gs` | Central backend (paste into Apps Script once - see GOOGLE_CLOUD_SETUP.md) |
| `www/` | The app (HTML/JS). `excel.js` builds the Excel reports |
| `tests/` | `npm test` - 29 automated tests against a simulated Google and a simulated phone |
| `.github/workflows/build-apk.yml` | Builds the APK (and optionally the Play Store .aab) |

## Run the tests
`npm ci && npm test`

## What the tests do and do NOT prove
They run the real backend code against a fake Google (OAuth, Sheets, Drive with per-account isolation) and the real app in a fake phone. They prove our logic: registration, roles, company isolation, licence rules, duplicate protection, reports and the Excel files. They do NOT prove that real Google accepts every call exactly as the fake does, nor camera/GPS on a real phone. First real-world run is the true test - follow GOOGLE_CLOUD_SETUP.md section D.

## Not built yet (planned next)
Offline queue (Pending/Synced/Failed), public-holiday calendar, Excel import of employees, data-retention tools, owner-side "register company on behalf of customer".
