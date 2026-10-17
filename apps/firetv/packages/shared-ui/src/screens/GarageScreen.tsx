// Garage Mode: the household's appraised items on the big screen. Pick with the D-pad, press select
// to mark items, then "List selected". The listing needs an on-screen yes, which goes back to Stoop as
// confirm_action (the same approval path an Alexa+ client without elicitation uses).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import {
  DefaultFocus,
  SpatialNavigationFocusableView,
  SpatialNavigationNode,
  SpatialNavigationRoot,
} from 'react-tv-space-navigation';
import { DrawerActions, useIsFocused, useNavigation } from '@react-navigation/native';
import { Direction } from '@bam.tech/lrud';
import { scaledPixels } from '../hooks/useScale';
import { colors, safeZones } from '../theme';
import FocusablePressable from '../components/FocusablePressable';
import { useMenuContext } from '../components/MenuContext';
import { getOpenDrawerDirection } from '../utils/rtl';
import { ApprovalRequired, callTool, Garage, GarageItem, money, SaleStatus, STOOP_URL, loadDemoPhotos } from '../stoop/api';

const SERIF = Platform.select({ android: 'serif', ios: 'Georgia', default: 'Georgia, serif' });
const MONO = Platform.select({ android: 'SpaceMono', ios: 'SpaceMono', default: 'SpaceMono, monospace' });
const STATUS_POLL_MS = 4000;

const STATE_LABEL: Record<string, string> = {
  LIVE: 'Listed',
  RESERVED: 'Reserved',
  SOLD: 'Sold',
  CLOSED: 'Sold',
  AWAITING_SELLER_OK: 'Draft',
};

