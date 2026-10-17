// Garage Mode talks to Stoop exactly like Alexa+ does: MCP over Streamable HTTP, stateless, with the
// documented approval fallback (approval_required -> on-screen confirm -> confirm_action). The TV holds
// no money or address keys; it only proposes, and Settlement decides.
import { Platform } from 'react-native';

// Android emulator reaches the host's localhost at 10.0.2.2; a real Fire TV needs EXPO_PUBLIC_STOOP_URL.
const DEFAULT_URL = Platform.OS === 'android' ? 'http://10.0.2.2:8787' : 'http://localhost:8787';
export const STOOP_URL = process.env.EXPO_PUBLIC_STOOP_URL ?? DEFAULT_URL;
// Demo household token from the local stack (services/stack DEMO). Never a real credential.
const SELLER_TOKEN = process.env.EXPO_PUBLIC_STOOP_SELLER_TOKEN ?? 'seller-demo-okafor';

export interface ToolResult<T = any> {
  text: string;
  data: T;
  isError: boolean;
}

let rpcId = 0;

export async function callTool<T = any>(name: string, args: Record<string, unknown> = {}): Promise<ToolResult<T>> {
  const res = await fetch(`${STOOP_URL}/mcp/seller`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${SELLER_TOKEN}`,
      'MCP-Protocol-Version': '2025-11-25',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  if (!res.ok) throw new Error(`Stoop answered ${res.status}`);
  const msg = await res.json();
  if (msg.error) throw new Error(msg.error.message ?? 'Stoop error');
  const r = msg.result ?? {};
  const text = (r.content ?? []).map((c: { text?: string }) => c.text ?? '').join(' ').trim();
  return { text, data: (r.structuredContent ?? {}) as T, isError: !!r.isError };
}

/** Loads the labelled demo photo set into the household's latest sweep (local stack only). */
export async function loadDemoPhotos(): Promise<void> {
  const res = await fetch(`${STOOP_URL}/sweep/demo`, { method: 'POST', headers: { Authorization: `Bearer ${SELLER_TOKEN}` } });
  if (!res.ok) throw new Error(`Couldn't load demo photos (${res.status})`);
}

export interface GarageItem {
  itemId: string;
  title: string;
  condition: string;
  listMinor: number;
  quickSaleMinor: number;
  comps: number;
  confidence: string;
  blocked: boolean;
  blockedReason?: string;
  alternative?: string;
  listingState?: string;
}

export interface Garage {
  kind: 'appraisal';
  totalListMinor: number;
  items: GarageItem[];
}

export interface ApprovalRequired {
  kind: 'approval_required';
  pendingActionId: string;
  summary: string;
}

export interface SaleStatus {
  kind: 'status';
  deal: null | { dealId: string; title: string; state: string; amountMinor: number };
}

export const money = (minor: number) => `$${(minor / 100).toFixed(minor % 100 ? 2 : 0)}`;
