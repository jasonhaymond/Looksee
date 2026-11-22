// The bridge between the app's JavaScript and Looksee's notification service
// (StreamService). JavaScript calls these functions through
// modules/looksee-stream/index.ts; "onStatus" events tell it when the
// connection state changes and "onAlert" events when new alerts arrived,
// while the app is open.
//
// Called by: the app after signing in (start), on sign-out (stop), and by the
// Settings screen (status, battery exemption, notification settings).

package expo.modules.lookseestream

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.os.bundleOf
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class LookseeStreamModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext)

  // Forwards service status changes to JavaScript as "onStatus" events.
  private val statusListener: (Context) -> Unit = { ctx -> sendEvent("onStatus", statusBundle(ctx)) }
  // Forwards "new alerts arrived" to JavaScript as "onAlert" events ({ count }).
  private val alertListener: (Int) -> Unit = { count -> sendEvent("onAlert", bundleOf("count" to count)) }

  /** The current status as a JavaScript object. */
  private fun statusBundle(ctx: Context) = StreamConfig.status(ctx).let { (state, error, last) ->
    bundleOf(
      "enabled" to StreamConfig.isEnabled(ctx),
      "state" to state,
      "lastError" to error,
      "lastConnectedAt" to (if (last > 0) last.toDouble() else null),
      "serverUrl" to StreamConfig.serverUrl(ctx),
    )
  }

  override fun definition() = ModuleDefinition {
    Name("LookseeStream")
    Events("onStatus", "onAlert")

    OnCreate {
      StreamEvents.add(statusListener)
      StreamAlerts.add(alertListener)
    }
    OnDestroy {
      StreamEvents.remove(statusListener)
      StreamAlerts.remove(alertListener)
    }

    /**
     * Saves the server address, this phone's notification token and name,
     * then starts the service. In: serverUrl (https://…), token, deviceName.
     */
    Function("start") { serverUrl: String, token: String, deviceName: String ->
      StreamConfig.save(context, serverUrl, token, deviceName)
      StreamService.createChannels(context)
      StreamService.start(context)
    }

    /** Stops the service and forgets the token (signing out). */
    Function("stop") {
      StreamConfig.clear(context)
      StreamService.stop(context)
      StreamConfig.setStatus(context, "stopped")
    }

    /** Starts the service again if it's set up (e.g. when the app opens). */
    Function("ensureRunning") { StreamService.start(context) }

    /** { enabled, state, lastError, lastConnectedAt (ms) | null, serverUrl }. */
    Function("getStatus") { statusBundle(context) }

    /** Whether Android's battery saving leaves this app alone (needed for a reliable connection). */
    Function("isIgnoringBatteryOptimizations") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return@Function true
      context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)
    }

    /** Shows Android's own "Allow Looksee to run in the background?" dialog. */
    Function("requestIgnoreBatteryOptimizations") {
      val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }

    /** Opens Android's notification settings for this app (sounds per category, etc.). */
    Function("openNotificationSettings") {
      val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }
  }
}
