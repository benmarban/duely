// Dayflow — begin "Connect Gmail". The app calls this (signed in); we mint a
// one-time state tied to the user, and hand back the Google consent URL to send
// them to. The matching callback (gmail-oauth-callback) finishes the handshake.
//
// Deploy with --no-verify-jwt; we authenticate the caller ourselves via getUser
// (the anon key is a valid JWT, so verify_jwt alone wouldn't prove a real user).
// Secrets: GOOGLE_CLIENT_ID. (SUPABASE_URL / _ANON_KEY / _SERVICE_ROLE_KEY auto.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Must byte-for-byte match the URI registered on the Google OAuth client.
const REDIRECT_URI = "https://aefmntlnwbmsgeoqqarw.supabase.co/functions/v1/gmail-oauth-callback";
// gmail.readonly is the least access that still lets us read message bodies.
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Not signed in" }, 401);
    const supaUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: u } = await supaUser.auth.getUser();
    const userId = u?.user?.id;
    if (!userId) return json({ error: "Not signed in" }, 401);

    const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
    if (!clientId) return json({ error: "Server missing GOOGLE_CLIENT_ID" }, 500);

    // One-time, single-use state so the callback can prove which account is linking.
    const state = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await supa.from("gmail_oauth_state").delete().eq("user_id", userId); // drop any stale attempt
    const { error } = await supa.from("gmail_oauth_state").insert({ state, user_id: userId });
    if (error) return json({ error: "Could not start: " + error.message }, 500);

    const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline", // ask for a refresh token
      prompt: "consent",       // force a refresh token every time
      include_granted_scopes: "true",
      state,
    }).toString();

    return json({ url });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
