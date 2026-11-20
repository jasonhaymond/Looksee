// Restarts Looksee's notification service after the phone restarts or the app
// is updated, so alerts keep arriving without opening the app. Does nothing
// unless the user is signed in with notifications on (StreamConfig.isEnabled).
//
// Android sends these broadcasts itself; the manifest lists exactly the two
// actions handled here, and anything else is ignored.

package expo.modules.lookseestream

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
  /** Starts the service on BOOT_COMPLETED / MY_PACKAGE_REPLACED. */
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    StreamService.start(context)
  }
}
