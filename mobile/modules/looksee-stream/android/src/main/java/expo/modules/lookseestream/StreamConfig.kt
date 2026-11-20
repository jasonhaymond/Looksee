// Saved settings for Looksee's notification service: the server address, the
// phone's notification token, whether the service should run, and its latest
// connection status (read by the app's Settings screen).
//
// Where this sits: written by LookseeStreamModule when the app signs in or out,
// read by StreamService and BootReceiver, which run without the app's
// JavaScript. Kept in the app's private SharedPreferences (a small key/value
// file only this app can read).
//
// Security: the notification token is encrypted with a key held in the Android
// Keystore (hardware-backed on most phones, and never readable by the app
// itself), so a copy of the app's files, such as a backup, doesn't reveal it.
// The token can only receive notifications; it can't manage anything.

package expo.modules.lookseestream

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

object StreamConfig {
  private const val PREFS = "looksee_stream"
  private const val KEY_ALIAS = "looksee_stream_token"
  private const val SEEN_LIMIT = 300

  /** The app's private settings file for the service. */
  private fun prefs(context: Context): SharedPreferences =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  // ---- token encryption ----

  /**
   * The AES key in the Android Keystore, created on first use. AES-GCM both
   * encrypts and detects tampering.
   */
  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return generator.generateKey()
  }

  /** Encrypts text. Out: "<iv>:<ciphertext>", both base64. */
  private fun encrypt(plain: String): String {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val sealed = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
    return Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(sealed, Base64.NO_WRAP)
  }

  /** Decrypts what encrypt() wrote. Out: the text, or null if it can't be read (key gone, data damaged). */
  private fun decrypt(stored: String): String? = try {
    val (iv, sealed) = stored.split(":", limit = 2)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
    String(cipher.doFinal(Base64.decode(sealed, Base64.NO_WRAP)), Charsets.UTF_8)
  } catch (e: Exception) {
    null
  }

  // ---- settings ----

  /** What the service needs to connect, or null when it isn't set up / is turned off. */
  data class Connection(val serverUrl: String, val token: String, val deviceName: String)

  /** Saves the server, phone token and name, and turns the service on. */
  fun save(context: Context, serverUrl: String, token: String, deviceName: String) {
    prefs(context).edit()
      .putString("serverUrl", serverUrl.trimEnd('/'))
      .putString("token", encrypt(token))
      .putString("deviceName", deviceName)
      .putBoolean("enabled", true)
      .apply()
  }

  /** Turns the service off and forgets the token (sign-out, or the phone was removed). */
  fun clear(context: Context) {
    prefs(context).edit().remove("token").putBoolean("enabled", false).apply()
  }

  /** The saved connection, when the service is on and the token can be read. */
  fun connection(context: Context): Connection? {
    val p = prefs(context)
    if (!p.getBoolean("enabled", false)) return null
    val url = p.getString("serverUrl", null) ?: return null
    val token = p.getString("token", null)?.let { decrypt(it) } ?: return null
    return Connection(url, token, p.getString("deviceName", "") ?: "")
  }

  fun isEnabled(context: Context) = prefs(context).getBoolean("enabled", false)

  // ---- status, for the app's Settings screen ----

  /** Records the connection state ("connecting", "connected", "waiting", "stopped") and the last error, if any. */
  fun setStatus(context: Context, state: String, error: String? = null) {
    val edit = prefs(context).edit().putString("state", state).putString("lastError", error)
    if (state == "connected") edit.putLong("lastConnectedAt", System.currentTimeMillis())
    edit.apply()
  }

  /** The latest status: state, last error, and when it was last connected (ms since 1970, 0 = never). */
  fun status(context: Context): Triple<String, String?, Long> {
    val p = prefs(context)
    return Triple(p.getString("state", "stopped") ?: "stopped", p.getString("lastError", null), p.getLong("lastConnectedAt", 0))
  }

  fun serverUrl(context: Context): String? = prefs(context).getString("serverUrl", null)

  // ---- notifications already shown ----

  /**
   * Remembers a notification's ID so it isn't shown twice when the server
   * resends it (it resends anything not yet acknowledged, for example after
   * the connection dropped just as it arrived).
   * Out: true when the ID is new (show it), false when it was seen before.
   */
  fun markSeen(context: Context, id: String): Boolean {
    val p = prefs(context)
    val seen = (p.getString("seen", "") ?: "").split(",").filter { it.isNotEmpty() }.toMutableList()
    if (seen.contains(id)) return false
    seen.add(id)
    p.edit().putString("seen", seen.takeLast(SEEN_LIMIT).joinToString(",")).apply()
    return true
  }
}
