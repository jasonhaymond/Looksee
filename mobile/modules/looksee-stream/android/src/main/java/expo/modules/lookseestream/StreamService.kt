// The Android "foreground service" that receives Looksee alerts: it keeps one
// WebSocket open to the Looksee engine (wss://<server>/api/app/stream), shows
// each alert it receives as a phone notification, and tells the server it was
// shown (so it isn't sent again). It runs without the app's JavaScript, so
// alerts arrive with the app closed, after a reboot (BootReceiver) and after an
// app update.
//
// A foreground service is one Android lets keep running in the background as
// long as it shows a permanent notification ("Looksee is watching"); that's the
// rule for any app that holds a connection open.
//
// Connection behaviour:
// - Reconnects after a drop, waiting 5 s, then 10, 20 … up to 5 minutes, and
//   immediately when the phone's network comes back.
// - Both sides ping every 30 s, so a silently dead connection is noticed.
// - After 10 minutes without a connection, posts one "Can't reach Looksee"
//   notification (and clears it on reconnect): with no connection no alerts can
//   arrive, which the user needs to know rather than assume all is well.
// - If the server says this phone was removed (close code 4001, or 401 on
//   connecting), it stops, forgets the token, and says so.
//
// Security: the token goes only in the Authorization header over the
// connection (HTTPS in production, since release builds refuse plain HTTP),
// never in the URL or logs. Messages are parsed as data and only shown as
// notification text.

