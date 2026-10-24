package ai.sara.companion;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * SaraVoice — the phone's real speech engine, for the standalone app.
 *
 * Why this plugin exists: an Android WebView usually has no speech synthesis at
 * all (window.speechSynthesis is missing or has zero voices), which is why the
 * standalone app used to report "No speech engine — replies stay text". Adding
 * Google Play services does not fix that from inside a web page. The fix is to
 * call Android's own {@link TextToSpeech}, which uses whichever engine the phone
 * has installed — Google Text-to-Speech, Samsung's, eSpeak — and works even on
 * phones with no Google account.
 *
 * What it really does:
 *  - reports the engine actually in use, its languages and voices;
 *  - speaks text with the user's chosen rate/pitch/volume/voice, and resolves
 *    only when speech finished (or timed out, so the UI never hangs);
 *  - opens Android's Text-to-speech settings so a missing engine can be
 *    installed instead of the user being told "it does not work".
 *
 * What it cannot do: speak without an installed engine. In that case it says so
 * with the store intent, never pretends the words were spoken.
 */
@CapacitorPlugin(name = "SaraVoice")
public class SaraVoicePlugin extends Plugin implements TextToSpeech.OnInitListener {

    private TextToSpeech tts;
    private boolean ready = false;
    private boolean starting = false;
    private String initError;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Map<String, PluginCall> pending = new HashMap<>();
    private final Set<String> settled = new HashSet<>();

    /* ------------------------------------------------------------------ engine */

    private void ensureEngine() {
        if (tts != null || starting) {
            return;
        }
        starting = true;
        final Context context = getContext().getApplicationContext();
        handler.post(() -> {
            try {
                tts = new TextToSpeech(context, this);
            } catch (Exception error) {
                starting = false;
                initError = "Android's Text-to-speech could not start: " + error.getMessage();
            }
        });
    }

