import { useEffect, useRef } from 'react';
import { StyleSheet, View, Platform, I18nManager } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { createDrawerNavigator } from '@react-navigation/drawer';
import { useNavigation, DrawerActions, NavigationProp } from '@react-navigation/native';
import { useMenuContext } from '../components/MenuContext';
import CustomDrawerContent from '../components/CustomDrawerContent';
import { scaledPixels } from '../hooks/useScale';
import { DrawerParamList } from './types';

// Import screens
import GarageScreen from '../screens/GarageScreen';
import SettingsScreen from '../screens/SettingsScreen';

const Drawer = createDrawerNavigator<DrawerParamList>();

function DrawerSyncWrapper({ drawerNavRef }: { drawerNavRef: React.MutableRefObject<any> }) {
  const { isOpen: isMenuOpen } = useMenuContext();
  const navigation = useNavigation();

  // Capture the drawer navigation object (useNavigation inside a Drawer.Screen gets the Drawer navigator)
  useEffect(() => {
    drawerNavRef.current = navigation;
  }, [navigation, drawerNavRef]);

  // Open drawer on mount if menu context says it should be open
  useEffect(() => {
    if (isMenuOpen) {
      navigation.dispatch(DrawerActions.openDrawer());
    }
  }, []);

  return null;
}

export default function DrawerNavigator() {
  const styles = drawerStyles;
  const { isOpen: isMenuOpen } = useMenuContext();
  const drawerNavRef = useRef<NavigationProp<DrawerParamList> | null>(null);

  const navigationContent = (
      <Drawer.Navigator
        drawerContent={CustomDrawerContent}
        initialRouteName="Garage"
        defaultStatus="closed"
        screenOptions={{
          headerShown: false,
          drawerActiveBackgroundColor: '#3498db',
          drawerActiveTintColor: '#ffffff',
          drawerInactiveTintColor: '#bdc3c7',
          drawerStyle: styles.drawerStyle,
          drawerLabelStyle: styles.drawerLabelStyle,
          drawerType: 'front',
          swipeEnabled: false,
          drawerPosition: I18nManager.isRTL ? 'right' : 'left',
        }}
      >
        <Drawer.Screen name="Garage" options={{ drawerLabel: 'Garage' }}>
          {() => (
            <>
              <DrawerSyncWrapper drawerNavRef={drawerNavRef} />
              <GarageScreen />
            </>
          )}
        </Drawer.Screen>
        <Drawer.Screen
          name="Settings"
          component={SettingsScreen}
          options={{
            drawerLabel: 'Settings',
          }}
        />
      </Drawer.Navigator>
  );

  // On TV platforms, don't use GestureHandlerRootView as we use remote control navigation
  if (Platform.isTV) {
    return <View style={{ flex: 1 }}>{navigationContent}</View>;
  }

  // On mobile/web, use GestureHandlerRootView for swipe gestures
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {navigationContent}
    </GestureHandlerRootView>
  );
}

const drawerStyles = StyleSheet.create({
    drawerStyle: {
      width: scaledPixels(300),
      backgroundColor: '#2c3e50',
      paddingTop: scaledPixels(0),
    },
    drawerLabelStyle: {
      fontSize: scaledPixels(18),
      fontWeight: 'bold',
      marginStart: scaledPixels(10),
    },
  });
