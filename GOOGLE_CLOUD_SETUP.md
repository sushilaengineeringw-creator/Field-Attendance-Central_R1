# One-time owner setup (you do this once; customers do nothing)

You need: a Google account for the product (use a dedicated one, e.g. `fieldattendance.owner@gmail.com`), a GitHub repo, and about 45 minutes.
Customer data is NOT stored in this account. It lives in each company admin's own Google account. This account only holds the company list (registry) and each admin's encrypted Google refresh token.

## A. Create the central backend (Apps Script)
1. Sign in to the owner Google account. Open https://script.google.com -> **New project**. Name it `Field Attendance Central`.
2. Replace everything in `Code.gs` with `apps-script/Code.gs` from this project. Save.
3. Keep this tab open. You will come back to it in step C.

## B. Create the Google sign-in (Google Cloud)
1. Open https://console.cloud.google.com with the same account -> create a project `Field Attendance`.
2. **APIs & Services -> Library**: enable **Google Sheets API** and **Google Drive API**.
3. **APIs & Services -> OAuth consent screen** (External):
   - App name `Field Attendance`, support email, developer email.
   - Scopes: add `.../auth/drive.file` and `.../auth/userinfo.email` ONLY (do not add anything else).
   - Add your privacy-policy URL (required for Play Store too) and your domain.
   - While it says **Testing**: only the "test users" you list can register, and Google expires the refresh tokens after 7 days. Before real customers use it, click **Publish app** (In production). With only these two scopes Google normally needs just basic brand verification, but check Google's current rules in the console.
4. **Credentials -> Create credentials -> OAuth client ID -> Web application**. Leave the redirect URI empty for now. Save. Copy the **Client ID** and **Client secret**.

## C. Connect the two
1. In Apps Script: **Project Settings (gear) -> Script properties -> Add**:
   - `CLIENT_ID` = the Client ID
   - `CLIENT_SECRET` = the Client secret
   - `OWNER_PASSWORD` = a long password only you know (this is your owner sign-in in the app)
   - optional `TRIAL_DAYS` = 14
2. Editor -> choose function `setup` -> **Run** (approve the permissions). The log says "Setup complete".
3. **Deploy -> New deployment -> Web app**: Execute as **Me**, Who has access **Anyone**. Deploy. Copy the `/exec` URL.
4. Back in Google Cloud -> Credentials -> your OAuth client -> **Authorised redirect URIs** -> add that exact `/exec` URL. Save.
5. When you later change the code, use **Deploy -> Manage deployments -> pencil -> New version** so the `/exec` URL (and the redirect URI) stays the same.

## D. Build the app
1. Put this project in a GitHub repo. Repo **Settings -> Secrets and variables -> Actions -> Variables -> New variable** `SERVER_URL` = the `/exec` URL.
2. **Actions -> Build Android APK -> Run workflow**. Download the APK from Artifacts.
3. Install it. Tap **Register your company**, register a test company with a Gmail account, tap **Allow**, return to the app. Sign in as `ADMIN`.
4. Check in your own Google Drive: a sheet `<Company> - Field Attendance` and a folder `Field Attendance - <Company>` now exist.
5. Owner console: on the sign-in page tap **Owner sign-in**.

## E. Play Store bundle (.aab) - later
Needs a Play developer account, a privacy policy, the Data safety form (camera, precise location, photos, personal info), and a release keystore that you keep safe forever.
1. Create a keystore: `keytool -genkeypair -v -keystore release.keystore -alias fa -keyalg RSA -keysize 2048 -validity 10000`
2. Encode it: `base64 -w0 release.keystore` and add GitHub secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
3. **Run workflow** with *build_aab* ticked. Upload the `.aab` from Artifacts to Play Console.
4. The app id is `com.fieldattendance.app` in `capacitor.config.json`. It can never change after the first Play upload. Change it to your own domain BEFORE the first upload if you want.
