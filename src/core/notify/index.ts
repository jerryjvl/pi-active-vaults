// Public surface of the notify module: the `notify` configuration, the
// outbox, sending and retrying, and `builtin:notify`.

export { isPlainAddress, parseNotifyConfig, type MailAddress, type NotifyConfig, type NotifyTransport } from './config.ts';
export { notifySchema, undeliveredNotifications, type UndeliveredNotification } from './outbox.ts';
export { deliverDue, sendNotification, testTransport, type NotificationRecord, type NotificationRequest, type NotifyDeps, type NotifyError } from './send.ts';
export { notifyBuiltin } from './builtin.ts';
