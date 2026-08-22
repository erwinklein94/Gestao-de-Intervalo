import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";

const allowedOrigins = new Set(["https://erwinklein94.github.io", "https://www.sistemagestaodeintervalos.com.br", "https://sistemagestaodeintervalos.com.br", "http://www.sistemagestaodeintervalos.com.br", "http://sistemagestaodeintervalos.com.br", "http://localhost:4173", "http://localhost:4174", "http://localhost:8000"]);
const roles = new Set(["director", "executive_manager", "manager", "consultant", "coordinator", "specialist"]);
const classificationOrder = ["superstructure", "infrastructure", "modernization"];
const singleClassificationRoles = new Set(["coordinator", "specialist"]);
const genders = new Set(["masculine", "feminine"]);

const ROLE_LABELS: Record<string, string> = {
  director: "Diretor", executive_manager: "Gerente Executivo", manager: "Gerente",
  consultant: "Consultor", coordinator: "Coordenador", specialist: "Especialista",
};
// Gerente e Especialista nao flexionam; os demais tem forma feminina propria.
const ROLE_LABELS_FEMININE: Record<string, string> = {
  director: "Diretora", executive_manager: "Gerente Executiva",
  consultant: "Consultora", coordinator: "Coordenadora",
};
const TYPE_LABELS: Record<string, string> = {
  superstructure: "Superestrutura", infrastructure: "Infraestrutura", modernization: "Modernização",
};

function roleLabel(role: string, gender: string | null) {
  if (gender === "feminine" && ROLE_LABELS_FEMININE[role]) return ROLE_LABELS_FEMININE[role];
  return ROLE_LABELS[role] || role;
}

function response(origin: string | null, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {
    "Access-Control-Allow-Origin": origin && allowedOrigins.has(origin) ? origin : "https://erwinklein94.github.io",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8", "Vary": "Origin", "X-Content-Type-Options": "nosniff",
  } });
}

function normalizeClassifications(value: unknown) {
  const raw = Array.isArray(value) ? value : [value].filter((entry) => entry !== undefined && entry !== null);
  const chosen = new Set(raw.map(String));
  return classificationOrder.filter((entry) => chosen.has(entry));
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] as string
  ));
}

// Destinatarios: o endereco configurado manda; os Editores cadastrados so
// entram quando nada foi configurado. Nenhum deles fica no codigo -- o
// repositorio e publico.
//
// A lista configurada tem prioridade em vez de somar-se aos Editores porque
// um provedor sem dominio verificado recusa o envio inteiro se qualquer
// destinatario estiver fora da conta. Somando os dois, ninguem receberia.
async function resolveRecipients(admin: ReturnType<typeof createClient>) {
  const separar = (valor: string) => valor.split(",").map((entry) => entry.trim()).filter(Boolean);

  const doAmbiente = separar(Deno.env.get("ACCESS_REQUEST_NOTIFY_EMAIL") || "");
  if (doAmbiente.length) return [...new Set(doAmbiente)];

  const { data: ajuste } = await admin.from("app_settings")
    .select("value").eq("key", "access_request_notify_email").maybeSingle();
  const configurado = separar(String(ajuste?.value || ""));
  if (configurado.length) return [...new Set(configurado)];

  const { data: editores } = await admin.from("user_profiles")
    .select("email").eq("role", "editor").eq("enabled", true);
  return [...new Set((editores || []).map((editor) => editor.email).filter(Boolean))];
}

