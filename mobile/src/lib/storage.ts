// Where the app keeps small saved values (server address, session token,
// phone ID, theme). On Android: expo-secure-store, encrypted with a key in the
// Android Keystore. Anywhere else (the web preview used for testing screens in
// a browser) there is no secure store, so values are kept in memory only and
// forgotten when the page closes; nothing is ever written unencrypted.

import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

const memory = new Map<string, string>();
const native = Platform.OS === "android" || Platform.OS === "ios";

/** The saved value, or null. */
export const getItem = (key: string): Promise<string | null> => (native ? SecureStore.getItemAsync(key) : Promise.resolve(memory.get(key) ?? null));

/** Saves a value. */
export const setItem = async (key: string, value: string): Promise<void> => {
  if (native) await SecureStore.setItemAsync(key, value);
  else memory.set(key, value);
};

/** Deletes a value. */
export const deleteItem = async (key: string): Promise<void> => {
  if (native) await SecureStore.deleteItemAsync(key);
  else memory.delete(key);
};
