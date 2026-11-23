/// <reference types="jest" />
import { WhatsAppSender } from './whatsapp.sender';

/** Verifica el formato exacto que se envía a la API de Meta (no se puede probar en vivo sin cuenta). */
describe('WhatsAppSender en modo Meta', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; jest.restoreAllMocks(); });

  it('envía la plantilla de referencia laboral con 3 variables y el token en el botón', async () => {
    Object.assign(process.env, {
      WHATSAPP_MODE: 'meta', WHATSAPP_PHONE_NUMBER_ID: '123', WHATSAPP_ACCESS_TOKEN: 'secret',
    });
    const fetchMock = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true, json: async () => ({ messages: [{ id: 'wamid.X' }] }),
    } as any);

    const r = await new WhatsAppSender().sendReferenceRequest({
      to: '+50761112222', referenceFirstName: 'Carlos', candidateName: 'Ana Gómez',
      companyName: 'Banco X', token: 'TOKEN123', confirmUrl: 'https://x/referencia/TOKEN123',
    });

    expect(r).toEqual(expect.objectContaining({ mode: 'meta', status: 'sent', providerMessageId: 'wamid.X' }));
    const [url, init] = fetchMock.mock.calls[0] as any[];
    expect(url).toBe('https://graph.facebook.com/v21.0/123/messages');
    expect(init.headers.Authorization).toBe('Bearer secret');
    const body = JSON.parse(init.body);
    expect(body.to).toBe('50761112222');
    expect(body.template.name).toBe('cme_validacion_referencia');
    expect(body.template.components[0].parameters.map((p: any) => p.text)).toEqual(['Carlos', 'Ana Gómez', 'Banco X']);
    expect(body.template.components[1]).toEqual({
      type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'TOKEN123' }],
    });
  });

  it('sin credenciales no intenta enviar y lo reporta', async () => {
    Object.assign(process.env, { WHATSAPP_MODE: 'meta' });
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    const r = await new WhatsAppSender().sendReferralInvite({
      to: '+50761112222', inviteeFirstName: 'A', referrerName: 'B', jobTitle: 'C', companyName: 'D',
      token: 'T', inviteUrl: 'u',
    });
    expect(r).toEqual(expect.objectContaining({ status: 'failed', error: 'whatsapp_not_configured' }));
  });
});
