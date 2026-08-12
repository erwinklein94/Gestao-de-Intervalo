import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";

const allowedOrigins = new Set(["https://erwinklein94.github.io", "http://localhost:4173", "http://localhost:4174"]);
const cors = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin && allowedOrigins.has(origin) ? origin : "https://erwinklein94.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin"
});

Deno.serve(async (req) => {
  const headers = { ...cors(req.headers.get("origin")), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Método não permitido." }), { status: 405, headers });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return new Response(JSON.stringify({ error: "Autenticação obrigatória." }), { status: 401, headers });
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data: userData, error: userError } = await admin.auth.getUser(authHeader.slice(7));
    if (userError || !userData.user) return new Response(JSON.stringify({ error: "Sessão inválida." }), { status: 401, headers });
    const { data: editor } = await admin.from("user_profiles").select("role,enabled").eq("id", userData.user.id).single();
    if (!editor?.enabled || editor.role !== "editor") return new Response(JSON.stringify({ error: "Apenas editores podem criar contas." }), { status: 403, headers });
    const body = await req.json();
    const email = String(body.email || "").trim().toLowerCase(); const password = String(body.password || ""); const fullName = String(body.fullName || "").trim().slice(0, 120);
    if (!email || !email.includes("@") || password.length < 8) return new Response(JSON.stringify({ error: "Informe e-mail válido e senha com ao menos 8 caracteres." }), { status: 400, headers });
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName }, app_metadata: { created_by_editor: true } });
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 400, headers });
    return new Response(JSON.stringify({ user: { id: data.user.id, email: data.user.email } }), { status: 201, headers });
  } catch { return new Response(JSON.stringify({ error: "Não foi possível criar a conta." }), { status: 500, headers }); }
});
