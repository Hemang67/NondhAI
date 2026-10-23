import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { shell } from "electron";
import type { Settings } from "@shared/settings";
import { getSecret, setSecret } from "../secrets";
import { log } from "../log";

export interface CalendarEvent {
  id: string;
  title: string;
  start: number;
  end: number;
  attendees: string[];
  provider: "google" | "microsoft";
}

interface Tokens {
  access: string;
  refresh: string;
  expiresAt: number;
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

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Read-only calendar access (Google, Microsoft 365/Outlook) with the user's own OAuth app
 * registration. Used to title meetings and to offer attendee names when naming speakers.
 * Tokens are stored encrypted (DPAPI).
 */
export class CalendarService {
  private cache: { at: number; events: CalendarEvent[] } = { at: 0, events: [] };

  constructor(private readonly settings: () => Settings) {}

  status(): { google: boolean; microsoft: boolean } {
    return { google: !!getSecret("google-oauth"), microsoft: !!getSecret("microsoft-oauth") };
  }

  disconnect(p: Provider): void {
    setSecret(`${p}-oauth`, "");
    this.cache = { at: 0, events: [] };
  }

  private clientId(p: Provider): string {
    const c = this.settings().calendar;
    const id = p === "google" ? c.googleClientId : c.microsoftClientId;
    if (!id) throw new Error(`Add your ${p === "google" ? "Google" : "Microsoft"} OAuth client ID in Settings → Calendar first.`);
    return id;
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
    setSecret(`${p}-oauth`, JSON.stringify(tokens));
    log.info(`calendar connected: ${p}`);
  }

  private async exchange(p: Provider, body: Record<string, string>, previousRefresh?: string): Promise<Tokens> {
    const form = new URLSearchParams({ client_id: this.clientId(p), ...body });
    const secret = this.settings().calendar.googleClientSecret;
    if (p === "google" && secret) form.set("client_secret", secret);
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
      t = await this.exchange(p, { grant_type: "refresh_token", refresh_token: t.refresh }, t.refresh);
      setSecret(`${p}-oauth`, JSON.stringify(t));
    }
    return t.access;
  }

  async upcoming(force = false): Promise<CalendarEvent[]> {
    if (!force && Date.now() - this.cache.at < 5 * 60 * 1000) return this.cache.events;
    const from = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
    const to = new Date(Date.now() + 3 * 86400 * 1000).toISOString();
    const events: CalendarEvent[] = [];
    try {
      const g = await this.accessToken("google");
      if (g) {
        const q = new URLSearchParams({ timeMin: from, timeMax: to, singleEvents: "true", orderBy: "startTime", maxResults: "100" });
        const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, { headers: { authorization: `Bearer ${g}` } });
        if (r.ok) {
          const j = (await r.json()) as { items?: Array<Record<string, any>> };
          for (const e of j.items ?? []) {
            if (!e.start?.dateTime) continue; // skip all-day events
            events.push({
              id: `google:${e.id}`,
              title: e.summary ?? "(no title)",
              start: Date.parse(e.start.dateTime),
              end: Date.parse(e.end.dateTime),
              attendees: (e.attendees ?? []).filter((a: any) => !a.self && !a.resource).map((a: any) => a.displayName || a.email),
              provider: "google",
            });
          }
        } else log.warn(`google calendar ${r.status}`);
      }
      const m = await this.accessToken("microsoft");
      if (m) {
        const q = new URLSearchParams({ startDateTime: from, endDateTime: to, $top: "100", $orderby: "start/dateTime" });
        const r = await fetch(`https://graph.microsoft.com/v1.0/me/calendarView?${q}`, {
          headers: { authorization: `Bearer ${m}`, Prefer: 'outlook.timezone="UTC"' },
        });
        if (r.ok) {
          const j = (await r.json()) as { value?: Array<Record<string, any>> };
          for (const e of j.value ?? []) {
            if (e.isAllDay) continue;
            events.push({
              id: `microsoft:${e.id}`,
              title: e.subject ?? "(no title)",
              start: Date.parse(`${e.start.dateTime}Z`),
              end: Date.parse(`${e.end.dateTime}Z`),
              attendees: (e.attendees ?? []).map((a: any) => a.emailAddress?.name || a.emailAddress?.address).filter(Boolean),
              provider: "microsoft",
            });
          }
        } else log.warn(`microsoft calendar ${r.status}`);
      }
    } catch (err) {
      log.warn("calendar fetch failed", err);
    }
    events.sort((a, b) => a.start - b.start);
    this.cache = { at: Date.now(), events };
    return events;
  }

  /** The event happening now (or starting within 10 minutes), if any. */
  async current(now = Date.now()): Promise<CalendarEvent | null> {
    const events = await this.upcoming();
    return events.find((e) => e.start - 10 * 60 * 1000 <= now && now <= e.end) ?? null;
  }
}
