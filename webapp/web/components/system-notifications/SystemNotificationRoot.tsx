import { SystemNotificationBanner } from './SystemNotificationBanner';
import { useAppUpdateNotifications } from './useAppUpdateNotifications';
import { useNativeWorkflowNotifications } from './useNativeWorkflowNotifications';

/**
 * Root component that renders the system notification banner and wires up
 * notification sources such as desktop app update availability.
 *
 * Must be placed inside SystemNotificationProvider.
 */
export function SystemNotificationRoot() {
  useAppUpdateNotifications();
  useNativeWorkflowNotifications();

  return <SystemNotificationBanner />;
}
