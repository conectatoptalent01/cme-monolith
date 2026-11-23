/// <reference types="jest" />
/**
 * Fase 4 contra PostgreSQL real: rating del referidor, Socio Reclutador,
 * referencias laborales y calificación de empresas.
 * Usa TEST_DATABASE_URL; sin esa variable se salta.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import {
  BadRequestException, ConflictException, ForbiddenException, GoneException, NotFoundException,
} from '@nestjs/common';
import { ReputationService } from '../modules/reputation/reputation.service';
import { WorkReferencesService } from '../modules/work-references/work-references.service';
import { WhatsAppSender } from '../modules/invitations/whatsapp.sender';
import { hashToken } from '../modules/invitations/invitations.service';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..');
const sql = (f: string) => readFileSync(join(ROOT, f), 'utf8');

const U = {
  admin: '00000000-0000-4000-8000-000000000001',
  empresa: '00000000-0000-4000-8000-000000000002',
  otraEmpresa: '00000000-0000-4000-8000-000000000003',
  referidor: '00000000-0000-4000-8000-000000000004',
  cand: '00000000-0000-4000-8000-000000000005',
  extraño: '00000000-0000-4000-8000-000000000006',
};

d('Fase 4 · Reputación (integración con PostgreSQL)', () => {
  let pool: Pool;
  let rep: ReputationService;
  let refs: WorkReferencesService;
  let companyC: string;
  let companyD: string;
  let jobC: string;

  const newReferral = async (status: string, candidateId: string | null = U.cand) => {
    const { rows: [r] } = await pool.query(
      `INSERT INTO referrals (headhunter_id, candidate_id, job_offer_id, status, referral_code)
       VALUES ($1, $2, $3, $4::referral_status, upper(substr(md5(random()::text), 1, 6))) RETURNING id`,
      [U.referidor, candidateId, jobC, status],
    );
    return r.id as string;
  };

  beforeAll(async () => {
    process.env.WHATSAPP_MODE = 'simulated';
    process.env.FRONTEND_BASE_URL = 'https://app.cme.test';
    pool = new Pool({ connectionString: DB });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pool.query(sql('db/test/base-schema.sql'));
    await pool.query(sql('db/migrations/2026-11-19_fase3_invitaciones.sql'));
    await pool.query(sql('db/migrations/2026-11-23_fase4_reputacion.sql'));
    await pool.query(sql('db/migrations/2026-11-23_fase4_reputacion.sql')); // idempotente

    await pool.query(
      `INSERT INTO profiles (id, email, full_name, role, phone) VALUES
        ($1,'admin@x.com','Admin CME','admin', NULL),
        ($2,'e@x.com','Empresa Admin','company_admin', NULL),
        ($3,'d@x.com','Otra Empresa','company_admin', NULL),
        ($4,'r@x.com','Juan Pérez','headhunter', NULL),
        ($5,'c@x.com','Ana Gómez','candidate', '+50760000000'),
        ($6,'x@x.com','Sin Relación','candidate', NULL)`,
      [U.admin, U.empresa, U.otraEmpresa, U.referidor, U.cand, U.extraño],
    );
    companyC = (await pool.query(`INSERT INTO companies (name, admin_id) VALUES ('ACME',$1) RETURNING id`, [U.empresa])).rows[0].id;
    companyD = (await pool.query(`INSERT INTO companies (name, admin_id) VALUES ('Otra',$1) RETURNING id`, [U.otraEmpresa])).rows[0].id;
    jobC = (await pool.query(
      `INSERT INTO job_offers (company_id, title, salary, currency) VALUES ($1,'Analista',2000,'USD') RETURNING id`, [companyC])).rows[0].id;

    const wa = new WhatsAppSender();
    rep = new ReputationService(pool);
    refs = new WorkReferencesService(pool, wa);
  });

  afterAll(async () => { await pool?.end(); });

  /* ------------------------- Rating del referidor ------------------------- */

  it('la empresa solo califica cuando ya decidió (shortlist, rechazado o contratado)', async () => {
    const pending = await newReferral('accepted_by_candidate');
    await expect(rep.rateReferral(pending, { id: U.empresa, isAdmin: false }, { stars: 5 }))
      .rejects.toBeInstanceOf(BadRequestException);

    const decided = await newReferral('shortlist');
    const r = await rep.rateReferral(decided, { id: U.empresa, isAdmin: false }, { stars: 4, comment: 'Buen perfil' });
    expect(r).toEqual(expect.objectContaining({ stars: 4, comment: 'Buen perfil' }));
  });

  it('otra empresa no puede calificar, y las estrellas van de 1 a 5', async () => {
    const id = await newReferral('rejected');
    await expect(rep.rateReferral(id, { id: U.otraEmpresa, isAdmin: false }, { stars: 5 }))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(rep.rateReferral(id, { id: U.empresa, isAdmin: false }, { stars: 6 }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(rep.rateReferral(id, { id: U.empresa, isAdmin: false }, { stars: 2.5 }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('una calificación por referido (se puede corregir), avisa al referidor y actualiza su reputación', async () => {
    const id = await newReferral('hired');
    await rep.rateReferral(id, { id: U.empresa, isAdmin: false }, { stars: 3 });
    await rep.rateReferral(id, { id: U.empresa, isAdmin: false }, { stars: 5 });
    const { rows } = await pool.query(`SELECT stars FROM referral_ratings WHERE referral_id = $1`, [id]);
    expect(rows).toEqual([{ stars: 5 }]);
    const { rows: n } = await pool.query(`SELECT title FROM notifications WHERE related_id = $1`, [id]);
    expect(n).toHaveLength(1); // solo la primera vez
    const { rows: [p] } = await pool.query(`SELECT reputation_score FROM profiles WHERE id = $1`, [U.referidor]);
    expect(Number(p.reputation_score)).toBeCloseTo(4.5, 2); // (4 + 5) / 2
  });

  /* --------------------------- Socio Reclutador --------------------------- */

  it('con menos de 15 referidos calificados no se puede pedir la certificación', async () => {
    const s = await rep.referrerSummary(U.referidor);
    expect(s).toEqual(expect.objectContaining({ ratedCount: 2, canApply: false, partnerStatus: 'none' }));
    await expect(rep.applyForPartner(U.referidor)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('15 referidos con promedio 4 o más habilitan la solicitud; un promedio menor no', async () => {
    // 13 más con 3 estrellas → 15 calificados, promedio (4+5+13*3)/15 = 3.2
    const low: string[] = [];
    for (let i = 0; i < 13; i++) {
      const id = await newReferral('rejected');
      low.push(id);
      await rep.rateReferral(id, { id: U.empresa, isAdmin: false }, { stars: 3 });
    }
    let s = await rep.referrerSummary(U.referidor);
    expect(s.ratedCount).toBe(15);
    expect(s.average).toBeCloseTo(3.2, 2);
    expect(s.canApply).toBe(false);

    // la empresa corrige esas 13 a 4 estrellas → promedio (4+5+13*4)/15 = 4.07
    for (const id of low) await rep.rateReferral(id, { id: U.empresa, isAdmin: false }, { stars: 4 });
    s = await rep.referrerSummary(U.referidor);
    expect(s.average).toBeCloseTo(4.07, 2);
    expect(s.canApply).toBe(true);
  });

  it('solicitar → pendiente; no se duplica; el admin aprueba y queda certificado', async () => {
    const app = await rep.applyForPartner(U.referidor, 'Llevo 5 años reclutando');
    expect(app.status).toBe('pending');
    await expect(rep.applyForPartner(U.referidor)).rejects.toBeInstanceOf(ConflictException);
    expect((await rep.referrerSummary(U.referidor)).partnerStatus).toBe('pending');

    const pending = await rep.listPartnerApplications('pending');
    expect(pending.map((a: any) => a.user_id)).toContain(U.referidor);
    const { rows: adminNote } = await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND related_id = $2`, [U.admin, app.id]);
    expect(adminNote).toHaveLength(1);

    await rep.reviewPartnerApplication(app.id, U.admin, true, 'Bienvenido');
    const s = await rep.referrerSummary(U.referidor);
    expect(s.partnerStatus).toBe('certified');
    expect(s.partnerSince).not.toBeNull();
    await expect(rep.reviewPartnerApplication(app.id, U.admin, true)).rejects.toBeInstanceOf(NotFoundException);
    await expect(rep.applyForPartner(U.referidor)).rejects.toBeInstanceOf(ConflictException);
  });

  /* ------------------------- Referencias laborales ------------------------ */

  it('el candidato agrega una referencia: WhatsApp simulado, enlace hasheado, sin exponer el teléfono', async () => {
    const r = await refs.create(U.cand, {
      referenceName: 'Carlos Ruiz', companyName: 'Banco X', relationship: 'Mi jefe directo', phone: '6111-2222',
    });
    expect(r.whatsapp).toEqual(expect.objectContaining({ mode: 'simulated', to: '+507 ****2222' }));
    expect(r.shareText).toContain('Ana Gómez te indicó como referencia laboral');
    expect(r).not.toHaveProperty('phone');
    const token = r.confirmUrl.split('/referencia/')[1];
    const { rows: [db] } = await pool.query(`SELECT phone, token_hash FROM work_references WHERE id = $1`, [r.id]);
    expect(db).toEqual({ phone: '+50761112222', token_hash: hashToken(token) });

    const pub = await refs.getPublic(token);
    expect(pub).toEqual(expect.objectContaining({ referenceFirstName: 'Carlos', candidateName: 'Ana Gómez', companyName: 'Banco X' }));
    expect(JSON.stringify(pub)).not.toContain('6111');
  });

  it('no se puede usar el propio teléfono ni pasar de 3 referencias vigentes', async () => {
    await expect(refs.create(U.cand, { referenceName: 'Yo', companyName: 'X', relationship: 'Yo', phone: '6000-0000' }))
      .rejects.toBeInstanceOf(BadRequestException);
    await refs.create(U.cand, { referenceName: 'B', companyName: 'Y', relationship: 'Jefa', phone: '6111-3333' });
    await refs.create(U.cand, { referenceName: 'C', companyName: 'Z', relationship: 'Jefe', phone: '6111-4444' });
    await expect(refs.create(U.cand, { referenceName: 'D', companyName: 'W', relationship: 'Jefe', phone: '6111-5555' }))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('confirmar: se borra el teléfono, se avisa al candidato y la empresa con postulación la ve; otra empresa no', async () => {
    const mine = await refs.listMine(U.cand);
    // reponer el enlace de la primera para poder responder
    const token = 'tok_confirm_abcdefghijklmnopqrstuvw';
    await pool.query(`UPDATE work_references SET token_hash = $2 WHERE id = $1`, [mine[mine.length - 1].id, hashToken(token)]);
    await refs.respond(token, true, 'Excelente profesional');
    await expect(refs.respond(token, true)).rejects.toBeInstanceOf(NotFoundException); // un solo uso

    const { rows: [db] } = await pool.query(`SELECT status, phone, token_hash FROM work_references WHERE id = $1`, [mine[mine.length - 1].id]);
    expect(db).toEqual({ status: 'confirmed', phone: null, token_hash: null });

    await pool.query(`INSERT INTO applications (job_offer_id, candidate_id) VALUES ($1, $2)`, [jobC, U.cand]);
    const seen = await refs.confirmedForCandidate(U.cand, { id: U.empresa, isAdmin: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(expect.objectContaining({ reference_comment: 'Excelente profesional' }));
    expect(seen[0]).not.toHaveProperty('phone');
    await expect(refs.confirmedForCandidate(U.cand, { id: U.otraEmpresa, isAdmin: false }))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('una referencia vencida no se puede responder; el proceso horario vence las pendientes', async () => {
    const token = 'tok_expired_abcdefghijklmnopqrstuvw';
    const { rows: [r] } = await pool.query(
      `INSERT INTO work_references (candidate_id, reference_name, company_name, relationship, phone, token_hash, expires_at)
       VALUES ($1,'E','Q','Jefe','+50761119999',$2, now() - interval '1 minute') RETURNING id`,
      [U.extraño, hashToken(token)]);
    await expect(refs.getPublic(token)).rejects.toBeInstanceOf(GoneException);
    const { rows: [db] } = await pool.query(`SELECT status, phone FROM work_references WHERE id = $1`, [r.id]);
    expect(db).toEqual({ status: 'expired', phone: null });

    await pool.query(
      `INSERT INTO work_references (candidate_id, reference_name, company_name, relationship, phone, token_hash, expires_at)
       VALUES ($1,'F','Q','Jefe','+50761118888','h2', now() - interval '1 hour')`, [U.extraño]);
    expect(await refs.expirePending()).toBeGreaterThanOrEqual(1);
  });

  /* ------------------------ Calificación de empresas ---------------------- */

  it('califican la empresa solo quienes postularon o le recomendaron a alguien; un voto por persona', async () => {
    await expect(rep.rateCompany(companyC, U.extraño, { stars: 1 })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(rep.rateCompany(companyC, U.empresa, { stars: 5 })).rejects.toBeInstanceOf(ForbiddenException);

    await rep.rateCompany(companyC, U.cand, { stars: 2 });         // postuló
    await rep.rateCompany(companyC, U.cand, { stars: 4 });         // corrige su voto
    const r = await rep.rateCompany(companyC, U.referidor, { stars: 5 }); // recomendó
    expect(r).toEqual(expect.objectContaining({ count: 2, average: 4.5, canRate: true }));

    const { rows: [c] } = await pool.query(`SELECT company_rating FROM companies WHERE id = $1`, [companyC]);
    expect(Number(c.company_rating)).toBe(4.5);

    const other = await rep.companyRating(companyD, U.cand);
    expect(other).toEqual(expect.objectContaining({ count: 0, canRate: false }));
  });
});