export default function GarageScreen() {
  const isFocused = useIsFocused();
  const navigation = useNavigation();
  const { isOpen: isMenuOpen, toggleMenu } = useMenuContext();
  const [garage, setGarage] = useState<Garage | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [approval, setApproval] = useState<ApprovalRequired | null>(null);
  const [said, setSaid] = useState('');
  const [sale, setSale] = useState<{ line: string; state?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const r = await callTool<Garage>('my_items');
      if (!mounted.current) return;
      setGarage(r.data);
      setOffline(false);
      setSelected((sel) => sel.filter((id) => r.data.items.some((i) => i.itemId === id && !i.blocked && i.listingState !== 'LIVE')));
    } catch {
      if (mounted.current) setOffline(true);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const pollSale = async () => {
      try {
        const r = await callTool<SaleStatus>('handoff_status');
        if (mounted.current) setSale(r.data.deal ? { line: r.text, state: r.data.deal.state } : null);
      } catch {
        /* the offline banner covers this */
      }
    };
    void pollSale();
    const t = setInterval(() => {
      void pollSale();
      void refresh();
    }, STATUS_POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(t);
    };
  }, [refresh]);

  const onDirectionHandledWithoutMovement = useCallback(
    (movement: Direction) => {
      if (movement === getOpenDrawerDirection()) {
        navigation.dispatch(DrawerActions.openDrawer());
        toggleMenu(true);
      }
    },
    [toggleMenu, navigation],
  );

  const toggle = (item: GarageItem) => {
    if (item.blocked) {
      setSaid(`${item.title} can't be sold. ${item.blockedReason ?? ''} ${item.alternative ?? ''}`.trim());
      return;
    }
    if (item.listingState && item.listingState !== 'AWAITING_SELLER_OK') {
      setSaid(`${item.title} is already ${STATE_LABEL[item.listingState]?.toLowerCase() ?? item.listingState.toLowerCase()}.`);
      return;
    }
    setSelected((sel) => (sel.includes(item.itemId) ? sel.filter((x) => x !== item.itemId) : [...sel, item.itemId]));
  };

  const loadDemo = async () => {
    setBusy(true);
    try {
      await loadDemoPhotos();
      const r = await callTool<Garage>('appraise_photos');
      setSaid(r.text);
      await refresh();
    } catch (e) {
      setSaid(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const listSelected = async () => {
    if (!selected.length) {
      setSaid('Pick something first: move to an item and press select.');
      return;
    }
    setBusy(true);
    try {
      const r = await callTool<ApprovalRequired | { kind: string }>('list_items', { items: selected });
      if (r.data.kind === 'approval_required') setApproval(r.data as ApprovalRequired);
      else setSaid(r.text);
    } catch (e) {
      setSaid(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const answer = async (decision: 'accept' | 'decline') => {
    const a = approval;
    setApproval(null);
    if (!a) return;
    try {
      const r = await callTool('confirm_action', { approvalId: a.pendingActionId, decision });
      setSaid(r.text);
      if (decision === 'accept' && !r.isError) setSelected([]);
      await refresh();
    } catch (e) {
      setSaid(e instanceof Error ? e.message : 'Something went wrong.');
    }
  };

  const items = garage?.items ?? [];
  const sellable = items.filter((i) => !i.blocked);

  return (
    <>
      <SpatialNavigationRoot
        isActive={isFocused && !isMenuOpen && !approval}
        onDirectionHandledWithoutMovement={onDirectionHandledWithoutMovement}
      >
        <View style={styles.container}>
          <Text style={styles.eyebrow}>STOOP · GARAGE MODE</Text>
          <Text style={styles.title}>{garage ? `Your garage: ${money(garage.totalListMinor)}` : 'Your garage'}</Text>
          <Text style={styles.lede}>
            Pick what to sell with your remote. Stoop lists it, haggles inside your limits, and pays out only when your
            doorbell sees the pickup.
          </Text>

          {offline && <Text style={styles.warn}>Can't reach Stoop at {STOOP_URL}. Is the local stack running?</Text>}

          {items.length > 0 ? (
            <SpatialNavigationNode orientation="horizontal">
              <View style={styles.row}>
                {items.map((item, i) => {
                  const card = (
                    <ItemCard key={item.itemId} item={item} selected={selected.includes(item.itemId)} onSelect={() => toggle(item)} />
                  );
                  return i === 0 ? <DefaultFocus key={item.itemId}>{card}</DefaultFocus> : card;
                })}
              </View>
            </SpatialNavigationNode>
          ) : (
            !offline && <Text style={styles.empty}>Nothing appraised yet. Snap photos with your phone, or try the demo set.</Text>
          )}

          <SpatialNavigationNode orientation="horizontal">
            <View style={styles.actions}>
              {items.length > 0 ? (
                <FocusablePressable
                  text={busy ? 'Working…' : selected.length ? `List selected (${selected.length})` : 'List selected'}
                  onSelect={() => void listSelected()}
                  style={styles.primaryBtn}
                />
              ) : (
                <DefaultFocus>
                  <FocusablePressable text={busy ? 'Pricing…' : 'Use demo photos'} onSelect={() => void loadDemo()} style={styles.primaryBtn} />
                </DefaultFocus>
              )}
              <FocusablePressable text="Refresh" onSelect={() => void refresh()} style={styles.secondaryBtn} />
            </View>
          </SpatialNavigationNode>

          <View style={styles.footer}>
            <View style={styles.footerCol}>
              <Text style={styles.footerLabel}>STOOP SAYS</Text>
              <Text style={styles.footerText} numberOfLines={2}>
                {said || `${sellable.length} sellable item${sellable.length === 1 ? '' : 's'}. Select toggles, then List selected.`}
              </Text>
            </View>
            <View style={styles.footerCol}>
              <Text style={styles.footerLabel}>LIVE SALE</Text>
              <Text style={styles.footerText} numberOfLines={2}>
                {sale ? sale.line : 'No sale in progress.'}
              </Text>
            </View>
          </View>
        </View>
      </SpatialNavigationRoot>

      {approval && (
        <SpatialNavigationRoot isActive={isFocused && !isMenuOpen}>
          <View style={styles.scrim}>
            <View style={styles.dialog}>
              <Text style={styles.eyebrow}>CONFIRM ON SCREEN</Text>
              <Text style={styles.dialogTitle}>List these?</Text>
              <Text style={styles.dialogBody}>{approval.summary}</Text>
              <Text style={styles.dialogFine}>Your yes is sent to Stoop as a one-time approval bound to exactly these terms.</Text>
              <SpatialNavigationNode orientation="horizontal">
                <View style={styles.actions}>
                  <DefaultFocus>
                    <FocusablePressable text="Yes, list them" onSelect={() => void answer('accept')} style={styles.primaryBtn} />
                  </DefaultFocus>
                  <FocusablePressable text="Not now" onSelect={() => void answer('decline')} style={styles.secondaryBtn} />
                </View>
              </SpatialNavigationNode>
            </View>
          </View>
        </SpatialNavigationRoot>
      )}
    </>
  );
}

function ItemCard({ item, selected, onSelect }: { item: GarageItem; selected: boolean; onSelect: () => void }) {
  const state = item.blocked ? "Can't be sold" : selected ? 'Selected' : item.listingState ? STATE_LABEL[item.listingState] ?? item.listingState : 'Not listed';
  return (
    <SpatialNavigationFocusableView onSelect={onSelect}>
      {({ isFocused }) => (
        <View style={[styles.card, selected && styles.cardSelected, item.blocked && styles.cardBlocked, isFocused && styles.cardFocused]}>
          <Text style={[styles.pill, item.blocked ? styles.pillBad : selected || item.listingState === 'LIVE' ? styles.pillOn : styles.pillOff]}>
            {state.toUpperCase()}
          </Text>
          <Text style={styles.cardTitle} numberOfLines={2}>
            {item.title}
          </Text>
          <Text style={styles.cardMeta}>Condition {item.condition}</Text>
          {item.blocked ? (
            <Text style={styles.cardReason} numberOfLines={4}>
              {item.blockedReason}
            </Text>
          ) : (
            <>
              <Text style={styles.price}>{money(item.listMinor)}</Text>
              <Text style={styles.cardMeta}>
                Quick sale {money(item.quickSaleMinor)} · {item.comps} comps
              </Text>
            </>
          )}
        </View>
      )}
    </SpatialNavigationFocusableView>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.background,
    paddingHorizontal: scaledPixels(safeZones.titleSafe.horizontal),
    paddingTop: scaledPixels(safeZones.titleSafe.vertical + 10),
  },
  eyebrow: { color: colors.primary, fontFamily: MONO, fontSize: scaledPixels(20), letterSpacing: scaledPixels(4) },
  title: { color: colors.text, fontFamily: SERIF, fontSize: scaledPixels(72), marginTop: scaledPixels(8) },
  lede: { color: colors.textSecondary, fontSize: scaledPixels(26), maxWidth: scaledPixels(1300), marginTop: scaledPixels(8), marginBottom: scaledPixels(36) },
  warn: { color: colors.error, fontSize: scaledPixels(24), marginBottom: scaledPixels(20) },
  empty: { color: colors.textSecondary, fontSize: scaledPixels(28), marginVertical: scaledPixels(60) },
  row: { flexDirection: 'row', gap: scaledPixels(24) },
  card: {
    width: scaledPixels(320),
    height: scaledPixels(380),
    backgroundColor: colors.card,
    borderWidth: scaledPixels(2),
    borderColor: colors.border,
    borderRadius: scaledPixels(6),
    padding: scaledPixels(24),
  },
  cardSelected: { borderColor: colors.primary, backgroundColor: colors.cardElevated },
  cardBlocked: { opacity: 0.85 },
  cardFocused: { borderColor: colors.focus, borderWidth: scaledPixels(5), transform: [{ scale: 1.05 }] },
  pill: { alignSelf: 'flex-start', fontFamily: MONO, fontSize: scaledPixels(16), letterSpacing: scaledPixels(2), paddingHorizontal: scaledPixels(10), paddingVertical: scaledPixels(4), borderWidth: scaledPixels(1), borderRadius: scaledPixels(3) },
  pillOn: { color: colors.textOnPrimary, backgroundColor: colors.primary, borderColor: colors.primary },
  pillOff: { color: colors.textSecondary, borderColor: colors.border },
  pillBad: { color: colors.error, borderColor: colors.error },
  cardTitle: { color: colors.text, fontFamily: SERIF, fontSize: scaledPixels(32), marginTop: scaledPixels(18), minHeight: scaledPixels(84) },
  cardMeta: { color: colors.textTertiary, fontSize: scaledPixels(20), marginTop: scaledPixels(6) },
  cardReason: { color: colors.textSecondary, fontSize: scaledPixels(20), marginTop: scaledPixels(16) },
  price: { color: colors.text, fontFamily: MONO, fontSize: scaledPixels(56), marginTop: scaledPixels(18) },
  actions: { flexDirection: 'row', gap: scaledPixels(24), marginTop: scaledPixels(40) },
  primaryBtn: { minWidth: scaledPixels(320), backgroundColor: colors.cardElevated, borderColor: colors.primary },
  secondaryBtn: { minWidth: scaledPixels(200) },
  footer: {
    position: 'absolute',
    left: scaledPixels(safeZones.titleSafe.horizontal),
    right: scaledPixels(safeZones.titleSafe.horizontal),
    bottom: scaledPixels(safeZones.titleSafe.vertical),
    flexDirection: 'row',
    gap: scaledPixels(48),
    borderTopWidth: scaledPixels(1),
    borderTopColor: colors.border,
    paddingTop: scaledPixels(20),
  },
  footerCol: { flex: 1 },
  footerLabel: { color: colors.primary, fontFamily: MONO, fontSize: scaledPixels(18), letterSpacing: scaledPixels(3) },
  footerText: { color: colors.text, fontSize: scaledPixels(26), marginTop: scaledPixels(8) },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.scrimDark, alignItems: 'center', justifyContent: 'center' },
  dialog: {
    width: scaledPixels(1100),
    backgroundColor: colors.backgroundElevated,
    borderWidth: scaledPixels(2),
    borderColor: colors.primary,
    borderRadius: scaledPixels(6),
    padding: scaledPixels(56),
  },
  dialogTitle: { color: colors.text, fontFamily: SERIF, fontSize: scaledPixels(56), marginTop: scaledPixels(8) },
  dialogBody: { color: colors.text, fontSize: scaledPixels(30), marginTop: scaledPixels(20), lineHeight: scaledPixels(42) },
  dialogFine: { color: colors.textTertiary, fontSize: scaledPixels(20), marginTop: scaledPixels(16) },
});
