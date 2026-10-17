import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { RootStackParamList } from './types';
import DrawerNavigator from './DrawerNavigator';

const Stack = createNativeStackNavigator<RootStackParamList>();

// Garage Mode is a single surface behind a drawer (Garage + Settings); the sample's
// Details/Player movie routes were removed with the movie screens.
export default function RootNavigator() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
      }}
    >
      <Stack.Screen name="DrawerNavigator" component={DrawerNavigator} />
    </Stack.Navigator>
  );
}
