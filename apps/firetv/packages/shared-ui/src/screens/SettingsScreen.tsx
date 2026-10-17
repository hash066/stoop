import { Platform, StyleSheet, View, Text } from 'react-native';
import {
  SpatialNavigationRoot,
  SpatialNavigationNode,
  SpatialNavigationScrollView,
  DefaultFocus,
} from 'react-tv-space-navigation';
import { DrawerActions, useIsFocused, useNavigation } from '@react-navigation/native';
import { Direction } from '@bam.tech/lrud';
import { scaledPixels } from '../hooks/useScale';
import { colors, safeZones } from '../theme';
import FocusablePressable from '../components/FocusablePressable';
import { useCallback } from 'react';
import { useMenuContext } from '../components/MenuContext';
import { getOpenDrawerDirection } from '../utils/rtl';
import { STOOP_URL } from '../stoop/api';

const SERIF = Platform.select({ android: 'serif', ios: 'Georgia', default: 'Georgia, serif' });
const MONO = Platform.select({ android: 'SpaceMono', ios: 'SpaceMono', default: 'SpaceMono, monospace' });

// Settings is informational: where Garage Mode is pointed, how it works, and attribution.
// No account or payment controls live here — the TV never holds keys.
export default function SettingsScreen() {
  const isFocused = useIsFocused();
  const navigation = useNavigation();
  const { isOpen: isMenuOpen, toggleMenu } = useMenuContext();

  const onDirectionHandledWithoutMovement = useCallback(
    (movement: Direction) => {
      if (movement === getOpenDrawerDirection()) {
        navigation.dispatch(DrawerActions.openDrawer());
        toggleMenu(true);
      }
    },
    [toggleMenu, navigation],
  );

  return (
    <SpatialNavigationRoot
      isActive={isFocused && !isMenuOpen}
      onDirectionHandledWithoutMovement={onDirectionHandledWithoutMovement}
    >
      <View style={styles.container}>
        <Text style={styles.eyebrow}>STOOP · GARAGE MODE</Text>
        <Text style={styles.title}>Settings</Text>
        <SpatialNavigationScrollView style={styles.scrollView}>
          <View style={styles.scrollContent}>
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Connection</Text>
              <View style={styles.infoContainer}>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Stoop stack</Text>
                  <Text style={styles.infoValueMono}>{STOOP_URL}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Household</Text>
                  <Text style={styles.infoValue}>Okafor household (demo)</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Protocol</Text>
                  <Text style={styles.infoValue}>MCP over Streamable HTTP</Text>
                </View>
              </View>
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>How it works</Text>
              <Text style={styles.body}>
                This TV only proposes. It lists items and relays offers, but it never holds your money
                or your address. A separate Settlement service accepts offers, holds payment, and
                releases it only after your doorbell verifies the pickup.
              </Text>
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>About</Text>
              <View style={styles.infoContainer}>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>App</Text>
                  <Text style={styles.infoValue}>Stoop Garage</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Version</Text>
                  <Text style={styles.infoValueMono}>0.1.0</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Built on</Text>
                  <Text style={styles.infoValue}>react-native-multi-tv-app-sample (MIT-0)</Text>
                </View>
              </View>
            </View>

            <SpatialNavigationNode orientation="horizontal">
              <View style={styles.actions}>
                <DefaultFocus>
                  <FocusablePressable
                    text="Back to Garage"
                    onSelect={() => navigation.dispatch(DrawerActions.jumpTo('Garage'))}
                    style={styles.primaryBtn}
                  />
                </DefaultFocus>
              </View>
            </SpatialNavigationNode>
          </View>
        </SpatialNavigationScrollView>
      </View>
    </SpatialNavigationRoot>
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
  title: { color: colors.text, fontFamily: SERIF, fontSize: scaledPixels(72), marginTop: scaledPixels(8), marginBottom: scaledPixels(24) },
  scrollView: { flex: 1 },
  scrollContent: { paddingBottom: scaledPixels(safeZones.actionSafe.vertical + 60) },
  section: { marginBottom: scaledPixels(40), maxWidth: scaledPixels(1300) },
  sectionTitle: { color: colors.primary, fontFamily: MONO, fontSize: scaledPixels(22), letterSpacing: scaledPixels(3), marginBottom: scaledPixels(16) },
  body: { color: colors.textSecondary, fontSize: scaledPixels(26), lineHeight: scaledPixels(38) },
  infoContainer: {
    backgroundColor: colors.card,
    borderWidth: scaledPixels(1),
    borderColor: colors.border,
    borderRadius: scaledPixels(6),
    padding: scaledPixels(28),
    gap: scaledPixels(18),
  },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  infoLabel: { fontSize: scaledPixels(24), color: colors.textTertiary },
  infoValue: { fontSize: scaledPixels(24), color: colors.text },
  infoValueMono: { fontSize: scaledPixels(24), color: colors.text, fontFamily: MONO },
  actions: { flexDirection: 'row', gap: scaledPixels(24), marginTop: scaledPixels(8) },
  primaryBtn: { minWidth: scaledPixels(320), backgroundColor: colors.cardElevated, borderColor: colors.primary },
});