    @Override
    public void onInit(int status) {
        starting = false;
        if (status == TextToSpeech.SUCCESS) {
            ready = true;
            initError = null;
            try {
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override
                    public void onStart(String utteranceId) {
                        /* nothing to report: the app already knows it is speaking */
                    }

                    @Override
                    public void onDone(String utteranceId) {
                        finish(utteranceId, true, null);
                    }

                    @Override
                    @SuppressWarnings("deprecation")
                    public void onError(String utteranceId) {
                        finish(utteranceId, false, "The speech engine reported an error.");
                    }

                    @Override
                    public void onError(String utteranceId, int errorCode) {
                        finish(utteranceId, false, "The speech engine reported error " + errorCode + ".");
                    }

                    @Override
                    public void onStop(String utteranceId, boolean interrupted) {
                        finish(utteranceId, true, null);
                    }
                });
            } catch (Exception ignored) {
                /* listener is an optimisation, not a requirement */
            }
        } else {
            ready = false;
            initError = "This phone has no working Text-to-speech engine (Android reported status " + status
                + "). Install one from Settings → System → Languages & input → Text-to-speech output.";
        }
    }

    private void finish(String utteranceId, boolean ok, String message) {
        if (utteranceId == null || !pending.containsKey(utteranceId) || settled.contains(utteranceId)) {
            return;
        }
        settled.add(utteranceId);
        PluginCall call = pending.remove(utteranceId);
        if (call == null) {
            return;
        }
        JSObject result = new JSObject();
        result.put("ok", ok);
        result.put("engine", engineName());
        if (message != null) {
            result.put("message", message);
        }
        call.resolve(result);
    }

    private String engineName() {
        if (tts == null) {
            return "";
        }
        try {
            String name = tts.getDefaultEngine();
            return name != null ? name : "";
        } catch (Exception error) {
            return "";
        }
    }

    /* ------------------------------------------------------------------- info */

    @PluginMethod
    public void info(PluginCall call) {
        ensureEngine();
        JSObject result = new JSObject();
        result.put("ready", ready);
        result.put("engine", engineName());
        if (initError != null) {
            result.put("error", initError);
        }

        JSArray voices = new JSArray();
        String defaultLanguage = "";
        if (ready && tts != null) {
            try {
                Locale locale = tts.getDefaultVoice() != null ? tts.getDefaultVoice().getLocale() : tts.getLanguage();
                if (locale != null) {
                    defaultLanguage = locale.toLanguageTag();
                }
            } catch (Exception ignored) {
                /* older engines do not expose a default voice */
            }
            try {
                Set<Voice> installed = tts.getVoices();
                if (installed != null) {
                    for (Voice voice : installed) {
                        // Only the voices the phone can actually speak, in a
                        // language it can speak, are useful in a picker.
                        if (voice == null || voice.isNetworkConnectionRequired()) {
                            continue;
                        }
                        JSObject row = new JSObject();
                        row.put("name", voice.getName());
                        row.put("lang", voice.getLocale() != null ? voice.getLocale().toLanguageTag() : "");
                        voices.put(row);
                    }
                }
            } catch (Exception ignored) {
                /* voice listing is optional */
            }
        }
        result.put("defaultLanguage", defaultLanguage);
        result.put("voices", voices);
        call.resolve(result);
    }

    /* ------------------------------------------------------------------ speak */

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        if (text == null || text.trim().isEmpty()) {
            JSObject empty = new JSObject();
            empty.put("ok", true);
            empty.put("engine", engineName());
            call.resolve(empty);
            return;
        }

        ensureEngine();
        if (!ready || tts == null) {
            JSObject result = new JSObject();
            result.put("ok", false);
            result.put("engine", engineName());
            result.put("message", initError != null ? initError : "Android's speech engine is still starting. Try again in a moment.");
            call.resolve(result);
            return;
        }

        float rate = (float) clamp(call.getData().optDouble("rate", 1.0), 0.4, 2.5);
        float pitch = (float) clamp(call.getData().optDouble("pitch", 1.0), 0.3, 2.5);
        float volume = (float) clamp(call.getData().optDouble("volume", 1.0), 0.0, 1.0);
        String voiceName = call.getString("voiceName", "");
        String language = call.getString("language", "");

        final String utteranceId = "sara-" + System.nanoTime();
        pending.put(utteranceId, call);

        handler.post(() -> {
            try {
                tts.setSpeechRate(rate);
                tts.setPitch(pitch);
                applyVoice(voiceName, language);

                Bundle params = new Bundle();
                params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, volume);

                int started = tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, utteranceId);
                if (started == TextToSpeech.ERROR) {
                    finish(utteranceId, false, "Android's speech engine refused to speak this text.");
                    return;
                }
                // Some engines never fire onDone; never leave the app waiting.
                long guard = Math.min(240_000L, 6_000L + text.length() * 120L);
                handler.postDelayed(() -> finish(utteranceId, true, null), guard);
            } catch (Exception error) {
                finish(utteranceId, false, "The speech engine failed: " + error.getMessage());
            }
        });
    }

    private void applyVoice(String voiceName, String language) {
        if (tts == null) {
            return;
        }
        if (voiceName != null && !voiceName.isEmpty()) {
            try {
                Set<Voice> voices = tts.getVoices();
                if (voices != null) {
                    for (Voice voice : voices) {
                        if (voice != null && voiceName.equals(voice.getName())) {
                            tts.setVoice(voice);
                            return;
                        }
                    }
                }
            } catch (Exception ignored) {
                /* fall through to the language below */
            }
        }
        if (language != null && !language.isEmpty()) {
            try {
                Locale locale = Locale.forLanguageTag(language);
                int available = tts.isLanguageAvailable(locale);
                if (available >= TextToSpeech.LANG_AVAILABLE) {
                    tts.setLanguage(locale);
                }
            } catch (Exception ignored) {
                /* the engine's default language stays */
            }
        }
    }

    private static double clamp(double value, double min, double max) {
        if (Double.isNaN(value)) {
            return min;
        }
        return Math.max(min, Math.min(max, value));
    }

    /* ------------------------------------------------------------------- stop */

    @PluginMethod
    public void stop(PluginCall call) {
        if (tts != null) {
            try {
                tts.stop();
            } catch (Exception ignored) {
                /* nothing was speaking */
            }
        }
        for (String id : new HashSet<>(pending.keySet())) {
            finish(id, true, null);
        }
        call.resolve();
    }

    /* --------------------------------------------------------------- settings */

    @PluginMethod
    public void openSettings(PluginCall call) {
        JSObject result = new JSObject();
        boolean opened = false;
        try {
            Intent intent = new Intent("com.android.settings.TTS_SETTINGS");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            opened = true;
        } catch (Exception first) {
            try {
                // Older ROMs: open the Text-to-speech data installer instead.
                Intent install = new Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA);
                install.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(install);
                opened = true;
            } catch (Exception second) {
                result.put("message", "Android did not open the speech settings. Open Settings → System → Languages & input → Text-to-speech output.");
            }
        }
        result.put("opened", opened);
        call.resolve(result);
    }

    /* -------------------------------------------------------------- lifecycle */

    @Override
    protected void handleOnDestroy() {
        if (tts != null) {
            try {
                tts.stop();
                tts.shutdown();
            } catch (Exception ignored) {
                /* already gone */
            }
            tts = null;
            ready = false;
        }
        super.handleOnDestroy();
    }
}
