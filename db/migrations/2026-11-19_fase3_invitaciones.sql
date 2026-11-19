-- =====================================================================
-- Fase 3 · Referir sin cuenta e invitación por WhatsApp
--
-- Cómo aplicarla: Supabase → SQL Editor → pegar este archivo → Run.
-- Es segura de correr más de una vez (usa IF NOT EXISTS).
-- Debe correrse ANTES de publicar el backend de la Fase 3.
-- =====================================================================

-- 1) Nuevo estado del referido: invitación vencida sin respuesta.
ALTER TYPE public.referral_status ADD VALUE IF NOT EXISTS 'expired';

-- 2) Datos mínimos del invitado (solo hasta que acepte, rechace o venza).
ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS invitee_first_name     text,
  ADD COLUMN IF NOT EXISTS invitee_last_name      text,
  ADD COLUMN IF NOT EXISTS invitee_phone          text,          -- formato E.164, ej. +50761234567
  ADD COLUMN IF NOT EXISTS recommendation_note    text,          -- "por qué lo recomiendo" (opcional)
  ADD COLUMN IF NOT EXISTS invite_token_hash      text,          -- SHA-256 del enlace; el enlace en claro nunca se guarda
  ADD COLUMN IF NOT EXISTS invite_expires_at      timestamptz,
  ADD COLUMN IF NOT EXISTS invite_sent_at         timestamptz,
  ADD COLUMN IF NOT EXISTS invitee_data_purged_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS referrals_invite_token_hash_key
  ON public.referrals (invite_token_hash)
  WHERE invite_token_hash IS NOT NULL;

-- Para que el proceso horario encuentre rápido las invitaciones vencidas.
CREATE INDEX IF NOT EXISTS referrals_invite_pending_idx
  ON public.referrals (invite_expires_at)
  WHERE invite_token_hash IS NOT NULL;

-- Evita que dos referidores inviten al mismo teléfono a la misma vacante mientras la invitación está viva.
CREATE UNIQUE INDEX IF NOT EXISTS referrals_active_invite_phone_job_key
  ON public.referrals (job_offer_id, invitee_phone)
  WHERE invite_token_hash IS NOT NULL AND invitee_phone IS NOT NULL;

-- 3) Registro de mensajes de WhatsApp (simulados o reales). Sin teléfono completo ni enlace.
CREATE TABLE IF NOT EXISTS public.whatsapp_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id         uuid REFERENCES public.referrals(id) ON DELETE SET NULL,
  to_phone_masked     text NOT NULL,          -- ej. +507 ****4567
  template            text NOT NULL,
  mode                text NOT NULL,          -- 'simulated' | 'meta'
  status              text NOT NULL,          -- 'simulated' | 'sent' | 'failed'
  provider_message_id text,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;  -- solo el backend (service role) la usa

-- 4) Documento de identidad del candidato (lo completa el propio candidato).
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS document_type text,   -- 'cedula' | 'passport'
  ADD COLUMN IF NOT EXISTS document_id   text;

-- 5) Nuevos tipos de vacante: trabajo puntual y consultoría.
--    Si employment_type es un enum, se agregan los valores; si es texto, no hace falta nada.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'employment_type') THEN
    ALTER TYPE public.employment_type ADD VALUE IF NOT EXISTS 'one-off';
    ALTER TYPE public.employment_type ADD VALUE IF NOT EXISTS 'consulting';
  END IF;
END $$;

-- Verificación (opcional): debe listar las columnas nuevas.
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'referrals' AND column_name LIKE 'invite%';
