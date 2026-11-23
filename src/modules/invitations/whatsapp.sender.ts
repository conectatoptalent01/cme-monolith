import { Injectable, Logger } from '@nestjs/common';

export interface ReferralInviteMessage {
  /** Teléfono en formato E.164. */
  to: string;
  inviteeFirstName: string;
  referrerName: string;
  jobTitle: string;
  companyName: string;
  /** Token del enlace (va como sufijo del botón de la plantilla). */
  token: string;
  /** Enlace completo, para el modo simulado y para el texto de respaldo. */
  inviteUrl: string;
}

export interface SendResult {
  mode: 'simulated' | 'meta';
  status: 'simulated' | 'sent' | 'failed';
  providerMessageId?: string | null;
  error?: string | null;
  /** Texto equivalente del mensaje (en modo simulado es lo que "se habría enviado"). */
  previewText: string;
}

export function buildInvitePreview(m: Omit<ReferralInviteMessage, 'to' | 'token'>): string {
  return (
    `Hola ${m.inviteeFirstName}, ${m.referrerName} te recomendó para la vacante ` +
    `"${m.jobTitle}" en ${m.companyName} a través de CME. ` +
    `Revisa la oferta y responde aquí: ${m.inviteUrl}`
  );
}

/**
 * Envía la invitación por WhatsApp.
 *
 * WHATSAPP_MODE=simulated (por defecto): no envía nada, solo registra el mensaje.
 * WHATSAPP_MODE=meta: envía con la API oficial de WhatsApp (Meta Cloud API). Requiere:
 *   WHATSAPP_PHONE_NUMBER_ID   id del número en Meta
 *   WHATSAPP_ACCESS_TOKEN      token permanente del usuario de sistema
 *   WHATSAPP_TEMPLATE_REFERRAL nombre de la plantilla aprobada (por defecto "cme_invitacion_referido")
 *   WHATSAPP_TEMPLATE_LANG     idioma de la plantilla (por defecto "es")
 *   WHATSAPP_GRAPH_VERSION     versión de la API (por defecto "v21.0")
 *
 * La plantilla debe tener 4 variables en el cuerpo
 *   {{1}} nombre del invitado · {{2}} quien recomienda · {{3}} vacante · {{4}} empresa
 * y un botón de tipo URL dinámica: https://<dominio>/invitacion/{{1}}  (el sufijo es el token).
 */
export interface ReferenceRequestMessage {
  to: string;
  referenceFirstName: string;
  candidateName: string;
  companyName: string;
  token: string;
  confirmUrl: string;
}

export function buildReferencePreview(m: Omit<ReferenceRequestMessage, 'to' | 'token'>): string {
  return (
    `Hola ${m.referenceFirstName}, ${m.candidateName} te indicó como referencia laboral de su ` +
    `trabajo en ${m.companyName}. ¿Nos ayudas a confirmarlo? Toma menos de un minuto: ${m.confirmUrl}`
  );
}

@Injectable()
export class WhatsAppSender {
  private readonly log = new Logger('WhatsApp');

  get mode(): 'simulated' | 'meta' {
    return process.env.WHATSAPP_MODE === 'meta' ? 'meta' : 'simulated';
  }

  /** Invitación a un referido: plantilla con 4 variables + botón /invitacion/{token}. */
  sendReferralInvite(m: ReferralInviteMessage): Promise<SendResult> {
    return this.sendTemplate({
      to: m.to,
      template: process.env.WHATSAPP_TEMPLATE_REFERRAL || 'cme_invitacion_referido',
      bodyParams: [m.inviteeFirstName, m.referrerName, m.jobTitle, m.companyName],
      buttonSuffix: m.token,
      previewText: buildInvitePreview(m),
    });
  }

  /**
   * Pedido de confirmación a una referencia laboral.
   * Plantilla (Utility, español) con 3 variables:
   *   {{1}} nombre de la referencia · {{2}} candidato · {{3}} empresa donde trabajaron
   * y botón URL dinámico: https://<dominio>/referencia/{{1}}
   */
  sendReferenceRequest(m: ReferenceRequestMessage): Promise<SendResult> {
    return this.sendTemplate({
      to: m.to,
      template: process.env.WHATSAPP_TEMPLATE_REFERENCE || 'cme_validacion_referencia',
      bodyParams: [m.referenceFirstName, m.candidateName, m.companyName],
      buttonSuffix: m.token,
      previewText: buildReferencePreview(m),
    });
  }

  private async sendTemplate(t: {
    to: string;
    template: string;
    bodyParams: string[];
    buttonSuffix: string;
    previewText: string;
  }): Promise<SendResult> {
    const { previewText } = t;

    if (this.mode === 'simulated') {
      this.log.log(`[SIMULADO] mensaje "${t.template}" preparado (no se envió).`);
      return { mode: 'simulated', status: 'simulated', previewText };
    }

    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    if (!phoneNumberId || !token) {
      return { mode: 'meta', status: 'failed', error: 'whatsapp_not_configured', previewText };
    }

    const version = process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';
    const body = {
      messaging_product: 'whatsapp',
      to: t.to.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: t.template,
        language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'es' },
        components: [
          { type: 'body', parameters: t.bodyParams.map((text) => ({ type: 'text', text })) },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: t.buttonSuffix }] },
        ],
      },
    };

    try {
      const res = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        const error = json?.error?.message || `http_${res.status}`;
        this.log.warn(`Envío fallido (${t.template}): ${error}`);
        return { mode: 'meta', status: 'failed', error, previewText };
      }
      return { mode: 'meta', status: 'sent', providerMessageId: json?.messages?.[0]?.id ?? null, previewText };
    } catch (e: any) {
      return { mode: 'meta', status: 'failed', error: e?.message || 'network_error', previewText };
    }
  }
}