package expo.modules.lookseestream

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class StreamService : Service() {
  companion object {
    // Notification categories ("channels"): each has its own sound/vibration
    // setting the user can change in Android's settings for the app.
    const val CHANNEL_DOWN = "looksee_down"
    const val CHANNEL_WARN = "looksee_warn"
    const val CHANNEL_OK = "looksee_ok"
    const val CHANNEL_CONNECTION = "looksee_connection"
    const val CHANNEL_SERVICE = "looksee_service"

    private const val SERVICE_NOTIFICATION_ID = 1
    private const val UNREACHABLE_NOTIFICATION_ID = 2
    private const val REMOVED_NOTIFICATION_ID = 3
    private const val UNREACHABLE_AFTER_MS = 10 * 60_000L
    private const val MAX_BACKOFF_MS = 5 * 60_000L

    /** Starts (or restarts) the service if it's turned on. Safe to call repeatedly. */
    fun start(context: Context) {
      if (!StreamConfig.isEnabled(context)) return
      ContextCompat.startForegroundService(context, Intent(context, StreamService::class.java))
    }

    /** Stops the service. */
    fun stop(context: Context) {
      context.stopService(Intent(context, StreamService::class.java))
    }

    /** Creates the notification categories (Android ignores repeats). */
    fun createChannels(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val nm = context.getSystemService(NotificationManager::class.java)
      nm.createNotificationChannel(NotificationChannel(CHANNEL_DOWN, "Down alerts", NotificationManager.IMPORTANCE_HIGH).apply { description = "A check is down. Sound and pop-up." })
      nm.createNotificationChannel(NotificationChannel(CHANNEL_WARN, "Warnings", NotificationManager.IMPORTANCE_DEFAULT).apply { description = "A check is degraded (warn)." })
      nm.createNotificationChannel(NotificationChannel(CHANNEL_OK, "Recoveries and other notices", NotificationManager.IMPORTANCE_LOW).apply { description = "A check recovered, tests, security notices." })
      nm.createNotificationChannel(NotificationChannel(CHANNEL_CONNECTION, "Connection problems", NotificationManager.IMPORTANCE_DEFAULT).apply { description = "This phone can't reach the Looksee server, so alerts can't arrive." })
      nm.createNotificationChannel(NotificationChannel(CHANNEL_SERVICE, "Watching (always on)", NotificationManager.IMPORTANCE_MIN).apply { description = "The permanent notification Android requires while Looksee listens for alerts. You can hide it here." })
    }
  }

  private val handler = Handler(Looper.getMainLooper())
  // readTimeout 0: a WebSocket waits indefinitely for the next message; the
  // 30-second ping is what detects a dead connection.
  private val client = OkHttpClient.Builder()
    .pingInterval(30, TimeUnit.SECONDS)
    .readTimeout(0, TimeUnit.MILLISECONDS)
    .connectTimeout(20, TimeUnit.SECONDS)
    .build()
  private var socket: WebSocket? = null
  private var connected = false
  private var stopping = false
  private var backoffMs = 5_000L
  private var disconnectedSince = System.currentTimeMillis()
  private var networkCallback: ConnectivityManager.NetworkCallback? = null

  override fun onBind(intent: Intent?): IBinder? = null

  /** Sets up notification categories, the permanent notification and the network watcher. */
  override fun onCreate() {
    super.onCreate()
    createChannels(this)
    val notification = serviceNotification("Starting…")
    // Android 14+ needs the service type stated when it goes to the foreground.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(SERVICE_NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(SERVICE_NOTIFICATION_ID, notification)
    }
    // Reconnect straight away when a network becomes available, instead of
    // waiting out the backoff.
    val cm = getSystemService(ConnectivityManager::class.java)
    networkCallback = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        handler.post { if (!connected && !stopping) reconnectNow() }
      }
    }.also { cm.registerDefaultNetworkCallback(it) }
    handler.postDelayed(unreachableCheck, 60_000)
  }

  /**
   * Called each time the service is started. Connects if it isn't already.
   * START_STICKY: if Android ever kills the service for memory, it restarts it.
   */
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (StreamConfig.connection(this) == null) {
      stopSelf()
      return START_NOT_STICKY
    }
    if (socket == null) connect()
    return START_STICKY
  }

  /** Closes the connection and stops watching the network. */
  override fun onDestroy() {
    stopping = true
    handler.removeCallbacksAndMessages(null)
    socket?.close(1000, "Stopped")
    socket = null
    networkCallback?.let { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) }
    // Keeps a reason already recorded (e.g. "This phone was removed").
    if (StreamConfig.status(this).first != "stopped") StreamConfig.setStatus(this, "stopped")
    StreamEvents.emit(this)
    super.onDestroy()
  }

  // ---- connection ----

  /** Opens the WebSocket with the saved server and token. */
  private fun connect() {
    val conn = StreamConfig.connection(this) ?: return stopSelf()
    StreamConfig.setStatus(this, "connecting")
    StreamEvents.emit(this)
    updateServiceNotification("Connecting to ${host(conn.serverUrl)}…")
    // OkHttp accepts https:// (and http://) URLs for WebSockets and upgrades
    // the connection itself.
    val request = Request.Builder()
      .url("${conn.serverUrl}/api/app/stream")
      .header("Authorization", "Bearer ${conn.token}")
      .header("User-Agent", "Looksee Android")
      .build()
    socket = client.newWebSocket(request, listener)
  }

  /** Drops any half-open connection and connects again now. */
  private fun reconnectNow() {
    handler.removeCallbacks(reconnectRunnable)
    socket?.cancel()
    socket = null
    connect()
  }

  private val reconnectRunnable = Runnable { if (!stopping) reconnectNow() }

  /** Schedules the next attempt, doubling the wait each time up to 5 minutes. */
  private fun scheduleReconnect(reason: String) {
    connected = false
    socket = null
    StreamConfig.setStatus(this, "waiting", reason)
    StreamEvents.emit(this)
    updateServiceNotification("Not connected: retrying in ${backoffMs / 1000} s")
    handler.removeCallbacks(reconnectRunnable)
    handler.postDelayed(reconnectRunnable, backoffMs)
    backoffMs = (backoffMs * 2).coerceAtMost(MAX_BACKOFF_MS)
  }

  // Every minute: if it has been disconnected for 10 minutes, say so once.
  private val unreachableCheck = object : Runnable {
    override fun run() {
      if (!connected && System.currentTimeMillis() - disconnectedSince > UNREACHABLE_AFTER_MS) showUnreachable()
      handler.postDelayed(this, 60_000)
    }
  }

  // OkHttp calls these from its own background thread; anything touching
  // the service's state is passed to the main thread with handler.post.
  private val listener = object : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      handler.post {
        connected = true
        backoffMs = 5_000L
        StreamConfig.setStatus(this@StreamService, "connected")
        StreamEvents.emit(this@StreamService)
        NotificationManagerCompat.from(this@StreamService).cancel(UNREACHABLE_NOTIFICATION_ID)
        updateServiceNotification("Watching for alerts")
      }
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      handler.post { handleMessage(webSocket, text) }
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      webSocket.close(code, null)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      handler.post {
        if (socket !== webSocket) return@post
        disconnectedSince = System.currentTimeMillis()
        if (code == 4001) removed() else if (!stopping) scheduleReconnect("Connection closed ($code)")
      }
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      handler.post {
        if (socket !== webSocket) return@post
        if (connected) disconnectedSince = System.currentTimeMillis()
        // 401 means the server no longer knows this phone's token.
        if (response?.code == 401) removed()
        else if (!stopping) scheduleReconnect(response?.let { "Server answered ${it.code}" } ?: (t.message ?: "Can't connect"))
      }
    }
  }

  /**
   * Handles one message from the server. "notify" carries alerts: each new
   * one is shown, then all of them are acknowledged, including repeats, so
   * the server stops resending them.
   */
  private fun handleMessage(webSocket: WebSocket, text: String) {
    val msg = try { JSONObject(text) } catch (e: Exception) { return }
    if (msg.optString("type") != "notify") return
    val items = msg.optJSONArray("items") ?: return
    val ids = JSONArray()
    for (i in 0 until items.length()) {
      val item = items.optJSONObject(i) ?: continue
      val id = item.optString("id")
      if (id.isEmpty()) continue
      if (StreamConfig.markSeen(this, id)) showAlert(item)
      ids.put(id)
    }
    if (ids.length() > 0) webSocket.send(JSONObject().put("type", "ack").put("ids", ids).toString())
  }

  /** The server removed this phone: stop for good and tell the user. */
  private fun removed() {
    StreamConfig.clear(this)
    StreamConfig.setStatus(this, "stopped", "This phone was removed from Looksee")
    StreamEvents.emit(this)
    notify(REMOVED_NOTIFICATION_ID, NotificationCompat.Builder(this, CHANNEL_CONNECTION)
      .setSmallIcon(R.drawable.looksee_stat)
      .setContentTitle("Looksee alerts stopped")
      .setContentText("This phone was removed from Looksee. Sign in again in the app to get alerts.")
      .setContentIntent(openApp("looksee://settings", REMOVED_NOTIFICATION_ID))
      .setAutoCancel(true)
      .build())
    stopSelf()
  }

  // ---- notifications ----

  /** Shows one alert, in the category matching its status; tapping it opens the check (or the alerts list). */
  private fun showAlert(item: JSONObject) {
    val status = item.optString("status").uppercase()
    val channel = when (status) {
      "DOWN" -> CHANNEL_DOWN
      "WARN" -> CHANNEL_WARN
      else -> CHANNEL_OK
    }
    val checkId = item.optString("checkId").takeIf { it.isNotEmpty() && it != "null" }
    // Only a check ID shaped like a UUID goes into the link, so server text
    // can never steer the tap somewhere unexpected.
    val link = if (checkId != null && Regex("^[0-9a-fA-F-]{36}$").matches(checkId)) "looksee://checks/$checkId" else "looksee://alerts"
    val id = item.optString("id").hashCode()
    val body = item.optString("body")
    notify(id, NotificationCompat.Builder(this, channel)
      .setSmallIcon(R.drawable.looksee_stat)
      .setContentTitle(item.optString("title", "Looksee"))
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setPriority(if (channel == CHANNEL_DOWN) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
      .setCategory(NotificationCompat.CATEGORY_ALARM.takeIf { channel == CHANNEL_DOWN } ?: NotificationCompat.CATEGORY_STATUS)
      .setContentIntent(openApp(link, id))
      .setAutoCancel(true)
      .build())
  }

  /** Posts "Can't reach Looksee" (once per outage; replacing it keeps it quiet). */
  private fun showUnreachable() {
    val conn = StreamConfig.connection(this) ?: return
    notify(UNREACHABLE_NOTIFICATION_ID, NotificationCompat.Builder(this, CHANNEL_CONNECTION)
      .setSmallIcon(R.drawable.looksee_stat)
      .setContentTitle("Can't reach Looksee")
      .setContentText("No connection to ${host(conn.serverUrl)} for over 10 minutes, so alerts can't arrive. Check the network or VPN.")
      .setStyle(NotificationCompat.BigTextStyle().bigText("No connection to ${host(conn.serverUrl)} for over 10 minutes, so alerts can't arrive. Check the network or VPN. This clears itself when the connection is back."))
      .setOnlyAlertOnce(true)
      .setContentIntent(openApp("looksee://settings", UNREACHABLE_NOTIFICATION_ID))
      .build())
  }

  /** The permanent notification the service must show. */
  private fun serviceNotification(text: String): Notification =
    NotificationCompat.Builder(this, CHANNEL_SERVICE)
      .setSmallIcon(R.drawable.looksee_stat)
      .setContentTitle("Looksee")
      .setContentText(text)
      .setOngoing(true)
      .setSilent(true)
      .setContentIntent(openApp("looksee://", SERVICE_NOTIFICATION_ID))
      .build()

  private fun updateServiceNotification(text: String) = notify(SERVICE_NOTIFICATION_ID, serviceNotification(text))

  /** Posts a notification if the user has allowed notifications (otherwise there's nothing to do). */
  private fun notify(id: Int, notification: Notification) {
    try {
      NotificationManagerCompat.from(this).notify(id, notification)
    } catch (e: SecurityException) {
      // Notifications not allowed (Android 13+ permission refused).
    }
  }

  /**
   * What happens on tap: opens the app at a looksee:// link. The intent is
   * limited to this app's own package and is immutable, so no other app can
   * catch or change it.
   */
  private fun openApp(link: String, requestCode: Int): PendingIntent {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link)).setPackage(packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(this, requestCode, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  /** The host part of the server address, for short messages. */
  private fun host(url: String) = Uri.parse(url).host ?: url
}

/**
 * Passes status changes to the app's JavaScript while it's open
 * (LookseeStreamModule registers a listener); does nothing when it isn't.
 */
object StreamEvents {
  private val listeners = mutableSetOf<(Context) -> Unit>()
  fun add(listener: (Context) -> Unit) = synchronized(listeners) { listeners.add(listener) }
  fun remove(listener: (Context) -> Unit) = synchronized(listeners) { listeners.remove(listener) }
  fun emit(context: Context) = synchronized(listeners) { listeners.toList() }.forEach { it(context) }
}
