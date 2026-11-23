-- =====================================================================
-- Fase 4 · Reputación: rating de referidores, Socio Reclutador,
-- referencias laborales y calificación de empresas.
--
-- Cómo aplicarla: Supabase → SQL Editor → pegar este archivo → Run.
-- Requiere la migración de la Fase 3. Es segura de correr más de una vez.
-- =====================================================================

-- 1) La empresa califica (1 a 5) a quien recomendó, al decidir sobre el candidato.
CREATE TABLE IF NOT EXISTS public.referral_ratings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id   uuid NOT NULL UNIQUE REFERENCES public.referrals(id) ON DELETE CASCADE,
  headhunter_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  company_id    uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  rated_by      uuid NOT NULL REFERENCES public.profiles(id),
  stars         smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment       text CHECK (char_length(comment) <= 500),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS referral_ratings_headhunter_idx ON public.referral_ratings (headhunter_id);
ALTER TABLE public.referral_ratings ENABLE ROW LEVEL SECURITY;

-- 2) Socio Reclutador.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS partner_status text NOT NULL DEFAULT 'none',   -- 'none' | 'pending' | 'certified'
  ADD COLUMN IF NOT EXISTS partner_since  timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_partner_status_check') THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_partner_status_check CHECK (partner_status IN ('none', 'pending', 'certified'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.partner_applications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  message      text CHECK (char_length(message) <= 1000),
  rated_count  integer NOT NULL,          -- foto de la reputación al momento de solicitar
  avg_stars    numeric(3,2) NOT NULL,
  reviewed_by  uuid REFERENCES public.profiles(id),
  reviewed_at  timestamptz,
  review_note  text CHECK (char_length(review_note) <= 1000),
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- Una sola solicitud pendiente por persona.
CREATE UNIQUE INDEX IF NOT EXISTS partner_applications_one_pending
  ON public.partner_applications (user_id) WHERE status = 'pending';
ALTER TABLE public.partner_applications ENABLE ROW LEVEL SECURITY;

-- 3) Referencias laborales (de 1 a 3 por candidato), confirmadas por WhatsApp.
CREATE TABLE IF NOT EXISTS public.work_references (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reference_name    text NOT NULL CHECK (char_length(reference_name) <= 120),
  company_name      text NOT NULL CHECK (char_length(company_name) <= 120),
  relationship      text NOT NULL CHECK (char_length(relationship) <= 120),  -- ej. "Mi jefe directo"
  phone             text,                 -- E.164; se borra al confirmar, rechazar o vencer
  token_hash        text,                 -- SHA-256 del enlace; se borra al resolverse
  expires_at        timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'declined', 'expired')),
  reference_comment text CHECK (char_length(reference_comment) <= 500),
  resolved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS work_references_token_hash_key
  ON public.work_references (token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS work_references_candidate_idx ON public.work_references (candidate_id);
ALTER TABLE public.work_references ENABLE ROW LEVEL SECURITY;

-- Los mensajes de WhatsApp ahora también pueden ser de referencias laborales.
ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS work_reference_id uuid REFERENCES public.work_references(id) ON DELETE SET NULL;

-- 4) Calificación de empresas: un voto por persona.
CREATE TABLE IF NOT EXISTS public.company_ratings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  stars       smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment     text CHECK (char_length(comment) <= 500),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, user_id)
);
ALTER TABLE public.company_ratings ENABLE ROW LEVEL SECURITY;
