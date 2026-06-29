export interface FastFoodContext {
  instanceId: string;
  phone: string;
  text: string;
  language: "kk" | "ru";
  config: Record<string, any>;
  runtimeStatus: Record<string, any> | null;
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
