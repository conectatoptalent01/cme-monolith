/// <reference types="jest" />
/**
 * Prueba de integración del flujo "referir sin cuenta → invitación → aceptar / rechazar / vencer"
 * contra una base PostgreSQL real.
 *
 * Usa TEST_DATABASE_URL (una base de pruebas vacía). Sin esa variable, la prueba se salta.
 * Crea el esquema mínimo (db/test/base-schema.sql), aplica la migración real de la Fase 3
 * y corre el flujo completo.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import {
  BadRequestException, ConflictException, ForbiddenException, GoneException, NotFoundException,
} from '@nestjs/common';
import { InvitationsService, hashToken } from '../modules/invitations/invitations.service';
import { WhatsAppSender } from '../modules/invitations/whatsapp.sender';
import { ReferralsService } from '../modules/referrals/referral-service.service';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;

const ROOT = join(__dirname, '..', '..');
const ids = {
  empresa: '11111111-1111-4111-8111-111111111111',
  referidor: '22222222-2222-4222-8222-222222222222',
  ana: '33333333-3333-4333-8333-333333333333',
  otro: '44444444-4444-4444-8444-444444444444',
};

d('Invitaciones por WhatsApp (integración con PostgreSQL)', () => {
  let pool: Pool;
  let svc: InvitationsService;
  let jobId: string;

  const tokenOf = (url: string) => url.split('/invitacion/')[1];

  beforeAll(async () => {
    process.env.WHATSAPP_MODE = 'simulated';
    process.env.FRONTEND_BASE_URL = 'https://app.cme.test';
    pool = new Pool({ connectionString: DB });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pool.query(readFileSync(join(ROOT, 'db/test/base-schema.sql'), 'utf8'));
    await pool.query(readFileSync(join(ROOT, 'db/migrations/2026-11-19_fase3_invitaciones.sql'), 'utf8'));
    // La migración debe poder correrse dos veces sin error.
    await pool.query(readFileSync(join(ROOT, 'db/migrations/2026-11-19_fase3_invitaciones.sql'), 'utf8'));

    await pool.query(
      `INSERT INTO profiles (id, email, full_name, role) VALUES
        ($1,'e@x.com','Empresa Admin','company_admin'),
        ($2,'r@x.com','Juan Pérez','headhunter'),
        ($3,'a@x.com','Ana Gómez','candidate'),
        ($4,'o@x.com','Otro Usuario','candidate')`,
      [ids.empresa, ids.referidor, ids.ana, ids.otro],
    );
    const { rows: [c] } = await pool.query(
      `INSERT INTO companies (name, admin_id) VALUES ('ACME', $1) RETURNING id`, [ids.empresa]);
    const { rows: [j] } = await pool.query(
      `INSERT INTO job_offers (company_id, title, employment_type, salary, currency)
       VALUES ($1, 'Analista de Datos', 'one-off', 2000, 'USD') RETURNING id`, [c.id]);
    jobId = j.id;

    svc = new InvitationsService(pool, new WhatsAppSender());
  });

  afterAll(async () => { await pool?.end(); });

  const invite = (phone = '6123-4567', firstName = 'Ana') =>
    svc.create(ids.referidor, { jobOfferId: jobId, firstName, lastName: 'Gómez', phone, note: 'Muy buena' });

  it('la migración agrega los tipos de vacante nuevos (el job de prueba ya usa "one-off")', async () => {
    const { rows } = await pool.query(`SELECT unnest(enum_range(NULL::employment_type))::text AS v`);
    expect(rows.map((r) => r.v)).toEqual(expect.arrayContaining(['one-off', 'consulting']));
  });

  it('crea la invitación: guarda solo el hash del enlace y registra el WhatsApp simulado sin el teléfono completo', async () => {
    const r = await invite();
    expect(r.whatsapp).toEqual(expect.objectContaining({ mode: 'simulated', status: 'simulated', to: '+507 ****4567' }));
    expect(r.inviteUrl).toMatch(/^https:\/\/app\.cme\.test\/invitacion\/[\w-]{30,}$/);
    expect(r.shareText).toContain('Juan Pérez te recomendó');

    const { rows: [ref] } = await pool.query(`SELECT * FROM referrals WHERE id = $1`, [r.referralId]);
    expect(ref.invitee_phone).toBe('+50761234567');
    expect(ref.invite_token_hash).toBe(hashToken(tokenOf(r.inviteUrl)));
    expect(ref.invite_token_hash).not.toContain(tokenOf(r.inviteUrl));
    expect(ref.candidate_id).toBeNull();

    const { rows: msgs } = await pool.query(`SELECT * FROM whatsapp_messages WHERE referral_id = $1`, [r.referralId]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].to_phone_masked).toBe('+507 ****4567');
  });

  it('rechaza teléfonos inválidos, invitar a la propia empresa y repetir el mismo teléfono en la misma vacante', async () => {
    await expect(invite('123')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create(ids.empresa, { jobOfferId: jobId, firstName: 'X', lastName: 'Y', phone: '61112222' }))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(invite('+507 6123 4567')).rejects.toBeInstanceOf(ConflictException);
  });

  it('la página pública muestra la vacante y quién recomienda, sin teléfono ni apellidos', async () => {
    const r = await invite('6000-0001', 'Luis');
    const pub = await svc.getPublic(tokenOf(r.inviteUrl));
    expect(pub).toEqual(expect.objectContaining({
      inviteeFirstName: 'Luis',
      referrerFirstName: 'Juan',
      job: expect.objectContaining({ title: 'Analista de Datos', companyName: 'ACME' }),
    }));
    expect(JSON.stringify(pub)).not.toMatch(/6000|Gómez|Pérez/);
  });

  it('aceptar: queda como candidata, postulada, se borran nombre y teléfono, se avisa al referidor y a la empresa', async () => {
    const r = await invite('6000-0002');
    const token = tokenOf(r.inviteUrl);

    await expect(svc.accept(token, ids.referidor)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.accept(token, ids.empresa)).rejects.toBeInstanceOf(ForbiddenException);

    const res = await svc.accept(token, ids.ana);
    expect(res.missingProfileFields).toEqual(expect.arrayContaining(['phone', 'document_id', 'cv_url']));

    const { rows: [ref] } = await pool.query(`SELECT * FROM referrals WHERE id = $1`, [r.referralId]);
    expect(ref.candidate_id).toBe(ids.ana);
    expect(ref.status).toBe('accepted_by_candidate');
    expect(ref.invitee_phone).toBeNull();
    expect(ref.invitee_first_name).toBeNull();
    expect(ref.invite_token_hash).toBeNull();

    const { rows: apps } = await pool.query(
      `SELECT * FROM applications WHERE job_offer_id = $1 AND candidate_id = $2`, [jobId, ids.ana]);
    expect(apps).toHaveLength(1);

    const { rows: notes } = await pool.query(
      `SELECT user_id FROM notifications WHERE related_id IN ($1, $2)`, [r.referralId, apps[0].id]);
    expect(notes.map((n) => n.user_id)).toEqual(expect.arrayContaining([ids.referidor, ids.empresa]));

    // El enlace es de un solo uso.
    await expect(svc.accept(token, ids.otro)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('una misma persona no queda referida dos veces a la misma vacante', async () => {
    const r = await invite('6000-0003');
    await expect(svc.accept(tokenOf(r.inviteUrl), ids.ana)).rejects.toBeInstanceOf(ConflictException);
  });

  it('rechazar no pide cuenta, borra los datos y avisa al referidor', async () => {
    const r = await invite('6000-0004', 'Pedro');
    await svc.decline(tokenOf(r.inviteUrl));
    const { rows: [ref] } = await pool.query(`SELECT * FROM referrals WHERE id = $1`, [r.referralId]);
    expect(ref.status).toBe('declined_by_candidate');
    expect(ref.invitee_phone).toBeNull();
    expect(ref.invitee_data_purged_at).not.toBeNull();
    const { rows: n } = await pool.query(`SELECT title FROM notifications WHERE related_id = $1`, [r.referralId]);
    expect(n[0].title).toContain('Pedro no aceptó');
  });

  it('una invitación vencida no se puede usar y sus datos se borran', async () => {
    const r = await invite('6000-0005');
    await pool.query(`UPDATE referrals SET invite_expires_at = now() - interval '1 minute' WHERE id = $1`, [r.referralId]);
    await expect(svc.getPublic(tokenOf(r.inviteUrl))).rejects.toBeInstanceOf(GoneException);
    const { rows: [ref] } = await pool.query(`SELECT * FROM referrals WHERE id = $1`, [r.referralId]);
    expect(ref.status).toBe('expired');
    expect(ref.invitee_phone).toBeNull();
  });

  it('el proceso horario vence todas las invitaciones sin respuesta', async () => {
    const r = await invite('6000-0006');
    await pool.query(`UPDATE referrals SET invite_expires_at = now() - interval '1 hour' WHERE id = $1`, [r.referralId]);
    expect(await svc.expirePending()).toBeGreaterThanOrEqual(1);
    const { rows: [ref] } = await pool.query(`SELECT status, invitee_phone FROM referrals WHERE id = $1`, [r.referralId]);
    expect(ref).toEqual({ status: 'expired', invitee_phone: null });
  });

  it('canjear un código: solo en su vacante, solo si está libre y nunca quien lo creó', async () => {
    const refs = new ReferralsService(pool as any);
    await pool.query(
      `INSERT INTO referrals (headhunter_id, job_offer_id, referral_code) VALUES ($1, $2, 'ABC234')`,
      [ids.referidor, jobId]);
    const otherJob = '99999999-9999-4999-8999-999999999999';
    await expect(refs.claimByCode('abc234', ids.otro, otherJob)).rejects.toBeInstanceOf(NotFoundException);
    await expect(refs.claimByCode('ABC234', ids.referidor, jobId)).rejects.toBeInstanceOf(NotFoundException);
    const r = await refs.claimByCode('abc234', ids.otro, jobId);
    expect(r).toEqual(expect.objectContaining({ candidate_id: ids.otro, status: 'accepted_by_candidate' }));
    await expect(refs.claimByCode('ABC234', ids.ana, jobId)).rejects.toBeInstanceOf(NotFoundException);
  });
});
