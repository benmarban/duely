// Dayflow — finish "Connect Gmail". Google redirects the user's browser here with
// ?code&state. We match state → account, trade the code for a refresh token, stash
// it in the service-role-only vault (gmail_accounts), flip a non-secret "connected"
// flag in user_state so the app can show it, then bounce back to the app.
//
// Deploy with --no-verify-jwt (Google's browser redirect carries no Supabase JWT;
// the random one-time state is the proof instead).
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const REDIRECT_URI = "https://aefmntlnwbmsgeoqqarw.supabase.co/functions/v1/gmail-oauth-callback";
const APP_URL = "https://dayflo.org/app.html";

const back = (status: string) => Response.redirect(`${APP_URL}?gmail=${status}`, 302);

Deno.serve(async (req) => {
  try {
    const u = new URL(req.url);
    const code = u.searchParams.get("code");
    const state = u.searchParams.get("state");
    if (u.searchParams.get("error") || !code || !state) return back("error");

    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Match + consume the one-time state.
    const { data: st } = await supa.from("gmail_oauth_state").select("user_id").eq("state", state).maybeSingle();
    const userId = (st as any)?.user_id as string | undefined;
    if (!userId) return back("error");
    await supa.from("gmail_oauth_state").delete().eq("state", state);

    // Trade the code for tokens. prompt=consent guaranteed a refresh_token.
    const tr = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
        client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    const tok = await tr.json();
    if (!tr.ok || !tok.refresh_token) {
      console.error("token exchange failed:", tr.status, JSON.stringify(tok).slice(0, 300));
      return back("error");
    }

    // Which mailbox did they connect? (nice for the UI; also confirms the token works)
    let email = "";
    try {
      const pr = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
        headers: { Authorization: "Bearer " + tok.access_token },
      });
      email = ((await pr.json()) as any)?.emailAddress || "";
    } catch { /* non-fatal */ }

    // Secret token → vault (service-role only).
    await supa.from("gmail_accounts").upsert({
      user_id: userId,
      email,
      refresh_token: tok.refresh_token,
      connected_at: new Date().toISOString(),
      last_error: null,
    });

    // Non-secret status flag → user_state, so the app shows "Connected ✓" without
    // ever touching the token. Read-modify-write the blob (service role).
    const { data: row } = await supa.from("user_state").select("data").eq("user_id", userId).maybeSingle();
    const data: any = (row as any)?.data ?? {};
    data.gmail = { connected: true, email };
    await supa.from("user_state").upsert({ user_id: userId, data, updated_at: new Date().toISOString() });

    return back("connected");
  } catch (e) {
    console.error("callback error:", (e as Error)?.message);
    return back("error");
  }
});
