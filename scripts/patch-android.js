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
import android.webkit.JavascriptInterface;
import com.getcapacitor.BridgeActivity;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

// Activite Android native de MonLangage.
// Elle fournit aussi un pont JavaScript pour Enregistrer/Ouvrir les fichiers .mlg.
public class MainActivity extends BridgeActivity {

    private static final int REQUEST_OPEN_MLG = 4101;
    private static final int REQUEST_SAVE_MLG = 4102;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Les boutons de l'editeur utilisent ce pont pour ouvrir les vrais
        // selecteurs de fichiers Android. Cela evite les limitations des
        // telechargements Blob dans une WebView Capacitor.
        getBridge().getWebView().addJavascriptInterface(new MonLangageBridge(), "MonLangage");

        traiterIntentOuverture(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        traiterIntentOuverture(intent);
    }

    private class MonLangageBridge {
        @JavascriptInterface
        public void saveFile(String filename, String content) {
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("text/plain");
                intent.putExtra(Intent.EXTRA_TITLE, filename);
                startActivityForResult(intent, REQUEST_SAVE_MLG);
                contenuAEnregistrer = content;
            });
        }

        @JavascriptInterface
        public void openFile() {
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                // "*/*" seul, sans EXTRA_MIME_TYPES : une extension inconnue du systeme
                // comme .mlg n'est associee a aucun type MIME standard, donc combiner
                // "*/*" avec une liste de types precis grisait tous les fichiers.
                intent.setType("*/*");
                startActivityForResult(intent, REQUEST_OPEN_MLG);
            });
        }
    }

    private String contenuAEnregistrer = null;

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode == REQUEST_SAVE_MLG) {
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                contenuAEnregistrer = null;
                notifierSauvegardeJS(false);
                return;
            }

            Uri uri = data.getData();
            if (contenuAEnregistrer == null) {
                notifierSauvegardeJS(false);
                return;
            }

            try (OutputStream sortie = getContentResolver().openOutputStream(uri)) {
                if (sortie == null) throw new Exception("Impossible d'ouvrir le fichier de destination.");
                sortie.write(contenuAEnregistrer.getBytes(StandardCharsets.UTF_8));
                sortie.flush();
                notifierSauvegardeJS(true);
            } catch (Exception e) {
                e.printStackTrace();
                afficherErreurJS("Impossible d'enregistrer le fichier.");
                notifierSauvegardeJS(false);
            } finally {
                contenuAEnregistrer = null;
            }

        } else if (requestCode == REQUEST_OPEN_MLG) {
            if (resultCode != RESULT_OK || data == null || data.getData() == null) return;
            lireFichierEtEnvoyerAuWebView(data.getData());
        }
    }

    private void lireFichierEtEnvoyerAuWebView(Uri uri) {
        try {
            StringBuilder contenu = new StringBuilder();

            try (BufferedReader lecteur = new BufferedReader(
                    new InputStreamReader(
                            getContentResolver().openInputStream(uri),
                            StandardCharsets.UTF_8))) {

                String ligne;
                boolean premiereLigne = true;
                while ((ligne = lecteur.readLine()) != null) {
                    if (!premiereLigne) contenu.append("\\n");
                    contenu.append(ligne);
                    premiereLigne = false;
                }
            }

            envoyerTexteAuWebView(contenu.toString(), obtenirNomFichier(uri));

        } catch (Exception e) {
            e.printStackTrace();
            afficherErreurJS("Impossible de lire ce fichier.");
        }
    }

    private void envoyerTexteAuWebView(String texte) {
        envoyerTexteAuWebView(texte, "Sans fichier");
    }

    private void envoyerTexteAuWebView(String texte, String nom) {
        String texteEchappe = JSONObject.quote(texte);
        String nomEchappe = JSONObject.quote(nom);
        String js = "window.chargerFichierExterne && window.chargerFichierExterne(" + texteEchappe + ", " + nomEchappe + ");";

        // Le fichier peut etre choisi juste apres le demarrage de l'application.
        // post() attend que la WebView soit prete avant d'appeler JavaScript.
        getBridge().getWebView().post(() ->
            getBridge().getWebView().evaluateJavascript(js, null)
        );
    }

    private void notifierSauvegardeJS(boolean succes) {
        String js = "window.monLangageSaveFinished && window.monLangageSaveFinished(" + (succes ? "true" : "false") + ");";
        getBridge().getWebView().post(() ->
            getBridge().getWebView().evaluateJavascript(js, null)
        );
    }

    private void afficherErreurJS(String message) {
        String texteEchappe = JSONObject.quote(message);
        String js = "alert(" + texteEchappe + ");";
        getBridge().getWebView().post(() ->
            getBridge().getWebView().evaluateJavascript(js, null)
        );
    }

    private String obtenirNomFichier(Uri uri) {
        String nom = null;
        try (android.database.Cursor cursor = getContentResolver().query(
                uri, new String[] { android.provider.OpenableColumns.DISPLAY_NAME },
                null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                if (index >= 0) nom = cursor.getString(index);
            }
        } catch (Exception ignored) { }
        if (nom == null || nom.trim().isEmpty()) {
            String dernier = uri.getLastPathSegment();
            nom = (dernier == null || dernier.trim().isEmpty()) ? "Sans fichier" : dernier;
        }
        return nom;
    }

    private void traiterIntentOuverture(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;

        Uri uri = intent.getData();
        if (uri == null) return;

        try {
            StringBuilder contenu = new StringBuilder();

            try (BufferedReader lecteur = new BufferedReader(
                    new InputStreamReader(
                            getContentResolver().openInputStream(uri),
                            StandardCharsets.UTF_8))) {

                String ligne;
                boolean premiereLigne = true;
                while ((ligne = lecteur.readLine()) != null) {
                    if (!premiereLigne) contenu.append("\\n");
                    contenu.append(ligne);
                    premiereLigne = false;
                }
            }

            String texte = contenu.toString();

            // L'intent peut arriver avant la fin du chargement de index.html.
            // On attend un peu avant d'appeler chargerFichierExterne().
            getBridge().getWebView().postDelayed(
                () -> envoyerTexteAuWebView(texte, obtenirNomFichier(uri)),
                1200
            );

        } catch (Exception e) {
            e.printStackTrace();
        }
    }
}
`;

fs.mkdirSync(mainActivityDir, { recursive: true });
fs.writeFileSync(mainActivityPath, mainActivityContent);
console.log('[patch-android] MainActivity.java remplace.');
