import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";

const allowedOrigins = new Set(["https://erwinklein94.github.io", "http://localhost:4173", "http://localhost:4174", "http://localhost:8000"]);
const roles = new Set(["director", "executive_manager", "manager", "consultant", "coordinator", "specialist"]);
const classifications = new Set(["superstructure", "infrastructure", "modernization"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function response(origin: string | null, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {
    "Access-Control-Allow-Origin": origin && allowedOrigins.has(origin) ? origin : "https://erwinklein94.github.io",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8", "Vary": "Origin", "X-Content-Type-Options": "nosniff",
  } });
}

function uniqueIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).filter((id) => uuidPattern.test(id)))];
}

async function validateSubordinates(admin: ReturnType<typeof createClient>, role: string, subordinateIds: string[]) {
  const expectedRoles = role === "executive_manager" ? ["manager"] : role === "manager" ? ["coordinator", "specialist"] : [];
  if (!expectedRoles.length) return subordinateIds.length === 0;
  if (!subordinateIds.length) return true;
  const { data, error } = await admin.from("user_profiles").select("id,role,enabled").in("id", subordinateIds);
  return !error && data?.length === subordinateIds.length && data.every((profile) => profile.enabled && expectedRoles.includes(profile.role));
}

async function replaceDirectReports(admin: ReturnType<typeof createClient>, supervisorId: string, role: string, subordinateIds: string[]) {
  const expectedRoles = role === "executive_manager" ? ["manager"] : role === "manager" ? ["coordinator", "specialist"] : [];
  if (!expectedRoles.length) return;
  if (!subordinateIds.length) return;
  if (role === "executive_manager") {
    const { error } = await admin.from("user_profiles").update({ manager_id: supervisorId }).in("id", subordinateIds).in("role", expectedRoles);
    if (error) throw error;
    return;
  }

  const [{ data: supervisor, error: supervisorError }, { data: operators, error: operatorsError }] = await Promise.all([
    admin.from("user_profiles").select("organization_member_id").eq("id", supervisorId).single(),
    admin.from("user_profiles").select("id,organization_member_id").in("id", subordinateIds).in("role", expectedRoles),
  ]);
  if (supervisorError || operatorsError || !supervisor?.organization_member_id || operators?.length !== subordinateIds.length) {
    throw supervisorError || operatorsError || new Error("missing_organization_members");
  }
  const { data: managerMember, error: memberError } = await admin.from("organization_members")
    .select("dataset_id").eq("id", supervisor.organization_member_id).single();
  if (memberError || !managerMember) throw memberError || new Error("missing_manager_member");
  const { error: assignmentError } = await admin.from("manager_operator_assignments").upsert(
    operators.map((operator) => ({
      dataset_id: managerMember.dataset_id,
      manager_member_id: supervisor.organization_member_id,
      operator_member_id: operator.organization_member_id,
    })),
    { onConflict: "manager_member_id,operator_member_id" },
  );
  if (assignmentError) throw assignmentError;
  const { error: primaryError } = await admin.from("user_profiles")
    .update({ manager_id: supervisorId }).in("id", subordinateIds).is("manager_id", null);
  if (primaryError) throw primaryError;
}

async function cleanupCreatedUser(admin: ReturnType<typeof createClient>, userId: string) {
  await admin.from("user_profiles").update({ manager_id: null }).eq("manager_id", userId);
  await admin.from("user_profiles").delete().eq("id", userId);
  await admin.from("organization_members").delete().eq("auth_user_id", userId);
  await admin.auth.admin.deleteUser(userId);
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  if (origin && !allowedOrigins.has(origin)) return response(origin, { error: "Origem não autorizada." }, 403);
  if (request.method === "OPTIONS") return response(origin, { ok: true });
  if (request.method !== "POST") return response(origin, { error: "Método não permitido." }, 405);
  if (Number(request.headers.get("content-length") || 0) > 16_384) return response(origin, { error: "Requisição inválida." }, 413);

  try {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return response(origin, { error: "Autenticação obrigatória." }, 401);
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY") || "";
    if (!supabaseUrl || !serviceKey) return response(origin, { error: "Serviço indisponível." }, 503);
    const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data: authData, error: authError } = await admin.auth.getUser(authHeader.slice(7));
    if (authError || !authData.user || authData.user.is_anonymous) return response(origin, { error: "Sessão inválida." }, 401);
    const { data: editor } = await admin.from("user_profiles").select("role,enabled").eq("id", authData.user.id).single();
    if (!editor?.enabled || editor.role !== "editor") return response(origin, { error: "Apenas Editores podem provisionar contas." }, 403);

    const body = await request.json().catch(() => ({}));
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const fullName = String(body.fullName || "").trim();
    const role = String(body.role || "");
    const classification = String(body.classification || "");
    const subordinateIds = uniqueIds(body.subordinateIds);
    const rawSubordinateCount = Array.isArray(body.subordinateIds) ? body.subordinateIds.length : 0;

    if (!fullName || fullName.length > 120 || !email || email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)
      || password.length < 8 || password.length > 256 || !roles.has(role) || !classifications.has(classification)
      || subordinateIds.length !== rawSubordinateCount) {
      return response(origin, { error: "Revise nome, e-mail, senha, função e classificação informados." }, 400);
    }
    if (!await validateSubordinates(admin, role, subordinateIds)) {
      return response(origin, { error: "Um ou mais subordinados selecionados não estão disponíveis para esta função." }, 400);
    }

    const { data: created, error: createError } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } });
    if (createError || !created.user) {
      const duplicate = createError?.code === "email_exists" || createError?.status === 422;
      return response(origin, { error: duplicate ? "Esta conta já existe." : "Não foi possível criar a conta." }, duplicate ? 409 : 400);
    }

    try {
      const { data: profile, error: profileError } = await admin.from("user_profiles").upsert({
        id: created.user.id, email, full_name: fullName, role, enabled: true, manager_id: null, sub_id: null,
        coordinator_type: classification, profile_needs_review: false,
      }, { onConflict: "id" }).select("id,email,full_name,role,enabled,manager_id,coordinator_type,organization_member_id").single();
      if (profileError || !profile) throw profileError || new Error("missing_profile");
      await replaceDirectReports(admin, created.user.id, role, subordinateIds);
      return response(origin, { action: "created", user: { id: created.user.id, email: created.user.email, email_confirmed: Boolean(created.user.email_confirmed_at) }, profile }, 201);
    } catch (error) {
      console.error("create-site-user profile", error instanceof Error ? error.message : "unknown");
      await cleanupCreatedUser(admin, created.user.id);
      return response(origin, { error: "A conta não pôde ser vinculada ao perfil solicitado." }, 500);
    }
  } catch (error) {
    console.error("create-site-user", error instanceof Error ? error.message : "unknown");
    return response(origin, { error: "Não foi possível provisionar a conta." }, 500);
  }
});
