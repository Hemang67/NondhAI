# Connecting a calendar

Nondh AI reads your calendar (read-only) to name meetings after the calendar event and to suggest attendee names when you label speakers. It uses **your own** OAuth app, so no third party is involved. Each setup takes about 10 minutes, once.

## Google Calendar

1. Go to <https://console.cloud.google.com/> and create a project (any name).
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen**: choose External, fill in the app name and your email, add the scope `.../auth/calendar.readonly`, and add yourself as a test user.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** → application type **Desktop app**.
5. Copy the **Client ID** and **Client secret** into Nondh AI → Settings → Calendar, then click **Connect Google**. A browser window opens; approve it.

## Microsoft 365 / Outlook

1. Go to <https://entra.microsoft.com/> → **App registrations → New registration**.
2. Supported account types: "Accounts in any organizational directory and personal Microsoft accounts" (or just your organization).
3. Redirect URI: platform **Public client/native (mobile & desktop)**, value `http://localhost`.
4. **API permissions → Add → Microsoft Graph → Delegated**: `Calendars.Read`, `User.Read`, `offline_access`.
5. Copy the **Application (client) ID** into Nondh AI → Settings → Calendar, then click **Connect Microsoft**.

Tokens are stored encrypted with Windows DPAPI. **Disconnect** removes them.

> This was built to the Google and Microsoft OAuth documentation but has **not** been tested against a real account, because that needs your own client IDs. If a sign-in fails, the error text from Google or Microsoft appears under the Connect buttons.
