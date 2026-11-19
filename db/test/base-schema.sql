-- =====================================================================
-- Esquema MÍNIMO para las pruebas de integración (NO es el esquema real).
-- Reproduce solo las tablas, columnas y tipos que usa el código, tal como
-- aparecen en las consultas del backend. El esquema real vive en Supabase.
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE public.user_role AS ENUM ('candidate', 'company_admin', 'headhunter', 'admin');
CREATE TYPE public.user_status AS ENUM ('active', 'inactive', 'banned', 'pending');
CREATE TYPE public.referral_status AS ENUM
  ('submitted', 'accepted_by_candidate', 'declined_by_candidate', 'reviewing', 'rejected', 'shortlist', 'hired');
CREATE TYPE public.notification_type AS ENUM ('job_offer', 'recommendation', 'payment', 'system_message');
CREATE TYPE public.notification_channel AS ENUM ('email', 'system');
CREATE TYPE public.notification_status AS ENUM ('queued', 'sent', 'failed');
CREATE TYPE public.employment_type AS ENUM ('full-time', 'part-time', 'services-agreement');

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  email text,
  full_name text,
  phone text,
  role public.user_role DEFAULT 'candidate',
  status public.user_status DEFAULT 'active',
  cv_url text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE public.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  admin_id uuid REFERENCES public.profiles(id)
);

CREATE TABLE public.job_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id),
  title text NOT NULL,
  employment_type public.employment_type,
  salary numeric,
  currency text
);

CREATE TABLE public.referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  headhunter_id uuid REFERENCES public.profiles(id),
  candidate_id uuid REFERENCES public.profiles(id),
  job_offer_id uuid NOT NULL REFERENCES public.job_offers(id),
  status public.referral_status NOT NULL DEFAULT 'submitted',
  referral_code text UNIQUE NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE public.applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_offer_id uuid NOT NULL REFERENCES public.job_offers(id),
  candidate_id uuid NOT NULL REFERENCES public.profiles(id),
  accepted boolean DEFAULT false,
  notes text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id),
  title text,
  message text,
  notification_type public.notification_type,
  channel public.notification_channel,
  status public.notification_status,
  related_id uuid,
  read_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
