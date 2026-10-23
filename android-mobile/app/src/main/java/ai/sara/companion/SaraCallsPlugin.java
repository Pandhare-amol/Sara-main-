package ai.sara.companion;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.telecom.TelecomManager;
import android.telephony.TelephonyManager;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * SaraCalls — the phone half of Sara's call integration.
 *
 * What it really does:
 *  - listens to TelephonyManager call-state broadcasts while the app runs;
 *  - POSTs ringing/connected/ended events (with the caller id when Android
 *    exposes it) to the Sara server, authenticated with a device token;
 *  - polls the server for commands (place_call, answer_call, reject_call,
 *    end_call) and executes the ones the platform permits.
 *
 * What it cannot do: inject audio into a cellular call. Android reserves
 * in-call audio to the system dialer, so Sara cannot speak into a GSM call from
 * an ordinary app. Answering/ending calls needs ANSWER_PHONE_CALLS (system dialer
 * role) and is reported as unsupported when the permission is unavailable —
 * never faked as success.
 */
@CapacitorPlugin(
    name = "SaraCalls",
    permissions = {
        @Permission(alias = "calls", strings = {
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.CALL_PHONE,
            Manifest.permission.READ_PHONE_NUMBERS
        })
    }
)
public class SaraCallsPlugin extends Plugin {

    private static final String TAG = "SaraCalls";
    private static final long POLL_INTERVAL_MS = 4000L;

    private String baseUrl = "";
    private String token = "";
    private String deviceId = "";
    private boolean listening = false;
    private String currentCallId = null;
    private String currentState = "IDLE";
    private ScheduledExecutorService poller;

