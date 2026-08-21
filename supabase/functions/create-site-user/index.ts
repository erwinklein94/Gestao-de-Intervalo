import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";

const allowedOrigins = new Set(["https://erwinklein94.github.io", "http://localhost:4173", "http://localhost:4174", "http://localhost:8000"]);
const roles = new Set(["director", "consultant", "manager", "coordinator", "editor"]);
const coordinatorTypes = new Set(["infrastructure", "superstructure"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function response(origin: string | null, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Access-Control-Allow-Origin": origin && allowedOrigins.has(origin) ? origin : "https://erwinklein94.github.io",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Vary": "Origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  if (origin && !allowedOrigins.has(origin)) return response(origin, { error: "Origem não autorizada." }, 403);
  if (request.method === "OPTIONS") return response(origin, { ok: true });
  if (request.method !== "POST") return response(origin, { error: "Método não permitido." }, 405);

  try {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return response(origin, { error: "Autenticação obrigatória." }, 401);
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data: authData, error: authError } = await admin.auth.getUser(authHeader.slice(7));
    if (authError || !authData.user || authData.user.is_anonymous) return response(origin, { error: "Sessão inválida." }, 401);
    const { data: editor } = await admin.from("user_profiles").select("role,enabled").eq("id", authData.user.id).single();
    if (!editor?.enabled || editor.role !== "editor") return response(origin, { error: "Apenas Editores podem criar contas." }, 403);

    const body = await request.json().catch(() => ({}));
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const fullName = String(body.fullName || "").trim();
    const role = String(body.role || "coordinator");
    const managerId = body.managerId == null || body.managerId === "" ? null : String(body.managerId);
    const subId = body.subId == null || body.subId === "" ? null : Number(body.subId);
    const coordinatorType = body.coordinatorType == null || body.coordinatorType === "" ? null : String(body.coordinatorType);

    if (!fullName || fullName.length > 120 || !email || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8 || !roles.has(role)) {
      return response(origin, { error: "Revise nome, e-mail, senha e perfil informados." }, 400);
    }

    if (role === "coordinator") {
      if (!managerId || !uuidPattern.test(managerId) || !Number.isSafeInteger(subId) || !coordinatorType || !coordinatorTypes.has(coordinatorType)) {
        return response(origin, { error: "Coordenador exige Gerente, SUB e classificação válidos." }, 400);
      }
      const [{ data: manager }, { data: sub }, { data: realDataset }] = await Promise.all([
        admin.from("user_profiles").select("id,role,enabled,organization_member_id").eq("id", managerId).maybeSingle(),
        admin.from("subs").select("id,active").eq("id", subId).maybeSingle(),
        admin.from("datasets").select("id").eq("code", "real").eq("kind", "real").eq("active", true).maybeSingle(),
      ]);
      if (!manager?.enabled || manager.role !== "manager" || !manager.organization_member_id || !sub?.active || !realDataset) {
        return response(origin, { error: "O Gerente ou a SUB selecionada não está disponível." }, 400);
      }
      const { data: managerMember } = await admin.from("organization_members").select("id,role,enabled").eq("id", manager.organization_member_id).eq("dataset_id", realDataset.id).maybeSingle();
      if (!managerMember?.enabled || managerMember.role !== "manager") return response(origin, { error: "O vínculo organizacional do Gerente precisa ser revisado." }, 400);
    } else if (managerId || subId != null || coordinatorType) {
      return response(origin, { error: "Somente Coordenadores podem receber Gerente, SUB e classificação." }, 400);
    }

    const { data: created, error: createError } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } });
    if (createError || !created.user) return response(origin, { error: createError?.message || "Não foi possível criar a conta." }, 400);

    const profilePayload = {
      full_name: fullName,
      role,
      enabled: true,
      manager_id: role === "coordinator" ? managerId : null,
      sub_id: role === "coordinator" ? subId : null,
      coordinator_type: role === "coordinator" ? coordinatorType : null,
      profile_needs_review: false,
    };
    const { data: savedProfile, error: profileError } = await admin.from("user_profiles").update(profilePayload).eq("id", created.user.id).select("id,role,enabled,manager_id,sub_id,coordinator_type").single();
    if (profileError || !savedProfile) {
      const { data: verified } = await admin.from("user_profiles").select("id,role,enabled,manager_id,sub_id,coordinator_type").eq("id", created.user.id).maybeSingle();
      const actuallySaved = verified?.enabled && verified.role === role && (role !== "coordinator" || (verified.manager_id === managerId && Number(verified.sub_id) === subId && verified.coordinator_type === coordinatorType));
      if (!actuallySaved) {
        await admin.from("user_profiles").delete().eq("id", created.user.id);
        await admin.from("organization_members").delete().eq("auth_user_id", created.user.id);
        await admin.auth.admin.deleteUser(created.user.id);
        return response(origin, { error: "A conta não pôde ser vinculada ao perfil solicitado." }, 500);
      }
    }
    return response(origin, { user: { id: created.user.id, email: created.user.email }, profile: savedProfile }, 201);
  } catch (error) {
    console.error("create-site-user", error instanceof Error ? error.message : "unknown");
    return response(origin, { error: "Não foi possível criar a conta." }, 500);
  }
});
