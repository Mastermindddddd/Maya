/**
 * AI Teacher App — Root Entry Point
 * ─────────────────────────────────
 * Bootstraps navigation and global providers.
 * The avatar session screen is the heart of the app.
 */

import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';

import SessionScreen from './src/screens/SessionScreen';
import HomeScreen    from './src/screens/HomeScreen';

export type RootStackParamList = {
  Home:    undefined;
  Session: { studentName: string };
};

const Stack = createStackNavigator<RootStackParamList>();

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <NavigationContainer>
          <StatusBar style="light" />
          <Stack.Navigator
            screenOptions={{ headerShown: false }}
            initialRouteName="Home"
          >
            <Stack.Screen name="Home"    component={HomeScreen} />
            <Stack.Screen name="Session" component={SessionScreen} />
          </Stack.Navigator>
        </NavigationContainer>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}