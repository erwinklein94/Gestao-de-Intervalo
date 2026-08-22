import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";

const allowedOrigins = new Set([
  "https://erwinklein94.github.io",
  "https://www.sistemagestaodeintervalos.com.br",
  "https://sistemagestaodeintervalos.com.br",
  "http://www.sistemagestaodeintervalos.com.br",
  "http://sistemagestaodeintervalos.com.br",
  "http://localhost:4173",
  "http://localhost:4174",
  "http://localhost:8000",
]);
const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function response(origin: string | null, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {
    "Access-Control-Allow-Origin": origin && allowedOrigins.has(origin) ? origin : "https://erwinklein94.github.io",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
  } });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] as string
  ));
}

async function notifyEditor(email: string, fullName: string) {
  const apiKey = Deno.env.get("RESEND_API_KEY") || "";
  const recipient = Deno.env.get("PASSWORD_RESET_NOTIFY_EMAIL") || "erwinklein1994@gmail.com";
  const sender = Deno.env.get("PASSWORD_RESET_FROM_EMAIL")
    || Deno.env.get("ACCESS_REQUEST_FROM_EMAIL")
    || "onboarding@resend.dev";
  if (!apiKey) return false;

  const result = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `Gestão de Intervalo <${sender}>`,
      to: [recipient],
      subject: `Solicitação de alteração de senha: ${fullName || email}`,
      html: `
        <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:540px">
          <p style="color:#627888;font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin:0 0 4px">Gestão de Intervalo</p>
          <h2 style="color:#003865;margin:0 0 16px">Solicitação de alteração de senha</h2>
          <p style="color:#123047">Um usuário solicitou ajuda para alterar a senha.</p>
          <table style="border-collapse:collapse;margin:16px 0 22px">
            <tr><td style="padding:6px 14px 6px 0;color:#627888">Usuário</td><td><strong>${escapeHtml(fullName || "Não informado")}</strong></td></tr>
            <tr><td style="padding:6px 14px 6px 0;color:#627888">E-mail</td><td><strong>${escapeHtml(email)}</strong></td></tr>
          </table>
          <a href="https://supabase.com/dashboard/project/rzsybguxlueorjpsstmu/auth/users"
             style="display:inline-block;padding:11px 18px;border-radius:8px;background:#003865;color:#fff;text-decoration:none;font-weight:700">
            Abrir usuários no Supabase
          </a>
          <p style="color:#627888;font-size:12px;margin-top:20px">Confirme a identidade do solicitante antes de definir uma senha temporária.</p>
        </div>`,
    }),
  });
  if (!result.ok) {
    console.error("request-password-reset email", result.status, await result.text());
    return false;
  }
  return true;
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  if (origin && !allowedOrigins.has(origin)) return response(origin, { error: "Origem não autorizada." }, 403);
  if (request.method === "OPTIONS") return response(origin, { ok: true });
  if (request.method !== "POST") return response(origin, { error: "Método não permitido." }, 405);
  if (Number(request.headers.get("content-length") || 0) > 2048) return response(origin, { error: "Requisição inválida." }, 413);

  try {
    const body = await request.json().catch(() => ({}));
    const email = String(body.email || "").trim().toLowerCase();
    if (!email || email.length > 254 || !emailPattern.test(email)) {
      return response(origin, { error: "Informe um e-mail válido." }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY") || "";
    if (!supabaseUrl || !serviceKey) return response(origin, { error: "Serviço indisponível." }, 503);
    const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data: profile } = await admin.from("user_profiles")
      .select("full_name,enabled").ilike("email", email).maybeSingle();

    // A resposta não revela se a conta existe. O Editor só é avisado quando
    // há um perfil ativo correspondente, evitando solicitações arbitrárias.
    if (profile?.enabled && !await notifyEditor(email, String(profile.full_name || ""))) {
      return response(origin, { error: "Não foi possível enviar a solicitação agora." }, 503);
    }
    return response(origin, { status: "received" }, 202);
  } catch (error) {
    console.error("request-password-reset", error instanceof Error ? error.message : "unknown");
    return response(origin, { error: "Não foi possível registrar a solicitação." }, 500);
  }
});
