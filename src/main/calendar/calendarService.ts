import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { shell } from "electron";
import type { Settings } from "@shared/settings";
import { fromGoogle, type CalendarEvent } from "@shared/calendar";
import { getSecret, setSecret } from "../secrets";
import { log } from "../log";

export type { CalendarEvent };

interface Tokens {
  access: string;
  refresh: string;
  expiresAt: number;
  /** The signed-in account's email, shown in Settings and on the Calendar page. */
  account?: string;
}

type Provider = "google" | "microsoft";

const CONFIG = {
  google: {
    auth: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/calendar.readonly",
  },
  microsoft: {
    auth: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "offline_access Calendars.Read User.Read",
  },
} as const;

// Google treats a desktop app's client secret as non-confidential; it's kept out of git only
// so GitHub secret scanning doesn't flag the public repo.
const BUILT_IN_GOOGLE = {
  id: import.meta.env.MAIN_VITE_GOOGLE_CLIENT_ID ?? "",
  secret: import.meta.env.MAIN_VITE_GOOGLE_CLIENT_SECRET ?? "",
};

const b64url =(b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Read-only calendar access (Google, Microsoft 365/Outlook) with the user's own OAuth app
 * registration. Used to title meetings and to offer attendee names when naming speakers.
 * Tokens are stored encrypted (DPAPI).
 */
export class CalendarService {
  private cache: { at: number; events: CalendarEvent[] } = { at: 0, events: [] };

  constructor(private readonly settings: () => Settings) {}

  status(): { google: boolean; microsoft: boolean; googleBuiltIn: boolean; googleAccount: string | null } {
    const google = getSecret("google-oauth");
    let googleAccount: string | null = null;
    try {
      googleAccount = google ? ((JSON.parse(google) as Tokens).account ?? null) : null;
    } catch {
      // unreadable token: treated as connected without a name
    }
    return { google: !!google, microsoft: !!getSecret("microsoft-oauth"), googleBuiltIn: this.googleBuiltIn, googleAccount };
  }

  disconnect(p: Provider): void {
    setSecret(`${p}-oauth`, "");
    this.cache = { at: 0, events: [] };
  }

  /** The publisher's Google OAuth app, built in from .env.local at build time (see .env.example). */
  get googleBuiltIn(): boolean {
    return !!BUILT_IN_GOOGLE.id;
  }

  /** A client ID entered in Settings (with its own secret) wins over the built-in Google app. */
  private oauthApp(p: Provider): { id: string; secret: string } {
    const c = this.settings().calendar;
    const app =
      p === "microsoft"
        ? { id: c.microsoftClientId, secret: "" }
        : c.googleClientId
          ? { id: c.googleClientId, secret: c.googleClientSecret }
          : BUILT_IN_GOOGLE;
    if (!app.id) throw new Error(`Add your ${p === "google" ? "Google" : "Microsoft"} OAuth client ID in Settings → Calendar first.`);
    return app;
  }

  private clientId(p: Provider): string {
    return this.oauthApp(p).id;
  }

  /** Browser sign-in with PKCE and a one-shot localhost redirect. */
  async connect(p: Provider): Promise<void> {
    const clientId = this.clientId(p);
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const state = b64url(randomBytes(16));
    const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const c = url.searchParams.get("code");
        const ok = c && url.searchParams.get("state") === state;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<html><body style="font-family:Segoe UI;padding:40px"><h2>${ok ? "Nondh AI is connected." : "Sign-in failed."}</h2><p>You can close this tab.</p></body></html>`,
        );
        server.close();
        if (ok) resolve({ code: c!, redirectUri });
        else reject(new Error(url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? "sign-in failed"));
      });
      let redirectUri = "";
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as { port: number }).port;
        // Microsoft matches "http://localhost" registrations on any port; Google accepts loopback IPs.
        redirectUri = p === "microsoft" ? `http://localhost:${port}` : `http://127.0.0.1:${port}`;
        const q = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: CONFIG[p].scope,
          code_challenge: challenge,
          code_challenge_method: "S256",
          state,
          ...(p === "google" ? { access_type: "offline", prompt: "consent" } : {}),
        });
        void shell.openExternal(`${CONFIG[p].auth}?${q}`);
      });
      setTimeout(() => {
        server.close();
        reject(new Error("Sign-in timed out"));
      }, 5 * 60 * 1000);
    });
    const tokens = await this.exchange(p, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    // The primary calendar's id is the account's email (no extra scope needed).
    if (p === "google") {
      const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary", { headers: { authorization: `Bearer ${tokens.access}` } }).catch(() => null);
      if (r?.ok) tokens.account = ((await r.json()) as { id?: string }).id;
    }
    setSecret(`${p}-oauth`, JSON.stringify(tokens));
    this.cache = { at: 0, events: [] };
    log.info(`calendar connected: ${p}`);
  }

  private async exchange(p: Provider, body: Record<string, string>, previousRefresh?: string): Promise<Tokens> {
    const app = this.oauthApp(p);
    const form = new URLSearchParams({ client_id: app.id, ...body });
    if (app.secret) form.set("client_secret", app.secret);
    if (p === "microsoft") form.set("scope", CONFIG.microsoft.scope);
    const r = await fetch(CONFIG[p].token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
    if (!r.ok) throw new Error(`${p} token request failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    return { access: j.access_token, refresh: j.refresh_token ?? previousRefresh ?? "", expiresAt: Date.now() + (j.expires_in - 60) * 1000 };
  }

  private async accessToken(p: Provider): Promise<string | null> {
    const raw = getSecret(`${p}-oauth`);
    if (!raw) return null;
    let t = JSON.parse(raw) as Tokens;
    if (Date.now() > t.expiresAt) {
      t = { ...(await this.exchange(p, { grant_type: "refresh_token", refresh_token: t.refresh }, t.refresh)), account: t.account };
      setSecret(`${p}-oauth`, JSON.stringify(t));
    }
    return t.access;
  }

  /**
   * Every event between `from` and `to` in the connected calendars (all pages, all-day events
   * included). Throws when a calendar can't be read, so the Calendar page can say why.
   */
  async events(from: number, to: number): Promise<CalendarEvent[]> {
    const events: CalendarEvent[] = [];
    const timeMin = new Date(from).toISOString();
    const timeMax = new Date(to).toISOString();
    const g = await this.accessToken("google");
    if (g) {
      let pageToken = "";
      do {
        const q = new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "2500" });
        if (pageToken) q.set("pageToken", pageToken);
        const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, { headers: { authorization: `Bearer ${g}` } });
        if (!r.ok) throw new Error(`Google Calendar: ${r.status} ${(await r.text()).slice(0, 200)}`);
        const j = (await r.json()) as { items?: Array<Record<string, any>>; nextPageToken?: string };
        for (const e of j.items ?? []) {
          const ev = fromGoogle(e);
          if (ev) events.push(ev);
        }
        pageToken = j.nextPageToken ?? "";
      } while (pageToken);
      log.info(`google calendar: ${events.length} events from ${timeMin} to ${timeMax}`);    }
    const m = await this.accessToken("microsoft");
    if (m) {
      let url: string | undefined =
        `https://graph.microsoft.com/v1.0/me/calendarView?${new URLSearchParams({ startDateTime: timeMin, endDateTime: timeMax, $top: "500", $orderby: "start/dateTime" })}`;
      while (url) {
        const r = await fetch(url, { headers: { authorization: `Bearer ${m}`, Prefer: 'outlook.timezone="UTC"' } });
        if (!r.ok) throw new Error(`Outlook calendar: ${r.status} ${(await r.text()).slice(0, 200)}`);
        const j = (await r.json()) as { value?: Array<Record<string, any>>; "@odata.nextLink"?: string };
        for (const e of j.value ?? []) {
          if (e.isCancelled) continue;
          events.push({
            id: `microsoft:${e.id}`,
            title: e.subject || "(no title)",
            start: Date.parse(`${e.start.dateTime}Z`),
            end: Date.parse(`${e.end.dateTime}Z`),
            allDay: !!e.isAllDay,
            attendees: (e.attendees ?? []).map((a: any) => a.emailAddress?.name || a.emailAddress?.address).filter(Boolean),
            provider: "microsoft",
            joinUrl: e.onlineMeeting?.joinUrl || undefined,
            location: e.location?.displayName || undefined,
            link: e.webLink || undefined,
          });
        }
        url = j["@odata.nextLink"];
      }
    }
    return events.sort((a, b) => a.start - b.start);
  }

  /** Recent and next few days' events, cached for 5 minutes (used to title new recordings). */
  async upcoming(force = false): Promise<CalendarEvent[]> {
    if (!force && Date.now() - this.cache.at < 5 * 60 * 1000) return this.cache.events;
    let events: CalendarEvent[] = [];
    try {
      events = await this.events(Date.now() - 12 * 3600 * 1000, Date.now() + 3 * 86400 * 1000);
    } catch (err) {
      log.warn("calendar fetch failed", err);
    }
    this.cache = { at: Date.now(), events };
    return events;
  }

  /** The timed event happening now (or starting within 10 minutes) that you haven't declined. */
  async current(now = Date.now()): Promise<CalendarEvent | null> {
    const events = await this.upcoming();
    return events.find((e) => !e.allDay && !e.declined && e.start - 10 * 60 * 1000 <= now && now <= e.end) ?? null;
  }
}