    private final BroadcastReceiver callReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (!TelephonyManager.ACTION_PHONE_STATE_CHANGED.equals(intent.getAction())) return;
            String state = intent.getStringExtra(TelephonyManager.EXTRA_STATE);
            String number = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER);
            if (state == null) return;
            handlePhoneState(state, number);
        }
    };

    @PluginMethod
    public void start(PluginCall call) {
        baseUrl = trimSlash(call.getString("baseUrl", ""));
        token = call.getString("token", "");
        deviceId = call.getString("deviceId", "");
        if (deviceId == null || deviceId.isEmpty()) deviceId = "android-" + UUID.randomUUID().toString().substring(0, 8);
        if (baseUrl.isEmpty() || token.isEmpty()) {
            call.reject("A server URL and device token are required.");
            return;
        }
        if (!hasCallPermission()) {
            requestPermissionForAlias("calls", call, "callsPermissionCallback");
            return;
        }
        beginListening();
        reportCapabilities();
        call.resolve(status());
    }

    @PermissionCallback
    private void callsPermissionCallback(PluginCall call) {
        if (!hasCallPermission()) {
            call.reject("Phone permission was denied. Sara cannot report calls without it.");
            return;
        }
        beginListening();
        reportCapabilities();
        call.resolve(status());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopListening();
        call.resolve(status());
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(status());
    }

    /** Place a real call the user already confirmed on the server side. */
    @PluginMethod
    public void placeCall(PluginCall call) {
        String number = call.getString("number", "");
        if (number == null || number.replaceAll("\\D", "").length() < 7) {
            call.reject("A full phone number is required.");
            return;
        }
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.CALL_PHONE)
                != PackageManager.PERMISSION_GRANTED) {
            call.reject("CALL_PHONE permission is not granted, so the call was not placed.");
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_CALL);
            intent.setData(Uri.parse("tel:" + number));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            // The call is not "connected" because an intent was accepted; the
            // telephony state broadcast is what reports connection.
            JSObject result = new JSObject();
            result.put("status", "DIALING");
            result.put("verified", false);
            result.put("message", "Android accepted the dial intent; waiting for the call-state broadcast.");
            call.resolve(result);
        } catch (SecurityException error) {
            call.reject("Android refused the call: " + error.getMessage());
        }
    }

    /**
     * Answer the ringing call. Requires the system dialer role on most devices;
     * when that is unavailable this reports failure instead of pretending.
     */
    @PluginMethod
    public void answerCall(PluginCall call) {
        JSObject result = new JSObject();
        if (!hasAnswerPermission()) {
            result.put("status", "FAILED");
            result.put("verified", false);
            result.put("error", "ANSWER_PHONE_CALLS is not available to a normal app on this device.");
            call.resolve(result);
            return;
        }
        try {
            TelecomManager telecom = (TelecomManager) getContext().getSystemService(Context.TELECOM_SERVICE);
            if (telecom == null) {
                result.put("status", "FAILED");
                result.put("verified", false);
                result.put("error", "Telecom service unavailable.");
                call.resolve(result);
                return;
            }
            telecom.acceptRingingCall();
            result.put("status", "ANSWER_REQUESTED");
            result.put("verified", false);
            result.put("message", "Answer requested; the call-state broadcast will confirm.");
            call.resolve(result);
        } catch (Exception error) {
            result.put("status", "FAILED");
            result.put("verified", false);
            result.put("error", error.getMessage() == null ? "Answer was refused." : error.getMessage());
            call.resolve(result);
        }
    }

    @PluginMethod
    public void endCall(PluginCall call) {
        JSObject result = new JSObject();
        try {
            TelecomManager telecom = (TelecomManager) getContext().getSystemService(Context.TELECOM_SERVICE);
            if (telecom == null) throw new IllegalStateException("Telecom service unavailable.");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                telecom.endCall();
            } else {
                throw new IllegalStateException("endCall needs Android 9 or newer.");
            }
            result.put("status", "END_REQUESTED");
            result.put("verified", false);
        } catch (Exception error) {
            result.put("status", "FAILED");
            result.put("verified", false);
            result.put("error", error.getMessage() == null ? "Ending the call is not permitted on this device." : error.getMessage());
        }
        call.resolve(result);
    }

    /* ------------------------------------------------------------------ */

    private void beginListening() {
        if (listening) return;
        IntentFilter filter = new IntentFilter(TelephonyManager.ACTION_PHONE_STATE_CHANGED);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(callReceiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            getContext().registerReceiver(callReceiver, filter);
        }
        listening = true;
        startPoller();
        Log.i(TAG, "Listening for call state as " + deviceId);
    }

    private void stopListening() {
        if (listening) {
            try {
                getContext().unregisterReceiver(callReceiver);
            } catch (IllegalArgumentException ignored) {
                // Already unregistered.
            }
            listening = false;
        }
        if (poller != null) {
            poller.shutdownNow();
            poller = null;
        }
    }

    private boolean hasCallPermission() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.READ_PHONE_STATE)
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasAnswerPermission() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ANSWER_PHONE_CALLS)
                == PackageManager.PERMISSION_GRANTED;
    }

    private JSObject status() {
        JSObject result = new JSObject();
        result.put("listening", listening);
        result.put("deviceId", deviceId);
        result.put("permission", hasCallPermission());
        result.put("canAnswer", hasAnswerPermission());
        result.put("state", currentState);
        return result;
    }

    private void handlePhoneState(String state, String number) {
        if (TelephonyManager.EXTRA_STATE_RINGING.equals(state)) {
            currentCallId = UUID.randomUUID().toString();
            currentState = "RINGING";
            postEvent("ringing", number);
        } else if (TelephonyManager.EXTRA_STATE_OFFHOOK.equals(state)) {
            if (currentCallId == null) currentCallId = UUID.randomUUID().toString();
            currentState = "CONNECTED";
            postEvent("connected", number);
        } else if (TelephonyManager.EXTRA_STATE_IDLE.equals(state)) {
            if (currentCallId != null) {
                postEvent("ended", number);
                currentCallId = null;
            }
            currentState = "IDLE";
        }
    }

    private void postEvent(String type, String number) {
        JSONObject payload = new JSONObject();
        try {
            payload.put("type", type);
            payload.put("callId", currentCallId);
            payload.put("deviceId", deviceId);
            payload.put("direction", "incoming");
            if (number != null && !number.isEmpty()) payload.put("number", number);
            payload.put("at", isoNow());
        } catch (Exception ignored) {
            return;
        }
        executor().execute(() -> http("POST", "/api/calls/events", payload.toString()));
    }

    /**
     * Tell the server what this build can actually do. Only real, implemented
     * capabilities are reported, and permission-dependent ones carry their live
     * permission state — a missing permission is NEEDS_PERMISSION, not a hope.
     */
    private void reportCapabilities() {
        JSONArray capabilities = new JSONArray();
        try {
            capabilities.put(capability("phone.call.events", "AVAILABLE", new String[]{"READ_PHONE_STATE"},
                    "Call-state broadcasts are reported to Sara while the app runs."));
            capabilities.put(capability("phone.call.place",
                    hasCallPermission() ? "AVAILABLE" : "NEEDS_PERMISSION",
                    new String[]{"CALL_PHONE"},
                    "Sara can dial a call you already approved."));
            capabilities.put(capability("phone.call.answer",
                    hasAnswerPermission() ? "AVAILABLE" : "NEEDS_PERMISSION",
                    new String[]{"ANSWER_PHONE_CALLS"},
                    "Answering depends on the system dialer role; otherwise Android refuses."));
            capabilities.put(capability("phone.call.end",
                    hasAnswerPermission() ? "AVAILABLE" : "NEEDS_PERMISSION",
                    new String[]{"ANSWER_PHONE_CALLS"},
                    "Hanging up needs the same dialer role."));
            capabilities.put(capability("phone.call.speak_audio", "NOT_SUPPORTED", new String[]{},
                    "Android reserves in-call audio for the system dialer; Sara cannot speak into a cellular call."));
        } catch (Exception error) {
            Log.w(TAG, "Could not build the capability report: " + error.getMessage());
        }

        JSONObject payload = new JSONObject();
        try {
            payload.put("deviceId", deviceId);
            payload.put("platform", "android");
            payload.put("appVersion", appVersionName());
            payload.put("capabilities", capabilities);
        } catch (Exception ignored) {
            return;
        }
        if (poller != null) {
            poller.execute(() -> http("POST", "/api/capabilities/report", payload.toString()));
        }
    }

    private String appVersionName() {
        try {
            return getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).versionName;
        } catch (Exception error) {
            return "unknown";
        }
    }

    private static JSONObject capability(String id, String status, String[] permissions, String detail) throws Exception {
        JSONObject item = new JSONObject();
        item.put("id", id);
        item.put("status", status);
        item.put("permissions", new JSONArray(java.util.Arrays.asList(permissions)));
        item.put("detail", detail);
        return item;
    }

    private void startPoller() {
        poller = Executors.newSingleThreadScheduledExecutor();
        poller.scheduleWithFixedDelay(this::pollCommands, 2, POLL_INTERVAL_MS / 1000, TimeUnit.SECONDS);
    }

    private void pollCommands() {
        String body = http("GET", "/api/calls/devices/" + deviceId + "/commands", null);
        if (body == null) return;
        try {
            JSONObject json = new JSONObject(body);
            JSONArray commands = json.optJSONArray("commands");
            if (commands == null) return;
            for (int i = 0; i < commands.length(); i++) {
                JSONObject command = commands.getJSONObject(i);
                execute(command.optString("id"), command.optString("kind"), command.optJSONObject("payload"));
            }
        } catch (Exception error) {
            Log.w(TAG, "Could not read commands: " + error.getMessage());
        }
    }

    private void execute(String commandId, String kind, JSONObject payload) {
        String result;
        try {
            switch (kind) {
                case "place_call": {
                    String number = payload == null ? "" : payload.optString("number");
                    Intent intent = new Intent(Intent.ACTION_CALL);
                    intent.setData(Uri.parse("tel:" + number));
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(intent);
                    result = "dialing " + number;
                    break;
                }
                case "answer_call":
                    result = "answer not permitted by this app";
                    break;
                case "reject_call":
                case "end_call":
                    result = "hang-up not permitted by this app";
                    break;
                default:
                    result = "unsupported: " + kind;
            }
        } catch (Exception error) {
            result = "failed: " + error.getMessage();
        }
        JSONObject ack = new JSONObject();
        try {
            ack.put("result", result);
        } catch (Exception ignored) {
            // Cannot happen for a string value.
        }
        http("POST", "/api/calls/devices/" + deviceId + "/commands/" + commandId + "/ack", ack.toString());
    }

    private ScheduledExecutorService executor() {
        if (poller == null) poller = Executors.newSingleThreadScheduledExecutor();
        return poller;
    }

    private String http(String method, String path, String body) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(baseUrl + path);
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod(method);
            connection.setConnectTimeout(6000);
            connection.setReadTimeout(8000);
            connection.setRequestProperty("x-sara-device-token", token);
            connection.setRequestProperty("Content-Type", "application/json");
            if (body != null) {
                connection.setDoOutput(true);
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(body.getBytes(StandardCharsets.UTF_8));
                }
            }
            int code = connection.getResponseCode();
            InputStream stream = code >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (stream == null) return null;
            StringBuilder builder = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) builder.append(line);
            }
            if (code >= 400) Log.w(TAG, method + " " + path + " -> " + code + " " + builder);
            return builder.toString();
        } catch (Exception error) {
            Log.w(TAG, method + " " + path + " failed: " + error.getMessage());
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** ISO-8601 in UTC without java.time (minSdk 23 has no desugaring here). */
    private static String isoNow() {
        java.text.SimpleDateFormat format =
                new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US);
        format.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return format.format(new java.util.Date());
    }

    private static String trimSlash(String value) {
        if (value == null) return "";
        String trimmed = value.trim();
        while (trimmed.endsWith("/")) trimmed = trimmed.substring(0, trimmed.length() - 1);
        return trimmed;
    }

    @Override
    protected void handleOnDestroy() {
        stopListening();
        super.handleOnDestroy();
    }
}