// O e-mail e um aviso, nao a fonte da verdade: se o envio falhar, a
// solicitacao continua registrada e visivel na Administracao.
async function notifyEditor(destinos: string[], payload: {
  fullName: string; email: string; role: string; roleGender: string | null;
  classifications: string[]; message: string;
}) {
  const apiKey = Deno.env.get("RESEND_API_KEY") || "";
  const remetente = Deno.env.get("ACCESS_REQUEST_FROM_EMAIL") || "onboarding@resend.dev";
  if (!apiKey || !destinos.length) return { sent: false, reason: "not_configured" };

  const linha = (rotulo: string, valor: string) =>
    `<tr><td style="padding:6px 14px 6px 0;color:#627888;font-size:13px">${rotulo}</td>` +
    `<td style="padding:6px 0;color:#123047;font-size:14px"><strong>${escapeHtml(valor)}</strong></td></tr>`;

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px">
      <p style="color:#627888;font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin:0 0 4px">Gestão de Intervalo</p>
      <h2 style="color:#003865;margin:0 0 16px">Nova solicitação de acesso</h2>
      <table style="border-collapse:collapse;margin-bottom:20px">
        ${linha("Nome", payload.fullName)}
        ${linha("E-mail", payload.email)}
        ${linha("Função pedida", roleLabel(payload.role, payload.roleGender))}
        ${linha("Classificação", payload.classifications.map((entry) => TYPE_LABELS[entry] || entry).join(" · "))}
        ${payload.message ? linha("Mensagem", payload.message) : ""}
      </table>
      <a href="https://www.sistemagestaodeintervalos.com.br/admin.html"
         style="display:inline-block;padding:11px 18px;border-radius:8px;background:#003865;color:#fff;text-decoration:none;font-weight:700;font-size:14px">
        Aprovar ou recusar na Administração
      </a>
      <p style="color:#627888;font-size:12px;margin-top:20px">A conta só é criada depois que um Editor aprova.</p>
    </div>`;

  try {
    const resposta = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `Gestão de Intervalo <${remetente}>`,
        to: destinos,
        subject: `Nova solicitação de acesso: ${payload.fullName}`,
        html,
      }),
    });
    if (!resposta.ok) {
      console.error("request-access email", resposta.status, await resposta.text());
      return { sent: false, reason: "provider_error" };
    }
    return { sent: true };
  } catch (error) {
    console.error("request-access email", error instanceof Error ? error.message : "unknown");
    return { sent: false, reason: "network_error" };
  }
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  if (origin && !allowedOrigins.has(origin)) return response(origin, { error: "Origem não autorizada." }, 403);
  if (request.method === "OPTIONS") return response(origin, { ok: true });
  if (request.method !== "POST") return response(origin, { error: "Método não permitido." }, 405);
  if (Number(request.headers.get("content-length") || 0) > 8192) return response(origin, { error: "Requisição inválida." }, 413);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY") || "";
    if (!supabaseUrl || !serviceKey) return response(origin, { error: "Serviço indisponível." }, 503);
    const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

    const body = await request.json().catch(() => ({}));
    const fullName = String(body.fullName || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const role = String(body.role || "");
    const classifications = normalizeClassifications(body.classifications ?? body.classification);
    const message = String(body.message || "").trim().slice(0, 500);
    const roleGender = genders.has(String(body.roleGender || "")) ? String(body.roleGender) : null;

    if (!fullName || fullName.length > 120 || !email || email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)
      || password.length < 8 || password.length > 256 || !roles.has(role) || !classifications.length) {
      return response(origin, { error: "Revise nome, e-mail, senha, função e classificação informados." }, 400);
    }
    if (singleClassificationRoles.has(role) && classifications.length > 1) {
      return response(origin, { error: "Coordenador e Especialista respondem por uma única classificação." }, 400);
    }

    const { error } = await admin.rpc("request_site_access", {
      p_full_name: fullName, p_email: email, p_password: password,
      p_role: role, p_classifications: classifications, p_message: message,
      p_role_gender: roleGender,
    });
    if (error) {
      console.error("request-access rpc", error.message);
      return response(origin, { error: "Não foi possível registrar a solicitação." }, 400);
    }

    const notice = await notifyEditor(await resolveRecipients(admin), { fullName, email, role, roleGender, classifications, message });
    // A resposta e sempre a mesma, tenha o e-mail existido ou nao: nao conta a
    // quem pergunta se aquele endereco ja possui conta.
    return response(origin, { status: "received", notified: notice.sent }, 201);
  } catch (error) {
    console.error("request-access", error instanceof Error ? error.message : "unknown");
    return response(origin, { error: "Não foi possível registrar a solicitação." }, 500);
  }
});
