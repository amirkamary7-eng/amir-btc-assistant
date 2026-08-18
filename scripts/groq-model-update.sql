-- ═══════════════════════════════════════════════════════════════════════════
-- Groq Model Replacement Migration
--
-- Replaces the retired model 'llama-3.3-70b-versatile' with 'openai/gpt-oss-120b'
-- in the public.groq_generate() Supabase DB function.
--
-- Background:
--   Groq retired the llama-3.3-70b-versatile model, causing HTTP 404
--   ("model_not_found") on every Groq API call. The new model
--   openai/gpt-oss-120b has been tested and confirmed compatible:
--   - Persian/Farsi translation: PASS
--   - Persian news summaries: PASS
--   - Structured JSON batch analysis: PASS
--
-- This migration ONLY changes the model whitelist. It preserves:
--   - Function signature
--   - SECURITY DEFINER
--   - search_path
--   - Vault secret retrieval
--   - HTTP endpoint (https://api.groq.com/openai/v1/chat/completions)
--   - Request format (OpenAI-compatible)
--   - Response format ({status_code, response_body})
--   - Error handling
--
-- Safe to run multiple times (CREATE OR REPLACE is idempotent).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.groq_generate(
  p_model text,
  p_messages jsonb,
  p_max_tokens integer DEFAULT 1024,
  p_temperature double precision DEFAULT 0.4
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault', 'extensions'
AS $function$
        DECLARE
          v_api_key text;
          v_request_body jsonb;
          v_status int;
          v_content text;
        BEGIN
          -- Hard timeout: 30 seconds
          PERFORM set_config('statement_timeout', '30000', true);

          -- Whitelist models (updated: llama-3.3-70b-versatile retired → openai/gpt-oss-120b)
          IF p_model NOT IN ('openai/gpt-oss-120b') THEN
            RETURN jsonb_build_object('status_code', 400, 'response_body', '{"error":{"message":"Invalid model: only openai/gpt-oss-120b is supported","status":"INVALID_ARGUMENT"}}');
          END IF;

          -- Retrieve API key from vault
          SELECT decrypted_secret INTO v_api_key
          FROM vault.decrypted_secrets
          WHERE name = 'GROQ_API_KEY'
          LIMIT 1;

          IF v_api_key IS NULL THEN
            RETURN jsonb_build_object('status_code', 503, 'response_body', '{"error":{"message":"Groq API key not configured in vault","status":"UNAVAILABLE"}}');
          END IF;

          -- Build request body (OpenAI-compatible format)
          v_request_body := jsonb_build_object(
            'model', p_model,
            'messages', p_messages,
            'max_tokens', p_max_tokens,
            'temperature', p_temperature
          );

          -- Make HTTP request using http() with http_header() for auth
          -- The API key is in the Authorization header, NEVER in the URL
          SELECT status, content INTO v_status, v_content
          FROM http((
            'POST',
            'https://api.groq.com/openai/v1/chat/completions',
            ARRAY[
              http_header('Authorization', 'Bearer ' || v_api_key),
              http_header('Content-Type', 'application/json')
            ],
            'application/json',
            v_request_body::text
          )::http_request);

          RETURN jsonb_build_object('status_code', v_status, 'response_body', v_content);
        END;
        $function$;
