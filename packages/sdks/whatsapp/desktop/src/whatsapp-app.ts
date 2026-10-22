import { appRunning } from '@workspace/sdk-apple-launch-services';

// WhatsApp writes its chats and messages only while the app runs. Its
// notification extension, which runs while the app is closed, writes only
// LocalKeyValue.sqlite.
export function whatsappRunning(): Promise<boolean> {
  return appRunning('net.whatsapp.WhatsApp');
}
