package ai.sara.companion;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Registered before super.onCreate so the bridge sees them on first load.
        // SaraCalls belongs to the client app's call integration; SaraVoice is the
        // phone's Text-to-speech engine, used by the standalone conversation.
        registerPlugin(SaraCallsPlugin.class);
        registerPlugin(SaraVoicePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
