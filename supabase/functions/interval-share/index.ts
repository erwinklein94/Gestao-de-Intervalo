import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Metodo nao permitido." }, 405);

  try {
    const payload = await request.json().catch(() => ({}));
    const token = typeof payload?.token === "string" ? payload.token.trim() : "";
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) {
      return json({ error: "Link de acompanhamento invalido." }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY") ?? "";
    if (!supabaseUrl || !serviceKey) return json({ error: "Servico indisponivel." }, 503);

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const tokenHash = await sha256(token);
    const now = new Date().toISOString();

    const { data: share, error: shareError } = await admin
      .from("interval_share_links")
      .select("id,plan_id,expires_at,revoked_at")
      .eq("token_hash", tokenHash)
      .is("revoked_at", null)
      .gt("expires_at", now)
      .maybeSingle();

    if (shareError) throw shareError;
    if (!share) return json({ error: "Este link expirou, foi revogado ou nao existe." }, 404);

    const { data: plan, error: planError } = await admin
      .from("interval_plans")
      .select("client_id,title,service_type,coordinator,interval_date,location,window_start,window_end,planning_notes,execution_notes,is_locked,locked_at,created_at,updated_at,interval_steps(client_id,position,activity_name,planned_start,planned_end,actual_start,actual_end,actual_notes,updated_at)")
      .eq("id", share.plan_id)
      .single();

    if (planError || !plan) return json({ error: "Intervalo nao encontrado." }, 404);

    await admin
      .from("interval_share_links")
      .update({ last_accessed_at: now })
      .eq("id", share.id);

    return json({
      plan,
      share: { expires_at: share.expires_at },
      fetched_at: now,
    });
  } catch (error) {
    console.error("interval-share", error);
    return json({ error: "Nao foi possivel carregar o acompanhamento agora." }, 500);
  }
});
