import type { Pool, PoolClient } from 'pg';

/** Crea una notificación interna (campana de la app) para un usuario. */
export async function insertSystemNotification(
  db: Pool | PoolClient,
  userId: string | null | undefined,
  n: { title: string; message: string; relatedId: string | null; type?: 'recommendation' | 'system_message' },
) {
  if (!userId) return;
  await db.query(
    `INSERT INTO public.notifications (user_id, title, message, notification_type, channel, status, related_id)
     VALUES ($1, $2, $3, $5::notification_type, 'system'::notification_channel, 'sent'::notification_status, $4)`,
    [userId, n.title.slice(0, 180), n.message.slice(0, 5000), n.relatedId, n.type ?? 'recommendation'],
  );
}
