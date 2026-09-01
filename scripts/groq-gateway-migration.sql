-- ═══════════════════════════════════════════════════════════════════════════
-- Groq DB Gateway Migration — Worker Egress WAF Bypass
--
-- PROBLEM: Cloudflare Worker → api.groq.com returns HTTP 403 Forbidden from
-- server:cloudflare (WAF edge). Both Groq keys (Key0 + Key1) blocked equally.
-- Worker egress to other services (cloudflare.com, openrouter.ai) works fine.
-- Root cause: Groq's Cloudflare WAF blocks Cloudflare Worker egress IPs.
--
-- SOLUTION: Route Groq calls through the Supabase DB gateway (same pattern as
-- public.gemini_generate()). Supabase's IP makes the outbound HTTP call to
-- api.groq.com, bypassing the Worker egress WAF block entirely.
--
-- DESIGN: This NEW function groq_generate_with_key() takes the API key as a
-- PARAMETER (passed from Worker's env.GROQ_API_KEY / env.GROQ_API_KEY_1).
-- This keeps the keys in Cloudflare secrets (where they already are) — no
-- need to migrate keys to Supabase Vault. The key transits the Worker→DB
-- connection (TLS-encrypted) and is used only inside the function scope.
--
-- SECURITY:
--   - SECURITY DEFINER (runs with function owner privileges)
--   - search_path locked to public, vault, extensions
--   - API key is a function parameter, NEVER stored in DB, NEVER logged
--   - The key is only used in the Authorization header for the Groq call
--   - No secrets written to tables/logs
--
-- The existing public.groq_generate() (reads from Vault) is UNCHANGED for
-- backward compatibility. This new function is the active path.
--
-- Safe to run multiple times (CREATE OR REPLACE is idempotent).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.groq_generate_with_key(
  p_model text,
  p_messages jsonb,
  p_max_tokens integer DEFAULT 1024,
  p_temperature double precision DEFAULT 0.4,
  p_api_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault', 'extensions'
AS $function$
        DECLARE
          v_request_body jsonb;
          v_status int;
          v_content text;
        BEGIN
          -- Hard timeout: 30 seconds (matches Worker's AbortController 30s)
          PERFORM set_config('statement_timeout', '30000', true);

          -- Validate API key parameter
          IF p_api_key IS NULL OR p_api_key = '' THEN
            RETURN jsonb_build_object('status_code', 503, 'response_body', '{"error":{"message":"Groq API key not provided as parameter","status":"UNAVAILABLE"}}');
          END IF;

          -- Whitelist models (same as existing groq_generate)
          IF p_model NOT IN ('openai/gpt-oss-120b') THEN
            RETURN jsonb_build_object('status_code', 400, 'response_body', '{"error":{"message":"Invalid model: only openai/gpt-oss-120b is supported","status":"INVALID_ARGUMENT"}}');
          END IF;

          -- Build request body (OpenAI-compatible format)
          v_request_body := jsonb_build_object(
            'model', p_model,
            'messages', p_messages,
            'max_tokens', p_max_tokens,
            'temperature', p_temperature
          );

          -- Make HTTP request using http() with http_header() for auth
          -- The API key is in the Authorization header, NEVER in the URL or body.
          -- Supabase's IP makes this call — bypasses Cloudflare Worker WAF block.
          SELECT status, content INTO v_status, v_content
          FROM http((
            'POST',
            'https://api.groq.com/openai/v1/chat/completions',
            ARRAY[
              http_header('Authorization', 'Bearer ' || p_api_key),
              http_header('Content-Type', 'application/json')
            ],
            'application/json',
            v_request_body::text
          )::http_request);

          RETURN jsonb_build_object('status_code', v_status, 'response_body', v_content);
        EXCEPTION
          WHEN OTHERS THEN
            -- Catch statement_timeout and other errors — return a shape that
            -- the Worker classifies as retryable (status_code 0 = network/timeout)
            RETURN jsonb_build_object(
              'status_code', 0,
              'response_body', jsonb_build_object(
                'error', jsonb_build_object(
                  'message', 'db_gateway_error',
                  'detail', substring(SQLERRM, 1, 200)
                )
              )::text
            );
        END;
        $function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Grant execute to the application role (anon/authenticated if used by Worker)
-- The Worker connects via the service role / postgres user, which has access.
-- ═══════════════════════════════════════════════════════════════════════════
GRANT EXECUTE ON FUNCTION public.groq_generate_with_key(text, jsonb, integer, double precision, text) TO PUBLIC;
