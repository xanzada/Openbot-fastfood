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
  menuSnapshot: Record<string, any> | null;
  activeShiftNotes: any[];
  activeShiftNotesFingerprint: string;
  mediaContext: Record<string, any> | null;
  shporContext: any[];
  magicLinkAlreadySent: boolean;
  explicitMenuLinkIntent: boolean;
  magicLink: string | null;
  // Set when the guest asked for the link and issuing it actually failed (hub
  // unreachable, secret rotated). Without this the skill could not tell an
  // outage apart from "the link was already sent" and reassured the guest about
  // a link that had never been issued.
  magicLinkFailed?: boolean;
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
