# Nondh AI Privacy Policy

_Effective: 24 October 2026_

Nondh AI is a Windows desktop app for dictation, meeting notes and screen recording. It is built to work offline: your recordings, transcripts, notes and settings stay on your own computer. The developer of Nondh AI does not run any server that receives your data, and the app contains no analytics, tracking or advertising.

## What stays on your computer

- **Audio and screen recordings, transcripts, summaries, notes and dictation history.** These are stored in folders on your PC that you choose. You can turn on encryption for recordings and the database in Settings, with keys protected by Windows.
- **Speech recognition and the built-in AI model.** These run locally on your computer. Your voice is not sent anywhere for transcription unless you choose a cloud engine (see below).
- **Voice fingerprints** you create to recognise speakers, stored only in the local database.

You can delete any meeting, recording or note in the app, or delete everything from **Settings**.

## Google Calendar (optional)

If you click **Connect Google**, you sign in with your own Google account and approve **read-only** access to your calendar (`calendar.readonly`).

- **What is read:** the title, start and end time, and attendee names or email addresses of your upcoming events.
- **How it is used:** to name a meeting recording after the calendar event it belongs to, and to suggest attendee names when you label speakers in a transcript. Event details you use this way are saved with that meeting on your computer.
- **Where it goes:** the calendar data travels directly from Google to your computer. It is not sent to the developer or to any other server, not sold, not used for advertising, and not used to train AI models.
- **Your sign-in:** the access token Google issues is stored only on your computer, encrypted with Windows (DPAPI). Nondh AI never sees your Google password.
- **Disconnecting:** click **Disconnect Google** in Settings → Calendar to delete the saved token from your computer. You can also remove Nondh AI's access at any time at <https://myaccount.google.com/permissions>.

Nondh AI's use and transfer of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

## Cloud services you choose to use (optional)

Nondh AI works without any cloud service. If you add your own API key for a cloud provider (for example Anthropic, OpenAI, Google Gemini, Groq or OpenRouter) and select it for transcription, text clean-up, summaries or questions, the text or audio needed for that task is sent from your computer directly to that provider under your own account and that provider's privacy policy. This can include a meeting's transcript, title and attendee names when you ask for a summary or ask a question about it. Your API keys are stored on your computer, encrypted with Windows. Nothing is sent to a cloud provider unless you set it up.

## Network connections the app makes

- **Model downloads** from Hugging Face and GitHub, the first time the app needs a speech or AI model.
- **Update checks** against this project's GitHub Releases (you can change or turn this off in Settings).
- **Google Calendar**, only if you connect it.
- **Cloud AI providers**, only if you add a key and choose them.

These requests carry the usual technical information any download does (such as your IP address), handled under those services' own policies. Nondh AI adds no identifiers of its own.

## Local API

The optional local API and MCP server listen only on your own computer (`127.0.0.1`) and require a token stored on your PC. They are not reachable from the internet.

## Children

Nondh AI is not directed at children under 13 and does not knowingly collect their information.

## Changes

If this policy changes, the new version will be published here with a new effective date.

## Contact

Questions or requests: open an issue at <https://github.com/Hemang67/NondhAI/issues>, or contact the developer, Hemang Rathod, via <https://hemang-rathod.vercel.app/>.
