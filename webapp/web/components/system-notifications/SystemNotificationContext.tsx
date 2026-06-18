import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

import type { SystemNotification } from './types';

type SystemNotificationContextValue = {
  notifications: SystemNotification[];
  addNotification: (notification: SystemNotification) => void;
  dismissNotification: (id: string) => void;
};

const SystemNotificationContext = createContext<SystemNotificationContextValue | null>(null);

export function SystemNotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<SystemNotification[]>([]);

  const addNotification = useCallback((notification: SystemNotification) => {
    // If it has a dismissKey, check localStorage first
    if (notification.dismissKey) {
      const dismissed = localStorage.getItem(notification.dismissKey);
      if (dismissed) return;
    }

    setNotifications(prev => {
      const index = prev.findIndex(n => n.id === notification.id);
      if (index === -1) return [...prev, notification];
      const next = [...prev];
      next[index] = notification;
      return next;
    });
  }, []);

  const dismissNotification = useCallback((id: string) => {
    setNotifications(prev => {
      const notification = prev.find(n => n.id === id);
      if (notification?.dismissKey) {
        localStorage.setItem(notification.dismissKey, Date.now().toString());
      }
      return prev.filter(n => n.id !== id);
    });
  }, []);

  const value = useMemo(
    () => ({ notifications, addNotification, dismissNotification }),
    [notifications, addNotification, dismissNotification]
  );

  return (
    <SystemNotificationContext.Provider value={value}>
      {children}
    </SystemNotificationContext.Provider>
  );
}

export function useSystemNotifications() {
  const context = useContext(SystemNotificationContext);
  if (!context) {
    throw new Error('useSystemNotifications must be used inside SystemNotificationProvider');
  }
  return context;
}
