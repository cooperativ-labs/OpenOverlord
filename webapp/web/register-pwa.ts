import { getSerwist } from 'virtual:serwist';

export async function registerPwa(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;

  const serwist = await getSerwist();
  void serwist?.register();
}
