// Ce script s'execute APRES "npx cap add android" et "npx cap sync android" dans le
// workflow GitHub Actions. Capacitor regenere le dossier android/ a chaque fois, donc
// on ne peut pas modifier ces fichiers a la main une fois pour toutes : on les repatche
// a chaque build.
//
// 1) Ajoute a AndroidManifest.xml l'association des fichiers .mlg (pour que l'app
//    apparaisse dans "Ouvrir avec..." quand on tape sur un .mlg dans un gestionnaire
//    de fichiers / une piece jointe).
// 2) Remplace MainActivity.java par une version qui recupere le contenu du fichier
//    .mlg ouvert et le transmet a l'editeur web via window.chargerFichierExterne(texte).

const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync('capacitor.config.json', 'utf8'));
const appId = config.appId;

/* ---------- 1) AndroidManifest.xml ---------- */
const manifestPath = path.join('android', 'app', 'src', 'main', 'AndroidManifest.xml');
let manifest = fs.readFileSync(manifestPath, 'utf8');

const intentFilterMlg =
`        <intent-filter>
            <action android:name="android.intent.action.VIEW" />
            <category android:name="android.intent.category.DEFAULT" />
            <category android:name="android.intent.category.BROWSABLE" />
            <data android:scheme="content" />
            <data android:scheme="file" />
            <data android:mimeType="*/*" />
            <data android:pathPattern=".*\\\\.mlg" />
        </intent-filter>
    </activity>`;

if (!manifest.includes('.mlg')) {
  manifest = manifest.replace('</activity>', intentFilterMlg);
  fs.writeFileSync(manifestPath, manifest);
  console.log('[patch-android] AndroidManifest.xml : association .mlg ajoutee.');
} else {
  console.log('[patch-android] AndroidManifest.xml : deja patche.');
}

/* ---------- 2) MainActivity.java ---------- */
const mainActivityDir = path.join('android', 'app', 'src', 'main', 'java', ...appId.split('.'));
const mainActivityPath = path.join(mainActivityDir, 'MainActivity.java');

const mainActivityContent = `package ${appId};

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import com.getcapacitor.BridgeActivity;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStreamReader;

// Recupere un fichier .mlg ouvert depuis une autre appli (gestionnaire de fichiers,
// messagerie...) et transmet son contenu texte a l'editeur web via
// window.chargerFichierExterne(texte), definie dans www/index.html.
public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        traiterIntentOuverture(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        traiterIntentOuverture(intent);
    }

    private void traiterIntentOuverture(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;
        Uri uri = intent.getData();
        if (uri == null) return;
        try {
            StringBuilder contenu = new StringBuilder();
            try (BufferedReader lecteur = new BufferedReader(
                    new InputStreamReader(getContentResolver().openInputStream(uri)))) {
                String ligne;
                while ((ligne = lecteur.readLine()) != null) {
                    contenu.append(ligne).append("\\n");
                }
            }
            String texteEchappe = JSONObject.quote(contenu.toString());
            String js = "window.chargerFichierExterne && window.chargerFichierExterne(" + texteEchappe + ");";
            // La page web n'est pas forcement finie de charger au moment de onCreate :
            // un petit delai pragmatique le temps du chargement initial. A affiner
            // (ex: se brancher sur onPageFinished) si ce n'est pas fiable au test.
            new Handler(getMainLooper()).postDelayed(() ->
                getBridge().getWebView().evaluateJavascript(js, null), 1200);
        } catch (Exception e) {
            e.printStackTrace();
        }
    }
}
`;

fs.mkdirSync(mainActivityDir, { recursive: true });
fs.writeFileSync(mainActivityPath, mainActivityContent);
console.log('[patch-android] MainActivity.java remplace.');
