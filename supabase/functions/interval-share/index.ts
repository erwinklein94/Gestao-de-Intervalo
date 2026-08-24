import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";

const allowedOrigins = new Set(["https://erwinklein94.github.io", "https://www.sistemagestaodeintervalos.com.br", "https://sistemagestaodeintervalos.com.br", "http://www.sistemagestaodeintervalos.com.br", "http://sistemagestaodeintervalos.com.br", "http://localhost:4173", "http://localhost:4174", "http://localhost:8000"]);

function json(origin: string | null, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Access-Control-Allow-Origin": origin && allowedOrigins.has(origin) ? origin : "https://erwinklein94.github.io",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Vary": "Origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  if (origin && !allowedOrigins.has(origin)) return json(origin, { error: "Link inválido ou indisponível." }, 404);
  if (request.method === "OPTIONS") return json(origin, { ok: true });
  if (request.method !== "POST") return json(origin, { error: "Método não permitido." }, 405);
  if (Number(request.headers.get("content-length") || 0) > 2048) return json(origin, { error: "Link inválido ou indisponível." }, 404);

  try {
    const payload = await request.json().catch(() => ({}));
    const token = typeof payload?.token === "string" ? payload.token.trim() : "";
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) return json(origin, { error: "Link inválido ou indisponível." }, 404);
    // Qual frente do bloqueio exibir. Vazio ou fora do formato cai na frente
    // que o link ancorou; a validacao de pertencimento vem depois.
    const rawFront = typeof payload?.front === "string" ? payload.front.trim() : "";
    const requestedFront = /^[0-9a-fA-F-]{16,64}$/.test(rawFront) ? rawFront : "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY") || "";
    if (!supabaseUrl || !serviceKey) return json(origin, { error: "Serviço indisponível." }, 503);
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const tokenHash = await sha256(token);
    const now = new Date().toISOString();

    const { data: share, error: shareError } = await admin.from("interval_share_links")
      .select("id,plan_id,owner_id,expires_at")
      .eq("token_hash", tokenHash).is("revoked_at", null).gt("expires_at", now).maybeSingle();
    if (shareError) throw shareError;
    if (!share) return json(origin, { error: "Link inválido ou indisponível." }, 404);

    const { data: realDataset } = await admin.from("datasets").select("id").eq("code", "real").eq("kind", "real").eq("active", true).maybeSingle();
    if (!realDataset) return json(origin, { error: "Serviço indisponível." }, 503);

    // O link aponta para uma frente, mas quem acompanha quer o bloqueio: o
    // group_id da frente ancorada define o intervalo inteiro que este token
    // enxerga. Todas as frentes de um grupo tem o mesmo responsavel -- o guard
    // do banco garante isso --, entao a autorizacao do dono vale para todas.
    const { data: anchor, error: anchorError } = await admin.from("interval_plans")
      .select("id,dataset_id,coordinator_member_id,group_id")
      .eq("id", share.plan_id).eq("dataset_id", realDataset.id).maybeSingle();
    if (anchorError) throw anchorError;
    if (!anchor) return json(origin, { error: "Link inválido ou indisponível." }, 404);

    const { data: ownerProfile } = await admin.from("user_profiles").select("id,role,enabled,organization_member_id").eq("id", share.owner_id).maybeSingle();
    if (!ownerProfile?.enabled || !ownerProfile.organization_member_id || !["editor", "manager", "coordinator", "specialist"].includes(ownerProfile.role)) return json(origin, { error: "Link inválido ou indisponível." }, 404);
    const { data: ownerMember } = await admin.from("organization_members").select("id,role,enabled,dataset_id").eq("id", ownerProfile.organization_member_id).eq("dataset_id", realDataset.id).maybeSingle();
    const ownerAuthorized = ownerMember?.enabled && ownerMember.role === ownerProfile.role && (ownerProfile.role === "editor" || ownerMember.id === anchor.coordinator_member_id);
    if (!ownerAuthorized) return json(origin, { error: "Link inválido ou indisponível." }, 404);

    const { data: groupPlans, error: groupError } = await admin.from("interval_plans")
      .select("id,dataset_id,coordinator_member_id,client_id,title,service_type,contractor_name,foreman_name,coordinator,interval_date,location,window_start,window_end,planning_notes,execution_notes,is_locked,locked_at,status,completed_at,created_at,updated_at,front_position,front_name,interval_steps(client_id,position,activity_name,planned_start,planned_end,actual_start,actual_end,actual_notes,status,skip_reason,updated_at)")
      .eq("group_id", anchor.group_id).eq("dataset_id", realDataset.id)
      .order("front_position").order("created_at");
    if (groupError) throw groupError;
    if (!groupPlans?.length) return json(origin, { error: "Link inválido ou indisponível." }, 404);

    // A frente pedida precisa pertencer ao mesmo bloqueio; qualquer outra coisa
    // cai de volta na frente do link.
    const plan = groupPlans.find((front) => front.client_id === requestedFront) || groupPlans.find((front) => front.id === anchor.id) || groupPlans[0];

    const { data: comments, error: commentsError } = await admin.from("interval_comments")
      .select("author_name,author_role,author_role_gender,content,created_at")
      .eq("plan_id", plan.id).eq("dataset_id", realDataset.id).is("deleted_at", null).order("created_at");
    if (commentsError) throw commentsError;

    const { data: touched } = await admin.from("interval_share_links").update({ last_accessed_at: now })
      .eq("id", share.id).eq("token_hash", tokenHash).is("revoked_at", null).gt("expires_at", now).select("id").maybeSingle();
    if (!touched) return json(origin, { error: "Link inválido ou indisponível." }, 404);

    // A lista de frentes nao carrega etapas nem identificadores internos: serve
    // so para desenhar a navegacao entre elas.
    const fronts = groupPlans.map((front) => ({
      client_id: front.client_id,
      front_position: front.front_position,
      front_name: front.front_name,
      service_type: front.service_type,
      status: front.status,
    }));

    const { id: _id, dataset_id: _dataset, coordinator_member_id: _coordinator, ...safePlan } = plan;
    return json(origin, { plan: safePlan, fronts, comments: comments || [], share: { expires_at: share.expires_at }, fetched_at: now });
  } catch (error) {
    console.error("interval-share", error instanceof Error ? error.message : "unknown");
    return json(origin, { error: "Não foi possível carregar o acompanhamento agora." }, 500);
  }
});
