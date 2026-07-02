export interface FastFoodContext {
  instanceId: string;
  phone: string;
  text: string;
  senderMeta: Record<string, any>;
  language: "kk" | "ru";
  languagePolicy: Record<string, any>;
  config: Record<string, any>;
  runtimeStatus: Record<string, any> | null;
  fetchedSettings: Record<string, any>;
  hardRealtimeContext: Record<string, any>;
  activeOrder: Record<string, any> | null;
  chatHistory: any[];
  activeShiftNotes: any[];
  mediaContext: Record<string, any> | null;
  shporContext: any[];
  magicLinkAlreadySent: boolean;
  explicitMenuLinkIntent: boolean;
  magicLink: string | null;
}
