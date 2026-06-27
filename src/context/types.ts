export interface FastFoodContext {
  instanceId: string;
  phone: string;
  text: string;
  language: "kk" | "ru";
  config: Record<string, any>;
  runtimeStatus: Record<string, any> | null;
  activeOrder: Record<string, any> | null;
  chatHistory: any[];
  activeShiftNotes: any[];
  shporContext: any[];
  magicLinkAlreadySent: boolean;
  explicitMenuLinkIntent: boolean;
  magicLink: string | null;
}
