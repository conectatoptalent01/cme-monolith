/// <reference types="jest" />
import { ProfilesController } from './profiles.controller';

describe('Perfil propio: lo que el usuario NO puede cambiarse', () => {
  const setup = () => {
    const svc: any = {
      updatePartial: jest.fn(async (_id: string, patch: any) => patch),
      upsert: jest.fn(async (_id: string, payload: any) => payload),
      findOne: jest.fn(async (id: string) => ({ id, full_name: 'Ana', document_type: 'cedula', document_id: '8-123-456' })),
    };
    return { svc, ctrl: new ProfilesController(svc) };
  };

  it('no puede hacerse admin, ni cambiar su estado o reputación', async () => {
    const { svc, ctrl } = setup();
    await ctrl.patchMe({ id: 'u1' }, { role: 'admin', status: 'active', reputation_score: 5, full_name: 'Ana' });
    expect(svc.updatePartial).toHaveBeenCalledWith('u1', { full_name: 'Ana' });
    await ctrl.upsertMe({ id: 'u1', email: 'a@x.com' }, { role: 'admin', full_name: 'Ana' } as any);
    expect(svc.upsert.mock.calls[0][1]).toEqual({ full_name: 'Ana', email: 'a@x.com' });
  });

  it('sí puede elegir un rol permitido', async () => {
    const { svc, ctrl } = setup();
    await ctrl.patchMe({ id: 'u1' }, { role: 'headhunter' });
    expect(svc.updatePartial).toHaveBeenCalledWith('u1', { role: 'headhunter' });
  });

  it('la cédula solo la ve su dueño', async () => {
    const { ctrl } = setup();
    const otherId = '33333333-3333-4333-8333-333333333333';
    expect(await ctrl.getById({ id: 'otro' }, otherId)).not.toHaveProperty('document_id');
    expect(await ctrl.getById({ id: otherId }, otherId)).toHaveProperty('document_id', '8-123-456');
  });
});
