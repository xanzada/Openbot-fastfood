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
  activeShiftNotesFingerprint: string;
  mediaContext: Record<string, any> | null;
  shporContext: any[];
  magicLinkAlreadySent: boolean;
  explicitMenuLinkIntent: boolean;
  magicLink: string | null;
  // Long-term memory. Optional so every existing caller, test, and smoke script
  // keeps compiling and behaves exactly as before when Redis has nothing yet.
  customerProfile?: Record<string, any> | null;
  conversationSummary?: Record<string, any> | null;
  lastTurnTrace?: Record<string, any> | null;
  // Silent pre-analysis (think layer) and the customer's tracked mission.
  // Optional for the same reason as memory: every existing caller keeps
  // compiling, and every read degrades to null without blocking the answer.
  thinking?: Record<string, any> | null;
  activeGoal?: Record<string, any> | null;
  proactiveSignals?: Record<string, any> | null;
}
