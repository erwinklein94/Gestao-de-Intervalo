import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";

const allowedOrigins = new Set(["https://erwinklein94.github.io", "http://localhost:4173", "http://localhost:4174", "http://localhost:8000"]);
const roles = new Set(["director", "consultant", "executive_manager", "manager", "coordinator", "editor"]);
const coordinatorTypes = new Set(["infrastructure", "superstructure"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const profileColumns = "id,email,full_name,role,enabled,manager_id,sub_id,coordinator_type,profile_needs_review";

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

function profileMatches(profile: Record<string, unknown> | null, expected: Record<string, unknown>) {
  if (!profile) return false;
  return profile.full_name === expected.full_name
    && profile.role === expected.role
    && profile.enabled === true
    && (profile.manager_id ?? null) === (expected.manager_id ?? null)
    && (profile.sub_id == null ? null : Number(profile.sub_id)) === (expected.sub_id ?? null)
    && (profile.coordinator_type ?? null) === (expected.coordinator_type ?? null)
    && profile.profile_needs_review === false;
}

function profilePayload(fullName: string, role: string, managerId: string | null, subId: number | null, coordinatorType: string | null) {
  return {
    full_name: fullName,
    role,
    enabled: true,
    manager_id: role === "coordinator" ? managerId : null,
    sub_id: role === "coordinator" ? subId : null,
    coordinator_type: role === "coordinator" ? coordinatorType : null,
    profile_needs_review: false,
  };
}

async function saveProfile(admin: ReturnType<typeof createClient>, userId: string, email: string, payload: Record<string, unknown>) {
  return await admin.from("user_profiles")
    .upsert({ id: userId, email, ...payload }, { onConflict: "id" })
    .select(profileColumns)
    .single();
}

async function readProfile(admin: ReturnType<typeof createClient>, userId: string) {
  return await admin.from("user_profiles").select(profileColumns).eq("id", userId).maybeSingle();
}

async function cleanupCreatedUser(admin: ReturnType<typeof createClient>, userId: string) {
  const failures: string[] = [];
  const { error: profileError } = await admin.from("user_profiles").delete().eq("id", userId);
  if (profileError) failures.push(`profile:${profileError.code || "unknown"}`);
  const { error: memberError } = await admin.from("organization_members").delete().eq("auth_user_id", userId);
  if (memberError) failures.push(`member:${memberError.code || "unknown"}`);
  const { error: authError } = await admin.auth.admin.deleteUser(userId);
  if (authError) failures.push(`auth:${authError.code || authError.status || "unknown"}`);
  if (failures.length) console.error("create-site-user rollback-created", { userId, failures });
  return failures.length === 0;
}

async function restoreExistingProfile(admin: ReturnType<typeof createClient>, userId: string, previousProfile: Record<string, unknown> | null) {
  const failures: string[] = [];
  if (previousProfile) {
    const { error } = await admin.from("user_profiles").upsert({
      id: previousProfile.id,
      email: previousProfile.email,
      full_name: previousProfile.full_name,
      role: previousProfile.role,
      enabled: previousProfile.enabled,
      manager_id: previousProfile.manager_id,
      sub_id: previousProfile.sub_id,
      coordinator_type: previousProfile.coordinator_type,
      profile_needs_review: previousProfile.profile_needs_review,
    }, { onConflict: "id" });
    if (error) failures.push(`profile:${error.code || "unknown"}`);
  } else {
    const { error: profileError } = await admin.from("user_profiles").delete().eq("id", userId);
    if (profileError) failures.push(`profile:${profileError.code || "unknown"}`);
    const { error: memberError } = await admin.from("organization_members").delete().eq("auth_user_id", userId);
    if (memberError) failures.push(`member:${memberError.code || "unknown"}`);
  }
  if (failures.length) console.error("create-site-user rollback-existing", { userId, failures });
  return failures.length === 0;
}

function safeResult(
  action: "created" | "updated",
  user: { id: string; email?: string | null; email_confirmed_at?: string | null },
  profile: Record<string, unknown>,
) {
  return {
    action,
    user: {
      id: user.id,
      email: user.email,
      email_confirmed: Boolean(user.email_confirmed_at),
    },
    profile,
  };
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
    const roleWasProvided = typeof body.role === "string" && body.role.length > 0;
    const role = roleWasProvided ? String(body.role) : "coordinator";
    const managerId = body.managerId == null || body.managerId === "" ? null : String(body.managerId);
    const subId = body.subId == null || body.subId === "" ? null : Number(body.subId);
    const coordinatorType = body.coordinatorType == null || body.coordinatorType === "" ? null : String(body.coordinatorType);
    const updateExisting = body.updateExisting === true;
    const existingUserId = body.existingUserId == null || body.existingUserId === "" ? null : String(body.existingUserId);

    if ((body.updateExisting != null && typeof body.updateExisting !== "boolean")
      || !fullName || fullName.length > 120
      || !email || email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)
      || password.length < 8 || password.length > 256
      || !roles.has(role)) {
      return response(origin, { error: "Revise nome, e-mail, senha e perfil informados." }, 400);
    }
    if (updateExisting && (!existingUserId || !uuidPattern.test(existingUserId) || !roleWasProvided)) {
      return response(origin, { error: "A atualização exige existingUserId e perfil explícitos." }, 400);
    }
    if (!updateExisting && existingUserId) {
      return response(origin, { error: "existingUserId só pode ser usado com updateExisting." }, 400);
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

    const desiredProfile = profilePayload(fullName, role, managerId, subId, coordinatorType);

    if (updateExisting && existingUserId) {
      const { data: existingAuthData, error: existingAuthError } = await admin.auth.admin.getUserById(existingUserId);
      const existingUser = existingAuthData?.user;
      if (existingAuthError || !existingUser || existingUser.is_anonymous || existingUser.email?.toLowerCase() !== email) {
        return response(origin, { error: "A conta existente não corresponde ao identificador e e-mail informados." }, 404);
      }

      const { data: previousProfile, error: previousProfileError } = await readProfile(admin, existingUserId);
      if (previousProfileError) return response(origin, { error: "Não foi possível validar o perfil atual." }, 500);

      try {
        let { data: savedProfile, error: profileError } = await saveProfile(admin, existingUserId, email, desiredProfile);
        if (profileError || !profileMatches(savedProfile, desiredProfile)) {
          const { data: verifiedProfile } = await readProfile(admin, existingUserId);
          if (!profileMatches(verifiedProfile, desiredProfile)) {
            await restoreExistingProfile(admin, existingUserId, previousProfile);
            return response(origin, { error: "O perfil existente não pôde ser atualizado." }, 500);
          }
          savedProfile = verifiedProfile;
        }

        const authUpdate = await admin.auth.admin.updateUserById(existingUserId, {
          password,
          email_confirm: true,
          user_metadata: { ...(existingUser.user_metadata || {}), full_name: fullName },
        });
        if (authUpdate.error || !authUpdate.data.user) {
          const rollbackComplete = await restoreExistingProfile(admin, existingUserId, previousProfile);
          console.error("create-site-user update-auth-failed", {
            userId: existingUserId,
            code: authUpdate.error?.code || authUpdate.error?.status || "unknown",
            rollbackComplete,
          });
          return response(origin, { error: "As credenciais não puderam ser atualizadas; o perfil anterior foi preservado quando possível." }, 500);
        }

        return response(origin, safeResult("updated", authUpdate.data.user, savedProfile), 200);
      } catch (updateError) {
        const rollbackComplete = await restoreExistingProfile(admin, existingUserId, previousProfile);
        console.error("create-site-user update-exception", {
          userId: existingUserId,
          code: updateError instanceof Error ? updateError.name : "unknown",
          rollbackComplete,
        });
        return response(origin, { error: "As credenciais não puderam ser atualizadas; o perfil anterior foi preservado quando possível." }, 500);
      }
    }

    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (createError || !created.user) {
      const duplicate = createError?.code === "email_exists" || createError?.status === 422;
      return response(origin, {
        error: duplicate
          ? "Esta conta já existe. Para atualizá-la, confirme updateExisting e informe existingUserId."
          : "Não foi possível criar a conta.",
      }, duplicate ? 409 : 400);
    }

    try {
      let { data: savedProfile, error: profileError } = await saveProfile(admin, created.user.id, email, desiredProfile);
      if (profileError || !profileMatches(savedProfile, desiredProfile)) {
        const { data: verifiedProfile } = await readProfile(admin, created.user.id);
        if (!profileMatches(verifiedProfile, desiredProfile)) {
          const rollbackComplete = await cleanupCreatedUser(admin, created.user.id);
          if (!rollbackComplete) {
            await admin.from("user_profiles").update({ enabled: false, profile_needs_review: true }).eq("id", created.user.id);
          }
          return response(origin, { error: "A conta não pôde ser vinculada ao perfil solicitado." }, 500);
        }
        savedProfile = verifiedProfile;
      }

      return response(origin, safeResult("created", created.user, savedProfile), 201);
    } catch (profileException) {
      const rollbackComplete = await cleanupCreatedUser(admin, created.user.id);
      if (!rollbackComplete) {
        await admin.from("user_profiles").update({ enabled: false, profile_needs_review: true }).eq("id", created.user.id);
      }
      console.error("create-site-user create-profile-exception", {
        userId: created.user.id,
        code: profileException instanceof Error ? profileException.name : "unknown",
        rollbackComplete,
      });
      return response(origin, { error: "A conta não pôde ser vinculada ao perfil solicitado." }, 500);
    }
  } catch (error) {
    console.error("create-site-user", error instanceof Error ? error.message : "unknown");
    return response(origin, { error: "Não foi possível provisionar a conta." }, 500);
  }
});
